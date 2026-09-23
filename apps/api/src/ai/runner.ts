import { Readable } from 'node:stream';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { withSystem, withTenant } from '../db.ts';
import { createApiKey, revokeApiKey } from '../auth.ts';
import { appStore, type AppStore } from '../appstore.ts';
import { release } from '../allocator.ts';
import { AI_PROFILES, isAiProfile, type AiProfile } from './pricing.ts';
import { spendThisMonth } from './queue.ts';
import { runAgent, type AgentOutcome, type Device, type DeviceKey, type Model, type Sink, type StopReason } from './agent.ts';

/**
 * THE AI RUN RUNNER — takes queued AI runs and drives each to a verdict (ADR-0043).
 *
 * OWNED BY THE SERVER, like the reaper: started by `buildServer` when an interval is configured,
 * stopped by `onClose`. It claims a queued run on the system pool (the only cross-org read), then
 * does everything else for that one org through `withTenant`.
 *
 * THE DEVICE IS REACHED THROUGH THE HUB, IN-PROCESS. `app.inject()` against `/wd/hub` with a key
 * minted for this run alone: allocation, `mfarm:appId` install, run joining, command recording and
 * release are the hub's own code paths, and no socket or new trust path exists (ADR-0043 §5).
 */

/** A run holds its key no longer than this. The step cap ends a run long before; this is the backstop. */
const RUN_KEY_TTL_MS = 3 * 60 * 60_000;
/** Capacity wait at allocation — the same the MCP server and the example suites use. */
const QUEUE_TIMEOUT_SECONDS = 300;

export interface AiRunnerOptions {
  intervalMs: number;
  /** Step screenshots older than this are deleted; the step rows (the ledger) stay. */
  retentionHours: number;
  maxConcurrent: number;
  modelId: string;
  /** Tests inject a scripted model. Production builds one from ANTHROPIC_API_KEY. */
  model?: Model;
  artifactDir: string;
}

/** The Anthropic call, with server-side refusal fallback enabled (default routing by category). */
export function anthropicModel(): Model {
  const client = new Anthropic();
  return (params) => client.beta.messages.create({
    ...params,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
}

/** True when this process can run AI at all. Checked at creation so a run is refused, not stranded. */
export function aiConfigured(opts: { model?: Model } = {}): boolean {
  return Boolean(opts.model) || Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function aiStepStore(artifactDir: string): AppStore {
  // A subdirectory of its own: session artifacts are swept by their rows' retention, and a blob with
  // no `artifacts` row must never be mistaken for an orphan of theirs.
  return appStore(join(artifactDir, 'ai'));
}

export interface ClaimedRun {
  id: string;
  org_id: string;
  prompt: string;
  profile: AiProfile;
  platform: 'android' | 'ios';
  region: string | null;
  app_ref: string | null;
  step_cap: number;
}

export function startAiRunner(app: FastifyInstance, opts: AiRunnerOptions): void {
  const model = opts.model ?? (aiConfigured() ? anthropicModel() : undefined);
  const store = aiStepStore(opts.artifactDir);
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let ticking = false;

  const tick = async () => {
    if (ticking || closing) return;
    ticking = true;
    try {
      while (!closing && inFlight.size < opts.maxConcurrent) {
        const run = await claimNext();
        if (!run) break;
        const p = driveRun(app, run, { model, modelId: opts.modelId, store, isClosing: () => closing })
          .catch((err: Error) => app.log.error({ err, aiRun: run.id }, 'ai run crashed'))
          .finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
    } catch (err) {
      app.log.error({ err }, 'ai runner tick failed');
    } finally {
      ticking = false;
    }
  };

  // A run that was mid-flight when the previous process died cannot be resumed: its key was in that
  // process's memory and the device's state is unknown. Say so, give back what it held.
  void sweepInterrupted().then(tick, (err: Error) => app.log.error({ err }, 'ai runner boot sweep failed'));
  const timer = setInterval(() => { void tick(); }, opts.intervalMs);
  timer.unref?.();
  // Hourly, and on its own timer: a slow disk must never delay a claim.
  const retention = setInterval(() => {
    void expireAiScreenshots(store, opts.retentionHours)
      .catch((err: Error) => app.log.error({ err }, 'ai screenshot retention failed'));
  }, 3_600_000);
  retention.unref?.();
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    clearInterval(retention);
    await Promise.allSettled([...inFlight]);
  });
}

async function claimNext(): Promise<ClaimedRun | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query<ClaimedRun>(
      `UPDATE ai_runs SET status = 'running', started_at = now()
        WHERE id = (SELECT id FROM ai_runs WHERE status = 'queued'
                     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, org_id, prompt, profile, platform, region, app_ref, step_cap`,
    );
    return rows[0] ?? null;
  });
}

