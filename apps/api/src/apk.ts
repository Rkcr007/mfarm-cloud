import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { isValidPackageName } from '@mfarm/protocol';

/**
 * Read an APK's identity out of the file itself.
 *
 * Why parse at all, rather than letting the uploader tell us the package name: everything downstream
 * acts on it. `adb uninstall`, launching an activity, "which build is on cf-2 right now", and the
 * library's own grouping all key off `package_name`. A client-supplied name means a caller can
 * claim someone else's package, and — far more likely — that a mislabelled upload is discovered by
 * a test run that installs the wrong app and fails somewhere unrelated.
 *
 * Why by hand, rather than with aapt2: aapt2 is part of the Android SDK build-tools, which the
 * control plane does not have and should not grow a dependency on — it is a container that talks to
 * Postgres. Shelling out to a binary on the API host to parse an untrusted upload is also a
 * distinctly worse attack surface than reading the two structures below.
 *
 * This reads exactly two things and nothing else: the zip central directory, to find
 * AndroidManifest.xml, and Android's binary XML, to pull four attributes out of it. It does NOT
 * read resources.arsc, verify a signature, or list activities. Each of those is a real feature and
 * each would be a much larger surface; when one is needed it should arrive deliberately.
 */

export interface ApkMetadata {
  packageName: string;
  versionCode: number | null;
  versionName: string | null;
  minSdk: number | null;
  /** NULL when the manifest points at a string resource; see the note on RESOURCE references. */
  label: string | null;
  /**
   * ABIs this build ships native libraries for, sorted. EMPTY MEANS "no native code", which runs
   * anywhere — never "runs nowhere". See `nativeAbisOf`.
   */
  abis: string[];
}

/**
 * What the MANIFEST alone can say. `abis` is absent because it is not in the manifest — it is the
 * shape of the zip around it — and a parser that had to invent a value for it would be inventing
 * "no native code", which is the answer that lets everything install.
 */
export type ManifestMetadata = Omit<ApkMetadata, 'abis'>;

/**
 * What `parseManifest` returns: the published metadata, plus the label's resource id when the
 * manifest stores one instead of a literal.
 *
 * `labelRef` is an INTERNAL HAND-OFF and deliberately not part of `ApkMetadata` — it is meaningless
 * outside this module and nothing downstream should ever see a resource id. `readApkMetadata`
 * resolves it and drops it.
 */
type ParsedManifest = ManifestMetadata & { labelRef: number | null };

/** The upload is not an APK, or is one we cannot read. Always a 400, never a 500. */
export class ApkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkParseError';
  }
}

// ---------------------------------------------------------------- zip

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** EOCD is 22 bytes plus a comment of at most 65535. Nothing before that can be the record. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

/**
 * A ceiling on the INFLATED manifest, not the compressed one.
 *
 * Without it a 4 KB entry that expands to 4 GB — a zip bomb, which takes about a minute to build —
 * is a heap allocation the API cannot refuse. Real manifests are a few kilobytes; a megabyte is
 * already an absurd one, and 4 MB leaves room to be wrong about that.
 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const MANIFEST_NAME = 'AndroidManifest.xml';

/**
 * `resources.arsc` — where `android:label="@string/app_name"` actually lives.
 *
 * A separate, much larger ceiling than the manifest's. A manifest is a few hundred kilobytes; a
 * resource table for an app translated into forty languages is routinely tens of megabytes, and
 * refusing to read it would put every localised app back to showing a package name.
 */
const ARSC_NAME = 'resources.arsc';
const MAX_ARSC_BYTES = 64 * 1024 * 1024;

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  if (bytesRead !== length) {
    throw new ApkParseError('Truncated archive: a structure it points at runs past the end of the file.');
  }
  return buf;
}

/**
 * Pull the raw AndroidManifest.xml bytes out of an APK on disk.
 *
 * Reads the central directory rather than streaming the whole archive, because the manifest is
 * typically the first entry of a file that may be hundreds of megabytes and there is no reason to
 * touch the other 99% of it.
 */
