/**
 * The runtime floor, kept in its own module so it can be tested.
 *
 * `engines` in package.json is advisory: npm prints EBADENGINE and installs the package anyway. So
 * without a check at startup an old runtime is discovered at the first HTTP call — which on Node 16
 * reads `fetch is not defined` AFTER FOUR RETRY ATTEMPTS, and on Node 18 or 20.0 reads
 * `AbortSignal.any is not a function` from inside a request. Both messages are true and neither says
 * "your Node is too old", and by then `mfarm run` may already be holding a device.
 *
 * This lives beside `bin.ts` rather than inside it because the comparison is the part that can be
 * wrong — an off-by-one either turns away a Node that works or admits one that does not — and
 * nothing can import the entry point to test it without running the CLI.
 */

/**
 * 20.3.0 is where `AbortSignal.any` landed. `client.ts` uses it to combine the caller's abort signal
 * with the per-request timeout, and it is the newest API this package touches.
 *
 * Raise this only alongside the API that forces it, and change `engines` in package.json to match.
 */
export const MIN_NODE: readonly [number, number, number] = [20, 3, 0];

/**
 * `null` when `version` is new enough, otherwise the sentence to print.
 *
 * Takes the version rather than reading `process.versions.node` so a test can ask about a runtime it
 * is not running on — which is every interesting case.
 */
export function nodeTooOld(version: string): string | null {
  // A nightly reports `21.0.0-nightly2023...`; the numeric prefix is what matters and `parseInt`
  // stops at the dash. A segment that will not parse counts as 0, so a malformed version is treated
  // as too old rather than waved through.
  const parts = version.split('.').map((n) => {
    const v = Number.parseInt(n, 10);
    return Number.isNaN(v) ? 0 : v;
  });

  for (let i = 0; i < MIN_NODE.length; i += 1) {
    const have = parts[i] ?? 0;
    const need = MIN_NODE[i]!;
    if (have > need) return null;
    if (have < need) return `mfarm needs Node ${MIN_NODE.join('.')} or newer; this is ${version}.`;
  }
  // Exactly the minimum.
  return null;
}
