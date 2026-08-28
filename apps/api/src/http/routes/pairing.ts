import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, forbidden } from '../errors.ts';
import { requireUser } from '../server.ts';
import {
  approvePairing, collectPairing, lookupPairing, startPairing, POLL_INTERVAL_SECONDS,
} from '../../pairing.ts';

/**
 * Pairing a machine by reading a code off its screen — ADR-0014, control-plane half.
 *
 * Three endpoints and two audiences. `/pair` and `/pair/poll` are spoken by an agent that HAS NO
 * CREDENTIAL YET, which is the entire reason they are unauthenticated; `/pair/inspect` and
 * `/pair/approve` are spoken by a browser with a session cookie and a CSRF token.
 *
 * WHAT MAKES THE UNAUTHENTICATED PAIR SAFE is not a check in this file. It is that the code
 * `/pair` hands out is worth nothing until an authenticated admin approves it, and what it then
 * grants is decided by that admin's org rather than by anything the agent said. An attacker who
 * floods `/pair` collects a pile of codes bound to no org, granting nothing.
 *
 * So the exposures that remain are ordinary, and are handled as such: a code space too large to
 * guess, a ten-minute TTL, and per-IP budgets on both unauthenticated routes plus a much tighter
 * per-user budget on approval — which is the one an attacker would have to get through, and the one
 * a person typing eight characters will never notice.
 *
 * EVERY FAILURE ON A CODE LOOKS THE SAME to the caller. Unknown, expired, mistyped and already
 * collected collapse into one message and one status. The reasons exist for the server log: a
 * person who mistyped wants to be told the code is not valid, and nobody should be able to learn
 * which codes exist by asking.
 */

/**
 * Pairings started per minute from one address.
 *
 * Generous, because a single machine legitimately restarts the flow whenever its window is
 * reopened, and because a shared office NAT is one address for everybody in the building. It is a
 * cap on table growth rather than a security control — the security control is that the rows this
 * creates grant nothing.
 */
export const DEFAULT_PAIR_START_RATE_LIMIT_MAX = 20;

/**
 * Polls per minute from one address.
 *
 * The agent is told to wait `POLL_INTERVAL_SECONDS` between polls, so a well-behaved one spends 12
 * a minute. This allows several agents behind one NAT without allowing a poll loop that has lost
 * its interval to hammer the endpoint.
 */
export const DEFAULT_PAIR_POLL_RATE_LIMIT_MAX = 120;

/**
 * Code submissions per minute from one signed-in user.
 *
 * THE ONE THAT MATTERS. Approval is where a guessed code would be cashed in, and it is reachable
 * only by an authenticated user — so the budget is per user, not per IP: an attacker who has an
 * account should not get a fresh allowance by changing address, and a legitimate admin should not
 * lose theirs because a colleague on the same NAT was mistyping.
 *
 * Ten a minute is far more than a person reading eight characters off a screen, and against a
 * 30^8 space it is not a strategy — a run at that rate would take longer than the universe has, and
 * each code it might find has expired ten minutes after it was issued.
 */
export const DEFAULT_PAIR_APPROVE_RATE_LIMIT_MAX = 10;

export interface PairingRoutesOptions {
  /** Tests only. They pair far more often in a few seconds than any person would. */
  pairStartRateLimitMax?: number;
  pairPollRateLimitMax?: number;
  pairApproveRateLimitMax?: number;
}

/** The rate-limit plugin THROWS whatever this returns, so it must be an Error or it becomes a 500. */
const limitError = (message: string) =>
  (_req: FastifyRequest, ctx: { ttl: number; statusCode: number }) =>
    new ApiError(ctx.statusCode, 'rate_limited', `${message} Retry after ${Math.ceil(ctx.ttl / 1000)}s.`);

/** One message for every way a code can fail to be usable. See the file header. */
const NOT_VALID = 'That code is not valid. Codes expire ten minutes after the agent shows them — '
  + 'check the agent window for a current one.';

