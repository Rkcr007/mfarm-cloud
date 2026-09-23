import { readFile } from 'node:fs/promises';
import { aiStepStore } from '../../ai/runner.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { withSystem } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { appStore } from '../../appstore.ts';
import { requireTenant } from '../server.ts';
import { badRequest, notFound } from '../errors.ts';
import { sendBlob } from '../blobRange.ts';
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
 * WHAT IS CARRIED ONLY WHEN THE LINK SAYS SO (ADR-0040, superseding ADR-0036 on these two):
 *
 *   THE LOG AND THE RECORDING. ADR-0036 kept both off every link — the log because it is the one
 *   artifact nobody curated, the recording because it covers the whole SESSION rather than this
 *   result. On 2026-09-14 the owner chose to let a link carry them, checked by default in the
 *   console, accepting that an unreviewed log can carry tokens. So `log` and `recording` are null
 *   unless `include_logcat` / `include_recording` are set AND the bytes are on disk — and the flag is
 *   checked in `logcatFor` / `recordingFor`, which the byte routes call too, so a holder who guesses
 *   `/logcat` on a link without it gets exactly what they would for evidence that never existed.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *   THE IDS. No org id, no session id, no device id, no run id. They identify nothing to a person
 *   without an account and would be a map of this tenant's fleet to a person with one.
 */
/**
 * The AI run behind a shared result, shaped for a STRANGER (ADR-0043 C10).
 *
 * An AI run posts its verdict as the session's test result, so a share of that result is a share of
 * the run — and the part a recipient needs is the part the command table cannot show: what the agent
 * was asked, what it did, why, and what the screen looked like at each step.
 *
 * TYPED TEXT IS NOT SHOWN. An AI run types whatever its prompt told it to, which is often a test
 * account's password; the step says a field was filled and how long the value was, never the value.
 * The prompt itself IS shown — it is the test — and the share dialog says so before a link exists.
 */
async function aiRunFor(sessionId: string) {
  return withSystem(async (c) => {
    const run = (await c.query<{ id: string; prompt: string; profile: string; status: string; summary: string | null; evidence: string | null; steps: number }>(
      'SELECT id, prompt, profile, status, summary, evidence, steps FROM ai_runs WHERE session_id = $1 LIMIT 1', [sessionId],
    )).rows[0];
    if (!run) return null;
    const steps = (await c.query<{ n: number; phase: string; thought: string | null; action: { tool: string; input: Record<string, unknown> } | null; result: string | null; screenshot_sha256: string | null }>(
      'SELECT n, phase, thought, action, result, screenshot_sha256 FROM ai_steps WHERE ai_run_id = $1 ORDER BY n LIMIT 200', [run.id],
    )).rows;
    return { run, steps };
  });
}

export function publicAiStep(s: { n: number; phase: string; thought: string | null; action: { tool: string; input: Record<string, unknown> } | null; result: string | null; screenshot_sha256: string | null }, hasShot: boolean) {
  const input = { ...(s.action?.input ?? {}) } as Record<string, unknown>;
  if (s.action?.tool === 'type_text') {
    const len = String(input.text ?? '').length;
    delete input.text;
    input.typedLength = len;
  }
  return {
    n: s.n,
    phase: s.phase,
    tool: s.action?.tool ?? null,
    input,
    // The agent's stated reason is its own words about the screen, not the customer's data.
    thought: s.thought,
    result: s.result,
    screenshot: hasShot,
  };
}

