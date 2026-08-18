import type { FastifyInstance, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { withTenant, withSystem } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { appStore, BlobTooLargeError } from '../../appstore.ts';
import { ApkParseError, readApkMetadata } from '../../apk.ts';
import { requireTenant, requireWorker } from '../server.ts';
import { badRequest, notFound, conflict } from '../errors.ts';

/**
 * The app library — upload a build once, install it onto a device you hold.
 *
 * Flow 5 of the MVP plan ("upload an APK, install, drive it by hand") and the first half of Phase
 * 3's first bullet. Deliberately OUTSIDE Appium: a suite that wants an app installed says so with
 * `appium:app` and always could, but the interactive path had no way to get an app onto a device at
 * all, which made the live view good for looking at a device and useless for looking at your app.
 *
 * Three parties touch these routes and they are not interchangeable:
 *
 *   a TENANT uploads a build and REQUESTS an install. It can never mark one done.
 *   a WORKER downloads the blob for an install it has been offered, and reports the outcome.
 *   nobody else reaches any of it — the server's default-deny auth hook sees to that.
 *
 * The worker's authority is the narrow part and worth stating plainly: `GET /apps/:id/blob`
 * authorises on the INSTALL, never on the worker's say-so. A host may read a build only while it is
 * holding an unfinished install of that exact build, for a device that host actually owns. There is
 * no route by which a worker can enumerate or fetch an org's apps, which matters because a worker
 * is the least trusted thing here that still holds a credential.
 */

/** Sessions that still hold a device. Installing against anything else has nowhere to land. */
const LIVE_SESSION_STATES = ['ALLOCATING', 'ACTIVE'];

interface AppRow {
  id: string;
  package_name: string;
  version_name: string | null;
  version_code: string | number | null;
  label: string | null;
  min_sdk: number | null;
  sha256: string;
  size_bytes: string | number;
  filename: string | null;
  platform: string;
  created_at: Date;
}

function appJson(r: AppRow) {
  return {
    id: r.id,
    packageName: r.package_name,
    versionName: r.version_name,
    // bigint arrives from pg as a string; both of these are small enough that Number is exact.
    versionCode: r.version_code === null ? null : Number(r.version_code),
    label: r.label,
    minSdk: r.min_sdk,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    filename: r.filename,
    platform: r.platform,
    createdAt: r.created_at,
  };
}

interface InstallRow {
  id: string;
  app_id: string;
  session_id: string;
  device_id: string;
  state: string;
  error: string | null;
  requested_at: Date;
  finished_at: Date | null;
}

function installJson(r: InstallRow) {
  return {
    id: r.id,
    appId: r.app_id,
    sessionId: r.session_id,
    deviceId: r.device_id,
    state: r.state,
    error: r.error,
    requestedAt: r.requested_at,
    finishedAt: r.finished_at,
  };
}

/**
 * A filename is decoration, so it is treated like one.
 *
 * It is displayed in the library and nothing resolves it to a path — but it is also attacker-chosen
 * text that will end up in a UI, so `basename` strips any directory a caller tried to smuggle in
 * and the length is capped rather than left to whatever fits in a text column.
 */
function safeFilename(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  // Control characters stripped, not escaped: this string is rendered in a console UI and read
  // out of a database by hand, and neither wants an embedded newline or a terminal escape.
  const name = basename(raw.trim()).replace(/[\u0000-\u001f\u007f]/g, '');
  if (name === '' || name === '.' || name === '..') return null;
  return name.slice(0, 128);
}

export async function appRoutes(app: FastifyInstance) {
  const cfg = loadConfig();
  const store = appStore(cfg.appStoreDir);

  /**
   * Take the request body as a STREAM.
   *
   * Registered inside this plugin, so it applies to these routes and nowhere else — Fastify
   * encapsulates content-type parsers, which is what keeps `application/octet-stream` from silently
   * becoming a stream on every other route in the server.
   *
   * Passing the payload straight through is the documented way to opt out of buffering, and opting
   * out is the whole point: `server.ts` sets a 1 MB `bodyLimit` for JSON, an APK is two to three
   * orders of magnitude larger than that, and raising the global limit to fit one would let every
   * other route accept a 512 MB JSON document. The size ceiling for THIS route is enforced by
   * `AppStore.put` as the bytes go past, which is also the only place it can be enforced honestly:
   * a chunked upload has no Content-Length to check.
   */
  app.addContentTypeParser(
    ['application/vnd.android.package-archive', 'application/octet-stream'],
    (_req, payload, done) => done(null, payload),
  );

  /**
   * Upload a build.
   *
   * The response is 201 for a new build and 200 for one this org already had — an upload is
   * idempotent on the file's own digest, so a CI job that uploads on every run costs one row and
   * one copy no matter how often it runs. That also makes the endpoint safe to retry, which matters
   * because it is the one request in this API that can take a minute.
   */
  app.post('/apps', {
    // Fastify's own check, for the case where a client does send an honest Content-Length. The
    // stream limit below still has to exist: this one cannot see a chunked body coming.
    bodyLimit: cfg.appMaxUploadBytes,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { filename: { type: 'string', maxLength: 256 } },
      },
    },
  }, async (req: FastifyRequest<{ Querystring: { filename?: string } }>, reply) => {
    const { orgId } = requireTenant(req);

    // The stream-through parser is registered for two content types; anything else Fastify has
    // already parsed into an object by now. Caught here so the answer names the fix, rather than
    // failing inside `pipeline` with a TypeError and a 500 for what is a caller's mistake.
    const body = req.body as unknown;
    if (typeof (body as Readable)?.pipe !== 'function') {
      throw badRequest(
        'Send the APK as a raw body with `Content-Type: application/vnd.android.package-archive` ' +
          '(or application/octet-stream). This endpoint takes bytes, not JSON.',
      );
    }

    let blob;
    try {
      blob = await store.put(body as Readable, cfg.appMaxUploadBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        throw badRequest(`This upload exceeds APP_MAX_UPLOAD_BYTES (${err.limit} bytes).`);
      }
      throw err;
    }

    let meta;
    try {
      meta = await readApkMetadata(blob.path);
    } catch (err) {
      // Only clean up a blob THIS request created. An identical upload that already succeeded once
      // is referenced by a row, and deleting its bytes because a second caller sent something we
      // could not parse would break the first one's library.
      if (blob.created) await store.remove(blob.sha256);
      if (err instanceof ApkParseError) throw badRequest(err.message);
      throw err;
    }

    const filename = safeFilename(req.query.filename)
      ?? safeFilename(req.headers['x-filename'])
      ?? `${meta.packageName}.apk`;

    const { row, created } = await withTenant(orgId, async (c) => {
      const insert = await c.query<AppRow>(
        `INSERT INTO app_builds (org_id, package_name, version_name, version_code, label,
                                 min_sdk, sha256, size_bytes, filename)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (org_id, sha256) DO NOTHING
         RETURNING *`,
        [orgId, meta.packageName, meta.versionName, meta.versionCode, meta.label,
         meta.minSdk, blob.sha256, blob.sizeBytes, filename],
      );
      if (insert.rows[0]) return { row: insert.rows[0], created: true };
      // Lost the race, or simply a re-upload. Either way the existing row is the answer, and it is
      // the ORIGINAL metadata — re-parsing cannot disagree with it, because the bytes are the same.
      const existing = await c.query<AppRow>(
        'SELECT * FROM app_builds WHERE org_id = $1 AND sha256 = $2', [orgId, blob.sha256],
      );
      return { row: existing.rows[0]!, created: false };
    });

    return reply.code(created ? 201 : 200).send({ app: appJson(row), deduplicated: !created });
  });

  /** The library. Newest first, optionally narrowed to one package. */
  app.get<{ Querystring: { package?: string; limit?: string } }>('/apps', async (req) => {
    const { orgId } = requireTenant(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const pkg = typeof req.query.package === 'string' ? req.query.package : null;

    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<AppRow>(
        `SELECT * FROM app_builds
          WHERE ($1::text IS NULL OR package_name = $1)
          ORDER BY created_at DESC
          LIMIT $2`,
        [pkg, limit],
      );
      return rows;
    });
    return { apps: rows.map(appJson) };
  });

  app.get<{ Params: { id: string } }>('/apps/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<AppRow>('SELECT * FROM app_builds WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    // RLS makes another org's build indistinguishable from one that does not exist, which is the
    // right disclosure boundary: a 403 would confirm the id.
    if (!row) throw notFound('App');
    return { app: appJson(row) };
  });

  /**
   * The bytes, for a WORKER that has been offered an install of them.
   *
   * The `installId` is not a convenience — it is the entire authorization. Without it the only
   * question this route could ask is "is this a valid worker token", and the answer would let any
   * host in the fleet download any org's builds. With it, the query below has to find an unfinished
   * install of THIS app, on a device belonging to THIS host, before a single byte is served.
   *
   * Runs on the owner pool because none of that is tenant-scoped — a worker has no org and must
   * never acquire one. The org never enters the decision; the join does all of the work.
   */
  app.get<{ Params: { id: string }; Querystring: { installId?: string } }>(
    '/apps/:id/blob',
    async (req, reply) => {
      const { hostId } = requireWorker(req);
      const installId = req.query.installId;
      if (!installId) throw badRequest('installId is required: a worker may read a build only for an install it is holding.');

      const row = await withSystem(async (c) => {
        const { rows } = await c.query<{ sha256: string; size_bytes: string; filename: string | null }>(
          `SELECT a.sha256, a.size_bytes, a.filename
             FROM app_installs i
             JOIN devices d    ON d.id = i.device_id
             JOIN app_builds a ON a.id = i.app_id
            WHERE i.id = $1 AND i.app_id = $2 AND d.host_id = $3 AND i.state = 'PENDING'`,
          [installId, req.params.id, hostId],
        );
        return rows[0];
      });
      // One answer for "no such install", "not your install", "already finished" and "wrong app".
      // Distinguishing them would let a worker probe the fleet for install ids it does not hold.
      if (!row) throw notFound('Pending install for this build on this host');

      const size = await store.size(row.sha256);
      if (size === null) {
        // The row survived and the blob did not — the exact failure APP_STORE_DIR defaulting to a
        // temp directory produces after a reboot. Say so, rather than streaming a 404 body as an APK.
        throw notFound(`Blob ${row.sha256} is missing from the app store`);
      }

      return reply
        .header('content-type', 'application/vnd.android.package-archive')
        .header('content-length', String(size))
        .header('x-mfarm-sha256', row.sha256)
        .send(store.read(row.sha256));
    },
  );

  /**
   * Request an install: put build X on the device session Y is holding.
   *
   * Returns 202, and the verb matters. Nothing here reaches a device — the control plane cannot
   * dial a worker — so this creates a job the next heartbeat carries down, and answering 201 would
   * imply the app is on the device when the worker has not even been told yet. Poll the returned
   * install, or read `GET /v1/sessions/:id/installs`.
   *
   * Everything that makes this safe is in the INSERT's SELECT, running under the tenant's own RLS:
   * the session must be this org's and live, the build must be this org's, and the device is taken
   * from the session rather than from the request — so there is no field a caller could set to aim
   * an install at hardware it does not hold.
   */
  app.post<{ Params: { id: string }; Body: { appId: string } }>(
    '/sessions/:id/installs',
    {
      schema: {
        body: {
          type: 'object', required: ['appId'], additionalProperties: false,
          // `pattern`, not `format: 'uuid'` — nothing else in this API relies on ajv-formats being
          // registered, and a schema that silently accepts anything is worse than no schema.
          properties: {
            appId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { orgId } = requireTenant(req);
      const sessionId = req.params.id;
      const { appId } = req.body;

      const row = await withTenant(orgId, async (c) => {
        // Checked first, and separately from the INSERT, purely so the caller learns WHICH
        // precondition failed. A single INSERT ... SELECT returning zero rows is correct and
        // useless to the person reading the error.
        const { rows: pre } = await c.query<{ state: string; device_id: string | null; can_install: boolean | null }>(
          `SELECT s.state::text AS state, s.device_id,
                  (d.capabilities ? 'app-install') AS can_install
             FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
            WHERE s.id = $1`,
          [sessionId],
        );
        if (!pre[0]) throw notFound('Session');
        if (!LIVE_SESSION_STATES.includes(pre[0].state) || !pre[0].device_id) {
          throw conflict('session_not_live', `Session ${sessionId} is ${pre[0].state} and holds no device. Installs need a live session.`);
        }
        if (pre[0].can_install !== true) {
          throw conflict(
            'capability_missing',
            'The device on this session does not declare the `app-install` capability.',
          );
        }

        const { rows } = await c.query<InstallRow>(
          `INSERT INTO app_installs (org_id, app_id, session_id, device_id, fence)
           SELECT s.org_id, a.id, s.id, s.device_id, s.fence
             FROM sessions s, app_builds a
            WHERE s.id = $1 AND a.id = $2
              AND s.state = ANY($3::session_state[])
              AND s.device_id IS NOT NULL AND s.fence IS NOT NULL
           RETURNING *`,
          [sessionId, appId, LIVE_SESSION_STATES],
        );
        // The session passed its checks a statement ago, so the only row the SELECT can be missing
        // now is the build — which RLS hides when it belongs to another org.
        if (!rows[0]) throw notFound('App');
        return rows[0];
      });

      return reply.code(202).send({
        install: installJson(row),
        message: 'Queued. The worker holding this device performs it on its next heartbeat.',
      });
    },
  );

  /** Every install requested against one session, newest first. */
  app.get<{ Params: { id: string } }>('/sessions/:id/installs', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<InstallRow>(
        `SELECT * FROM app_installs WHERE session_id = $1 ORDER BY requested_at DESC LIMIT 100`,
        [req.params.id],
      );
      return rows;
    });
    return { installs: rows.map(installJson) };
  });

  /** One install, for polling. */
  app.get<{ Params: { id: string } }>('/installs/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<InstallRow>('SELECT * FROM app_installs WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    if (!row) throw notFound('Install');
    return { install: installJson(row) };
  });
}
