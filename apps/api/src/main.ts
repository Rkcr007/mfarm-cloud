import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertAppRoleIsRlsBound, closePools } from './db.ts';
import { buildServer } from './http/server.ts';
import { startMetricsServer, type MetricsServer } from './http/metrics-server.ts';
import { ConfigError, describeConfig, loadConfig, type Config } from './config.ts';

/**
 * Control plane entry point.
 *
 * Until this file existed the server was only ever constructed by tests, and the difference showed
 * in the one place it hurts: `buildServer({ reaperIntervalMs })` defaults the reaper to off, which
 * is right for a test suite sharing a database and catastrophic for a deployment. Nothing turned it
 * on, so a deployed control plane would never expire a session, never promote a queued one, and
 * never purge an idempotency key.
 *
 * `start()` is exported and the auto-run is guarded, so a test can drive the real lifecycle without
 * the test runner inheriting signal handlers and a bound port.
 */

export interface Service {
  /** Where the server actually bound. Not necessarily what was asked for — port 0 means the kernel
   *  chose, which is how tests avoid fighting over a number. */
  readonly address: string;
  /** Idempotent. Resolves true when the drain finished inside SHUTDOWN_GRACE_MS. */
  close(reason?: string): Promise<boolean>;
}

/** Resolves true if `work` did not finish in time. Never leaves the timer holding the event loop
 *  open — a shutdown helper that keeps the process alive is its own bug. */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), ms);
  });
  try {
    return (await Promise.race([work.then(() => 'done' as const), expired])) === 'expired';
  } finally {
    clearTimeout(timer);
  }
}

export async function start(cfg: Config): Promise<Service> {
  // BEFORE the listener, so a control plane whose app role is not actually bound by RLS never binds
  // a port at all. parseConfig can only compare the two connection strings it was handed; this asks
  // the server who we really are. Throws ConfigError, which exits 78 like every other refusal.
  await assertAppRoleIsRlsBound();

  // server.ts reads LOG_LEVEL from the environment itself. Writing the resolved value back means
  // the configuration logged below is the configuration that actually runs, instead of two default
  // tables in two files that agree until someone changes one of them. RATE_LIMIT_MAX is passed
  // explicitly rather than through the environment, so nothing depends on assignment order.
  process.env.LOG_LEVEL = cfg.logLevel;

  const app = await buildServer({
    reaperIntervalMs: cfg.reaperIntervalMs,
    rateLimitMax: cfg.rateLimitMax,
    // Configured, never derived from the request: behind a reverse proxy this process sees plain
    // HTTP even when the browser is on TLS, and this farm serves plain HTTP in production.
    secureCookies: cfg.sessionCookieSecure,
  });

  // The metrics listener binds BEFORE the API does, and that order is deliberate in both halves.
  //
  // Before, because if it cannot bind — the port is taken, the address does not exist on this host —
  // `start()` rejects while nothing is listening yet, so the process exits with nothing to leak. The
  // reverse order leaves an API bound to a port and a process on its way out with no drain.
  //
  // And it is fatal rather than a warning, which is the less obvious half. A farm running blind is
  // worse than a farm that refuses to start: "down" is discovered in seconds by the next suite,
  // while "unmonitored" is discovered by the incident the monitoring was supposed to catch. The
  // tempting fallback — keep serving and let `up == 0` raise it — depends on the alerting path,
  // which is precisely the part that has not been exercised. A bind failure is also a
  // misconfiguration, and misconfigurations here refuse to start; that is the whole of `config.ts`.
  //
  // The token is read from the environment here rather than carried on Config, exactly like the
  // signing key: `describeConfig()` is logged, and the cheapest way to keep a secret out of a log
  // line is for the logged object never to hold it.
  let metrics: MetricsServer | undefined;
  if (cfg.metricsEnabled) {
    metrics = await startMetricsServer({
      host: cfg.metricsHost,
      port: cfg.metricsPort,
      token: process.env.METRICS_TOKEN?.trim() || undefined,
      onError: (err) => app.log.error({ err }, 'metrics scrape failed'),
    });
  }

  const address = await app.listen({ port: cfg.port, host: cfg.host });

  // Logged through the app logger so it carries the same redaction rules as everything else, and
  // through describeConfig() so adding a secret to Config is a deliberate act rather than a leak.
  // `address` is separate from describeConfig's `listen`: with PORT=0 the kernel picks, so the
  // requested value is `:0` and only this says where the process can actually be reached.
  app.log.info({ ...describeConfig(cfg), address }, 'control plane listening');
  if (cfg.signingKeySource === 'ephemeral') {
    app.log.warn('session keypair is ephemeral — tokens minted now stop verifying after a restart');
  }
  if (metrics) {
    app.log.info(
      { address: metrics.address, authenticated: cfg.metricsTokenSource === 'environment' },
      'metrics listening',
    );
  } else {
    app.log.warn('METRICS_ENABLED is off — device health, queue depth and reset failures are unobserved');
  }

  let draining: Promise<boolean> | undefined;

  const drain = async (reason: string): Promise<boolean> => {
    app.log.info({ reason, graceMs: cfg.shutdownGraceMs }, 'shutting down');

    // Step 1-3 are all `app.close()`, and Fastify does them in the order they have to happen:
    // stop the listener so no new connection is accepted, wait for in-flight requests to finish,
    // then run onClose hooks — which is where buildServer clears the reaper interval.
    //
    // The reaper is cleared at the END rather than first, deliberately. A reap() already in flight
    // owns a transaction on the owner pool; clearInterval cannot cancel it, and killing the pool
    // underneath it would roll back an expiry sweep halfway through. Letting the drain finish first
    // means the timer is gone before anything it could schedule against is torn down.
    const closed = app.close().catch((err: Error) => {
      app.log.error({ err }, 'HTTP server close failed');
    });
    const timedOut = await withDeadline(closed, cfg.shutdownGraceMs);
    if (timedOut) {
      // Exit code stays 0 for this: a slow drain is a capacity problem to alert on, not a crash,
      // and reporting failure here would make every deploy look like one.
      app.log.error(
        { graceMs: cfg.shutdownGraceMs },
        'grace period expired with requests still in flight — dropping them',
      );
    }

    // The metrics listener closes after the API has drained and before the pools do. After, so the
    // drain itself stays scrapeable — a slow shutdown is a thing you want a graph of. Before, so a
    // scrape cannot arrive at a pool that has just been ended and turn a clean shutdown into an
    // error log.
    await metrics?.close();

    // Step 4, and last on purpose. Ending a pool while a handler still holds a client aborts a
    // request that was about to succeed and leaves the server to roll its transaction back on
    // disconnect. On session creation that is a device reserved by a transaction that never
    // committed, and an idempotency key claimed for a response that was never produced.
    await closePools();
    return !timedOut;
  };

  return {
    address,
    close: (reason = 'close') => (draining ??= drain(reason)),
  };
}