export async function pairingRoutes(
  app: FastifyInstance,
  routeOptions: PairingRoutesOptions = {},
): Promise<void> {
  const bucket = (key: string, max: number, message: string, perUser = false) => ({
    config: {
      rateLimit: {
        max,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => {
          if (!perUser) return `${key}:${req.ip}`;
          const p = req.principal;
          // Falls back to the address for an unauthenticated caller, who is about to be refused by
          // `requireUser` anyway — this only has to produce a key, not an authorization decision.
          return p?.kind === 'user' ? `${key}:user:${p.userId}` : `${key}:ip:${req.ip}`;
        },
        errorResponseBuilder: limitError(message),
      },
    },
  });

  /**
   * POST /v1/pair — an agent asks for a code. UNAUTHENTICATED, by necessity.
   *
   * The body describes the machine so a human can recognise it before approving. It is
   * self-reported and therefore untrusted: bounded, stored, and shown as a description, never used
   * as an identifier. The host names itself again at registration and `hosts.hostname` stays the key.
   */
  app.post(
    '/pair',
    {
      ...bucket('pair-start', routeOptions.pairStartRateLimitMax ?? DEFAULT_PAIR_START_RATE_LIMIT_MAX,
        'Too many pairing requests from this address.'),
      schema: {
        body: {
          type: 'object',
          properties: {
            hostname: { type: 'string', maxLength: 200 },
            platform: { type: 'string', maxLength: 200 },
            agentVersion: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const pending = await startPairing(body);
      // 201: this created a pending pairing. The device code is in this response and nowhere else,
      // ever again — it is not recoverable and not logged.
      return reply.code(201).send({
        deviceCode: pending.deviceCode,
        userCode: pending.userCode,
        expiresAt: pending.expiresAt,
        intervalSeconds: pending.intervalSeconds,
      });
    },
  );

  /**
   * POST /v1/pair/poll — the agent asks whether anyone approved it yet. UNAUTHENTICATED, and
   * authenticated by the device code it presents.
   *
   * `pending` is a 200, not an error. The agent is doing the right thing by asking, and an error
   * status for the expected case is how a client ends up with retry logic that treats success as
   * failure.
   */
  app.post(
    '/pair/poll',
    {
      ...bucket('pair-poll', routeOptions.pairPollRateLimitMax ?? DEFAULT_PAIR_POLL_RATE_LIMIT_MAX,
        'Polling too fast.'),
      schema: {
        body: {
          type: 'object',
          required: ['deviceCode'],
          properties: { deviceCode: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const { deviceCode } = req.body as { deviceCode: string };
      const result = await collectPairing(deviceCode);
      if (!result.ok) {
        req.log.info({ reason: result.reason }, 'pairing poll refused');
        // 410, not 404: this pairing is gone rather than never having been, and the agent should
        // start a new one rather than keep polling. `unknown` shares the status deliberately —
        // separating them would tell a caller which device codes exist.
        return reply.code(410).send({
          error: {
            code: 'pairing_gone',
            message: 'This pairing is no longer valid. Restart the agent to get a new code.',
          },
        });
      }
      if (result.status === 'pending') {
        return { status: 'pending', intervalSeconds: result.intervalSeconds };
      }
      // The enrollment token, minted moments ago, delivered exactly once. A second poll gets a 410.
      return { status: 'approved', token: result.token, orgId: result.orgId };
    },
  );

  /**
   * POST /v1/pair/inspect — what is this code, without approving it.
   *
   * ADR-0014 §2's mitigation for the flow's one real weakness: somebody talked into typing an
   * attacker's code into their own console. Naming the machine before asking for confirmation is
   * what gives them a chance to notice, so approval is two calls rather than one — and this one
   * changes nothing, so a mistyped code costs nothing.
   */
  app.post(
    '/pair/inspect',
    {
      ...bucket('pair-approve', routeOptions.pairApproveRateLimitMax ?? DEFAULT_PAIR_APPROVE_RATE_LIMIT_MAX,
        'Too many code attempts.', true),
      schema: {
        body: {
          type: 'object',
          required: ['userCode'],
          properties: { userCode: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      requireOrgAdmin(req);
      const { userCode } = req.body as { userCode: string };
      const found = await lookupPairing(userCode);
      if (!found.ok) {
        req.log.info({ reason: found.reason }, 'pairing inspect refused');
        return reply.code(404).send({ error: { code: 'pairing_not_found', message: NOT_VALID } });
      }
      return { pairing: found.pairing };
    },
  );

  /**
   * POST /v1/pair/approve — bind this pairing to my org.
   *
   * ORG AND USER COME FROM THE SESSION, never from the request body. That is the whole security
   * argument of ADR-0014 §1: the code proves possession of a machine, and the identity it is
   * attached to is the authenticated approver's.
   *
   * Admin-only, matching `POST /v1/account/agent-enrollments` — this produces the same credential,
   * so it cannot be a weaker door to it.
   */
  app.post(
    '/pair/approve',
    {
      ...bucket('pair-approve', routeOptions.pairApproveRateLimitMax ?? DEFAULT_PAIR_APPROVE_RATE_LIMIT_MAX,
        'Too many code attempts.', true),
      schema: {
        body: {
          type: 'object',
          required: ['userCode'],
          properties: { userCode: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      const { userId, orgId } = requireOrgAdmin(req);
      const { userCode } = req.body as { userCode: string };
      const result = await approvePairing(userCode, orgId, userId);
      if (!result.ok) {
        req.log.info({ reason: result.reason }, 'pairing approval refused');
        if (result.reason === 'already_approved') {
          return reply.code(409).send({
            error: {
              code: 'already_approved',
              message: 'That code has already been approved. The agent should have paired — check its window.',
            },
          });
        }
        return reply.code(404).send({ error: { code: 'pairing_not_found', message: NOT_VALID } });
      }
      return { pairing: result.pairing };
    },
  );
}

/**
 * Approving a pairing mints the same credential `POST /v1/account/agent-enrollments` mints, so it
 * carries the same requirement. Duplicated from `account.ts` rather than exported from it, which is
 * how that file already treats it — one four-line guard in two places reads better than an import
 * cycle between two route modules.
 */
function requireOrgAdmin(req: FastifyRequest): { userId: string; orgId: string } {
  const { userId, orgId, role } = requireUser(req);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or admin can pair a machine into this org.');
  }
  return { userId, orgId };
}