async function sweepInterrupted(): Promise<void> {
  const stranded = await withSystem(async (c) => (await c.query<{ id: string; org_id: string; session_id: string | null }>(
    `UPDATE ai_runs SET status = 'error', stop_reason = 'interrupted', ended_at = now(),
            summary = 'The control plane restarted while this run was in progress.'
      WHERE status = 'running' RETURNING id, org_id, session_id`,
  )).rows);
  for (const r of stranded) {
    await revokeRunKeys(r.org_id, r.id);
    // The hub's idle sweep would collect the device anyway; ending it now stops the meter now.
    if (r.session_id) await releaseSession(r.org_id, r.session_id).catch(() => {});
  }
}

/**
 * Step screenshots past retention. Same two-step order as `expire_artifacts` in the reaper, and for
 * its reason: rows first, files second — a crash between leaves an unreferenced file (disk), never a
 * row pointing at bytes that are gone (a 404 while someone chases a failure). A blob is deleted only
 * when no step at all still points at it, because content addressing shares one file between runs.
 */
export async function expireAiScreenshots(store: AppStore, retentionHours: number, batch = 500): Promise<number> {
  return withSystem(async (c) => {
    // Two statements, not one: a single statement's NOT EXISTS would read the rows it is clearing
    // as they were before it began, and would always find the blob still referenced.
    const cleared = (await c.query<{ sha: string }>(
      `WITH old AS (
         SELECT id, screenshot_sha256 AS sha FROM ai_steps
          WHERE screenshot_sha256 IS NOT NULL AND created_at < now() - make_interval(hours => $1)
          LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE ai_steps s SET screenshot_sha256 = NULL FROM old WHERE s.id = old.id RETURNING old.sha`,
      [retentionHours, batch],
    )).rows.map((r) => r.sha);
    if (cleared.length === 0) return 0;
    const orphaned = (await c.query<{ sha: string }>(
      `SELECT DISTINCT sha FROM unnest($1::text[]) AS sha
        WHERE NOT EXISTS (SELECT 1 FROM ai_steps WHERE screenshot_sha256 = sha)`,
      [cleared],
    )).rows.map((r) => r.sha);
    for (const sha of orphaned) await store.remove(sha);
    return orphaned.length;
  });
}

async function revokeRunKeys(orgId: string, runId: string): Promise<void> {
  const prefixes = await withSystem(async (c) => (await c.query<{ prefix: string }>(
    'SELECT prefix FROM api_keys WHERE ai_run_id = $1 AND revoked_at IS NULL', [runId],
  )).rows.map((r) => r.prefix));
  for (const p of prefixes) await revokeApiKey(orgId, p);
}

async function releaseSession(orgId: string, sessionId: string): Promise<void> {
  // The run's own key is already revoked here, so end it the way the reaper would.
  await release(orgId, sessionId, 'ai_run_interrupted');
}

// ---------------------------------------------------------------- one run

