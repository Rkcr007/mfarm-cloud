/**
 * What is actually running here.
 *
 * The point of this file is a question that was unanswerable for the first month of this project:
 * "is the fix I just shipped the code that is serving me?" Answering it required sshing to the box
 * and reading a git log, which meant in practice that nobody answered it — and a deployment you
 * cannot identify is one you cannot reason about. It is now one authenticated GET and a line in the
 * console header.
 *
 * The SHA is BAKED IN AT BUILD TIME, not read from a checkout at runtime, and that distinction is
 * the whole value. A container that reports the git state of whatever directory it happens to be
 * running in reports the deployer's intent rather than its own contents; a container that carries
 * the SHA it was built from cannot lie about it, however the file system around it drifts.
 */

/**
 * `unknown` rather than a fallback to `git rev-parse` on purpose. A dev process started from a
 * working tree genuinely does not have a release identity — it has uncommitted files — and
 * inventing one would make the badge say something confident and wrong exactly where the risk of
 * confusion is highest.
 */
export const GIT_SHA = process.env.MFARM_GIT_SHA ?? 'unknown';
export const BUILT_AT = process.env.MFARM_BUILT_AT ?? null;

/** The first seven characters, which is what a human compares against a commit list. */
export const shortSha = (sha: string = GIT_SHA): string =>
  sha === 'unknown' ? 'dev' : sha.slice(0, 7);
