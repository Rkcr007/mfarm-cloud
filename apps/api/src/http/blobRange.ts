import type { FastifyReply, FastifyRequest } from 'fastify';
import type { appStore } from '../appstore.ts';

/**
 * Stream a stored blob, honouring a single byte range.
 *
 * ONE COPY, used by `/v1/artifacts/:id/blob` and by the share page's recording (ADR-0040). The range
 * arithmetic has one trap that already produced a silent stall once — see the suffix comment — and a
 * second copy in a second route is how the two would come to disagree about it.
 *
 * RANGE REQUESTS ARE NOT OPTIONAL FOR VIDEO. Without `accept-ranges`, Chrome will not seek a `<video>`
 * at all — the scrubber is dead and the whole file downloads before the first frame plays. For a
 * 40 MB recording that turns "what happened just before it failed?" back into a download and a media
 * player, which is precisely the question the recording exists to answer in one click.
 *
 * Headers the caller wants on every response (a sha, `no-store`) are set on `reply` before calling.
 */
export function sendBlob(
  req: FastifyRequest,
  reply: FastifyReply,
  store: ReturnType<typeof appStore>,
  size: number,
  blob: { sha256: string; contentType: string; disposition: string },
): FastifyReply {
  reply.header('accept-ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range) {
    // An open-ended suffix (`bytes=-500`) means the LAST n bytes, which is a different request
    // from "from byte 0". Getting this backwards serves the head of the file for the tail and the
    // player simply stalls, with no error anywhere.
    const suffix = range[1] === '';
    let start = suffix ? size - Number(range[2] || 0) : Number(range[1]);
    let end = suffix || range[2] === '' ? size - 1 : Number(range[2]);
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    return reply
      .code(206)
      .header('content-type', blob.contentType)
      .header('content-range', `bytes ${start}-${end}/${size}`)
      .header('content-length', String(end - start + 1))
      .header('content-disposition', blob.disposition)
      .send(store.read(blob.sha256, { start, end }));
  }

  return reply
    .header('content-type', blob.contentType)
    .header('content-length', String(size))
    .header('content-disposition', blob.disposition)
    .send(store.read(blob.sha256));
}
