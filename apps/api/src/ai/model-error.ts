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
  /**
   * Set when the provider refused the request for its SIZE against this key's tier ("Request too
   * large … Limit 1000, Requested 1748") — read once, in the adapter that saw the words (D54). No
   * wait can change the answer to the same request, so it is the request's fault, not an outage.
   */
  readonly tooLarge: TooLarge | null;

  constructor(message: string, opts: { status: number | null; retryAfterMs?: number | null; body?: string; tooLarge?: TooLarge | null }) {
    super(message);
    this.name = 'ModelError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
    this.tooLarge = opts.tooLarge ?? null;
  }
}

/** A size refusal: the tier's limit and what the request asked for, and whether it is OUTPUT tokens. */
export interface TooLarge {
  limit: number | null;
  requested: number | null;
  /** Output tokens can be capped by the caller; input tokens cannot be un-sent. */
  output: boolean;
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

/**
 * A failed model call, in the sentence a run or a diagnosis ends with. A request refused for its size
 * was said as "could not be reached" (D54) — which sent people looking for an outage, not a tier.
 */
export function modelFailureWords(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  return err instanceof ModelError && err.tooLarge
    ? `The model provider refused the request as larger than this farm's key allows: ${message}`
    : `The model could not be reached: ${message}`;
}
