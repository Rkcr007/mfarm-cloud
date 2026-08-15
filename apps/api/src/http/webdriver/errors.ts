/**
 * W3C WebDriver error shape.
 *
 * A WebDriver client parses `{"value": {"error": ..., "message": ..., "stacktrace": ...}}` and
 * nothing else. The control plane's own `{"error": {...}}` envelope is unreadable to it: Appium
 * clients hand the raw body to the user as an unhelpful blob, so an auth failure surfaces as
 * "An unknown server-side error occurred" and someone spends an afternoon on it.
 *
 * `error` is therefore always one of the spec's codes, because that is what clients branch on. Our
 * own machine-readable code rides alongside as `mfarm:code`, which the spec permits and clients
 * ignore.
 */

/** The subset of https://w3c.github.io/webdriver/#errors this hub can produce, with its status. */
const STATUS: Record<string, number> = {
  'invalid argument': 400,
  'invalid session id': 404,
  'no such element': 404,
  'session not created': 500,
  timeout: 500,
  'unknown command': 404,
  'unknown error': 500,
  'unknown method': 405,
  'unsupported operation': 500,
};

export interface WebDriverErrorOptions {
  /** Our own code, for anyone reading the body programmatically. */
  mfarmCode?: string;
  data?: Record<string, unknown>;
  /** Overrides the status the W3C code maps to. Only for conditions the spec has no code for. */
  statusCode?: number;
}

export class WebDriverError extends Error {
  readonly error: string;
  readonly statusCode: number;
  readonly mfarmCode?: string;
  readonly data?: Record<string, unknown>;

  constructor(error: string, message: string, opts: WebDriverErrorOptions = {}) {
    super(message);
    this.name = 'WebDriverError';
    this.error = error;
    this.statusCode = opts.statusCode ?? STATUS[error] ?? 500;
    this.mfarmCode = opts.mfarmCode;
    this.data = opts.data;
  }
}

export const invalidArgument = (m: string) => new WebDriverError('invalid argument', m);
export const invalidSessionId = (m = 'No such session. It may have ended, timed out, or belong to another account.') =>
  new WebDriverError('invalid session id', m);
export const sessionNotCreated = (m: string, mfarmCode?: string) =>
  new WebDriverError('session not created', m, { mfarmCode });

export interface W3cErrorBody {
  value: {
    error: string;
    message: string;
    stacktrace: string;
    [key: string]: unknown;
  };
}

/**
 * Serialise anything thrown under the hub into the W3C envelope.
 *
 * `stacktrace` is present because the spec requires the field, and empty because a stack trace is a
 * disclosure vector — the same rule the main error handler follows.
 */
export function toW3cBody(err: WebDriverError, requestId: string): W3cErrorBody {
  return {
    value: {
      error: err.error,
      message: err.message,
      stacktrace: '',
      ...(err.data ?? {}),
      ...(err.mfarmCode ? { 'mfarm:code': err.mfarmCode } : {}),
      'mfarm:requestId': requestId,
    },
  };
}

/**
 * Map a control-plane ApiError onto the closest W3C code.
 *
 * The HTTP status stays exactly what the control plane decided — 401 is not 500 — because that is
 * the part a proxy, a CI log and a retry policy all read. The W3C code is the closest available
 * label for a condition the spec never contemplated (there is no "your API key expired" error), so
 * the real reason travels in the message and in `mfarm:code`.
 */
export function fromApiError(statusCode: number, code: string, message: string): WebDriverError {
  const w3c =
    statusCode === 400 ? 'invalid argument'
    : statusCode === 404 ? 'invalid session id'
    : statusCode === 405 ? 'unknown method'
    : 'unknown error';
  return new WebDriverError(w3c, message, { mfarmCode: code, statusCode });
}
