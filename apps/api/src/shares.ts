import { randomBytes } from 'node:crypto';
import { withSystem, withTenant } from './db.ts';
import { sha256, safeEqualHex } from './auth.ts';

/**
 * A link that shows ONE failed test to somebody with no account here (migration 051).
 *
 * WHAT THIS IS FOR. Every way of looking at a failure needs a session cookie for this org, so the
 * thing a QA engineer does thirty times a week — paste a failure into a channel and ask "is this
 * you?" — is not possible. The developer who broke it, the contractor on the integration and the
 * person in the incident channel would each need an account on the farm first, and what happens
 * instead is a screenshot of a screenshot with the stack retyped and the step trace lost.
 *
 * THE THREE PROPERTIES THAT MAKE IT SAFE TO HAND OUT, each learned elsewhere in this repo:
 *
 *   The org is DERIVED from the result, never read from the caller. Architecture rule 4 — the same
 *   reasoning that stops a worker naming the org it bills.
 *
 *   The plaintext is returned once and only a sha256 is stored, exactly like `api_keys`, so a
 *   database dump does not hand somebody every live link.
 *
 *   Resolution runs on the SYSTEM pool with the token as the entire authorization, because an
 *   anonymous caller has no org for RLS to scope by. That is the same shape `authenticate()` uses
 *   and it is the one place in this file where a tenant policy is deliberately not the guard.
 */

/** `mfs_` so a token found in a log is identifiable at a glance, and so it can never be mistaken
 *  for `mfk_` (a tenant key) or `mwk_` (a worker token) by `authenticate()`. */
const SHARE_TOKEN_PREFIX = 'mfs_';

/** Same length as an API key prefix, for the same reason: enough to identify a link in a list
 *  without being enough to guess the rest of it. */
const PREFIX_LEN = 12;

/**
 * How long a link lives when the caller does not say.
 *
 * SEVEN DAYS, because the link outlives the conversation it was made for and the realistic life of
 * "is this you?" in a chat channel is a working week. A share that never expires is a disclosure
 * nobody revisits; one that expires in an hour is one the recipient opens on Monday and cannot use.
 */
export const DEFAULT_SHARE_DAYS = 7;

/**
 * The ceiling, enforced here rather than left to the column.
 *
 * The migration's `expires_at` only RECORDS what was chosen; nothing in the schema stops a caller
 * asking for the year 3000. This does, and it is a deliberate product limit rather than a technical
 * one — a link that outlives the evidence it points at is a link to a 404, since artifacts are
 * deleted on their org's retention schedule (migration 046).
 */
export const MAX_SHARE_DAYS = 30;

/** How many steps a share carries. The tail, not the head — see `windowedSteps`. */
export const MAX_SHARE_STEPS = 200;

export interface ShareRow {
  id: string;
  org_id: string;
  test_result_id: string;
  prefix: string;
  created_by: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_viewed_at: Date | null;
  views: number;
}

/**
 * What the console shows about a link it made. Never the token — that is returned exactly once.
 *
 * AND THEREFORE NO `path` OR `url` EITHER, which the first version of this function did have: it
 * built `sharePath(s.prefix)` and returned `/s/mfs_g4M9wlev`. That is a URL of exactly the right
 * SHAPE which resolves to nothing, because a prefix is twelve characters of a forty-seven character
 * credential — so the console would have rendered a copy button beside a link that 404s for
 * whoever it was pasted to, and the person who sent it would have had no way to tell. Caught by
 * reading one real response, not by any test, which is the failure mode this repo keeps meeting: a
 * control built on a value that looks like the right one.
 *
 * A link whose token was lost is not recoverable. Make another and revoke this one — which is also
 * what makes `views` mean anything.
 */
