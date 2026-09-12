import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { withSystem } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { appStore } from '../../appstore.ts';
import { requireTenant } from '../server.ts';
import { badRequest, notFound } from '../errors.ts';
import {
  createShare, listShares, revokeShare, resolveShare, windowedSteps,
  shareJson, sharePath, ShareError,
  DEFAULT_SHARE_DAYS, MAX_SHARE_DAYS, type ResolvedShare,
} from '../../shares.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', '..', 'public');

/**
 * Share links (migration 051) — both halves, deliberately in one file.
 *
 * The AUTHENTICATED half (make, list, withdraw) and the ANONYMOUS half (resolve, render, the one
 * image) are the same feature seen from two sides, and the property that matters most about it is
 * what the anonymous side does NOT return. Splitting them across two files is how the two drift: a
 * field added to the payload upstairs appears downstairs without anyone deciding it should.
 */

/**
 * THE ABSOLUTE URL IS BUILT FROM THE REQUEST, and the `path` beside it is what a cautious client
 * uses instead.
 *
 * There is no configured console origin in this repo — `deploy/farm.env` holds the hostname for the
 * scripts, nothing hands it to the API — so the only thing the process knows about how it was
 * reached is the request. `req.protocol` respects `X-Forwarded-Proto` only when `TRUST_PROXY` is
 * set, which is exactly the deployment where the header is the truth. A caller that would rather
 * not trust a Host header at all gets `path` and can prepend its own origin.
 */
function shareUrl(req: { protocol: string; headers: Record<string, unknown> }, token: string): string {
  const host = String(req.headers.host ?? '');
  return host ? `${req.protocol}://${host}${sharePath(token)}` : sharePath(token);
}

/**
 * What an anonymous holder of the link is shown.
 *
 * WRITTEN AS ONE EXPLICIT OBJECT, never by spreading a database row. Every field here was decided;
 * a `...row` would mean the next column added to `test_results` is disclosed to the public internet
 * by whoever added it, which is not a decision a migration author should be making by accident.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each one:
 *
 *   THE LOGCAT. A share is readable by anyone holding the link, and a device log is the artifact
 *   most likely to contain something the person sharing it has not read — an app logs auth headers,
 *   deep links with tokens in them, and whatever a third-party SDK feels like printing. The
 *   screenshot was framed by the app, the stack was written by the suite, and the step trace is
 *   MFARM's own record of which commands it forwarded (ADR-0029 stores no request bodies). The log
 *   is the one artifact nobody curated. That is a default, not a law: somebody who wants to hand
 *   over a log can still download it and send it, and the difference is that they will have looked.
 *
 *   THE RECORDING. A video covers the whole SESSION, which on a multi-test session is every other
 *   test that ran on that device — the exact widening that scoping a share to one result exists to
 *   prevent. There is no per-test recording to offer instead, so the honest answer is none.
 *
 *   THE IDS. No org id, no session id, no device id, no run id. They identify nothing to a person
 *   without an account and would be a map of this tenant's fleet to a person with one.
 */
function publicPayload(
  r: ResolvedShare,
  steps: Awaited<ReturnType<typeof windowedSteps>>,
  hasScreenshot: boolean,
) {
  return {
    test: {
      name: r.result.name,
      status: r.result.status,
      failure: r.result.failure,
      failureClass: r.result.failure_class,
      failureReason: r.result.failure_reason,
      durationMs: r.result.duration_ms,
      reportedAt: r.result.reported_at.toISOString(),
      occurredAt: r.result.occurred_at ? r.result.occurred_at.toISOString() : null,
    },
    // The session's own name (migration 048), which on the one-test-per-session shape IS this test
    // and on a multi-test session is the suite's label for the batch. Never the uuid.
    session: {
      name: r.session.name,
      region: r.session.region,
      startedAt: r.session.started_at ? r.session.started_at.toISOString() : null,
      endedAt: r.session.ended_at ? r.session.ended_at.toISOString() : null,
    },
    /**
     * The device by its PROFILE, so the page can call `deviceName()` out of `/profiles.js` — the
     * console's own naming authority — rather than growing a second opinion about what an X1 Pro is
     * called. Same reason the fields are these five and not a formatted string.
     */
    device: r.device && {
      model: r.device.model,
      platform: r.device.platform,
      osVersion: r.device.os_version,
      tier: r.device.tier,
      profile: r.device.profile,
    },
    run: r.run && { name: r.run.name, externalId: r.run.external_id },
    // Who this came from, which is the first thing a recipient with no account needs to know. The
    // org's NAME, never its id or its slug.
    org: { name: r.org.name },
    steps: {
      items: steps.steps.map((c) => ({
        seq: c.seq,
        method: c.method,
        path: c.path,
        status: c.status,
        durationMs: c.duration_ms,
        startedAt: c.started_at.toISOString(),
        // Derived exactly as `/v1/sessions/:id/commands` derives it, and for the same reason: a
        // NULL status is a command that was sent and never answered, which is the most alarming
        // thing that can happen to a session and must not be painted as ordinary.
        failed: c.status === null || c.status >= 400,
      })),
      // The window is stated rather than implied, because the page says out loud that these are the
      // steps between the previous test and this one — see `windowedSteps` for its honest error.
      from: steps.from ? steps.from.toISOString() : null,
      to: steps.to.toISOString(),
      truncated: steps.truncated,
    },
    screenshot: hasScreenshot,
    share: {
      expiresAt: r.share.expires_at.toISOString(),
      createdAt: r.share.created_at.toISOString(),
    },
  };
}

