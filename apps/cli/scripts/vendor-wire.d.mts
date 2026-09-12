/**
 * Types for `vendor-wire.mjs`, so the drift test typechecks.
 *
 * Hand-written and tiny, matching `apps/api/scripts/build-icon-sprite.d.mts` — the generator is a
 * build script rather than shipped code, and giving it a full TypeScript source would mean a build
 * step to run a build step.
 */
export declare function generate(): Promise<string>;
