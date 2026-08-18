import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

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
}

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
export async function extractManifest(apkPath: string): Promise<Buffer> {
  const fh = await open(apkPath, 'r');
  try {
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
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
        throw new ApkParseError('Corrupt archive: central directory entry has a bad signature.');
      }
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      if (name === MANIFEST_NAME) {
        if (uncompressedSize > MAX_MANIFEST_BYTES || compressedSize > MAX_MANIFEST_BYTES) {
          throw new ApkParseError(`AndroidManifest.xml claims ${uncompressedSize} bytes; refusing to inflate it.`);
        }
        // The local header repeats the name and carries its OWN extra field, which is routinely a
        // different length from the central one (alignment padding). Reading the central directory's
        // extraLen here lands mid-file and inflates garbage.
        const local = await readAt(fh, localOffset, 30);
        if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
          throw new ApkParseError('Corrupt archive: AndroidManifest.xml has a bad local header.');
        }
        const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const raw = await readAt(fh, dataStart, compressedSize);
        if (method === 0) return raw;
        if (method !== 8) throw new ApkParseError(`AndroidManifest.xml uses zip method ${method}; only stored and deflate are supported.`);
        try {
          return inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });
        } catch (e) {
          throw new ApkParseError(`AndroidManifest.xml could not be inflated: ${(e as Error).message}`);
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new ApkParseError('No AndroidManifest.xml in the archive. This is a zip, but not an APK.');
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
export function parseManifest(buf: Buffer): ApkMetadata {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new ApkParseError('AndroidManifest.xml is not Android binary XML. A plain-text manifest means this is a source tree, not a built APK.');
  }

  let pool: StringPool | undefined;
  let resourceMap: number[] = [];
  let result: ApkMetadata | undefined;

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
        // The manifest element is the last thing worth reading; once application's label is in,
        // everything after it is activities and permissions.
      }
    }
    p += size;
  }

  if (!result) {
    throw new ApkParseError('AndroidManifest.xml has no <manifest> element with a package name.');
  }
  return result;
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

function fromManifestElement(attrs: RawAttribute[], pool: StringPool): ApkMetadata {
  // `package` is a plain attribute with no android: namespace and no resource id, so there is no
  // id fallback for it — which is fine, because aapt has never emitted it without a name.
  const pkgAttr = attrs.find((a) => a.name === 'package');
  const packageName = pkgAttr ? stringOf(pkgAttr, pool) : null;
  if (!packageName) {
    throw new ApkParseError('AndroidManifest.xml declares no package name.');
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
  return parseManifest(await extractManifest(apkPath));
}