/**
 * Plain stderr, not the logger: the logger is built from the configuration that just failed to
 * parse. Whoever is looking at a crash-looping pod gets every problem in one message, which is the
 * entire reason parseConfig collects them instead of throwing on the first.
 *
 * Exit 78 is EX_CONFIG, so a supervisor can tell "this will never start" from "this crashed". It
 * covers the startup RLS assertion too: an app role that bypasses RLS will not fix itself on a
 * restart either.
 */
function exitOnConfigError(err: unknown): never {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`[api] ${err.message}`);
  process.exit(78);
}

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    return exitOnConfigError(err);
  }
}

async function main(): Promise<void> {
  // Installed before anything can throw. An uncaught exception or a rejected promise means an
  // invariant nobody anticipated is already broken; Node's default for an unhandled rejection is
  // to crash anyway, and the default for an uncaught exception used to be to carry on, which is
  // the worse half. No drain is attempted from here: the shutdown path runs application code, and
  // application code is exactly what has just been shown to be untrustworthy. A supervisor restart
  // is cheaper than a process that keeps allocating devices from a state nobody has reasoned about.
  const die = (kind: string) => (err: unknown) => {
    console.error(`[api] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  };
  process.on('uncaughtException', die('uncaughtException'));
  process.on('unhandledRejection', die('unhandledRejection'));

  const service = await start(loadConfigOrExit()).catch(exitOnConfigError);

  let signalled = false;
  const onSignal = (signal: string) => {
    if (signalled) {
      // The second signal is the platform (or a person) saying the drain has gone on too long.
      // Refusing it is how a rolling deploy stalls until the kubelet SIGKILLs us anyway, with the
      // pools left open instead of closed.
      console.error(`[api] ${signal} again — exiting now, in-flight requests dropped`);
      process.exit(1);
    }
    signalled = true;
    void service.close(signal).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

/**
 * Whether this module IS the process, rather than something the process imported.
 *
 * The obvious `import.meta.url === pathToFileURL(process.argv[1]).href` is wrong, and wrong in the
 * direction that produces silence. Node's ESM loader resolves the entry point through symlinks, so
 * `import.meta.url` is the REAL path; `process.argv[1]` is whatever was typed. Under the standard
 * release layout — `/app/current -> /app/releases/2026-08-16`, a Capistrano-style deploy, a bind
 * mount that traverses a symlink — the two differ, `main()` never runs, and the process prints
 * nothing and exits 0. A supervisor reads that as a clean shutdown, and none of the EX_CONFIG
 * signalling above ever happens because the configuration is never parsed.
 *
 * `realpathSync` puts argv[1] in the same terms as `import.meta.url`. The unresolved comparison is
 * kept as well, for `--preserve-symlinks-main` and for anything that puts a non-file path in
 * argv[1]; realpathSync throws on a path that does not exist, which is why it is guarded.
 *
 * `import.meta.main` would say this directly, but it is undefined on the Node this project targets
 * (checked on 23.11.0, and it landed later than the `>=22.6` in package.json), so it is not usable.
 */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(argv1).href) return true;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((err: Error) => {
    console.error('[api] fatal:', err.stack ?? err.message);
    process.exit(1);
  });
}