/** One central-directory record, reduced to the fields anything here reads. */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/**
 * Walk the central directory once and hand back every entry.
 *
 * Split out of `extractManifest` when the ABI preflight arrived and needed a second reader of the
 * same structure. Deliberately shared rather than copied: the EOCD scan below has three separate
 * bounds checks on attacker-controlled lengths, and a second hand-rolled copy of it is a second
 * place for one of them to be forgotten.
 */
async function readCentralDirectory(fh: FileHandle): Promise<ZipEntry[]> {
  const { size } = await fh.stat();
  if (size < 22) throw new ApkParseError('File is too small to be a zip archive.');

  // Scan backwards for the end-of-central-directory record. Backwards because a zip comment may
  // contain the signature bytes, and the LAST occurrence is the real one.
  const tailLen = Math.min(size, MAX_EOCD_SEARCH);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd === -1) {
    throw new ApkParseError('Not a zip archive: no end-of-central-directory record. An APK is a zip.');
  }

  const entryCount = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > size) {
    throw new ApkParseError('Corrupt archive: the central directory runs past the end of the file.');
  }

  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new ApkParseError('Corrupt archive: central directory entry has a bad signature.');
    }
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      uncompressedSize: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * ABIs this build ships native code for, read from the `lib/<abi>/` layout every APK uses.
 *
 * An EMPTY RESULT MEANS "pure bytecode, runs anywhere" and is the common case — most apps ship no
 * native libraries at all. It must never be confused with "runs nowhere", which is why the caller
 * checks for a non-empty list before refusing anything.
 *
 * Split APKs are a known gap and are called out rather than guessed at: an `abi` split ships each
 * ABI as a SEPARATE file, so a base.apk read on its own reports no native code and this preflight
 * has nothing to say about it. It catches the universal APK, which is what gets uploaded by hand.
 */
export function nativeAbisOf(entries: { name: string }[]): string[] {
  const abis = new Set<string>();
  for (const e of entries) {
    // `lib/arm64-v8a/libfoo.so` — exactly three segments, and the last must be a file. A directory
    // entry (`lib/arm64-v8a/`) carries no code and is not evidence of anything.
    const m = /^lib\/([^/]+)\/[^/]+$/.exec(e.name);
    if (m) abis.add(m[1]);
  }
  return [...abis].sort();
}

/**
 * One entry out of an APK, inflated.
 *
 * Split out of `extractManifest` when `resources.arsc` became a second thing worth reading. Takes
 * an open handle rather than a path so a caller wanting both files opens the archive once — this is
 * on the upload path for a build that can be a quarter of a gigabyte.
 *
 * Returns null for an entry that is not there, and THROWS for one that is there and unreadable.
 * The distinction carries the whole policy: an APK with no `resources.arsc` is an ordinary APK with
 * no resources, while an `AndroidManifest.xml` that will not inflate is a corrupt upload.
 */
async function extractEntry(
  fh: FileHandle,
  entries: ZipEntry[],
  wanted: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const entry = entries.find((e) => e.name === wanted);
  if (!entry) return null;

  const { method, compressedSize, uncompressedSize, localOffset } = entry;
  if (uncompressedSize > maxBytes || compressedSize > maxBytes) {
    throw new ApkParseError(`${wanted} claims ${uncompressedSize} bytes; refusing to inflate it.`);
  }
  // The local header repeats the name and carries its OWN extra field, which is routinely a
  // different length from the central one (alignment padding). Reading the central directory's
  // extraLen here lands mid-file and inflates garbage.
  const local = await readAt(fh, localOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ApkParseError(`Corrupt archive: ${wanted} has a bad local header.`);
  }
  const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const raw = await readAt(fh, dataStart, compressedSize);
  if (method === 0) return raw;
  if (method !== 8) throw new ApkParseError(`${wanted} uses zip method ${method}; only stored and deflate are supported.`);
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (e) {
    throw new ApkParseError(`${wanted} could not be inflated: ${(e as Error).message}`);
  }
}