/**
 * The screenshot captured FOR THIS RESULT, and only that one.
 *
 * `context->>'testResultId'` is the link migration 040 writes when a failed test asks for its own
 * evidence. The release-time screenshot is deliberately not a fallback: it is taken after Appium
 * force-stops the app, so it reliably shows the launcher — offering it here would put a picture of
 * an empty home screen under a stack trace and call it evidence.
 */
async function screenshotFor(resultId: string): Promise<{ sha256: string; content_type: string } | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query<{ sha256: string; content_type: string }>(
      `SELECT sha256, content_type FROM artifacts
        WHERE kind = 'screenshot' AND context->>'testResultId' = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [resultId],
    );
    return rows[0] ?? null;
  });
}

/** Headers every anonymous share response carries. */
function publicHeaders(reply: FastifyReply): FastifyReply {
  return reply
    /**
     * `no-store`, and it is not decorative. A share link is pasted into chat clients and read
     * through corporate proxies; a shared cache holding this response is a shared cache holding
     * somebody's failure after the link was revoked, which would make revocation a suggestion.
     */
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    /**
     * `noindex`, because the whole point is a link with no account behind it and that is exactly
     * the shape a crawler follows happily. The token makes the URL unguessable; nothing makes it
     * unpublishable once somebody pastes it somewhere public.
     */
    .header('x-robots-tag', 'noindex, nofollow, noarchive')
    // A link pasted into a chat client is followed by that client. Sending the token onward in a
    // Referer to whatever the page links to would hand the credential to a third party.
    .header('referrer-policy', 'no-referrer');
}

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  const store = appStore(loadConfig().artifactDir);

  // ---------------------------------------------------------------- the authenticated half

  /**
   * POST /v1/results/:id/shares — make a link.
   *
   * `requireTenant` rather than `requireUser`: a CI job that has just watched a test go red is a
   * legitimate maker of these, and refusing an API key would mean the one caller who knows the
   * result id at the moment it matters cannot use the feature. `created_by` is therefore nullable
   * and is the person where there is one.
   */
  app.post<{ Params: { id: string }; Body: { expiresInDays?: number } }>(
    '/results/:id/shares',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Bounded in the schema AND in `createShare`. The schema is this door's contract; the
            // check in the module is what holds for a caller arriving through any other door.
            expiresInDays: { type: 'integer', minimum: 1, maximum: MAX_SHARE_DAYS },
          },
        },
      },
    },
    async (req, reply) => {
      const { orgId } = requireTenant(req);
      const createdBy = req.principal?.kind === 'user' ? req.principal.userId : null;
      try {
        const { token, share } = await createShare(orgId, req.params.id, {
          expiresInDays: req.body?.expiresInDays ?? DEFAULT_SHARE_DAYS,
          createdBy,
        });
        return reply.code(201).send({
          /**
           * THE TOKEN IS IN THIS RESPONSE AND IN NO OTHER, exactly like a new API key. Everything
           * that lists shares afterwards returns the prefix, so a person who loses the link makes a
           * second one and revokes the first — which is also the behaviour that makes `views`
           * meaningful.
           */
          token,
          url: shareUrl(req, token),
          path: sharePath(token),
          share: shareJson({ ...share, created_by_email: null }),
        });
      } catch (e) {
        if (e instanceof ShareError) {
          if (e.kind === 'no_result') throw notFound('Test result');
          throw badRequest(e.message);
        }
        throw e;
      }
    },
  );

  /** GET /v1/results/:id/shares — every link ever made for this result, live or not. */
  app.get<{ Params: { id: string } }>('/results/:id/shares', async (req) => {
    const { orgId } = requireTenant(req);
    return { shares: (await listShares(orgId, req.params.id)).map(shareJson) };
  });

  /**
   * DELETE /v1/shares/:prefix — withdraw one.
   *
   * Addressed by PREFIX, which is the only handle the console has: the token is gone after
   * creation, and giving the row's uuid to the console would be a second identifier for the same
   * thing. The prefix is unique by constraint, and it is scoped to the caller's org by RLS — so a
   * prefix belonging to another org answers exactly like one that never existed.
   */
  app.delete<{ Params: { prefix: string } }>('/shares/:prefix', async (req, reply) => {
    const { orgId } = requireTenant(req);
    const done = await revokeShare(orgId, req.params.prefix);
    // 200 either way: the person pressing this wants the link dead, and telling them it was
    // already dead is not a failure of the request.
    return reply.code(200).send({ revoked: done });
  });

  // ---------------------------------------------------------------- the anonymous half

  /**
   * GET /v1/shares/:token — what the page renders. NO CREDENTIAL, the token is the whole thing.
   *
   * 404 for every way of being invalid — unknown, malformed, revoked, expired — see `resolveShare`.
   */
  app.get<{ Params: { token: string } }>('/shares/:token', async (req, reply) => {
    const resolved = await resolveShare(req.params.token);
    if (!resolved) throw notFound('Share');
    const [steps, shot] = await Promise.all([
      windowedSteps(resolved),
      screenshotFor(resolved.result.id),
    ]);
    // The bytes must actually be on disk before the page is told there is a picture, or it renders
    // a broken image under a stack trace. `store.size` is the same question `/artifacts/:id/blob`
    // asks before streaming.
    const present = shot ? (await store.size(shot.sha256)) !== null : false;
    return publicHeaders(reply).send(publicPayload(resolved, steps, present));
  });

  /**
   * GET /v1/shares/:token/screenshot — the one image, streamed.
   *
   * Reached through the TOKEN, never through an artifact id. A share must not be able to name a
   * blob, which is the property `/v1/artifacts/:id/blob` protects by reaching bytes only through a
   * row the caller's org can see; here the row is reached only through the result the token names.
   * No range support, because this is a PNG of a phone screen and nothing seeks one.
   */
  app.get<{ Params: { token: string } }>('/shares/:token/screenshot', async (req, reply) => {
    const resolved = await resolveShare(req.params.token);
    if (!resolved) throw notFound('Share');
    const shot = await screenshotFor(resolved.result.id);
    if (!shot) throw notFound('Screenshot');
    if ((await store.size(shot.sha256)) === null) {
      throw notFound(`Blob ${shot.sha256} is missing from the artifact store`);
    }
    return publicHeaders(reply)
      .header('content-type', shot.content_type)
      .header('content-disposition', 'inline; filename="failure.png"')
      .send(store.read(shot.sha256));
  });
}

/**
 * The page itself, at `/s/<token>`.
 *
 * Registered OUTSIDE the `/v1` prefix and served as a static shell that reads its own token out of
 * `location.pathname` — so the token never reaches this handler's logs by way of a route it can
 * mistype, and one file answers every share.
 *
 * ITS OWN HTML, not the console. The console's shell boots a signed-in application: it fetches the
 * fleet, opens a socket, and renders a sign-in screen to anyone without a cookie. A person opening
 * a share has no cookie and never will, and sending them the console would show them a login form
 * with the thing they came to read behind it.
 */
export async function sharePageRoutes(app: FastifyInstance): Promise<void> {
  const html = join(PUBLIC_DIR, 'share.html');

  app.get('/s/:token', async (_req, reply) =>
    publicHeaders(reply)
      .header('content-type', 'text/html; charset=utf-8')
      /**
       * The share page's OWN policy, and it is tighter than the console's in the two ways that
       * matter for a page served to strangers: no `connect-src` beyond `'self'` (there is no data
       * plane here and never will be), and no `media-src` at all (there is no recording on a share
       * — see `publicPayload`). `img-src 'self'` is what carries the one screenshot.
       */
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
        "img-src 'self'; connect-src 'self'; " +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(await readFile(html, 'utf8')));
}

/** The page's own assets, so `ui.ts` can serve them from its allowlist and the server can exempt
 *  them from the authenticate-by-default rule. A path missing from that list answers 401 and the
 *  browser cannot resolve the import — which took the whole console down once, see `ui.ts`. */
export const SHARE_ASSETS = ['/share.css', '/share.js'];
