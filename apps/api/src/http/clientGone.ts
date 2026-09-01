import type { FastifyReply } from 'fastify';

/**
 * Has the CLIENT gone away — as opposed to the request body simply having been read?
 *
 * `req.raw.destroyed` is the obvious-looking answer, it is what both waits used, and it is wrong
 * in a way that NO test using `app.inject()` can see. `req.raw` is the IncomingMessage, and its
 * readable side is destroyed once the body has been consumed — which Fastify does before the
 * handler runs. On a perfectly healthy request it therefore flips to true at the first `await`,
 * while the client is still sitting there waiting for its response.
 *
 * Measured rather than reasoned about: over a real socket `destroyed` is false on entry to the
 * handler and true 50 ms later, with `req.raw.socket.destroyed` and `reply.raw.destroyed` both
 * still false. Under `app.inject()` it stays false forever.
 *
 * What that cost: `mfarm:appId` failed on EVERY session — the install wait abandoned itself on
 * its first poll and reported "still installing after 240s" having waited about a millisecond —
 * and `mfarm:queueTimeoutSeconds` never queued, returning "no device became free" immediately.
 * Both looked like infrastructure problems and neither was.
 *
 * The RESPONSE is what tracks the connection. `close` on a ServerResponse fires when the response
 * completes or when the connection is torn down early; consulted only while the handler is still
 * working — before a byte has been sent — it can only mean the second.
 */
export function clientGone(reply: FastifyReply): () => boolean {
  let gone = false;
  reply.raw.on('close', () => { gone = true; });
  return () => gone;
}

/**
 * WHY THIS LIVES IN ITS OWN FILE rather than beside the hub that first needed it.
 *
 * Because there are now two callers — the hub's two long waits, and the execution-event stream —
 * and this is exactly the kind of check that must not exist twice. ADR-0011 declined to verify the
 * automation grant in two places on the same grounds: a check that exists twice eventually
 * disagrees with itself, and the disagreement surfaces as an infrastructure mystery rather than as
 * a bug in the copy that drifted.
 *
 * It matters more here than the general rule suggests, because the WRONG version of this looks
 * completely correct and passes every test written with `app.inject()`.
 */