export async function extractManifest(apkPath: string): Promise<Buffer> {
  const fh = await open(apkPath, 'r');
  try {
    const buf = await extractEntry(fh, await readCentralDirectory(fh), MANIFEST_NAME, MAX_MANIFEST_BYTES);
    if (!buf) throw new ApkParseError('No AndroidManifest.xml in the archive. This is a zip, but not an APK.');
    return buf;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- binary XML

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;

const UTF8_FLAG = 1 << 8;

/** Res_value dataTypes we can render. Everything else is reported as unresolvable rather than guessed. */
const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_FIRST = 0x10;
const TYPE_INT_LAST = 0x1f;

/**
 * The framework attribute ids we care about, as a fallback for when the name string is absent.
 *
 * Names are present in anything aapt2 produces, but an obfuscated or hand-built manifest can leave
 * the string pool entry empty and identify an attribute only by its resource id through the
 * RESOURCE_MAP chunk. Matching on both means the parser reads the manifests that exist, not the
 * ones the format guarantees.
 */
const ATTR_LABEL = 0x01010001;
const ATTR_MIN_SDK = 0x0101020c;
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

interface StringPool {
  get(index: number): string | null;
}

function parseStringPool(buf: Buffer, start: number): StringPool {
  const headerSize = buf.readUInt16LE(start + 2);
  const stringCount = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const offsetsAt = start + headerSize;
  const dataAt = start + stringsStart;

  // Decoded lazily and memoised: a manifest's pool holds every attribute value in the document and
  // this reads four of them.
  const cache = new Map<number, string | null>();

  const decodeAt = (at: number): string | null => {
    if (utf8) {
      // Two lengths, each a varint of 1 or 2 bytes: character count, then BYTE count. The second is
      // the one that matters — the first is not a byte length for anything outside the BMP.
      let p = at;
      const skipLen = () => { const v = buf.readUInt8(p); p += (v & 0x80) !== 0 ? 2 : 1; };
      skipLen();
      let byteLen = buf.readUInt8(p);
      if ((byteLen & 0x80) !== 0) { byteLen = ((byteLen & 0x7f) << 8) | buf.readUInt8(p + 1); p += 2; }
      else p += 1;
      if (p + byteLen > buf.length) return null;
      return buf.subarray(p, p + byteLen).toString('utf8');
    }
    let len = buf.readUInt16LE(at);
    let p = at + 2;
    if ((len & 0x8000) !== 0) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
    if (p + len * 2 > buf.length) return null;
    return buf.subarray(p, p + len * 2).toString('utf16le');
  };

  return {
    get(index: number): string | null {
      if (index < 0 || index >= stringCount) return null;
      if (cache.has(index)) return cache.get(index)!;
      let value: string | null = null;
      try {
        value = decodeAt(dataAt + buf.readUInt32LE(offsetsAt + index * 4));
      } catch {
        value = null; // a malformed pool entry is a missing attribute, never a crash
      }
      cache.set(index, value);
      return value;
    },
  };
}

/* ---------------------------------------------------------------- resources.arsc */

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;

/** `ResTable_entry::flags` — a complex entry is a bag (a style, an array), not a single value. */
const ENTRY_FLAG_COMPLEX = 0x0001;

/** A missing entry in a type's offset array. */
const NO_ENTRY = 0xffffffff;

/**
 * Resolve `@0x7f130023` to the string it names — the reason apps have names instead of package ids.
 *
 * WHY THIS EXISTS AT ALL. `android:label` in a real app is almost never a literal; it is
 * `@string/app_name`, a TYPE_REFERENCE into this table. `stringOf` answers null for a reference and
 * says why: rendering `@0x7f130023` would put a number nobody can use into the library. That was
 * the right call, but it meant EVERY normally-built app displayed as `com.example.thing`, which is
 * what a database row looks like rather than what a product looks like.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not resolve the caller's locale, follow a reference
 * whose value is itself a reference, or read bags. It answers the DEFAULT configuration's string
 * and nothing else, because that is the one an app's name is written in and because every further
 * step is a new way to be subtly wrong about somebody's product name.
 *
 * Answers null for anything it cannot resolve confidently. Null is already a state every caller
 * handles — it is what shipped before this function existed — so a resource table this parser does
 * not understand costs a nice-to-have and never an upload.
 */
function resolveStringResource(buf: Buffer, resourceId: number): string | null {
  if (buf.length < 12 || buf.readUInt16LE(0) !== RES_TABLE_TYPE) return null;

  const wantPackage = (resourceId >>> 24) & 0xff;
  const wantType = (resourceId >>> 16) & 0xff;
  const wantEntry = resourceId & 0xffff;
  if (wantPackage === 0 || wantType === 0) return null;

  const headerSize = buf.readUInt16LE(2);
  let globalPool: StringPool | undefined;

  // The table's own chunks: one global string pool, then one chunk per package.
  let p = headerSize;
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const chunkHeader = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;

    if (type === RES_STRING_POOL_TYPE && !globalPool) {
      globalPool = parseStringPool(buf, p);
    } else if (type === RES_TABLE_PACKAGE_TYPE) {
      const packageId = buf.readUInt32LE(p + 8);
      if ((packageId & 0xff) === wantPackage && globalPool) {
        const hit = findEntryInPackage(buf, p, chunkHeader, size, wantType, wantEntry, globalPool);
        if (hit !== null) return hit;
      }
    }
    p += size;
  }
  return null;
}

/**
 * Walk one package's type chunks for the entry, preferring the DEFAULT configuration.
 *
 * A type appears once per configuration an app ships — `values/`, `values-fr/`, `values-ar/` and so
 * on — so the same entry index exists many times with different strings. The default one is the
 * app's real name; the others are translations of it. Picking the first match would hand back
 * whichever locale happened to be laid out first, which on a heavily localised app is effectively
 * random. Recorded because it is a bug that would look like a typo in somebody's product name.
 */
function findEntryInPackage(
  buf: Buffer,
  packageStart: number,
  packageHeaderSize: number,
  packageSize: number,
  wantType: number,
  wantEntry: number,
  pool: StringPool,
): string | null {
  let fallback: string | null = null;
  let p = packageStart + packageHeaderSize;
  const end = packageStart + packageSize;

  while (p + 8 <= end) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > end) break;

    if (type === RES_TABLE_TYPE_TYPE && buf.readUInt8(p + 8) === wantType) {
      const entryCount = buf.readUInt32LE(p + 12);
      const entriesStart = buf.readUInt32LE(p + 16);

      if (wantEntry < entryCount) {
        const offsetAt = p + headerSize + wantEntry * 4;
        if (offsetAt + 4 <= p + size) {
          const offset = buf.readUInt32LE(offsetAt);
          if (offset !== NO_ENTRY) {
            const value = readEntryValue(buf, p + entriesStart + offset, p + size, pool);
            if (value !== null) {
              // `ResTable_config::size` is at the start of the config struct, which follows the
              // 20-byte type header. A config whose bytes past that size field are all zero is the
              // DEFAULT one — no locale, no density, no qualifier of any kind.
              const configAt = p + 20;
              const configSize = configAt + 4 <= p + size ? buf.readUInt32LE(configAt) : 0;
              const isDefault = configSize > 0
                && configAt + configSize <= p + size
                && buf.subarray(configAt + 4, configAt + configSize).every((b) => b === 0);
              if (isDefault) return value;
              fallback ??= value;
            }
          }
        }
      }
    }
    p += size;
  }
  // No default configuration carried this entry. A translation is a better answer than a package
  // name, so the first one found is used rather than discarded.
  return fallback;
}

