/**
 * Types for `sync-fonts.mjs`, which stays plain JavaScript because it is a build script run by
 * `node` directly — the same reason `public/*.js` is plain JavaScript.
 *
 * This file exists so `fonts.test.ts` can import it under `tsc --noEmit` without the whole module
 * arriving as `any`. Declaring the shape is worth more than suppressing the error: the test reads
 * four fields off every face, and a rename in the script should fail the typecheck rather than the
 * assertion.
 */
export interface Face {
  /** Package name under `@fontsource-variable`, and the face's own name. */
  name: string;
  /** Bare filename, e.g. `instrument-sans-latin-wght-normal.woff2`. */
  file: string;
  /** Absolute path to the copy in `node_modules`. */
  from: string;
  /** Absolute path to the checked-in copy under `public/fonts`. */
  to: string;
}

export const FACES: Face[];
