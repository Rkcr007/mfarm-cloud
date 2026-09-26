import { withTenant } from '../db.ts';
import { AI_CURRENCY, AI_PROFILES } from './pricing.ts';
import { spendThisMonth } from './budget.ts';
import { modelHalfOpen, modelUsable, providerHealth } from './health.ts';
import type { ModelSlot } from './provider.ts';

/**
 * CAN AN AI RUN START RIGHT NOW — one go / no-go, and the reason in words (ADR-0044).
 *
 * An AI run depends on four things, and each used to be discovered only by failing: the farm has a
 * model key; the model provider answers; a device of the right platform can be given; the budget can
 * pay a step. On 2026-09-26 a person started a run while the provider's daily allowance was used up —
 * the run took a device, installed the app and died on its first model call, and the page said "could
 * not be reached". This answers the question BEFORE anything is taken, and the same answer gates the
 * console's buttons and the API's doors, so a control is never offered on a false premise.
 *
 * Each check says what is wrong, what to do, and — when it will lift by itself — when.
 */

export type ReadinessBlocker = 'configured' | 'model' | 'devices' | 'budget';

export interface ReadinessCheck {
  ok: boolean;
  /** One sentence a person can act on. */
  message: string;
  /** For an operator: what the provider or the fleet actually said. */
  detail?: string | null;
  /** When the problem lifts by itself, if it will (ISO). */
  retryAt?: string | null;
  /** Where to go to fix it, when there is somewhere. A console route. */
  action?: { label: string; href: string } | null;
}

export interface DevicesCheck extends ReadinessCheck {
  platform: 'android' | 'ios';
  region: string | null;
  total: number;
  /** Can take a run now or soon: free, busy, being reset or booting. */
  usable: number;
  /** Free right now. */
  ready: number;
}

export interface AiReadiness {
  ready: boolean;
  /** The first check that says no, in the order a person should fix them. */
  blocking: ReadinessBlocker | null;
  message: string | null;
  checks: {
    configured: ReadinessCheck;
    model: ReadinessCheck & { using: string | null };
    devices: DevicesCheck;
    budget: ReadinessCheck & { spentInr: number; budgetInr: number };
  };
}

/** Device states that can take a run now (READY) or will be able to without anyone acting. */
const USABLE = new Set(['READY', 'RESERVED', 'SESSION_ACTIVE', 'CLEANING', 'PREPARING', 'BOOTING']);

const osName = (p: 'android' | 'ios') => (p === 'ios' ? 'iOS' : 'Android');
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface ReadinessInput {
  platform: 'android' | 'ios';
  region?: string | null;
  /** The providers configured on this farm (provider.ts `configuredSlots`). Empty: AI is off. */
  slots: ModelSlot[];
  /** Tests inject a model directly; then there is nothing to be unhealthy. */
  injected?: boolean;
}

export async function aiReadiness(orgId: string, input: ReadinessInput): Promise<AiReadiness> {
  const configured = aiConfiguredCheck(input);
  const model = modelCheck(input);
  const [devices, budget] = await Promise.all([devicesCheck(orgId, input.platform, input.region ?? null), budgetCheck(orgId)]);
  const order: [ReadinessBlocker, ReadinessCheck][] = [['configured', configured], ['model', model], ['devices', devices], ['budget', budget]];
  const first = order.find(([, c]) => !c.ok) ?? null;
  return {
    ready: first === null,
    blocking: first ? first[0] : null,
    message: first ? first[1].message : null,
    checks: { configured, model, devices, budget },
  };
}

function aiConfiguredCheck(input: ReadinessInput): ReadinessCheck {
  if (input.injected || input.slots.length) return { ok: true, message: 'AI runs are switched on for this farm.' };
  return {
    ok: false,
    message: 'AI runs are not switched on for this farm: it has no model key. An operator adds one (runbook: "Turn on AI runs").',
  };
}