class HubError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A WebDriver client of this process's own hub. */
function hubCaller(app: FastifyInstance, key: string) {
  return async (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<unknown> => {
    const res = await app.inject({
      method,
      url: `/wd/hub${url}`,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let parsed: { value?: { error?: string; message?: string } & Record<string, unknown> } | null = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { /* handled below */ }
    if (res.statusCode >= 400) {
      throw new HubError(
        res.statusCode,
        parsed?.value?.error ?? 'unknown error',
        parsed?.value?.message ?? `HTTP ${res.statusCode} from the hub`,
      );
    }
    return parsed?.value ?? null;
  };
}

const ANDROID_KEYCODES: Record<DeviceKey, number> = { back: 4, home: 3, enter: 66, app_switch: 187 };

function hubDevice(call: ReturnType<typeof hubCaller>, sessionId: string, platform: 'android' | 'ios'): Device {
  const s = `/session/${encodeURIComponent(sessionId)}`;
  const pointer = (actions: unknown[]) => call('POST', `${s}/actions`, {
    actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
  });
  let size: { width: number; height: number } | null = null;
  return {
    platform,
    async screenshot() {
      const v = await call('GET', `${s}/screenshot`);
      if (typeof v !== 'string') throw new Error('the device returned no screenshot');
      return v;
    },
    async source() {
      const v = await call('GET', `${s}/source`);
      return typeof v === 'string' ? v : '';
    },
    async size() {
      if (!size) {
        const v = await call('GET', `${s}/window/rect`) as { width?: number; height?: number } | null;
        size = { width: Math.round(v?.width ?? 1080), height: Math.round(v?.height ?? 2400) };
      }
      return size;
    },
    async tap(x, y) {
      await pointer([
        { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 80 }, { type: 'pointerUp', button: 0 },
      ]);
    },
    async swipe(x1, y1, x2, y2) {
      await pointer([
        { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 },
        { type: 'pointerMove', duration: 300, x: Math.round(x2), y: Math.round(y2) },
        { type: 'pointerUp', button: 0 },
      ]);
    },
    async typeText(text) {
      const active = await call('POST', `${s}/element/active`, {}) as Record<string, unknown> | null;
      const id = active?.['element-6066-11e4-a52e-4f735466cecf'] ?? active?.ELEMENT;
      if (typeof id !== 'string') throw new Error('no field has focus — tap the field first');
      await call('POST', `${s}/element/${encodeURIComponent(id)}/value`, { text, value: [...text] });
    },
    async pressKey(key) {
      if (platform === 'ios') {
        await call('POST', `${s}/execute/sync`, { script: 'mobile: pressButton', args: [{ name: 'home' }] });
      } else {
        await call('POST', `${s}/execute/sync`, { script: 'mobile: pressKey', args: [{ keycode: ANDROID_KEYCODES[key] }] });
      }
    },
    async launchApp(appId) {
      const args = platform === 'ios' ? { bundleId: appId } : { appId };
      await call('POST', `${s}/execute/sync`, { script: 'mobile: activateApp', args: [args] });
    },
  };
}

interface DriveContext {
  model: Model | undefined;
  modelId: string;
  store: AppStore;
  isClosing: () => boolean;
}

async function finishRun(
  orgId: string,
  runId: string,
  fields: { status: string; stop_reason?: string | null; summary?: string | null; evidence?: string | null },
): Promise<void> {
  await withTenant(orgId, (c) => c.query(
    `UPDATE ai_runs SET status = $3, stop_reason = $4, summary = $5, evidence = $6, ended_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, runId, fields.status, fields.stop_reason ?? null, fields.summary ?? null, fields.evidence ?? null],
  ));
}

export async function driveRun(app: FastifyInstance, run: ClaimedRun, ctx: DriveContext): Promise<void> {
  const orgId = run.org_id;
  if (!ctx.model) {
    await finishRun(orgId, run.id, { status: 'error', stop_reason: 'not_configured', summary: 'AI runs are not configured on this farm.' });
    return;
  }
  const profile: AiProfile = isAiProfile(run.profile) ? run.profile : 'flash';

  const key = await createApiKey(orgId, `AI run ${run.id.slice(0, 8)}`, {
    scope: 'automation',
    expiresAt: new Date(Date.now() + RUN_KEY_TTL_MS),
  });
  await withSystem((c) => c.query('UPDATE api_keys SET ai_run_id = $1 WHERE prefix = $2', [run.id, key.prefix]));
  await withTenant(orgId, (c) => c.query(
    'UPDATE ai_runs SET model = $3 WHERE org_id = $1 AND id = $2', [orgId, run.id, ctx.modelId],
  ));

  const call = hubCaller(app, key.plaintext);
  let sessionId: string | null = null;
  let outcome: AgentOutcome | null = null;
  try {
    const title = run.prompt.replace(/\s+/g, ' ').trim();
    const created = await call('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          platformName: run.platform === 'ios' ? 'iOS' : 'Android',
          'appium:automationName': run.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
          'appium:newCommandTimeout': 300,
          ...(run.platform === 'android' ? { 'appium:autoGrantPermissions': true } : {}),
          'mfarm:queueTimeoutSeconds': QUEUE_TIMEOUT_SECONDS,
          'mfarm:runId': `ai-${run.id}`,
          'mfarm:runName': `AI: ${title.slice(0, 80)}`,
          'mfarm:name': `AI: ${title.slice(0, 120)}`,
          ...(run.region ? { 'mfarm:region': run.region } : {}),
          ...(run.app_ref ? { 'mfarm:appId': run.app_ref } : {}),
        },
        firstMatch: [{}],
      },
    }) as { sessionId?: string } | null;
    if (!created?.sessionId) throw new HubError(502, 'session not created', 'The hub answered without a session.');
    sessionId = created.sessionId;

    await withTenant(orgId, (c) => c.query(
      `UPDATE ai_runs SET session_id = $3,
              run_id = (SELECT run_id FROM sessions WHERE id = $3)
        WHERE org_id = $1 AND id = $2`,
      [orgId, run.id, sessionId],
    ));

    const price = AI_PROFILES[profile].priceInr;
    const sink: Sink = {
      async beforeStep(): Promise<StopReason | null> {
        // A deploy is not a person pressing Cancel; the run reads as interrupted, like the boot sweep's.
        if (ctx.isClosing()) return 'interrupted';
        const cancelled = await withTenant(orgId, async (c) => (await c.query<{ cancelled: boolean }>(
          'SELECT (cancel_requested_at IS NOT NULL) AS cancelled FROM ai_runs WHERE org_id = $1 AND id = $2',
          [orgId, run.id],
        )).rows[0]?.cancelled ?? true);
        if (cancelled) return 'cancelled';
        // The same sum the routes quote from — one definition of "spent this month" (queue.ts).
        const { spentInr, budgetInr } = await spendThisMonth(orgId);
        if (spentInr + price > budgetInr) return 'budget';
        return null;
      },
      async record(step) {
        let sha: string | null = null;
        if (step.screenshotB64) {
          const blob = await ctx.store.put(Readable.from([Buffer.from(step.screenshotB64, 'base64')]), 20 * 1024 * 1024);
          sha = blob.sha256;
        }
        await withTenant(orgId, async (c) => {
          await c.query(
            `INSERT INTO ai_steps (org_id, ai_run_id, n, phase, thought, action, result, screenshot_sha256,
                                   element_count, model, input_tokens, output_tokens, cache_read_tokens,
                                   cache_write_tokens, price_inr, started_at, duration_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [orgId, run.id, step.n, step.phase, step.thought?.slice(0, 4000) ?? null,
             step.action ? JSON.stringify(step.action) : null, step.result?.slice(0, 1000) ?? null, sha,
             step.elementCount, step.model, step.usage.input, step.usage.output, step.usage.cacheRead,
             step.usage.cacheWrite, price, step.startedAt, step.durationMs],
          );
          await c.query(
            'UPDATE ai_runs SET steps = $3, cost_inr = cost_inr + $4 WHERE org_id = $1 AND id = $2',
            [orgId, run.id, step.n, price],
          );
        });
      },
    };

    outcome = await runAgent({
      task: run.prompt,
      profile,
      device: hubDevice(call, sessionId, run.platform),
      sink,
      model: ctx.model,
      modelId: ctx.modelId,
      stepCap: run.step_cap,
    });
  } catch (err) {
    const e = err as Error;
    // Before a session exists this is allocation — no capacity, an unknown build, a region with no
    // devices — and the hub's message says which. After, the device went away under the run.
    outcome = { status: 'error', reason: sessionId ? 'device_lost' : 'no_device', message: e.message.slice(0, 500), steps: 0 };
  }

  // Report the verdict on the session, so it reads like any test's in Runs, flake history and shares.
  if (sessionId && (outcome.status === 'passed' || outcome.status === 'failed')) {
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/result`,
      headers: { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        status: outcome.status,
        name: `AI: ${run.prompt.replace(/\s+/g, ' ').trim().slice(0, 400)}`,
        ...(outcome.status === 'failed' ? { failure: outcome.summary.slice(0, 4000) } : {}),
      }),
    }).catch(() => {});
  }
  if (sessionId) await call('DELETE', `/session/${encodeURIComponent(sessionId)}`).catch(() => {});
  await revokeRunKeys(orgId, run.id);

  if ('summary' in outcome) {
    await finishRun(orgId, run.id, { status: outcome.status, summary: outcome.summary, evidence: outcome.evidence });
  } else {
    await finishRun(orgId, run.id, { status: outcome.status, stop_reason: outcome.reason, summary: outcome.message });
  }
}
