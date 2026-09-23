/**
 * The public share page (`public/share.js`) RENDERED — under the same DOM shim as the console.
 *
 * Until ADR-0043 C10 nothing rendered this page in a test: `ui.test.ts` checks it is served and
 * `shares.test.ts` checks the API it reads. The AI-run card is the first part of it that decides
 * what a STRANGER sees about typed text, so it is rendered here from a real payload shape rather
 * than trusted to a browser check that may not happen the same day.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom, textOf } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
let dir = '';

const TOKEN = 'mfs_testtoken0123456789abcdefghij';
const PAYLOAD = {
  test: { name: 'AI: Log in', status: 'passed', failure: null, failureClass: null, failureReason: null, durationMs: 1000, reportedAt: new Date().toISOString(), occurredAt: null },
  session: { name: 'AI: Log in', region: 'lab', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
  device: { model: 'cf_x86_64', platform: 'android', osVersion: '15', tier: 'cuttlefish', profile: null },
  run: null,
  org: { name: 'Acme' },
  steps: { items: [], from: null, to: new Date().toISOString(), truncated: false },
  screenshot: false, log: null, recording: null,
  aiRun: {
    prompt: 'Log in as demo and open settings', profile: 'pro', status: 'passed',
    summary: 'Settings opened', evidence: 'Settings title visible',
    steps: [
      { n: 1, phase: 'plan', tool: null, input: {}, thought: '1. Log in', result: null, screenshot: true },
      { n: 2, phase: 'act', tool: 'type_text', input: { typedLength: 8, submit: true, why: 'password' }, thought: 'Fill the password', result: 'ok', screenshot: true },
      { n: 3, phase: 'act', tool: 'finish', input: { passed: true }, thought: 'Done', result: 'passed', screenshot: false },
    ],
  },
  share: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString() },
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-share-'));
  const modules = (await readdir(PUBLIC)).filter((n) => n.endsWith('.js'));
  for (const name of modules) {
    const src = (await readFile(join(PUBLIC, name), 'utf8')).replace(
      /from '\/([\w.-]+\.js)'/g,
      (whole, file: string) => (modules.includes(file) ? `from ${JSON.stringify(pathToFileURL(join(dir, file)).href)}` : whole));
    await writeFile(join(dir, name), src);
  }
  installDom();
  const g = globalThis as Record<string, any>;
  g.location.pathname = `/s/${TOKEN}`;
  g.window.matchMedia = () => ({ matches: true });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => PAYLOAD });
  await import(pathToFileURL(join(dir, 'share.js')).href);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
});

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test('an AI run reads as the task, the verdict and each step with its screen', () => {
  const root = (globalThis as any).document.getElementById('root');
  const text = textOf(root);
  assert.match(text, /An AI run/);
  assert.match(text, /Log in as demo and open settings/);
  assert.match(text, /The agent concluded:\s+Settings opened/);
  assert.match(text, /Typed 8 characters into a field and pressed Enter/);
  assert.match(text, /Text the agent typed is not shown/);
  // `share.js` sets `class` with setAttribute (its own tiny `h`), so find by the attribute.
  const find = (n: any): any => {
    if (!n) return null;
    if (n.tagName === 'IMG' && String(n.getAttribute?.('class') ?? '').includes('sh-ai-thumb')) return n;
    for (const c of n.children ?? []) { const r = find(c); if (r) return r; }
    return null;
  };
  const thumb = find(root);
  assert.equal(thumb.getAttribute('src'), `/v1/shares/${TOKEN}/ai-steps/1/screenshot`, 'reached through the token and a step number only');
});
