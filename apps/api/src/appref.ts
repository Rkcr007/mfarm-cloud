import type { PoolClient } from 'pg';

/**
 * Naming a build in the app library, in the three forms a person actually writes.
 *
 * The library has always been addressable by uuid, and a uuid is the right identity for a build —
 * it is exact, it survives a re-upload, and it is what `POST /v1/apps` hands back. It is also
 * unwritable by hand: `mfarm:appId: '9c3f...'` in a committed wdio.conf.js is a line nobody can
 * review, and a nightly that wants "whatever we built last night" cannot express it at all.
 *
 * So a reference is one of:
 *
 *   9c3f8e1a-...            a build id. Exact, and the only form that cannot drift.
 *   com.acme.app@1.4.2      a package coordinate pinned to a version_name.
 *   com.acme.app@latest     the newest build of that package this org has uploaded.
 *   com.acme.app            the same as @latest, because that is what a bare package name means
 *                           everywhere else a package manager reads one.
 *
 * The last two RESOLVE AT SESSION CREATION and are therefore not reproducible — the same suite run
 * twice can get two builds. That is the point of them, and it is why the resolved build id is
 * reported back on the session rather than left implicit.
 *
 * Resolution is per ORG and runs under the tenant's own RLS. There is no form of this reference
 * that can name another org's build, including the uuid one: `app_builds` is row-level scoped, so
 * another org's id resolves to nothing at all rather than to a permission error.
 */

/** A reference the caller wrote that cannot be parsed. Callers map this to their own error shape. */
export class AppRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRefError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Android's own rule, minus the parts nothing enforces: at least two segments, each starting with a
 * letter or underscore. The dot requirement is what makes a bare package name distinguishable from
 * a typo'd uuid, so it is load-bearing rather than cosmetic.
 */
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** `versionName` is a free-text field in the manifest; this only bounds it. */
const MAX_VERSION = 64;

export type AppRef =
  | { kind: 'id'; id: string }
  /** `versionName: null` means "the newest one", which is both `@latest` and a bare package name. */
  | { kind: 'package'; packageName: string; versionName: string | null };

export function parseAppRef(raw: string): AppRef {
  const ref = raw.trim();
  if (ref === '') throw new AppRefError('an app reference cannot be empty.');

  if (UUID.test(ref)) return { kind: 'id', id: ref.toLowerCase() };

  const at = ref.indexOf('@');
  if (at === -1) {
    if (!PACKAGE.test(ref)) throw new AppRefError(unparseable(ref));
    return { kind: 'package', packageName: ref, versionName: null };
  }

  const packageName = ref.slice(0, at);
  const version = ref.slice(at + 1);
  // A bare `@latest` is the one mistake worth naming precisely, because it is a reasonable thing to
  // try and because guessing which package it meant — the org's newest upload of anything — would
  // occasionally be right and would be a disaster the times it was not.
  if (packageName === '') {
    throw new AppRefError(
      `"${ref}" does not name a package. Write the package too — \`com.example.app@${version || 'latest'}\`.`,
    );
  }
  if (!PACKAGE.test(packageName)) throw new AppRefError(unparseable(ref));
  if (version === '') {
    throw new AppRefError(`"${ref}" ends in a bare "@". Use \`${packageName}@latest\`, or a version like \`${packageName}@1.4.2\`.`);
  }
  if (version.length > MAX_VERSION) {
    throw new AppRefError(`the version in "${ref.slice(0, 40)}…" is longer than ${MAX_VERSION} characters.`);
  }
  // `@latest` is a keyword, not a version_name. A build whose manifest genuinely says
  // `versionName="latest"` is unreachable by coordinate — name it by id.
  return { kind: 'package', packageName, versionName: version === 'latest' ? null : version };
}

const unparseable = (ref: string) =>
  `"${ref.slice(0, 80)}" is not an app reference. Use a build id (a uuid), a package name ` +
  `(\`com.example.app\`, the newest build), or a coordinate (\`com.example.app@1.4.2\`, \`com.example.app@latest\`).`;

/** What a caller sees echoed back — the reference as written, normalised. */
export function describeAppRef(ref: AppRef): string {
  if (ref.kind === 'id') return ref.id;
  return `${ref.packageName}@${ref.versionName ?? 'latest'}`;
}

export interface ResolvedApp {
  id: string;
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  sha256: string;
}

interface Row {
  id: string;
  package_name: string;
  version_name: string | null;
  version_code: string | number | null;
  sha256: string;
}

/**
 * The build a reference names, or null when this org has no such build.
 *
 * Takes a client rather than opening its own, so a caller already inside a tenant transaction gets
 * the same snapshot — and so the RLS scope is the caller's, which is the entire security story here.
 *
 * `platform` is a filter and not a formality: an ios session that resolved an android build would
 * queue an install the worker could only fail, one heartbeat later, with a message about adb.
 *
 * Ordering is `created_at DESC` for both package forms. For `@latest` that is the definition. For a
 * pinned `@1.4.2` it is a tie-break: `versionName` is free text in the manifest and nothing stops a
 * team uploading it twice, so the newest upload of that version wins rather than an arbitrary row.
 */
export async function resolveAppRef(
  c: PoolClient,
  ref: AppRef,
  platform: 'android' | 'ios',
): Promise<ResolvedApp | null> {
  const { rows } = ref.kind === 'id'
    ? await c.query<Row>(
      `SELECT id, package_name, version_name, version_code, sha256
         FROM app_builds WHERE id = $1 AND platform = $2`,
      [ref.id, platform],
    )
    : await c.query<Row>(
      `SELECT id, package_name, version_name, version_code, sha256
         FROM app_builds
        WHERE package_name = $1 AND platform = $2
          AND ($3::text IS NULL OR version_name = $3)
        ORDER BY created_at DESC
        LIMIT 1`,
      [ref.packageName, platform, ref.versionName],
    );

  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    packageName: r.package_name,
    versionName: r.version_name,
    // bigint arrives from pg as a string; a versionCode is small enough that Number is exact.
    versionCode: r.version_code === null ? null : Number(r.version_code),
    sha256: r.sha256,
  };
}