function publicPayload(
  r: ResolvedShare,
  steps: Awaited<ReturnType<typeof windowedSteps>>,
  hasScreenshot: boolean,
  evidence: {
    log: { sizeBytes: number } | null;
    recording: { sizeBytes: number; startedAt: string | null; failureAtSeconds: number | null; partial: boolean } | null;
  },
  ai: {
    prompt: string; profile: string; status: string; summary: string | null; evidence: string | null;
    steps: ReturnType<typeof publicAiStep>[];
  } | null = null,
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
    // Null unless the link includes it and the bytes exist — see the comment above and ADR-0040.
    log: evidence.log,
    recording: evidence.recording,
    aiRun: ai,
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

interface EvidenceRow { sha256: string; content_type: string; context: Record<string, unknown> }

/**
 * The device log a link may serve — null unless the link INCLUDES it (ADR-0040).
 *
 * THE FLAG IS CHECKED HERE, not in the route or the payload, because both call this: a gate that
 * lived in the payload alone would withhold the key and still hand the bytes to anybody who typed
 * `/logcat` on the end of the link.
 *
 * The log captured FOR THIS RESULT when a failing test asked for one (migration 040 binds it through
 * `context.testResultId`), otherwise the session's release-time log. A log bound to a DIFFERENT
 * result is never the fallback: it is another test's capture, and showing it here would be the
 * wrong test's evidence under this one's stack.
 */
async function logcatFor(r: ResolvedShare): Promise<EvidenceRow | null> {
  if (!r.share.include_logcat) return null;
  return withSystem(async (c) => {
    const { rows } = await c.query<EvidenceRow>(
      `SELECT sha256, content_type, context FROM artifacts
        WHERE kind = 'logcat' AND session_id = $1
          AND (context->>'testResultId' = $2 OR NOT (context ? 'testResultId'))
        ORDER BY (context->>'testResultId' = $2) IS TRUE DESC, created_at DESC
        LIMIT 1`,
      [r.session.id, r.result.id],
    );
    return rows[0] ?? null;
  });
}

/** The session's recording — null unless the link INCLUDES it. The newest one, since a session
 *  records once and a second row would be a re-upload of the same capture. */
async function recordingFor(r: ResolvedShare): Promise<EvidenceRow | null> {
  if (!r.share.include_recording) return null;
  return withSystem(async (c) => {
    const { rows } = await c.query<EvidenceRow>(
      `SELECT sha256, content_type, context FROM artifacts
        WHERE kind = 'video' AND session_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [r.session.id],
    );
    return rows[0] ?? null;
  });
}

/**
 * The console's `FAILURE_LEAD_IN_SECONDS`, and the console's arithmetic (`failureOffsetSeconds` in
 * `console.js`): `reportedAt − startedAt`, pulled back five seconds, floored at zero.
 *
 * COMPUTED HERE rather than in `share.js` because the share page cannot import the console, and a
 * second copy of the subtraction in a second browser file is how the console's "Watch at 1:05" and
 * the link's would come to disagree about when the same test failed. Both ends are approximate in
 * the same direction — the anchor to about a frame, `reportedAt` by however long the suite took to
 * post — which is also why the seek lands early rather than exactly.
 */
const FAILURE_LEAD_IN_SECONDS = 5;

export function failureAtSeconds(startedAt: unknown, reportedAt: Date): number | null {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  return Math.max(0, (reportedAt.getTime() - start) / 1000 - FAILURE_LEAD_IN_SECONDS);
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
  // AI step screenshots live in their own subdirectory (runner.ts `aiStepStore`).
  const aiStore = aiStepStore(loadConfig().artifactDir);

  // ---------------------------------------------------------------- the authenticated half

  /**
   * POST /v1/results/:id/shares — make a link.
   *
   * `requireTenant` rather than `requireUser`: a CI job that has just watched a test go red is a
   * legitimate maker of these, and refusing an API key would mean the one caller who knows the
   * result id at the moment it matters cannot use the feature. `created_by` is therefore nullable
   * and is the person where there is one.
   */
  app.post<{ Params: { id: string };
             Body: { expiresInDays?: number; includeRecording?: boolean; includeLogcat?: boolean } }>(
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
            // ADR-0040. Absent is false, which is what every caller before 057 got.
            includeRecording: { type: 'boolean' },
            includeLogcat: { type: 'boolean' },
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
          includeRecording: req.body?.includeRecording === true,
          includeLogcat: req.body?.includeLogcat === true,
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
    const [steps, shot, log, rec] = await Promise.all([
      windowedSteps(resolved),
      screenshotFor(resolved.result.id),
      logcatFor(resolved),
      recordingFor(resolved),
    ]);
    // The bytes must actually be on disk before the page is told there is a picture, or it renders
    // a broken image under a stack trace. `store.size` is the same question `/artifacts/:id/blob`
    // asks before streaming — and for the recording it is the ordinary case rather than a corner,
    // because video retention is shorter than the longest link.
    const onDisk = (b: { sha256: string } | null) => (b ? store.size(b.sha256) : Promise.resolve(null));
    const [shotSize, logSize, recSize] = await Promise.all([onDisk(shot), onDisk(log), onDisk(rec)]);
    const ai = await aiRunFor(resolved.session.id);
    const aiShots = ai ? await Promise.all(ai.steps.map((st) =>
      st.screenshot_sha256 ? aiStore.size(st.screenshot_sha256).then((n) => n !== null) : Promise.resolve(false))) : [];
    return publicHeaders(reply).send(publicPayload(resolved, steps, shotSize !== null, {
      log: logSize !== null ? { sizeBytes: logSize } : null,
      recording: rec && recSize !== null
        ? {
            sizeBytes: recSize,
            startedAt: typeof rec.context.startedAt === 'string' ? rec.context.startedAt : null,
            failureAtSeconds: failureAtSeconds(rec.context.startedAt, resolved.result.reported_at),
            // Said out loud by the page: a partial file plays, and ends early.
            partial: rec.context.partial === true,
          }
        : null,
    }, ai ? {
      prompt: ai.run.prompt, profile: ai.run.profile, status: ai.run.status,
      summary: ai.run.summary, evidence: ai.run.evidence,
      steps: ai.steps.map((st, i) => publicAiStep(st, aiShots[i] === true)),
    } : null));
  });

  /**
   * GET /v1/shares/:token/ai-steps/:n/screenshot — what the agent saw at one step (C10).
   *
   * Reached through the TOKEN and the step NUMBER only, for the same reason the failure screenshot
   * is: the link must not be able to name a blob. The step is looked up under the AI run of the
   * shared result's own session, so a token can reach exactly that run's screens and nothing else.
   */
  app.get<{ Params: { token: string; n: string } }>('/shares/:token/ai-steps/:n/screenshot', async (req, reply) => {
    const resolved = await resolveShare(req.params.token);
    if (!resolved) throw notFound('Share');
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw notFound('Screenshot');
    const sha = await withSystem(async (c) => (await c.query<{ screenshot_sha256: string | null }>(
      `SELECT st.screenshot_sha256 FROM ai_steps st JOIN ai_runs r ON r.id = st.ai_run_id
        WHERE r.session_id = $1 AND st.n = $2`, [resolved.session.id, n],
    )).rows[0]?.screenshot_sha256);
    if (!sha || (await aiStore.size(sha)) === null) throw notFound('Screenshot');
    return publicHeaders(reply)
      .header('content-type', 'image/png')
      .header('content-disposition', `inline; filename="step-${n}.png"`)
      .send(aiStore.read(sha));
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

  /**
   * GET /v1/shares/:token/logcat — the device log, only on a link that includes it (ADR-0040).
   *
   * A DOWNLOAD, and `text/plain` whatever the row says: `attachment` plus `nosniff` means a log line
   * that happens to look like markup is never rendered as a page on this origin. A link without the
   * flag reaches `logcatFor`'s null and answers exactly as evidence that was never captured does.
   */
  app.get<{ Params: { token: string } }>('/shares/:token/logcat', async (req, reply) => {
    const resolved = await resolveShare(req.params.token);
    if (!resolved) throw notFound('Share');
    const log = await logcatFor(resolved);
    const size = log ? await store.size(log.sha256) : null;
    if (!log || size === null) throw notFound('Log');
    return sendBlob(req, publicHeaders(reply), store, size, {
      sha256: log.sha256,
      contentType: 'text/plain; charset=utf-8',
      disposition: 'attachment; filename="device-log.txt"',
    });
  });

  /**
   * GET /v1/shares/:token/recording — the session recording, only on a link that includes it.
   *
   * With range support, through the same helper `/v1/artifacts/:id/blob` uses: a `<video>` that
   * cannot seek cannot jump to the failure, which is the one thing the recording is on this page for.
   * Every range request re-resolves the token, so revoking a link stops a video mid-play.
   */
  app.get<{ Params: { token: string } }>('/shares/:token/recording', async (req, reply) => {
    const resolved = await resolveShare(req.params.token);
    if (!resolved) throw notFound('Share');
    const rec = await recordingFor(resolved);
    const size = rec ? await store.size(rec.sha256) : null;
    if (!rec || size === null) throw notFound('Recording');
    return sendBlob(req, publicHeaders(reply), store, size, {
      sha256: rec.sha256,
      contentType: rec.content_type,
      disposition: 'inline; filename="recording.webm"',
    });
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
       * The share page's OWN policy, and it is tighter than the console's in the ways that matter
       * for a page served to strangers: no `connect-src` beyond `'self'` (there is no data plane
       * here and never will be), and `media-src 'self'` with no `blob:` — the recording a link may
       * carry (ADR-0040) streams from this origin's own route and from nowhere else. The shell is
       * identical for every token, so the policy is too, whether or not this link has a recording.
       */
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
        "img-src 'self'; media-src 'self'; connect-src 'self'; " +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(await readFile(html, 'utf8')));
}

/** The page's own assets, so `ui.ts` can serve them from its allowlist and the server can exempt
 *  them from the authenticate-by-default rule. A path missing from that list answers 401 and the
 *  browser cannot resolve the import — which took the whole console down once, see `ui.ts`. */
export const SHARE_ASSETS = ['/share.css', '/share.js'];
