import { ModelError } from './model-error.ts';

/**
 * IS THE AI MODEL PROVIDER USABLE RIGHT NOW — a circuit breaker per configured provider (ADR-0044).
 *
 * Found on the farm 2026-09-26: a person started a run while the provider's daily token allowance was
 * used up. The farm allocated a device, installed their app, asked the model, and only then learned
 * what the previous call had already been told — and the page said "could not be reached". Every
 * model call now reports here, so the NEXT thing that needs the model can be refused, deferred or
 * sent to the fallback provider before it takes a device, with the reason and the time it lifts.
 *
 * IN MEMORY, deliberately. The farm runs one API process; a restart forgets, and the first call
 * after it re-learns in one request. Persisting it would mean a schema for a fact that is only ever
 * true for minutes.
 *
 * HALF-OPEN by time: a provider that failed is not tried again before `retryAt`. After it, the next
 * caller may try — the runner does that with a one-token probe (provider.ts `probeModel`) BEFORE it
 * takes a device, so a provider that is still down costs a request, never a device.
 */

export type ProviderSlot = 'primary' | 'fallback';
export type HealthState = 'unknown' | 'ok' | 'limited' | 'down';

export interface ProviderHealth {
  state: HealthState;
  /** Why it cannot be used, in words a person can act on. Null while it is usable. */
  reason: string | null;
  /** The earliest time it is worth trying again (epoch ms). Null while usable. */
  retryAt: number | null;
  /** What the provider itself said, for an operator. */
  detail: string | null;
  /** When it entered this state. */
  since: number | null;
  lastOkAt: number | null;
}

const UNKNOWN: ProviderHealth = { state: 'unknown', reason: null, retryAt: null, detail: null, since: null, lastOkAt: null };
const table = new Map<ProviderSlot, ProviderHealth>();

/** How long to leave a provider alone after each kind of failure, when it did not say. */
export const COOL_DOWN_MS = Object.freeze({
  /** Rate-limited with no hint: per-minute caps are the common case. */
  limited: 60_000,
  /** Down, unreachable or erroring: long enough not to hammer it, short enough to notice it return. */
  down: 60_000,
  /** The key itself: no credit, rejected, or a model it cannot use. A person has to act first. */
  account: 15 * 60_000,
});

export function providerHealth(slot: ProviderSlot): ProviderHealth {
  return table.get(slot) ?? UNKNOWN;
}

/** Usable now: never failed, last call worked, or the wait it asked for is over (half-open). */
export function modelUsable(slot: ProviderSlot, now = Date.now()): boolean {
  const h = providerHealth(slot);
  if (h.state === 'ok' || h.state === 'unknown') return true;
  return h.retryAt !== null && h.retryAt <= now;
}

/** True when the slot failed before and has only been let back in by the clock, not by a success. */
export function modelHalfOpen(slot: ProviderSlot, now = Date.now()): boolean {
  const h = providerHealth(slot);
  return (h.state === 'limited' || h.state === 'down') && h.retryAt !== null && h.retryAt <= now;
}

export function recordModelOk(slot: ProviderSlot, now = Date.now()): void {
  table.set(slot, { state: 'ok', reason: null, retryAt: null, detail: null, since: now, lastOkAt: now });
}

/**
 * A failed call. Returns the new health, or NULL when the failure is the request's own fault — a
 * schema the provider refused, a prompt too large — which says nothing about the provider and must
 * not stop every other run.
 */
export function recordModelFailure(slot: ProviderSlot, err: unknown, now = Date.now()): ProviderHealth | null {
  const verdict = classifyModelFailure(err, now);
  if (!verdict) return null;
  const prev = providerHealth(slot);
  const next: ProviderHealth = {
    ...verdict,
    since: prev.state === verdict.state ? prev.since ?? now : now,
    lastOkAt: prev.lastOkAt,
  };
  table.set(slot, next);
  return next;
}

/** Forget everything — tests, and nothing else. */
export function resetProviderHealth(): void {
  table.clear();
}

type Verdict = Pick<ProviderHealth, 'state' | 'reason' | 'retryAt' | 'detail'>;

export function classifyModelFailure(err: unknown, now = Date.now()): Verdict | null {
  const e = err instanceof ModelError ? err : null;
  const status = e ? e.status : null;
  const detail = String(e?.body || (err as Error)?.message || err || '').slice(0, 600) || null;
  const wait = (fallbackMs: number) => now + (e?.retryAfterMs ?? fallbackMs);

  if (status === 429) {
    const daily = /per day|\bTPD\b|\bRPD\b|daily/i.test(`${e?.body ?? ''} ${e?.message ?? ''}`);
    return {
      state: 'limited',
      reason: daily
        ? 'The AI model provider’s daily allowance for this farm’s key is used up.'
        : 'The AI model provider is rate-limiting this farm’s key.',
      retryAt: wait(COOL_DOWN_MS.limited),
      detail,
    };
  }
  if (status === 402) {
    return { state: 'down', reason: 'The AI model provider says this farm’s key has no credit left.', retryAt: now + COOL_DOWN_MS.account, detail };
  }
  if (status === 401) {
    return { state: 'down', reason: 'The AI model provider rejected this farm’s key.', retryAt: now + COOL_DOWN_MS.account, detail };
  }
  if (status === 403) {
    return { state: 'down', reason: 'The AI model provider refused this farm’s key access.', retryAt: now + COOL_DOWN_MS.account, detail };
  }
  if (status === 404) {
    return { state: 'down', reason: 'The configured AI model is not available to this farm’s key.', retryAt: now + COOL_DOWN_MS.account, detail };
  }
  if (status === null && !e) {
    // Not a ModelError at all: a bug of ours, not a fact about the provider.
    return null;
  }
  if (status === null || status === 408 || status >= 500) {
    return {
      state: 'down',
      reason: status === null ? 'The AI model provider did not answer.' : `The AI model provider is failing (HTTP ${status}).`,
      retryAt: wait(COOL_DOWN_MS.down),
      detail,
    };
  }
  // 400, 413, 422 and the like: the request's own fault.
  return null;
}
