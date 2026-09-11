import type { FastifyInstance, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { withTenant, withSystem } from '../../db.ts';
import { recordSessionEvent } from '../../executionEvents.ts';
import { loadConfig } from '../../config.ts';
import { appStore, BlobTooLargeError } from '../../appstore.ts';
import { requireTenant, requireTenantDestructive, requireWorker } from '../server.ts';
import { badRequest, conflict, notFound } from '../errors.ts';

/**
 * Session artifacts: what a failed run leaves behind.
 *
 * WHY THIS EXISTS. Logcat and screenshots have worked since ADR-0007 and lived only in the browser
 * tab that watched them. Close the tab and the evidence is gone; a CI run never had a tab at all.
 * So "the suite went red at 02:14" has been unanswerable after the fact, and answering it is most
 * of what a farm offers over running the suite on a laptop.
 *
 * THREE PROPERTIES, EACH LEARNED SOMEWHERE ELSE IN THIS REPO:
 *
 *   Upload is worker -> API, never API -> worker. ADR-0006: the control plane holds no socket to
 *   the farm and gains none here.
 *
 *   The paying org is DERIVED from the session inside `artifact_record`, never read from the
 *   worker's request. Architecture rule 4 — metering took the org from the worker's body once, and
 *   that was a billing forgery waiting to happen.
 *
 *   A release is never blocked on an upload. A device that cannot ship its logcat is still a device
 *   that must reset, so every failure here is reported to the worker as something to drop rather
 *   than something to retry forever.
 */

/** What a worker may declare. Anything else is refused rather than stored under a made-up kind. */
const KINDS = new Set(['logcat', 'screenshot', 'video']);

const CONTENT_TYPE: Record<string, string> = {
  logcat: 'text/plain; charset=utf-8',
  screenshot: 'image/png',
  // WebM/VP8, because that is what cvd's host-side recorder writes and re-containering it would
  // mean a transcode on the device host — the CPU this whole design exists to protect.
  // docs/VIDEO_EVIDENCE.md §4 has the tradeoff against MP4/H.264 written out.
  video: 'video/webm',
};

/** File extension per kind, for the name a browser sees on a download. */
const EXTENSION: Record<string, string> = { screenshot: '.png', video: '.webm', logcat: '.txt' };

interface ArtifactRow {
  id: string;
  session_id: string;
  device_id: string | null;
  kind: string;
  sha256: string;
  size_bytes: string;
  content_type: string;
  filename: string | null;
  created_at: Date;
  expires_at: Date;
  context: Record<string, unknown>;
}

function artifactJson(a: ArtifactRow) {
  return {
    id: a.id,
    sessionId: a.session_id,
    deviceId: a.device_id,
    kind: a.kind,
    sha256: a.sha256,
    // bigint arrives as a string from pg; a size is small enough to be a number and a caller
    // formatting "1.2 MB" should not have to know that.
    sizeBytes: Number(a.size_bytes),
    contentType: a.content_type,
    filename: a.filename,
    createdAt: a.created_at.toISOString(),
    expiresAt: a.expires_at.toISOString(),
    /**
     * Why this was captured (migration 040). `{}` on a release-time capture, which is most of them.
     *
     * Sent always rather than omitted when empty: a screen that has to distinguish "no context" from
     * "the field is not in this response" is a screen that will get it wrong once, and the column
     * has a NOT NULL default so there is no third state to represent.
     */
    context: a.context ?? {},
  };
}

/** Strip any path a caller put in a filename. It is a label on a download, never a path. */
function safeFilename(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const b = basename(v.trim()).replace(/[^\w.\-]/g, '_').slice(0, 128);
  return b && b !== '.' && b !== '..' ? b : null;
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  const store = appStore(cfg.artifactDir);

  // Stream, do not buffer — same reasoning as the app upload, and encapsulated to this plugin so
  // `application/octet-stream` does not silently become a stream on every other route.
  app.addContentTypeParser(
    ['application/octet-stream', 'text/plain', 'image/png'],
    (_req, payload, done) => done(null, payload),
  );

  /**
   * POST /v1/sessions/:id/artifacts?kind=logcat|screenshot — worker-authenticated upload.
   *
   * The device is named in the query rather than inferred, because a host runs several and the
   * definer function has to check the pair. `artifact_record` returns NULL when the session is not
   * on that device or that device is not on that host, and all three failures are one 409 — telling
   * a worker WHICH of them was wrong lets it probe the rest of the fleet.
   */
  app.post<{ Params: { id: string };
             Querystring: { kind?: string; device?: string; filename?: string; context?: string } }>(
    '/sessions/:id/artifacts',
    {
      bodyLimit: cfg.artifactMaxUploadBytes,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', maxLength: 32 },
            device: { type: 'string', maxLength: 64 },
            filename: { type: 'string', maxLength: 256 },
            /**
             * Why this artifact was captured (migration 040), echoed back by the worker from the
             * action that asked for it.
             *
             * A QUERY PARAMETER carrying JSON, because the BODY IS THE BYTES — this endpoint takes
             * an octet-stream and there is nowhere else to put it. Capped hard: it is a label, and
             * a worker that could write a megabyte of jsonb per artifact has found a way to fill
             * the control plane's disk with something that is not evidence.
             */
            context: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (req, reply) => {
      const { hostId } = requireWorker(req);
      const kind = req.query.kind ?? '';
      if (!KINDS.has(kind)) {
        throw badRequest(`kind must be one of ${[...KINDS].join(', ')}.`);
      }
      const deviceId = req.query.device;
      if (!deviceId) throw badRequest('device is required — a host runs more than one.');

      const body = req.body as unknown;
      if (typeof (body as Readable)?.pipe !== 'function') {
        throw badRequest(
          'Send the artifact as a raw body with `Content-Type: application/octet-stream`. ' +
            'This endpoint takes bytes, not JSON.',
        );
      }

      /**
       * PARSED BEFORE THE BYTES ARE STORED, so a malformed label is a 400 rather than a blob
       * written to disk and then orphaned by a failing insert.
       *
       * A NON-OBJECT IS REFUSED, not coerced. `context` is read back by the run screen as a record
       * with a `source` — a bare string or an array reaching the column would render as nothing and
       * be indistinguishable from an artifact that carried no context at all.
       */
      let context = '{}';
      if (req.query.context !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(req.query.context);
        } catch {
          throw badRequest('context must be a JSON object.');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw badRequest('context must be a JSON object.');
        }
        context = JSON.stringify(parsed);
      }

      let blob;
      try {
        blob = await store.put(body as Readable, cfg.artifactMaxUploadBytes);
      } catch (err) {
        if (err instanceof BlobTooLargeError) {
          throw badRequest(`This upload exceeds ARTIFACT_MAX_UPLOAD_BYTES (${err.limit} bytes).`);
        }
        throw err;
      }

      // `withSystem`, like every other worker-facing write (008, `device_reset_complete`). A worker
      // is not a tenant, so there is no org to scope the connection to — the authorization lives
      // inside `artifact_record`, which is the whole point of putting the host id in its signature.
      const id = await withSystem(async (c) => {
        const r = await c.query<{ id: string | null }>(
          `SELECT artifact_record($1,$2,$3,$4,$5,$6,$7,$8, make_interval(hours => $9), $10::jsonb) AS id`,
          [hostId, deviceId, req.params.id, kind, blob.sha256, blob.sizeBytes,
           CONTENT_TYPE[kind], safeFilename(req.query.filename),
           // A recording gets its OWN retention, and it is shorter. It is an order of magnitude
           // larger than everything else a session leaves behind, so sharing one number with logcat
           // means the disk conversation can only be had by shortening logcat too.
           kind === 'video' ? cfg.videoRetentionHours : cfg.artifactRetentionHours,
           context],
        );
        return r.rows[0]?.id ?? null;
      });

      if (!id) {
        // Only clean up bytes THIS request created. An identical blob already referenced by another
        // row must survive — content addressing means the file is shared.
        if (blob.created) await store.remove(blob.sha256);
        throw conflict('not_your_session',
          'That session is not on that device, or that device is not on this host.');
      }

      /**
       * EVIDENCE LANDING IS A TIMELINE EVENT (migration 042).
       *
       * The `detail` carries the artifact id, so the entry is a LINK to the picture rather than a
       * note that a picture exists somewhere — and it carries the context from 040, so a screenshot
       * taken for a failure sits under that failure rather than beside it.
       *
       * `recordSessionEvent` is a no-op for a session with no run, which is most console captures,
       * and it swallows its own errors. An artifact is stored either way: a timeline that could not
       * be written must never cost somebody the evidence itself.
       */
      const org = await withSystem(async (c) => (await c.query<{ org_id: string }>(
        'SELECT org_id FROM artifacts WHERE id = $1', [id])).rows[0]?.org_id ?? null);
      if (org) {
        await recordSessionEvent(org, req.params.id, 'artifact-created', {
          artifactId: id, kind, sizeBytes: blob.sizeBytes, context: JSON.parse(context),
        });
      }

      return reply.code(201).send({ artifact: { id, kind, sha256: blob.sha256, sizeBytes: blob.sizeBytes } });
    },
  );

  /** GET /v1/sessions/:id/artifacts — what this session left behind. Newest first. */
  app.get<{ Params: { id: string } }>('/sessions/:id/artifacts', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<ArtifactRow>(
        `SELECT * FROM artifacts WHERE session_id = $1 ORDER BY created_at DESC`,
        [req.params.id],
      );
      return r.rows;
    });
    return { artifacts: rows.map(artifactJson) };
  });

  /** GET /v1/artifacts — the whole org's, newest first. What the Sessions list counts against. */
  app.get<{ Querystring: { limit?: string; kind?: string } }>('/artifacts', async (req) => {
    const { orgId } = requireTenant(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const kind = req.query.kind && KINDS.has(req.query.kind) ? req.query.kind : null;
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<ArtifactRow>(
        `SELECT * FROM artifacts
          WHERE ($2::text IS NULL OR kind = $2)
          ORDER BY created_at DESC LIMIT $1`,
        [limit, kind],
      );
      return r.rows;
    });
    return { artifacts: rows.map(artifactJson) };
  });

  /**
   * GET /v1/artifacts/:id/blob — the bytes, streamed.
   *
   * RLS scopes the row lookup, so a caller cannot name another org's artifact — and because the
   * only way to reach a blob is through a row, a caller cannot name a digest it does not own
   * either. That is the property content addressing gives away for free and is easy to lose by
   * adding a "download by sha" convenience route. Do not add one.
   */
  /**
   * Delete evidence — one artifact, or everything a session left behind (migration 046).
   *
   * THE TENANT'S DATA, THE TENANT'S DELETE. Retention used to be an operator's environment variable
   * applied to everybody and invisible from the console: a person could neither see when a
   * recording of their checkout flow would go, nor take it off a shared disk sooner. Both doors are
   * here, and both are scoped to the caller's org inside the SQL rather than by anything in the
   * request — architecture rule 4, the same rule that keeps a worker from naming its own org.
   *
   * ROWS FIRST, FILES SECOND, which is `expire_artifacts`' order and for its reason: crash between
   * the two and the store holds a file nothing references, which costs disk and breaks nothing. The
   * other order leaves a row pointing at bytes that are gone, which a person discovers as a 404
   * while chasing a failure.
   *
   * The blob is CONTENT-ADDRESSED and shared, so only `blob_orphaned` may authorise an unlink — two
   * sessions that captured identical bytes reference one file, and deleting it because one of them
   * was removed breaks the other's download.
   */
  async function removeBlobs(rows: Array<{ sha256: string; blob_orphaned: boolean }>): Promise<number> {
    let removed = 0;
    for (const sha of new Set(rows.filter((r) => r.blob_orphaned).map((r) => r.sha256))) {
      await store.remove(sha);
      removed++;
    }
    return removed;
  }

  app.delete<{ Params: { id: string } }>('/artifacts/:id', async (req, reply) => {
    const { orgId } = requireTenantDestructive(req);
    const rows = await withTenant(orgId, async (c) => (await c.query<{
      sha256: string; blob_orphaned: boolean;
    }>('SELECT sha256, blob_orphaned FROM delete_artifact($1, $2)', [orgId, req.params.id])).rows);

    // NOT FOUND rather than "deleted nothing". An id belonging to another org answers exactly like
    // one that never existed, which is the disclosure boundary every other route here holds.
    if (!rows.length) throw notFound('Artifact');
    const blobsDeleted = await removeBlobs(rows);
    return reply.code(200).send({ deleted: 1, blobsDeleted });
  });

  app.delete<{ Params: { id: string } }>('/sessions/:id/artifacts', async (req, reply) => {
    const { orgId } = requireTenantDestructive(req);
    const rows = await withTenant(orgId, async (c) => (await c.query<{
      sha256: string; blob_orphaned: boolean;
    }>('SELECT sha256, blob_orphaned FROM delete_session_evidence($1, $2)', [orgId, req.params.id])).rows);
    const blobsDeleted = await removeBlobs(rows);
    // 200 with a zero count, not a 404: "this session has no evidence" is a true and useful answer,
    // and a session whose evidence already expired is the ordinary case rather than a mistake.
    return reply.code(200).send({ deleted: rows.length, blobsDeleted });
  });

  /**
   * Delete the session record itself, and everything that hangs off it.
   *
   * SEPARATE FROM THE EVIDENCE DELETE, and much heavier: this removes the WebDriver session, the
   * commands, the reported results and the attempt ledger by cascade. **Metering survives** —
   * `metering_events.session_id` is `ON DELETE SET NULL` (001), so billing keeps its rows and merely
   * forgets which session they came from. Had that been CASCADE this endpoint could not exist: a
   * tenant would be able to delete its own invoice, which is architecture rule 4 read backwards.
   *
   * A LIVE SESSION IS REFUSED by `purge_session`, because deleting one strands its device at a
   * fence nothing can match and the reaper never releases it.
   *
   * `/record` RATHER THAN `DELETE /sessions/:id`, WHICH IS ALREADY TAKEN and means something almost
   * opposite: `sessions.ts` uses that verb to RELEASE a device — end the lease, restore the
   * snapshot, hand it back to the pool. Two routes on one method and path is a registration error
   * in Fastify and would have been a confusing endpoint even if it were not: "delete the session"
   * has meant "stop using the device" in this API since 001, and the destructive one has to be the
   * one that says so in its path.
   */
  app.delete<{ Params: { id: string } }>('/sessions/:id/record', async (req, reply) => {
    const { orgId } = requireTenantDestructive(req);
    try {
      const rows = await withTenant(orgId, async (c) => (await c.query<{
        sha256: string; blob_orphaned: boolean;
      }>('SELECT sha256, blob_orphaned FROM purge_session($1, $2)', [orgId, req.params.id])).rows);
      const blobsDeleted = await removeBlobs(rows);
      return reply.code(200).send({ deleted: true, blobsDeleted });
    } catch (e) {
      // The state guard raises rather than returning, so the message names the state a person can
      // act on ("release it before deleting it") instead of a generic 500.
      const msg = (e as { message?: string }).message ?? '';
      if (/still (QUEUED|ALLOCATING|ACTIVE|ENDING)/.test(msg)) throw conflict('session_live', msg);
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/artifacts/:id/blob', async (req, reply) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const r = await c.query<ArtifactRow>('SELECT * FROM artifacts WHERE id = $1', [req.params.id]);
      return r.rows[0] ?? null;
    });
    if (!row) throw notFound('Artifact');

    const size = await store.size(row.sha256);
    if (size === null) {
      // The row survived and the blob did not — what ARTIFACT_DIR defaulting to a temp directory
      // produces after a reboot. Say so, rather than streaming a 404 body as a screenshot.
      throw notFound(`Blob ${row.sha256} is missing from the artifact store`);
    }

    const name = row.filename ?? `${row.kind}-${row.id.slice(0, 8)}${EXTENSION[row.kind] ?? '.txt'}`;

    /**
     * RANGE REQUESTS, AND THEY ARE NOT OPTIONAL FOR VIDEO.
     *
     * Without `accept-ranges`, Chrome will not seek a `<video>` at all — the scrubber is dead and
     * the whole file downloads before the first frame plays. For a 40 MB recording that turns "what
     * happened just before it failed?" back into a download and a media player, which is precisely
     * the question this feature exists to answer in one click.
     *
     * Served for every kind rather than only video: it is the same eight lines, and a browser that
     * resumes an interrupted logcat download is not a problem to solve twice.
     */
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
        .header('content-type', row.content_type)
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('content-length', String(end - start + 1))
        .header('content-disposition', `inline; filename="${name}"`)
        .header('x-mfarm-sha256', row.sha256)
        .send(store.read(row.sha256, { start, end }));
    }

    return reply
      .header('content-type', row.content_type)
      .header('content-length', String(size))
      // `inline` so a screenshot opens in the tab and a logcat reads in the browser. A person
      // chasing a failure wants to look, not to manage a downloads folder.
      .header('content-disposition', `inline; filename="${name}"`)
      .header('x-mfarm-sha256', row.sha256)
      .send(store.read(row.sha256));
  });
}