/** One `ResTable_entry` + its `Res_value`, when that value is a plain string. */
function readEntryValue(buf: Buffer, at: number, limit: number, pool: StringPool): string | null {
  if (at + 8 > limit) return null;
  const entrySize = buf.readUInt16LE(at);
  const flags = buf.readUInt16LE(at + 2);
  // A bag has no single value to read, and an app label is never one.
  if ((flags & ENTRY_FLAG_COMPLEX) !== 0) return null;

  const valueAt = at + entrySize;
  if (valueAt + 8 > limit) return null;
  const dataType = buf.readUInt8(valueAt + 3);
  const data = buf.readUInt32LE(valueAt + 4);
  if (dataType !== TYPE_STRING) return null;
  const s = pool.get(data);
  return s && s.trim() ? s : null;
}

interface RawAttribute {
  name: string | null;
  resourceId: number | null;
  dataType: number;
  data: number;
  rawValue: number;
}

/**
 * Parse the four facts we need out of a binary AndroidManifest.xml.
 *
 * Exported separately from `extractManifest` so it can be tested on a manifest alone, and so a
 * caller that already has the bytes (a future `mfarm app inspect`) does not have to go through a
 * file on disk.
 */
export function parseManifest(buf: Buffer): ParsedManifest {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new ApkParseError('AndroidManifest.xml is not Android binary XML. A plain-text manifest means this is a source tree, not a built APK.');
  }

  let pool: StringPool | undefined;
  let labelRef: number | null = null;
  let resourceMap: number[] = [];
  let result: ManifestMetadata | undefined;

  // Walk the top-level chunks. The string pool always precedes the elements that index into it, and
  // the resource map precedes them too, so a single forward pass is enough.
  let p = buf.readUInt16LE(2); // first chunk starts after the file header
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    // A zero or nonsensical size would spin this loop forever on a malformed file.
    if (size < 8 || p + size > buf.length) break;

    if (type === RES_STRING_POOL_TYPE) {
      pool = parseStringPool(buf, p);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const count = (size - headerSize) >> 2;
      resourceMap = new Array(count);
      for (let i = 0; i < count; i++) resourceMap[i] = buf.readUInt32LE(p + headerSize + i * 4);
    } else if (type === RES_XML_START_ELEMENT_TYPE && pool) {
      const ext = p + headerSize;
      const nameIndex = buf.readUInt32LE(ext + 4);
      const elementName = pool.get(nameIndex);
      const attrs = readAttributes(buf, p, headerSize, pool, resourceMap);

      if (elementName === 'manifest' && !result) {
        result = fromManifestElement(attrs, pool);
      } else if (elementName === 'uses-sdk' && result && result.minSdk === null) {
        const v = pick(attrs, 'minSdkVersion', ATTR_MIN_SDK);
        result.minSdk = v ? intOf(v, pool) : null;
      } else if (elementName === 'application' && result && result.label === null) {
        const v = pick(attrs, 'label', ATTR_LABEL);
        result.label = v ? stringOf(v, pool) : null;
        // A reference is not a failure — it is the NORMAL case, and the id is the only thing that
        // can find the real name in `resources.arsc`. Reported so `readApkMetadata` can resolve it;
        // the manifest alone genuinely cannot.
        if (v && v.dataType === TYPE_REFERENCE && v.data) labelRef = v.data;
        // The manifest element is the last thing worth reading; once application's label is in,
        // everything after it is activities and permissions.
      }
    }
    p += size;
  }

  if (!result) {
    throw new ApkParseError('AndroidManifest.xml has no <manifest> element with a package name.');
  }
  return { ...result, labelRef };
}

