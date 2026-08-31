import { deflateRawSync } from 'node:zlib';

/**
 * Build a real APK — a real zip, holding a real binary AndroidManifest.xml — in memory.
 *
 * A checked-in .apk fixture would be a megabyte of opaque binary nobody can review, tied to
 * whatever aapt built it, and unable to express the cases that actually matter here: a UTF-8 string
 * pool versus a UTF-16 one, a versionName that is a resource reference rather than a literal, a
 * manifest that identifies its attributes only by resource id. Generating it means each of those is
 * one argument.
 *
 * This is a WRITER for the same two formats `src/apk.ts` reads, which is the property that makes the
 * pair worth having: a test that round-trips through an independently written encoder catches a
 * parser that agrees with itself and with nothing else. The encoder follows AOSP's
 * `ResourceTypes.h` — the same document the parser was written from, which is the honest limit of
 * how independent the two can be.
 */

// ---------------------------------------------------------------- binary XML

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;

const UTF8_FLAG = 1 << 8;

export const TYPE_REFERENCE = 0x01;
export const TYPE_STRING = 0x03;
export const TYPE_INT_DEC = 0x10;

export interface AttrSpec {
  /** Pool string for the attribute name. Pass '' to force the parser onto its resource-id path. */
  name: string;
  /** Entry in the resource map for this name index, or 0 for none. */
  resourceId?: number;
  type: number;
  /** A string for TYPE_STRING (pooled automatically), a number for everything else. */
  value: string | number;
}

export interface ElementSpec {
  name: string;
  attrs: AttrSpec[];
}

class Pool {
  private readonly strings: string[] = [];

  /**
   * Interning is not an optimisation here: an attribute's name index is also its resource-map index.
   *
   * The empty string is the exception and is never deduplicated. A manifest that identifies its
   * attributes only by resource id has SEVERAL empty name entries — one per attribute, each at its
   * own index — and collapsing them into one would give every such attribute the same resource id,
   * which is the opposite of the case being fixtured.
   */
  intern(s: string): number {
    if (s !== '') {
      const at = this.strings.indexOf(s);
      if (at !== -1) return at;
    }
    this.strings.push(s);
    return this.strings.length - 1;
  }

  get size(): number { return this.strings.length; }

  encode(utf8: boolean): Buffer {
    const bodies = this.strings.map((s) => (utf8 ? encodeUtf8String(s) : encodeUtf16String(s)));
    const offsets = Buffer.alloc(this.strings.length * 4);
    let cursor = 0;
    bodies.forEach((b, i) => { offsets.writeUInt32LE(cursor, i * 4); cursor += b.length; });

    let data = Buffer.concat(bodies);
    // Chunks are 4-byte aligned. A pool that is not leaves every chunk after it misaligned, and the
    // parser walks to a type field that is half of something else.
    if (data.length % 4 !== 0) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);

    const headerSize = 28;
    const stringsStart = headerSize + offsets.length;
    const size = stringsStart + data.length;

    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(size, 4);
    header.writeUInt32LE(this.strings.length, 8);
    header.writeUInt32LE(0, 12);                       // styleCount
    header.writeUInt32LE(utf8 ? UTF8_FLAG : 0, 16);
    header.writeUInt32LE(stringsStart, 20);
    header.writeUInt32LE(0, 24);                       // stylesStart
    return Buffer.concat([header, offsets, data]);
  }
}

function encodeUtf16String(s: string): Buffer {
  const chars = Buffer.from(s, 'utf16le');
  const out = Buffer.alloc(2 + chars.length + 2);
  out.writeUInt16LE(s.length, 0);
  chars.copy(out, 2);
  out.writeUInt16LE(0, 2 + chars.length);              // NUL terminator
  return out;
}

function encodeUtf8String(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  // Single-byte lengths only: every string these fixtures use is far below the 0x80 threshold that
  // would need the two-byte form.
  const out = Buffer.alloc(2 + bytes.length + 1);
  out.writeUInt8(s.length, 0);
  out.writeUInt8(bytes.length, 1);
  bytes.copy(out, 2);
  out.writeUInt8(0, 2 + bytes.length);
  return out;
}

export interface ManifestOptions {
  /** UTF-8 string pool rather than UTF-16. aapt2 emits both depending on version and content. */
  utf8?: boolean;
  /** Emit the RESOURCE_MAP chunk. Without it, an attribute with an empty name is unidentifiable. */
  resourceMap?: boolean;
}

