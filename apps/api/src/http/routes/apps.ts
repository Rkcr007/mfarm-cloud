import type { FastifyInstance, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { withTenant, withSystem } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { appStore, BlobTooLargeError } from '../../appstore.ts';
import { abiMismatchReason, ApkParseError, readApkMetadata } from '../../apk.ts';
import type { AppActionKind } from '@mfarm/protocol';
import { LIVE_SESSION_STATES, requestAppAction, type AppActionRow } from '../../appactions.ts';
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

interface AppRow {
  id: string;
  package_name: string;
  version_name: string | null;
  version_code: string | number | null;
  label: string | null;
  min_sdk: number | null;
  abis: string[] | null;
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
    // `[]` (no native code) and `null` (uploaded before we parsed for it) are deliberately NOT
    // collapsed: the first is a finding, the second is an absence, and only the second is worth
    // backfilling. Both allow an install.
    abis: r.abis,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    filename: r.filename,
    platform: r.platform,
    createdAt: r.created_at,
  };
}

type ActionRow = AppActionRow;

function actionJson(r: ActionRow) {
  return {
    id: r.id,
    kind: r.kind,
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
                                 min_sdk, sha256, size_bytes, filename, abis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (org_id, sha256) DO NOTHING
         RETURNING *`,
        [orgId, meta.packageName, meta.versionName, meta.versionCode, meta.label,
         meta.minSdk, blob.sha256, blob.sizeBytes, filename, JSON.stringify(meta.abis)],
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
   * The `actionId` is not a convenience — it is the entire authorization. Without it the only
   * question this route could ask is "is this a valid worker token", and the answer would let any
   * host in the fleet download any org's builds. With it, the query below has to find an unfinished
   * INSTALL of THIS app, on a device belonging to THIS host, before a single byte is served.
   *
   * `kind = 'install'` is part of that and not a tidiness clause: launch and uninstall carry a
   * package name and move no bytes, so a pending launch must not become a licence to read the
   * build's contents.
   *
   * Runs on the owner pool because none of that is tenant-scoped — a worker has no org and must
   * never acquire one. The org never enters the decision; the join does all of the work.
   */
  app.get<{ Params: { id: string }; Querystring: { actionId?: string } }>(
    '/apps/:id/blob',
    async (req, reply) => {
      const { hostId } = requireWorker(req);
      const actionId = req.query.actionId;
      if (!actionId) throw badRequest('actionId is required: a worker may read a build only for an install it is holding.');

      const row = await withSystem(async (c) => {
        const { rows } = await c.query<{ sha256: string; size_bytes: string; filename: string | null }>(
          `SELECT a.sha256, a.size_bytes, a.filename
             FROM app_actions i
             JOIN devices d    ON d.id = i.device_id
             JOIN app_builds a ON a.id = i.app_id
            WHERE i.id = $1 AND i.app_id = $2 AND d.host_id = $3
              AND i.state = 'PENDING' AND i.kind = 'install'`,
          [actionId, req.params.id, hostId],
        );
        return rows[0];
      });
      // One answer for "no such action", "not your action", "already finished", "wrong app" and
      // "that is a launch, not an install". Distinguishing them would let a worker probe the fleet.
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
   * Request an app action: install, launch or uninstall build X on the device session Y holds.
   *
   * Returns 202, and the verb matters. Nothing here reaches a device — the control plane cannot
   * dial a worker — so this creates a job the next heartbeat carries down, and answering 201 would
   * imply the app is on the device when the worker has not even been told yet. Poll the returned
   * action, or read `GET /v1/sessions/:id/app-actions`.
   *
   * Everything that makes this safe is in the INSERT's SELECT, running under the tenant's own RLS:
   * the session must be this org's and live, the build must be this org's, and the device is taken
   * from the session rather than from the request — so there is no field a caller could set to aim
   * an action at hardware it does not hold.
   */
  app.post<{ Params: { id: string }; Body: { appId?: string; kind?: AppActionKind } }>(
    '/sessions/:id/app-actions',
    {
      schema: {
        body: {
          // `appId` is no longer required BY THE SCHEMA, because `screenshot` names no app. The
          // handler enforces it per-kind instead, so the error says which verb needs what rather
          // than "must have required property appId" for a request that correctly omitted it.
          type: 'object', additionalProperties: false,
          properties: {
            // `pattern`, not `format: 'uuid'` — nothing else in this API relies on ajv-formats being
            // registered, and a schema that silently accepts anything is worse than no schema.
            appId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            // Defaulted rather than required, so the shape that existed before launch and uninstall
            // did keeps working and reads the same.
            kind: {
              type: 'string',
              enum: ['install', 'launch', 'uninstall', 'screenshot'],
              default: 'install',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { orgId } = requireTenant(req);
      const sessionId = req.params.id;
      const { appId } = req.body;
      const kind: AppActionKind = req.body.kind ?? 'install';

      // Per-kind, so the message names the verb. A `screenshot` with an appId is ACCEPTED rather
      // than refused — recording which build was on screen is a reasonable thing to want, and the
      // schema's job is to stop nonsense, not to stop specificity.
      if (kind !== 'screenshot' && !appId) {
        throw badRequest(`A \`${kind}\` needs an \`appId\` — the build to act on. Only \`screenshot\` acts on no app.`);
      }

      const row = await withTenant(orgId, async (c) => {
        // Checked first, and separately from the INSERT, purely so the caller learns WHICH
        // precondition failed. A single INSERT ... SELECT returning zero rows is correct and
        // useless to the person reading the error.
        // The capability a verb needs depends on the verb. `screenshot` is not an app action in
        // the capability sense — a tier can capture a screen without being able to install
        // anything — so demanding `app-install` for it would refuse the one device that could
        // actually serve it.
        const needs = kind === 'screenshot' ? 'screenshot' : 'app-install';
        const { rows: pre } = await c.query<{
          state: string; device_id: string | null; capable: boolean | null;
          device_abis: string[] | null; device_model: string | null;
        }>(
          `SELECT s.state::text AS state, s.device_id,
                  (d.capabilities ? $2) AS capable,
                  d.abis AS device_abis, d.model AS device_model
             FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
            WHERE s.id = $1`,
          [sessionId, needs],
        );
        if (!pre[0]) throw notFound('Session');
        if (!LIVE_SESSION_STATES.includes(pre[0].state) || !pre[0].device_id) {
          throw conflict('session_not_live', `Session ${sessionId} is ${pre[0].state} and holds no device. App actions need a live session.`);
        }
        if (pre[0].capable !== true) {
          throw conflict(
            'capability_missing',
            `The device on this session does not declare the \`${needs}\` capability.`,
          );
        }

        /**
         * ABI PREFLIGHT — every virtual device in this farm executes x86_64.
         *
         * Most real APKs ship arm64-only native libraries, so without this the upload dies inside
         * `adb install` with INSTALL_FAILED_NO_MATCHING_ABIS and the customer is left to work out
         * that the farm, not their build, is what cannot do this. Refusing here, by name, costs one
         * field on a query that was already running.
         *
         * It predates ADR-0017, when the devices claimed Samsung model names and this was the thing
         * that made the claim defensible. The claim is gone and the wall remains, because the wall
         * was never caused by the claim.
         *
         * ONLY for `install`. A `launch` or `uninstall` acts on something already on the device, and
         * a build's ABIs say nothing about whether that is possible.
         */
        if (kind === 'install' && appId) {
          const { rows: build } = await c.query<{ abis: string[] | null }>(
            'SELECT abis FROM app_builds WHERE id = $1', [appId],
          );
          // A missing row is left to `requestAppAction` below, which already answers it as a 404 —
          // RLS hides another org's build, and duplicating that here would leak its existence.
          const reason = build[0] && abiMismatchReason(
            { abis: build[0].abis ?? [] },
            { abis: pre[0].device_abis, model: pre[0].device_model },
          );
          if (reason) throw conflict('abi_mismatch', reason);
        }

        const action = await requestAppAction(c, { sessionId, appId, kind });
        // The session passed its checks a statement ago, so the only row the SELECT can be missing
        // now is the build — which RLS hides when it belongs to another org. A screenshot names no
        // build, so for that kind this cannot fire at all.
        if (!action) throw notFound('App');
        return action;
      });

      return reply.code(202).send({
        action: actionJson(row),
        message: `Queued. The worker holding this device performs the ${kind} on its next heartbeat.`,
      });
    },
  );

  /** Every app action requested against one session, newest first. */
  app.get<{ Params: { id: string } }>('/sessions/:id/app-actions', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<ActionRow>(
        `SELECT * FROM app_actions WHERE session_id = $1 ORDER BY requested_at DESC LIMIT 100`,
        [req.params.id],
      );
      return rows;
    });
    return { actions: rows.map(actionJson) };
  });

  /**
   * The org's recent app actions across every session — what the console's library rows show.
   *
   * Capped and newest-first for the same reason the session list is: this is a browsing surface, and
   * a farm generates these steadily.
   */
  app.get<{ Querystring: { limit?: string } }>('/app-actions', async (req) => {
    const { orgId } = requireTenant(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<ActionRow>(
        'SELECT * FROM app_actions ORDER BY requested_at DESC LIMIT $1', [limit],
      );
      return rows;
    });
    return { actions: rows.map(actionJson) };
  });

  /** One action, for polling. */
  app.get<{ Params: { id: string } }>('/app-actions/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<ActionRow>('SELECT * FROM app_actions WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    if (!row) throw notFound('App action');
    return { action: actionJson(row) };
  });
}
