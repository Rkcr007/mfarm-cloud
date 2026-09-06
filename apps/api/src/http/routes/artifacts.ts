import type { FastifyInstance, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { withTenant, withSystem } from '../../db.ts';
import { recordSessionEvent } from '../../executionEvents.ts';
import { loadConfig } from '../../config.ts';
import { appStore, BlobTooLargeError } from '../../appstore.ts';
import { requireTenant, requireWorker } from '../server.ts';
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
const KINDS = new Set(['logcat', 'screenshot']);

const CONTENT_TYPE: Record<string, string> = {
  logcat: 'text/plain; charset=utf-8',
  screenshot: 'image/png',
};

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
           CONTENT_TYPE[kind], safeFilename(req.query.filename), cfg.artifactRetentionHours,
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

    const name = row.filename ?? `${row.kind}-${row.id.slice(0, 8)}${row.kind === 'screenshot' ? '.png' : '.txt'}`;
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
