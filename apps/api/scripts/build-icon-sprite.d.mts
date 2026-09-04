/**
 * Types for `build-icon-sprite.mjs`. Same reasoning as `sync-fonts.d.mts`: the generator is a plain
 * `node` script, and `icons.test.ts` imports it to re-run the generation in memory.
 */

/** Console icon name -> the Lucide file it is extracted from. The set is closed on purpose. */
export const ICON_MAP: Record<string, string>;

/** The exact contents `public/icons.js` should have, for comparison against what is on disk. */
export function generate(): Promise<string>;
