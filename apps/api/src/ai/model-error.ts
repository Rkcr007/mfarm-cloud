/**
 * A MODEL CALL THAT FAILED, SAID STRUCTURALLY.
 *
 * The health tracker (health.ts) has to tell "slow down for six minutes" from "this key has no credit"
 * from "the provider is down" — and it used to have only prose to go on. Both providers' adapters
 * (provider.ts) throw this, so the difference is decided once, from the status and the provider's own
 * retry hint, never by matching words in a message.
 *
 * Fields are declared and assigned explicitly, not as constructor parameter properties: those emit
 * runtime code, which Node's native type stripping rejects.
 */
export class ModelError extends Error {
  /** The provider's HTTP status. Null when no HTTP answer came back at all (network, timeout). */
  readonly status: number | null;
  /** How long the provider asked us to wait, when it said. */
  readonly retryAfterMs: number | null;
  /** What the provider itself said — for an operator, never parsed for decisions. */
  readonly body: string;

  constructor(message: string, opts: { status: number | null; retryAfterMs?: number | null; body?: string }) {
    super(message);
    this.name = 'ModelError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
  }
}

/**
 * Nothing could serve the call: every configured provider is known to be down or limited. Thrown
 * WITHOUT contacting anyone, so a run can be told why at once instead of after a device was taken.
 */
export class ModelUnavailableError extends ModelError {
  /** The earliest time any provider is worth trying again, when one is known. */
  readonly retryAt: number | null;

  constructor(message: string, retryAt: number | null) {
    super(message, { status: 503 });
    this.name = 'ModelUnavailableError';
    this.retryAt = retryAt;
  }
}