function readAttributes(
  buf: Buffer,
  node: number,
  headerSize: number,
  pool: StringPool,
  resourceMap: number[],
): RawAttribute[] {
  const ext = node + headerSize;
  const attributeStart = buf.readUInt16LE(ext + 8);
  const attributeSize = buf.readUInt16LE(ext + 10);
  const attributeCount = buf.readUInt16LE(ext + 12);
  const attrs: RawAttribute[] = [];

  for (let i = 0; i < attributeCount; i++) {
    // `attributeStart` is relative to the extended header, and `attributeSize` is the stride — both
    // are read from the file rather than assumed at 20 bytes, because a newer aapt may grow the
    // struct and a hardcoded stride would silently read the wrong fields rather than fail.
    const a = ext + attributeStart + i * attributeSize;
    if (a + 20 > buf.length) break;
    const nameIndex = buf.readUInt32LE(a + 4);
    attrs.push({
      name: pool.get(nameIndex),
      resourceId: nameIndex < resourceMap.length ? resourceMap[nameIndex]! : null,
      rawValue: buf.readInt32LE(a + 8),
      dataType: buf.readUInt8(a + 15),
      data: buf.readInt32LE(a + 16),
    });
  }
  return attrs;
}

function pick(attrs: RawAttribute[], name: string, resourceId: number): RawAttribute | undefined {
  return attrs.find((a) => a.name === name) ?? attrs.find((a) => a.resourceId === resourceId);
}