/** The model provider: usable now, served by the fallback, or down until a time. Reads memory only. */
export function modelCheck(input: Pick<ReadinessInput, 'slots' | 'injected'>, now = Date.now()): ReadinessCheck & { using: string | null } {
  if (input.injected) return { ok: true, message: 'Ready.', using: null };
  if (!input.slots.length) return { ok: false, message: 'No AI model is configured.', using: null };
  const [primary, ...rest] = input.slots;
  const p = providerHealth(primary!.slot);
  if (modelUsable(primary!.slot, now)) {
    return {
      ok: true,
      message: modelHalfOpen(primary!.slot, now)
        ? `${p.reason ?? 'It was unavailable.'} The wait it asked for is over; the next run checks it before taking a device.`
        : 'Ready.',
      using: primary!.label,
    };
  }
  const usableFallback = rest.find((s) => modelUsable(s.slot, now));
  if (usableFallback) {
    return {
      ok: true,
      message: `${p.reason} Runs use the fallback model (${usableFallback.model}) until ${iso(p.retryAt) ? 'it lifts' : 'it is fixed'}.`,
      detail: p.detail,
      retryAt: iso(p.retryAt),
      using: usableFallback.label,
    };
  }
  const retryAt = input.slots.map((s) => providerHealth(s.slot).retryAt)
    .filter((t): t is number => t !== null).sort((a, b) => a - b)[0] ?? null;
  const fb = rest.length ? providerHealth(rest[0]!.slot) : null;
  return {
    ok: false,
    message: [p.reason ?? 'The AI model is unavailable.', fb?.reason ? `The fallback is unavailable too: ${fb.reason}` : null]
      .filter(Boolean).join(' '),
    detail: p.detail,
    retryAt: iso(retryAt),
    using: null,
  };
}

/**
 * Can a device of this platform take a run: now (READY), soon (busy, resetting, booting), or not
 * without somebody acting (quarantined, offline — a stopped host puts every device here).
 */
export async function devicesCheck(orgId: string, platform: 'android' | 'ios', region: string | null): Promise<DevicesCheck> {
  const rows = await withTenant(orgId, async (c) => (await c.query<{
    state: string; source: string | null; reason: string | null; n: number;
  }>(
    `SELECT state::text AS state, quarantine_source AS source, quarantine_reason AS reason, count(*)::int AS n
       FROM devices WHERE platform = $1 AND ($2::text IS NULL OR region = $2)
      GROUP BY 1, 2, 3`,
    [platform, region],
  )).rows);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const usable = rows.filter((r) => USABLE.has(r.state)).reduce((a, r) => a + r.n, 0);
  const ready = rows.filter((r) => r.state === 'READY').reduce((a, r) => a + r.n, 0);
  const os = osName(platform);
  const where = region ? ` in ${region}` : '';
  const base = { platform, region, total, usable, ready };

  if (!total) return { ...base, ok: false, message: `This farm has no ${os} devices${where}.` };
  if (!usable) {
    const out = rows.filter((r) => !USABLE.has(r.state)).sort((a, b) => b.n - a.n);
    const hostStopped = out.some((r) => r.source === 'host' && /stopped/i.test(r.reason ?? ''));
    // A host switched off OUTSIDE the console just goes quiet: its devices read "its host was
    // quarantined: no heartbeat for 90s" (seen on the farm 2026-09-26), which is a stop by another name.
    const hostSilent = out.some((r) => r.source === 'reaper'
      || (r.source === 'host' && /heartbeat|not answering|silent/i.test(r.reason ?? '')));
    const infra = { label: 'Open Infrastructure', href: '#/infra/hosts' };
    if (hostStopped) {
      return { ...base, ok: false, action: infra, detail: out[0]?.reason ?? null,
        message: `The device host is stopped, so no ${os} device can take a run. Start it from Infrastructure.` };
    }
    if (hostSilent) {
      return { ...base, ok: false, action: infra, detail: out[0]?.reason ?? null,
        message: `The device host has stopped answering — it may be switched off — so no ${os} device can take a run.` };
    }
    return { ...base, ok: false, action: { label: 'Open the fleet', href: '#/fleet' }, detail: out[0]?.reason ?? null,
      message: `All ${total} ${os} device${total === 1 ? ' is' : 's are'} out of the pool${where}, so none can take a run.` };
  }
  if (!ready) {
    return { ...base, ok: true, message: `All ${usable} ${os} device${usable === 1 ? ' is' : 's are'} busy; a run waits for the next free one.` };
  }
  return { ...base, ok: true, message: `${ready} of ${total} ${os} device${total === 1 ? '' : 's'} free${where}.` };
}

/** Whether the budget can pay for the cheapest step — the same sum every door checks (queue.ts). */
export async function budgetCheck(orgId: string): Promise<ReadinessCheck & { spentInr: number; budgetInr: number }> {
  const { spentInr, budgetInr } = await spendThisMonth(orgId);
  const cheapest = Math.min(...Object.values(AI_PROFILES).map((p) => p.priceInr));
  const left = Math.max(0, budgetInr - spentInr);
  if (spentInr + cheapest > budgetInr) {
    return { ok: false, spentInr, budgetInr,
      message: `This month's AI budget is used up (${AI_CURRENCY}${spentInr} of ${AI_CURRENCY}${budgetInr}). It resets on the 1st.` };
  }
  return { ok: true, spentInr, budgetInr, message: `${AI_CURRENCY}${left} of ${AI_CURRENCY}${budgetInr} left this month.` };
}
