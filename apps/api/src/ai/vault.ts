import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AN AI TEST'S SECRETS, SEALED AT REST (ADR-0045).
 *
 * A task names a secret — `{{PIN}}` — and never holds it. The value lives here, sealed with
 * AES-256-GCM, and is opened only by the runner, at the moment the agent types it. The model is never
 * shown it (agent.ts), no endpoint ever returns it (routes/ai-secrets.ts), and a database dump or an
 * off-site backup holds ciphertext.
 *
 * THE KEY IS DERIVED, NOT STORED: HKDF over the farm's session signing key, which every farm already
 * has as a docker secret. A new secret of its own would have broken the next auto-deploy of every farm
 * that lacked the file — compose refuses to start on a declared secret with no file. The cost is
 * written down in the ADR: rotating the signing key makes every sealed value unreadable, and the
 * console then says so and asks for them again.
 *
 * EACH VALUE IS BOUND TO ITS ORG AND NAME (the GCM additional data), so a row copied to another org,
 * or renamed, does not open.
 */

const INFO = 'mfarm ai secrets v1';

export function vaultKey(signingKeyPem: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(signingKeyPem, 'utf8'), Buffer.alloc(0), INFO, 32));
}

const aad = (orgId: string, name: string) => Buffer.from(`${orgId}\u0000${name}`, 'utf8');

/** iv (12) ‖ tag (16) ‖ ciphertext. */
export function seal(key: Buffer, orgId: string, name: string, value: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(orgId, name));
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** The value, or null when it does not open — another key, another org, another name, or tampering. */
export function unseal(key: Buffer, orgId: string, name: string, sealed: Buffer): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    d.setAAD(aad(orgId, name));
    d.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A secret's name as a task writes it: `{{PIN}}`, `{{LOGIN_EMAIL}}`. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([A-Z][A-Z0-9_]{0,39})\s*\}\}/g;

/** The names a task refers to, in order of first use, each once. */
export function secretNamesIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Text with each placeholder replaced by its value. Unknown names are left as written, and listed. */
export function fillSecrets(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (Object.hasOwn(values, name)) return values[name]!;
    missing.push(name);
    return whole;
  });
  return { text: out, missing: [...new Set(missing)] };
}

/**
 * Text with every secret VALUE replaced by its placeholder — what the model is shown of the screen,
 * and what is recorded. Longest first, so a value that contains another is replaced whole.
 */
export function hideSecrets(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(values).sort((a, b) => b[1].length - a[1].length)) {
    if (value) out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}

/** What a run carries: the values that opened, and the names that are saved but did not. */
export interface RunSecrets {
  values: Record<string, string>;
  /** Saved, but sealed under another key — the signing key was rotated since. */
  unreadable: string[];
}

export const NO_SECRETS: RunSecrets = Object.freeze({ values: Object.freeze({}) as Record<string, string>, unreadable: [] as string[] });

/** Text split at its placeholders — how "Export as script" writes `{{PIN}}` as the environment's PIN. */
export function secretParts(text: string): Array<{ text: string } | { secret: string }> {
  const parts: Array<{ text: string } | { secret: string }> = [];
  let at = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ secret: m[1]! });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