function fromManifestElement(attrs: RawAttribute[], pool: StringPool): ManifestMetadata {
  // `package` is a plain attribute with no android: namespace and no resource id, so there is no
  // id fallback for it — which is fine, because aapt has never emitted it without a name.
  const pkgAttr = attrs.find((a) => a.name === 'package');
  const packageName = pkgAttr ? stringOf(pkgAttr, pool) : null;
  if (!packageName) {
    throw new ApkParseError('AndroidManifest.xml declares no package name.');
  }
  // Validated at the DOOR, because this string comes out of a file a stranger uploaded and then
  // travels to an adb argument, a database column and a UI. Nothing downstream builds a shell
  // command — every adb call passes argv — so this is not the thing standing between us and
  // injection; it is the thing that keeps a value which is not a package name from being treated
  // as one three layers away, where the check would have to be repeated or assumed.
  if (!isValidPackageName(packageName)) {
    throw new ApkParseError(`"${packageName.slice(0, 64)}" is not a valid Android package name.`);
  }

  const codeAttr = pick(attrs, 'versionCode', ATTR_VERSION_CODE);
  const nameAttr = pick(attrs, 'versionName', ATTR_VERSION_NAME);
  return {
    packageName,
    versionCode: codeAttr ? intOf(codeAttr, pool) : null,
    versionName: nameAttr ? stringOf(nameAttr, pool) : null,
    minSdk: null,
    label: null,
  };
}

/**
 * A string value, or null.
 *
 * Null covers the case that actually happens: `android:versionName="@string/version"`, a RESOURCE
 * reference into resources.arsc. Rendering it as `@0x7f0e0042` would put a number nobody can use
 * into the library UI and into `version_name`; null is the honest answer, and a caller that needs
 * the real value has to resolve the resource table, which this parser deliberately does not do.
 */
function stringOf(a: RawAttribute, pool: StringPool): string | null {
  if (a.dataType === TYPE_STRING) return pool.get(a.data);
  if (a.dataType >= TYPE_INT_FIRST && a.dataType <= TYPE_INT_LAST) return String(a.data);
  // Some writers leave the typed value empty and put everything in rawValue.
  if (a.dataType === TYPE_REFERENCE) return null;
  return a.rawValue >= 0 ? pool.get(a.rawValue) : null;
}

/**
 * An integer value, or null.
 *
 * The string branch is not theoretical: `android:versionCode="7"` written into the manifest by hand
 * survives aapt as a TYPE_STRING, and `a.data` is then a POOL INDEX rather than the number — which
 * is exactly the mistake worth naming, because reading it as the value yields a plausible small
 * integer that is silently wrong.
 */