export function shareJson(s: ShareRow & { created_by_email?: string | null }) {
  return {
    prefix: s.prefix,
    createdAt: s.created_at.toISOString(),
    createdByEmail: s.created_by_email ?? null,
    expiresAt: s.expires_at.toISOString(),
    revokedAt: s.revoked_at ? s.revoked_at.toISOString() : null,
    lastViewedAt: s.last_viewed_at ? s.last_viewed_at.toISOString() : null,
    views: s.views,
    /**
     * Derived here rather than stored, so that what "live" means can change without a migration —
     * and so the console cannot disagree with the API about which links are still circulating. The
     * same reasoning `session_commands.failed` is derived under.
     */
    active: !s.revoked_at && s.expires_at.getTime() > Date.now(),
  };
}

/**
 * The path a link points at, in ONE place.
 *
 * Short on purpose: `/s/<token>` rather than `/share/results/<token>`, because this is pasted into
 * chat clients that truncate, and a person reading the channel should be able to see the whole
 * thing. It is also the reason the token is the whole credential and there is no id in the path —
 * two opaque strings would double the length to disclose nothing extra.
 */
export const sharePath = (token: string) => `/s/${token}`;

export function generateShareToken(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `${SHARE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { plaintext, prefix: plaintext.slice(0, PREFIX_LEN), hash: sha256(plaintext) };
}

export class ShareError extends Error {
  readonly kind: 'no_result' | 'bad_expiry';
  constructor(kind: 'no_result' | 'bad_expiry', message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Make a link for one test result.
 *
 * SCOPED TO ONE TEST RESULT, not a run, not a session, not an org — the narrowest thing that
 * answers the question somebody is asking, because every widening is a disclosure nobody reviewed.
 * A session share would carry every other test that ran on that device; a run share would carry the
 * entire suite.
 *
 * ANY STATUS, not failures only. The table is named for the case it exists to serve and the public
 * page is laid out for a failure, but refusing to share a passing result would be an arbitrary
 * refusal a person hits on the day they want to send "it passes on the farm, it is your local
 * setup" — which is the same conversation, pointed the other way.
 */
export async function createShare(
  orgId: string,
  testResultId: string,
  opts: { expiresInDays?: number; createdBy?: string | null } = {},
): Promise<{ token: string; share: ShareRow }> {
  const days = opts.expiresInDays ?? DEFAULT_SHARE_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > MAX_SHARE_DAYS) {
    throw new ShareError(
      'bad_expiry',
      `A share may last between 1 and ${MAX_SHARE_DAYS} days; ${days} was asked for.`,
    );
  }

  const { plaintext, prefix, hash } = generateShareToken();

  const share = await withTenant(orgId, async (c) => {
    /**
     * The result is read back under RLS before anything is written, so a caller naming another
     * org's result gets the answer a caller naming a result that never existed gets. `org_id` on
     * the new row then comes from THIS row rather than from the request.
     */
    const { rows } = await c.query<{ id: string; org_id: string }>(
      'SELECT id, org_id FROM test_results WHERE id = $1',
      [testResultId],
    );
    if (rows.length === 0) throw new ShareError('no_result', 'Test result not found.');

    const ins = await c.query<ShareRow>(
      `INSERT INTO result_shares (org_id, test_result_id, prefix, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING *`,
      [rows[0].org_id, rows[0].id, prefix, hash, opts.createdBy ?? null, String(days)],
    );
    return ins.rows[0];
  });

  return { token: plaintext, share };
}

/** Every link that has ever been made for one result, newest first. Revoked and expired ones are
 *  INCLUDED: "who did I send this to and did I withdraw it" is the question this list answers. */
export async function listShares(orgId: string, testResultId: string): Promise<Array<ShareRow & { created_by_email: string | null }>> {
  return withTenant(orgId, async (c) => (await c.query<ShareRow & { created_by_email: string | null }>(
    `SELECT s.*, u.email AS created_by_email
       FROM result_shares s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.test_result_id = $1
      ORDER BY s.created_at DESC`,
    [testResultId],
  )).rows);
}

/**
 * Withdraw a link.
 *
 * THIS IS WHY THE CREDENTIAL IS A TABLE AND NOT A SIGNED TOKEN. A signed URL cannot be withdrawn,
 * and the realistic mistake with this feature is not that the crypto fails — it is that somebody
 * shares a failure and then notices the screenshot has a customer's name in it.
 *
 * Idempotent: revoking an already-revoked link reports false rather than failing, because the
 * person pressing the button twice wants it gone either way.
 */
export async function revokeShare(orgId: string, prefix: string): Promise<boolean> {
  return withTenant(orgId, async (c) => {
    const r = await c.query(
      'UPDATE result_shares SET revoked_at = now() WHERE prefix = $1 AND revoked_at IS NULL',
      [prefix],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * How stale `last_viewed_at` and `views` are allowed to get — the same argument as
 * `api_keys.last_used_at`, for the same reason and at a coarser resolution.
 *
 * A LINK PASTED IN A BUSY CHANNEL IS FETCHED BY EVERY UNFURLER THAT SEES IT, so counting every
 * request would report a number about Slack rather than about people. The question the column
 * answers is "is this link still circulating?", and five minutes is far finer than that needs.
 */
const VIEW_STALE_MS = 5 * 60_000;

export interface ResolvedShare {
  share: ShareRow;
  result: {
    id: string; name: string; status: string; failure: string | null;
    failure_class: string | null; failure_reason: string | null;
    duration_ms: number | null; reported_at: Date; occurred_at: Date | null;
  };
  session: {
    id: string; name: string | null; region: string;
    started_at: Date | null; ended_at: Date | null;
  };
  device: {
    model: string; platform: string; os_version: string; tier: string; profile: string | null;
  } | null;
  run: { name: string | null; external_id: string } | null;
  org: { name: string };
}

/**
 * Resolve a token to everything the public page renders, or null.
 *
 * ONE `null` FOR EVERY WAY OF FAILING — unknown, malformed, revoked, expired, and a result that has
 * since been deleted. A page that distinguished "this link was revoked" from "this link never
 * existed" would confirm to somebody holding a withdrawn link that they once held a real one, which
 * is exactly the fact revocation is trying to take back.
 *
 * Runs on the system pool: an anonymous caller has no org, so there is no `current_org()` for a
 * policy to compare against and the token IS the authorization. Everything this returns is
 * therefore assembled by explicit joins from the share's OWN row rather than by a scoped query.
 */
export async function resolveShare(token: string): Promise<ResolvedShare | null> {
  if (typeof token !== 'string' || !token.startsWith(SHARE_TOKEN_PREFIX)) return null;
  if (token.length < PREFIX_LEN + 8) return null;

  const prefix = token.slice(0, PREFIX_LEN);
  const presented = sha256(token);

  return withSystem(async (c) => {
    const { rows } = await c.query<ShareRow & { token_hash: string }>(
      'SELECT * FROM result_shares WHERE prefix = $1',
      [prefix],
    );
    if (rows.length === 0) return null;
    const share = rows[0];
    if (!safeEqualHex(share.token_hash, presented)) return null;
    if (share.revoked_at) return null;
    if (share.expires_at.getTime() <= Date.now()) return null;

    const detail = await c.query(
      `SELECT
          r.id, r.name, r.status, r.failure, r.failure_class, r.failure_reason,
          r.duration_ms, r.reported_at, r.occurred_at,
          s.id AS session_id, s.name AS session_name, s.region,
          s.started_at, s.ended_at,
          d.model, d.platform, d.os_version, d.tier, d.profile,
          run.name AS run_name, run.external_id AS run_external_id,
          o.name AS org_name
         FROM test_results r
         JOIN sessions s ON s.id = r.session_id
         JOIN orgs o     ON o.id = r.org_id
         LEFT JOIN devices d ON d.id = s.device_id
         LEFT JOIN runs run  ON run.id = s.run_id
        WHERE r.id = $1`,
      [share.test_result_id],
    );
    // The FK is ON DELETE CASCADE, so this is all but unreachable — it costs one branch to make the
    // unreachable case a dead link rather than a 500 on an anonymous page.
    if (detail.rows.length === 0) return null;
    const d = detail.rows[0];

    await touchShare(c, share);

    return {
      share,
      result: {
        id: d.id, name: d.name, status: d.status, failure: d.failure,
        failure_class: d.failure_class, failure_reason: d.failure_reason,
        duration_ms: d.duration_ms, reported_at: d.reported_at, occurred_at: d.occurred_at,
      },
      session: {
        id: d.session_id, name: d.session_name, region: d.region,
        started_at: d.started_at, ended_at: d.ended_at,
      },
      device: d.model
        ? { model: d.model, platform: d.platform, os_version: d.os_version, tier: d.tier, profile: d.profile }
        : null,
      run: d.run_external_id ? { name: d.run_name, external_id: d.run_external_id } : null,
      org: { name: d.org_name },
    };
  });
}

async function touchShare(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  share: ShareRow,
): Promise<void> {
  const last = share.last_viewed_at?.getTime() ?? 0;
  if (Date.now() - last < VIEW_STALE_MS) return;
  /**
   * `views + 1`, not `views + <however many fetches we swallowed>`. The count is explicitly
   * approximate and the column comment says so; inventing a multiplier would make it look precise
   * while being no more true.
   */
  await c.query(
    'UPDATE result_shares SET last_viewed_at = now(), views = views + 1 WHERE id = $1',
    [share.id],
  );
}

/**
 * The steps that belong to THIS test, out of a session that may have run several.
 *
 * THE WINDOW IS BETWEEN THE PREVIOUS RESULT AND THIS ONE, and getting this right is the difference
 * between a share and a leak. `session_commands` is the whole SESSION's step trace: on the
 * one-test-per-session shape that is this test and nothing else, but a suite running eight
 * scenarios on one session would otherwise hand the link holder all eight — precisely the widening
 * that scoping a share to one result exists to prevent.
 *
 * So the lower bound is the moment the PREVIOUS result was reported (or the session's start, for
 * the first), and the upper bound is this result's own `reported_at`. Both are wall clock and both
 * come from rows this API wrote, so the window is derived rather than guessed.
 *
 * ITS HONEST ERROR, stated because the page states it too: `reported_at` is when the SUITE POSTED
 * the result, which is after the assertion fired by however long the suite took to notice. A
 * command issued by the next test before this one's `afterEach` finished reporting would land
 * inside the window. That error is bounded by the reporting gap — a fraction of a second on every
 * real suite — and it errs towards showing one step too many of the caller's OWN session rather
 * than towards hiding the step that explains the failure.
 *
 * THE TAIL, NOT THE HEAD. When the window holds more steps than a page should carry, the ones worth
 * having are the last ones: a failure is explained by what happened just before it, never by the
 * first `POST /session` of a scenario that ran for four minutes.
 */
export async function windowedSteps(
  resolved: ResolvedShare,
  limit = MAX_SHARE_STEPS,
): Promise<{
  steps: Array<{
    seq: number; method: string; path: string; status: number | null;
    duration_ms: number | null; started_at: Date; error: string | null;
  }>;
  from: Date | null;
  to: Date;
  truncated: boolean;
}> {
  const to = resolved.result.reported_at;

  return withSystem(async (c) => {
    const prev = await c.query<{ reported_at: Date }>(
      `SELECT reported_at FROM test_results
        WHERE session_id = $1 AND (reported_at, id) < ($2, $3)
        ORDER BY reported_at DESC, id DESC
        LIMIT 1`,
      [resolved.session.id, to, resolved.result.id],
    );
    // The session's own start where there is no earlier result, and NULL where even that is
    // unknown — a session that never started has no commands for the window to exclude.
    const from: Date | null = prev.rows[0]?.reported_at ?? resolved.session.started_at ?? null;

    const { rows } = await c.query(
      `SELECT seq, method, path, status, duration_ms, started_at, error
         FROM session_commands
        WHERE session_id = $1
          AND ($2::timestamptz IS NULL OR started_at >= $2)
          AND started_at <= $3
        ORDER BY seq DESC
        LIMIT $4`,
      [resolved.session.id, from, to, limit + 1],
    );

    const truncated = rows.length > limit;
    // Read newest-first so the LIMIT takes the tail, then handed back in the order a person reads.
    return { steps: rows.slice(0, limit).reverse(), from, to, truncated };
  });
}
