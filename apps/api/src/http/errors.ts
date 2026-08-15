/**
 * One error shape for every failure, so clients can branch on `code` rather than parsing prose.
 * Messages say what happened and what to do — no apologies, no vagueness.
 */
// Fields are declared and assigned explicitly rather than via constructor parameter properties:
// those are one of the few TypeScript constructs that emit runtime code, so Node's native type
// stripping rejects them and the whole no-build-step setup falls over.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (m = 'Missing or invalid credentials. Send a valid key as `Authorization: Bearer <key>`.') =>
  new ApiError(401, 'unauthorized', m);

export const forbidden = (m: string) => new ApiError(403, 'forbidden', m);
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);
export const badRequest = (m: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'bad_request', m, details);
export const conflict = (code: string, m: string) => new ApiError(409, code, m);
export const unavailable = (m: string) => new ApiError(503, 'unavailable', m);