function intOf(a: RawAttribute, pool: StringPool): number | null {
  if (a.dataType >= TYPE_INT_FIRST && a.dataType <= TYPE_INT_LAST) return a.data;
  if (a.dataType === TYPE_STRING) {
    const n = Number(pool.get(a.data));
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------- entry point

export async function readApkMetadata(apkPath: string): Promise<ApkMetadata> {
  const fh = await open(apkPath, 'r');
  try {
    const entries = await readCentralDirectory(fh);
    const manifestBuf = await extractEntry(fh, entries, MANIFEST_NAME, MAX_MANIFEST_BYTES);
    if (!manifestBuf) {
      throw new ApkParseError('No AndroidManifest.xml in the archive. This is a zip, but not an APK.');
    }
    const { labelRef, ...meta } = parseManifest(manifestBuf);

    /**
     * Resolve the app's real name, and NEVER fail the upload over it.
     *
     * A name is a nicety; a build the tester cannot install is not. So every failure here — no
     * resource table, a table this parser does not understand, a reference that resolves to a bag —
     * lands on `label: null`, which is exactly the state that shipped before this existed and which
     * every caller already renders (the console falls back to the package name).
     *
     * Only read when there IS a reference to chase. An app with a literal label costs nothing, and
     * on a 272 MB build this skips inflating a resource table for no reason.
     */
    let label = meta.label;
    if (label === null && labelRef !== null) {
      try {
        const arsc = await extractEntry(fh, entries, ARSC_NAME, MAX_ARSC_BYTES);
        if (arsc) label = resolveStringResource(arsc, labelRef);
      } catch {
        label = null;
      }
    }

    return { ...meta, label, abis: nativeAbisOf(entries) };
  } finally {
    await fh.close();
  }
}

/**
 * Why an APK cannot run on a device, when the reason is its native code — or null when it can.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. Every virtual device in this farm executes x86_64, and most
 * real APKs ship arm64-only native libraries. Without this check the first such upload dies inside
 * `adb install` with `INSTALL_FAILED_NO_MATCHING_ABIS`, which names a constraint of the runtime in
 * the vocabulary of a package manager and leaves the customer to work out that the farm, not their
 * build, is the thing that cannot do this.
 *
 * IT WAS WRITTEN FOR A SHARPER VERSION OF THAT PROBLEM and outlived it. Until ADR-0017 two devices
 * reported a Samsung `Build.MODEL` while executing x86_64 — so an arm64 APK failed on a device
 * calling itself the exact phone the customer builds for, and this preflight was the whole
 * justification for claiming that name. The name is gone; the ABI wall is not, because it was never
 * caused by the name. An MFARM X1 Pro is honestly a virtual x86_64 device, and this function is what
 * lets it say so at the moment it matters.
 *
 * BOTH UNKNOWNS MEAN "ALLOW", and for the same reason: this is a preflight that turns one specific
 * known-impossible install into a clear sentence. It is not an authority on what can run. A device
 * whose worker never reported its ABIs, and an APK with no native code, both fall through to the
 * behaviour that existed before this function did — try it and find out.
 */
export function abiMismatchReason(
  apk: Pick<ApkMetadata, 'abis'>,
  device: { abis?: string[] | null; model?: string | null },
): string | null {
  const deviceAbis = device.abis ?? [];
  if (apk.abis.length === 0 || deviceAbis.length === 0) return null;
  if (apk.abis.some((a) => deviceAbis.includes(a))) return null;
  // Names the device's model as well as its ABIs, because on a profiled device the model is exactly
  // what made the reader expect this to work.
  return `This build ships native code for ${apk.abis.join(', ')} only. `
    + `${device.model || 'This device'} executes ${deviceAbis.join(', ')}, so Android will refuse to install it. `
    + 'Upload a build that includes one of the device ABIs, or run it on a device with a matching architecture.';
}