/** Encode a document as Android binary XML. */
export function encodeBinaryXml(elements: ElementSpec[], opts: ManifestOptions = {}): Buffer {
  const pool = new Pool();
  // The resource map is indexed BY name-string index, so every attribute name has to be interned
  // before any other string or the map lands on the wrong entries. aapt does the same.
  //
  // The index is recorded per attribute rather than looked up again later: with anonymous
  // attributes the name is '', which the pool deliberately does not deduplicate, so a second
  // `intern('')` would allocate a second entry and the node would point at the wrong one.
  const nameIndex = new Map<AttrSpec, number>();
  const resourceIds: number[] = [];
  for (const el of elements) {
    for (const a of el.attrs) {
      const idx = pool.intern(a.name);
      nameIndex.set(a, idx);
      while (resourceIds.length <= idx) resourceIds.push(0);
      if (a.resourceId) resourceIds[idx] = a.resourceId;
    }
  }
  for (const el of elements) pool.intern(el.name);
  for (const el of elements) {
    for (const a of el.attrs) if (a.type === TYPE_STRING) pool.intern(String(a.value));
  }

  const chunks: Buffer[] = [pool.encode(opts.utf8 === true)];

  if (opts.resourceMap !== false && resourceIds.length > 0) {
    const map = Buffer.alloc(8 + resourceIds.length * 4);
    map.writeUInt16LE(RES_XML_RESOURCE_MAP_TYPE, 0);
    map.writeUInt16LE(8, 2);
    map.writeUInt32LE(map.length, 4);
    resourceIds.forEach((id, i) => map.writeUInt32LE(id, 8 + i * 4));
    chunks.push(map);
  }

  for (const el of elements) {
    const attrSize = 20;
    const node = Buffer.alloc(16 + 20 + el.attrs.length * attrSize);
    node.writeUInt16LE(RES_XML_START_ELEMENT_TYPE, 0);
    node.writeUInt16LE(16, 2);                          // headerSize
    node.writeUInt32LE(node.length, 4);
    node.writeUInt32LE(1, 8);                           // lineNumber
    node.writeInt32LE(-1, 12);                          // comment
    node.writeInt32LE(-1, 16);                          // ns
    node.writeUInt32LE(pool.intern(el.name), 20);       // name
    node.writeUInt16LE(20, 24);                         // attributeStart, from the ext header
    node.writeUInt16LE(attrSize, 26);
    node.writeUInt16LE(el.attrs.length, 28);
    node.writeUInt16LE(0, 30);                          // idIndex
    node.writeUInt16LE(0, 32);                          // classIndex
    node.writeUInt16LE(0, 34);                          // styleIndex

    el.attrs.forEach((a, i) => {
      const at = 36 + i * attrSize;
      node.writeInt32LE(-1, at);                        // ns
      node.writeUInt32LE(nameIndex.get(a)!, at + 4);     // name
      const data = a.type === TYPE_STRING ? pool.intern(String(a.value)) : Number(a.value);
      node.writeInt32LE(a.type === TYPE_STRING ? data : -1, at + 8); // rawValue
      node.writeUInt16LE(8, at + 12);                   // Res_value.size
      node.writeUInt8(0, at + 14);                      // res0
      node.writeUInt8(a.type, at + 15);
      node.writeInt32LE(data, at + 16);
    });
    chunks.push(node);

    const end = Buffer.alloc(24);
    end.writeUInt16LE(RES_XML_END_ELEMENT_TYPE, 0);
    end.writeUInt16LE(16, 2);
    end.writeUInt32LE(24, 4);
    end.writeUInt32LE(1, 8);
    end.writeInt32LE(-1, 12);
    end.writeInt32LE(-1, 16);
    end.writeUInt32LE(pool.intern(el.name), 20);
    chunks.push(end);
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export interface ApkOptions extends ManifestOptions {
  packageName?: string;
  versionCode?: number;
  versionName?: string | null;
  /** versionName as a resource reference (`@string/…`), which is common and unresolvable. */
  versionNameAsReference?: boolean;
  /**
   * `android:label="@string/app_name"` — a resource reference, which is what a NORMALLY BUILT app
   * has. The literal label the other option produces is the rare case.
   */
  labelAsReference?: number;
  /** The string that reference resolves to, written into a real `resources.arsc`. */
  labelResourceValue?: string;
  /** Emit the reference but NO resource table, so resolution has to fail gracefully. */
  omitArsc?: boolean;
  minSdk?: number;
  label?: string;
  /** Name attributes by resource id only, with empty name strings. */
  anonymousAttributes?: boolean;
  /** Store the manifest uncompressed. Both are legal and both occur in the wild. */
  stored?: boolean;
  /** Extra padding entry, so the manifest is not the only member of the archive. */
  padBytes?: number;
  /**
   * Native libraries to ship, as ABI directory names — `['arm64-v8a']`.
   *
   * Written as real `lib/<abi>/libnative.so` members, because that layout IS the thing the ABI
   * preflight reads. An option that injected a metadata field instead would test the parser against
   * a fiction and pass while the real reader found nothing.
   */
  abis?: string[];
}

export function buildManifest(opts: ApkOptions = {}): Buffer {
  const anon = opts.anonymousAttributes === true;
  const name = (real: string) => (anon ? '' : real);

  const manifestAttrs: AttrSpec[] = [
    // `package` has no resource id in the framework, so it is never anonymous — this is why the
    // parser has no id fallback for it.
    { name: 'package', type: TYPE_STRING, value: opts.packageName ?? 'com.example.mfarm' },
    { name: name('versionCode'), resourceId: 0x0101021b, type: TYPE_INT_DEC, value: opts.versionCode ?? 42 },
  ];
  if (opts.versionNameAsReference) {
    manifestAttrs.push({ name: name('versionName'), resourceId: 0x0101021c, type: TYPE_REFERENCE, value: 0x7f0e0042 });
  } else if (opts.versionName !== null) {
    manifestAttrs.push({ name: name('versionName'), resourceId: 0x0101021c, type: TYPE_STRING, value: opts.versionName ?? '1.4.2' });
  }

  const elements: ElementSpec[] = [
    { name: 'manifest', attrs: manifestAttrs },
    { name: 'uses-sdk', attrs: [{ name: name('minSdkVersion'), resourceId: 0x0101020c, type: TYPE_INT_DEC, value: opts.minSdk ?? 26 }] },
    { name: 'application', attrs: [opts.labelAsReference
      ? { name: name('label'), resourceId: 0x01010001, type: TYPE_REFERENCE, value: opts.labelAsReference }
      : { name: name('label'), resourceId: 0x01010001, type: TYPE_STRING, value: opts.label ?? 'MFarm Example' }] },
  ];
  return encodeBinaryXml(elements, opts);
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  content: Buffer;
  stored?: boolean;
  /**
   * Extra bytes in the LOCAL header only.
   *
   * The whole reason this option exists: zipalign pads local extra fields and leaves the central
   * directory's alone, so the two lengths differ in every real APK. A reader that uses the central
   * value to find the local data lands mid-file — which is the single easiest way to get this
   * parser wrong, and it fails only on real APKs, never on a fixture that pads neither.
   */
  localExtra?: number;
}

export function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const stored = e.stored === true;
    const data = stored ? e.content : deflateRawSync(e.content);
    const extra = Buffer.alloc(e.localExtra ?? 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                        // version needed
    local.writeUInt16LE(0, 6);                         // flags
    local.writeUInt16LE(stored ? 0 : 8, 8);            // method
    local.writeUInt16LE(0, 10);                        // time
    local.writeUInt16LE(0, 12);                        // date
    local.writeUInt32LE(crc32(e.content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, nameBytes, extra, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(e.content), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);                      // extra length: deliberately NOT the local one
    central.writeUInt16LE(0, 32);                      // comment length
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + extra.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * A complete, parseable APK.
 *
 * `padBytes` pads a second entry so two calls with the same manifest can still produce different
 * bytes — which is what a test of "same digest deduplicates, different digest does not" needs.
 */
/* ---------------------------------------------------------------- resources.arsc */

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;

/**
 * A real `resources.arsc` holding ONE string, addressable by resource id.
 *
 * Minimal but STRUCTURALLY HONEST — it is a table the production parser walks the same way it walks
 * Play Store output, not a stub shaped to whatever the parser happens to read. That distinction is
 * the whole value: a fixture that skips the package header, or writes a config block the parser
 * never validates, would pass while the real reader found nothing.
 *
 * `config` is 64 zero bytes after its own size field, which is what makes this the DEFAULT
 * configuration — the one an app's real name lives in, as opposed to a translation.
 */
export function buildArsc(opts: {
  resourceId: number;
  value: string;
  /** Emit a non-default config (a locale), to prove the default is the one preferred. */
  locale?: string;
} = { resourceId: 0x7f130023, value: 'Fixture App' }): Buffer {
  const typeId = (opts.resourceId >>> 16) & 0xff;
  const entryIndex = opts.resourceId & 0xffff;
  const packageId = (opts.resourceId >>> 24) & 0xff;

  const globalPool = new Pool();
  const valueIndex = globalPool.intern(opts.value);
  const globals = globalPool.encode(true);

  // --- one type chunk: header, config, offsets, entries -----------------------------------
  const CONFIG_SIZE = 64;
  const config = Buffer.alloc(CONFIG_SIZE);
  config.writeUInt32LE(CONFIG_SIZE, 0);
  if (opts.locale) {
    // language[2] sits at offset 8 in ResTable_config. Any non-zero byte past the size field is
    // what makes this NOT the default configuration.
    config.write(opts.locale.slice(0, 2), 8, 'ascii');
  }

  const entryCount = entryIndex + 1;
  const offsets = Buffer.alloc(entryCount * 4);
  for (let i = 0; i < entryCount; i++) offsets.writeUInt32LE(0xffffffff, i * 4); // NO_ENTRY
  offsets.writeUInt32LE(0, entryIndex * 4);

  // ResTable_entry (8 bytes: size, flags, key) followed by Res_value (8 bytes).
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(8, 0);            // entry size — where the Res_value starts
  entry.writeUInt16LE(0, 2);            // flags: not complex
  entry.writeUInt32LE(0, 4);            // key index
  entry.writeUInt16LE(8, 8);            // Res_value size
  entry.writeUInt8(0, 10);              // res0
  entry.writeUInt8(0x03, 11);           // TYPE_STRING
  entry.writeUInt32LE(valueIndex, 12);

  const typeHeaderSize = 20 + CONFIG_SIZE;
  const entriesStart = typeHeaderSize + offsets.length;
  const typeSize = entriesStart + entry.length;
  const typeHeader = Buffer.alloc(20);
  typeHeader.writeUInt16LE(RES_TABLE_TYPE_TYPE, 0);
  typeHeader.writeUInt16LE(typeHeaderSize, 2);
  typeHeader.writeUInt32LE(typeSize, 4);
  typeHeader.writeUInt8(typeId, 8);
  typeHeader.writeUInt32LE(entryCount, 12);
  typeHeader.writeUInt32LE(entriesStart, 16);
  const typeChunk = Buffer.concat([typeHeader, config, offsets, entry]);

  // --- the package chunk ------------------------------------------------------------------
  const PKG_HEADER = 288;
  const pkgHeader = Buffer.alloc(PKG_HEADER);
  pkgHeader.writeUInt16LE(RES_TABLE_PACKAGE_TYPE, 0);
  pkgHeader.writeUInt16LE(PKG_HEADER, 2);
  pkgHeader.writeUInt32LE(PKG_HEADER + typeChunk.length, 4);
  pkgHeader.writeUInt32LE(packageId, 8);
  pkgHeader.write('fixture', 12, 'utf16le');
  const pkgChunk = Buffer.concat([pkgHeader, typeChunk]);

  // --- the table header -------------------------------------------------------------------
  const TABLE_HEADER = 12;
  const header = Buffer.alloc(TABLE_HEADER);
  header.writeUInt16LE(RES_TABLE_TYPE, 0);
  header.writeUInt16LE(TABLE_HEADER, 2);
  header.writeUInt32LE(TABLE_HEADER + globals.length + pkgChunk.length, 4);
  header.writeUInt32LE(1, 8); // packageCount

  return Buffer.concat([header, globals, pkgChunk]);
}

export function buildApk(opts: ApkOptions = {}): Buffer {
  return buildZip([
    // Local extra of 3 by default: every real APK's local and central extra lengths disagree.
    { name: 'AndroidManifest.xml', content: buildManifest(opts), stored: opts.stored, localExtra: 3 },
    { name: 'classes.dex', content: Buffer.alloc(opts.padBytes ?? 64, 0x7a) },
    ...(opts.labelAsReference && !opts.omitArsc
      ? [{ name: 'resources.arsc', content: buildArsc({
          resourceId: opts.labelAsReference,
          value: opts.labelResourceValue ?? 'Fixture App',
        }) }]
      : []),
    // A directory entry as well as the .so, because real archives carry both and the reader has to
    // ignore the directory — it holds no code and is not evidence that an ABI is supported.
    ...(opts.abis ?? []).flatMap((abi) => ([
      { name: `lib/${abi}/`, content: Buffer.alloc(0) },
      { name: `lib/${abi}/libnative.so`, content: Buffer.from(`native code for ${abi}`) },
    ])),
  ]);
}

/** A zip that is not an APK — no manifest at all. */
export function buildNonApkZip(): Buffer {
  return buildZip([{ name: 'readme.txt', content: Buffer.from('this is not an apk') }]);
}
