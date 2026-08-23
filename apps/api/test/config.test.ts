/**
 * Configuration parsing.
 *
 * The interesting half is the production refusals. Every one of them describes a deployment that
 * would otherwise have started, passed its health check, and been wrong — a fleet with no reaper, a
 * process talking to a tmpfs database on someone's laptop, an app connected as the owner with row
 * level security silently inert. Config is the only place those are cheap to catch.
 *
 * No database, no ports, no process.env: parseConfig takes the environment as an argument.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  ConfigError,
  DEV_APP_URL,
  DEV_SYSTEM_URL,
  describeConfig,
  parseConfig,
  parseDbConfig,
  redactUrl,
} from '../src/config.ts';
import { generateKeypair } from '../src/tokens.ts';

const kp = generateKeypair();

/** A production environment with nothing wrong with it. Each test breaks exactly one thing. */
const prod = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://mfarm_owner:rotated-owner-pw@db.internal:5432/mfarm',
  APP_DATABASE_URL: 'postgres://mfarm_app:rotated-app-pw@db.internal:5432/mfarm',
  SESSION_SIGNING_KEY: kp.privateKeyPem,
  SESSION_PUBLIC_KEY: kp.publicKeyPem,
  APP_STORE_DIR: '/var/lib/mfarm/apps',
  ARTIFACT_DIR: '/var/lib/mfarm/artifacts',
  ...overrides,
});

/** Asserts the environment is refused and hands back the complaints. */
function refusal(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
    return err.problems;
  }
  assert.fail('expected parseConfig to refuse this environment');
}

/** Case-insensitive substring match across the whole complaint list. */
const mentions = (problems: string[], needle: string) =>
  problems.some((p) => p.toLowerCase().includes(needle.toLowerCase()));

describe('defaults', () => {
  test('an empty environment is a working local-dev configuration', () => {
    const c = parseConfig({});
    assert.equal(c.nodeEnv, 'development');
    assert.equal(c.isProduction, false);
    assert.equal(c.port, 3000);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.databaseUrl, DEV_SYSTEM_URL);
    assert.equal(c.appDatabaseUrl, DEV_APP_URL);
    assert.equal(c.signingKeySource, 'ephemeral');
    assert.equal(c.reaperIntervalMs, 30_000);
    assert.equal(c.rateLimitMax, 120);
    assert.equal(c.logLevel, 'info');
    assert.equal(c.shutdownGraceMs, 15_000);
  });

  test('the reaper is ON by default — off is a choice someone has to make', () => {
    // The whole reason this file exists: buildServer defaults the reaper to off because that is
    // right for tests, and a deployment that inherits a test default collects nothing.
    assert.ok(parseConfig({}).reaperIntervalMs > 0);
  });

  test('a valid production environment parses', () => {
    const c = parseConfig(prod());
    assert.equal(c.isProduction, true);
    assert.equal(c.signingKeySource, 'environment');
  });

  test('TRUST_PROXY stays off in production, unlike the cookie flag it resembles', () => {
    // These two look like one question — "am I behind a proxy?" — and default in opposite
    // directions on purpose. A Secure cookie with no TLS costs a confusing login; a trusted
    // X-Forwarded-For with no proxy in front lets any caller name its own `req.ip`, which is the
    // key the limiter rations anonymous traffic by. Defaulting that on would ship a limiter that
    // anyone can walk around, so it has to be stated per deployment.
    assert.equal(parseConfig({}).trustProxy, false);
    assert.equal(parseConfig(prod()).sessionCookieSecure, true);
    assert.equal(parseConfig(prod()).trustProxy, false);
    assert.equal(parseConfig(prod({ TRUST_PROXY: '1' })).trustProxy, true);
  });

  test('the result is frozen', () => {
    const c = parseConfig({});
    assert.throws(() => {
      (c as { port: number }).port = 9999;
    }, TypeError);
  });

  test('parseConfig reads its argument and mutates nothing', () => {
    const env = { PORT: '8081', LOG_LEVEL: 'debug' };
    const before = { ...env };
    const c = parseConfig(env);
    assert.deepEqual(env, before);
    assert.equal(c.port, 8081);
    assert.equal(c.logLevel, 'debug');
  });
});

describe('production refusals', () => {
  test('missing signing keys', () => {
    const p = refusal(prod({ SESSION_SIGNING_KEY: undefined, SESSION_PUBLIC_KEY: undefined }));
    assert.ok(mentions(p, 'SESSION_SIGNING_KEY'));
    // The message has to say what breaks, not that a variable is absent.
    assert.ok(mentions(p, 'restart'), p.join('\n'));
  });

  test('half a signing keypair, in any environment', () => {
    // Worse than none: loadSigningKey falls back to an ephemeral pair when either half is missing,
    // so the key that was deployed is not the key in use and nothing says so.
    assert.ok(mentions(refusal(prod({ SESSION_PUBLIC_KEY: undefined })), 'SESSION_PUBLIC_KEY'));
    const dev = refusal({ SESSION_SIGNING_KEY: kp.privateKeyPem });
    assert.ok(mentions(dev, 'SESSION_PUBLIC_KEY'));
  });

  test('a signing key that is not readable', () => {
    // A secret manager that truncated the value still leaves the PEM header in place, so checking
    // for the header is not checking anything.
    const truncated = kp.privateKeyPem.slice(0, kp.privateKeyPem.length / 2);
    assert.ok(mentions(refusal(prod({ SESSION_SIGNING_KEY: truncated })), 'not a readable private key'));
  });

  test('a public key that is really the private key', () => {
    // createPublicKey() ACCEPTS a private PEM and derives the public half from it, so this passed
    // every check and left the signing key sitting in the variable that gets handed to every
    // worker. A round trip does not catch it either — the derived half matches.
    const p = refusal(prod({ SESSION_PUBLIC_KEY: kp.privateKeyPem }));
    assert.ok(mentions(p, 'PRIVATE key material'), p.join('\n'));
    // The complaint must not quote the key back at whoever is reading the crash log.
    assert.ok(!p.join('\n').includes(kp.privateKeyPem));
  });

  test('two halves of two different keypairs', () => {
    // Both parse. Both are Ed25519. Nothing about the pair is wrong except that it is not a pair,
    // which is the whole failure: the process boots cleanly and every token it mints is rejected by
    // every worker. The likely cause is one half left behind by a rotation.
    const other = generateKeypair();
    const p = refusal(prod({ SESSION_PUBLIC_KEY: other.publicKeyPem }));
    assert.ok(mentions(p, 'not the public half'), p.join('\n'));
  });

  test('a matching pair of the wrong algorithm', () => {
    // A real, self-consistent RSA pair: the round trip alone would pass it, and then
    // mintSessionToken would throw on the first session because tokens are Ed25519.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p = refusal(prod({
      SESSION_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      SESSION_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }));
    assert.ok(mentions(p, 'ed25519'), p.join('\n'));
  });

  test('a real keypair is accepted, so the check is not just refusing everything', () => {
    assert.equal(parseConfig(prod()).signingKeySource, 'environment');
  });

  test('the local-dev DATABASE_URL', () => {
    const p = refusal(prod({ DATABASE_URL: DEV_SYSTEM_URL }));
    assert.ok(mentions(p, 'local-dev default'));
    assert.ok(mentions(p, 'tmpfs'), 'must say what is lost, not just that the value is wrong');
  });

  test('the local-dev APP_DATABASE_URL', () => {
    assert.ok(mentions(refusal(prod({ APP_DATABASE_URL: DEV_APP_URL })), 'APP_DATABASE_URL'));
  });

  test('a password that is committed to the repo, even on a real host', () => {
    // Rotating the host and keeping the password is the likely half-migration.
    const p = refusal(prod({ APP_DATABASE_URL: 'postgres://mfarm_app:mfarm_app@db.internal:5432/mfarm' }));
    assert.ok(mentions(p, 'committed to 001_init.sql'));
  });

  test('the app and owner connections being the same', () => {
    const same = 'postgres://mfarm_owner:rotated-owner-pw@db.internal:5432/mfarm';
    const p = refusal(prod({ DATABASE_URL: same, APP_DATABASE_URL: same }));
    assert.ok(mentions(p, 'row-level security'), p.join('\n'));
  });

  describe('the same connection, spelt differently', () => {
    // `===` on the two raw strings was the entire check, and it is the startup-time expression of
    // the most dangerous invariant in this codebase. Every variant below is one connection: the app
    // would run as the schema owner, owners bypass RLS, and every tenant policy would read as
    // enabled while enforcing nothing. COMMITTED_PASSWORDS is not a backstop here — these use
    // rotated passwords, so it never fires.
    const owner = 'postgres://mfarm_owner:rotated-owner-pw@db.internal:5432/mfarm';
    const variants: Record<string, string> = {
      'a query parameter on one side': `${owner}?sslmode=require`,
      'the postgresql:// spelling': owner.replace('postgres://', 'postgresql://'),
      'a trailing slash on the database name': `${owner}/`,
      'a different password for the same role': owner.replace('rotated-owner-pw', 'other-pw'),
      'an uppercase hostname': owner.replace('db.internal', 'DB.INTERNAL'),
      'a percent-encoded role name': owner.replace('mfarm_owner', 'mfarm%5Fowner'),
      'the default port written out on one side': owner.replace(':5432', ''),
    };

    for (const [what, appUrl] of Object.entries(variants)) {
      test(what, () => {
        const p = refusal(prod({ DATABASE_URL: owner, APP_DATABASE_URL: appUrl }));
        assert.ok(mentions(p, 'row-level security'), `${appUrl} was accepted:\n${p.join('\n')}`);
      });
    }

    test('genuinely different roles on the same server are still fine', () => {
      // The check must not be so eager that a correct deployment cannot start.
      const c = parseConfig(prod({
        DATABASE_URL: owner,
        APP_DATABASE_URL: 'postgresql://mfarm_app:rotated-app-pw@db.internal:5432/mfarm?sslmode=require',
      }));
      assert.equal(c.isProduction, true);
    });
  });

  test('the local-dev default, laundered through a query parameter', () => {
    // Same class as above: the dev-default check was string equality too.
    const p = refusal(prod({ APP_DATABASE_URL: `${DEV_APP_URL}?sslmode=require` }));
    assert.ok(mentions(p, 'local-dev default'), p.join('\n'));
  });

  test('a reaper interval of 0', () => {
    const p = refusal(prod({ REAPER_INTERVAL_MS: '0' }));
    // Naming all three consequences, because "invalid" would not tell anyone why they should care.
    assert.ok(mentions(p, 'expire_sessions'));
    assert.ok(mentions(p, 'promote_queued'));
    assert.ok(mentions(p, 'idempotency_keys'));
  });

  test('a reaper interval fast enough to be a load generator', () => {
    assert.ok(mentions(refusal(prod({ REAPER_INTERVAL_MS: '50' })), 'REAPER_INTERVAL_MS'));
  });

  test('none of these are refused outside production', () => {
    // Local dev has to keep working with an empty environment, or nobody will run it.
    const c = parseConfig({ DATABASE_URL: DEV_SYSTEM_URL, APP_DATABASE_URL: DEV_APP_URL, REAPER_INTERVAL_MS: '0' });
    assert.equal(c.reaperIntervalMs, 0);
  });
});

describe('malformed values', () => {
  test('a non-numeric port', () => {
    assert.ok(mentions(refusal({ PORT: '8080abc' }), 'PORT'));
  });

  test('a duration written the way a human writes one', () => {
    // "30s" is Number-NaN, and the old `Number(process.env.X ?? d)` style turned that into NaN
    // rather than an error.
    assert.ok(mentions(refusal({ REAPER_INTERVAL_MS: '30s' }), 'REAPER_INTERVAL_MS'));
  });

  test('a port outside the range', () => {
    assert.ok(mentions(refusal({ PORT: '70000' }), 'PORT'));
  });

  test('a rate limit of zero', () => {
    // Not a refusal to serve; a refusal to serve anything, including the probes.
    assert.ok(mentions(refusal({ RATE_LIMIT_MAX: '0' }), 'RATE_LIMIT_MAX'));
  });

  test('a log level pino would throw on', () => {
    // pino throws while constructing the logger, so this kills the process at startup either way —
    // the difference is whether the operator gets a sentence or a stack trace.
    assert.ok(mentions(refusal({ LOG_LEVEL: 'verbose' }), 'LOG_LEVEL'));
  });

  test('a connection string that is not a postgres URL', () => {
    assert.ok(mentions(refusal({ DATABASE_URL: 'mysql://u:p@h:3306/db' }), 'postgres'));
    assert.ok(mentions(refusal({ APP_DATABASE_URL: 'not a url at all' }), 'APP_DATABASE_URL'));
  });

  test('a misspelt NODE_ENV is caught rather than read as "not production"', () => {
    // The dangerous direction: `NODE_ENV=prod` silently disables every guard above.
    assert.ok(mentions(refusal({ NODE_ENV: 'prod' }), 'NODE_ENV'));
  });
});

describe('reporting', () => {
  test('every problem is named at once, not one per restart', () => {
    const p = refusal({
      NODE_ENV: 'production',
      PORT: 'http',
      LOG_LEVEL: 'chatty',
      REAPER_INTERVAL_MS: '0',
      RATE_LIMIT_MAX: '-4',
    });
    // Two bad numbers, a bad level, a dead reaper, the dev database twice, and no signing keys.
    assert.ok(p.length >= 6, `expected the whole list, got:\n${p.join('\n')}`);
    for (const needle of ['PORT', 'LOG_LEVEL', 'REAPER_INTERVAL_MS', 'RATE_LIMIT_MAX', 'SESSION_SIGNING_KEY']) {
      assert.ok(mentions(p, needle), `${needle} missing from:\n${p.join('\n')}`);
    }
  });

  test('the thrown message contains the list, so a container log is enough to fix it', () => {
    try {
      parseConfig({ NODE_ENV: 'production' });
      assert.fail('expected a refusal');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes('DATABASE_URL'));
      assert.ok(err.message.includes('SESSION_SIGNING_KEY'));
    }
  });
});

describe('redaction', () => {
  test('a connection string keeps its host and loses its password', () => {
    const out = redactUrl('postgres://mfarm_app:hunter2@db.internal:5432/mfarm');
    assert.ok(!out.includes('hunter2'));
    assert.ok(out.includes('db.internal'), 'a log line without the host is not worth writing');
    assert.ok(out.includes('mfarm_app'), 'the role is the thing you are usually diagnosing');
  });

  test('nothing describeConfig emits contains a secret', () => {
    const described = describeConfig(parseConfig(prod()));
    const serialised = JSON.stringify(described);
    for (const secret of ['rotated-owner-pw', 'rotated-app-pw', 'PRIVATE KEY']) {
      assert.ok(!serialised.includes(secret), `${secret} leaked into the startup log: ${serialised}`);
    }
    assert.equal(described.signingKeySource, 'environment');
    assert.equal(described.listen, '0.0.0.0:3000');
  });

  test('an unparseable connection string does not get echoed back into the log', () => {
    assert.equal(redactUrl('postgres://user:pw@ho st/db'), '<unparseable>');
  });
});

/**
 * The database environment, read in exactly one place (known issues 7 and 8).
 *
 * `db.ts` used to carry its own copies of the local-dev connection strings and its own unchecked
 * `Number()` calls for the pool sizes. Both are the same class of defect: a second reader that
 * agrees with the first until the day it does not.
 */
describe('database configuration', () => {
  test('an unset environment falls back to the shared dev defaults', () => {
    const db = parseDbConfig({}, []);
    // The literals live in config.ts and nowhere else. If db.ts ever grows its own copy again,
    // this is not what catches it — the test below is.
    assert.equal(db.databaseUrl, DEV_SYSTEM_URL);
    assert.equal(db.appDatabaseUrl, DEV_APP_URL);
    assert.equal(db.poolMax, 20);
    assert.equal(db.systemPoolMax, 5);
    assert.equal(db.pgConnectTimeoutMs, 10_000);
  });

  test('a non-numeric pool size is a reported problem, never NaN', () => {
    // The actual defect: `Number('twenty')` reached `new Pool({ max: NaN })`, which does not throw.
    // It misbehaves under load instead — the worst moment to discover a config typo.
    const problems: string[] = [];
    const db = parseDbConfig({ PG_POOL_MAX: 'twenty' }, problems);
    assert.ok(!Number.isNaN(db.poolMax), 'the pool must never receive NaN');
    assert.equal(db.poolMax, 20, 'falls back rather than propagating garbage');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /PG_POOL_MAX/);
  });

  test('pool sizes are bounded on both ends', () => {
    for (const [name, value] of [['PG_POOL_MAX', '0'], ['PG_SYSTEM_POOL_MAX', '0'],
                                 ['PG_POOL_MAX', '99999'], ['PG_POOL_MAX', '2.5']] as const) {
      const problems: string[] = [];
      parseDbConfig({ [name]: value }, problems);
      assert.equal(problems.length, 1, `${name}=${value} should be rejected`);
      assert.match(problems[0], new RegExp(name));
    }
  });

  test('parseConfig reports a pool typo alongside everything else, and exits 78 in production', () => {
    // This is what makes discarding the problems array inside db.ts safe: the same variables are
    // read again here, and main turns this into EX_CONFIG rather than a surprise at load.
    const problems = refusal({ NODE_ENV: 'production', PG_POOL_MAX: 'lots' });
    assert.ok(problems.some((p) => /PG_POOL_MAX/.test(p)),
      'a pool typo must appear in the same list as every other problem');
  });

  test('pool sizing is logged at startup, so it is answerable without a shell', () => {
    const described = describeConfig(parseConfig({ PG_POOL_MAX: '42' }));
    assert.equal(described.poolMax, 42);
    assert.equal(described.systemPoolMax, 5);
  });
});

/**
 * The metrics listener is a SECOND server, and the settings that decide who can reach it are the
 * whole of its access control. Every gauge it serves is fleet-wide and collected on the owner pool
 * because RLS would otherwise hide it, so a mistake here discloses every org's devices and sessions
 * to whoever can open the port.
 */
describe('metrics listener configuration', () => {
  test('the default is loopback, on its own port, with no credential needed', () => {
    const c = parseConfig({});
    assert.equal(c.metricsEnabled, true);
    assert.equal(c.metricsHost, '127.0.0.1');
    assert.equal(c.metricsPort, 9464);
    assert.equal(c.metricsTokenSource, 'none');
  });

  test('the scrape token is never carried on Config, only whether one exists', () => {
    const c = parseConfig({ METRICS_TOKEN: 'super-secret-scrape-token' });
    assert.equal(c.metricsTokenSource, 'environment');
    const described = JSON.stringify(describeConfig(c));
    assert.ok(!described.includes('super-secret-scrape-token'), 'describeConfig() is logged');
  });

  test('an unset APP_STORE_DIR is refused in production', () => {
    // The failure this prevents is delayed and confusing: uploads work, the library fills up, and
    // the first reboot leaves every app_builds row pointing at a blob under a cleared temp
    // directory. The refusal is at startup because that is the last moment it is cheap.
    const problems = refusal(prod({ APP_STORE_DIR: undefined }));
    assert.ok(mentions(problems, 'APP_STORE_DIR'));
    assert.ok(mentions(problems, 'reboot'));
  });

  test('APP_STORE_DIR defaults to a temp directory outside production', () => {
    assert.match(parseConfig({}).appStoreDir, /mfarm-app-store/);
  });

  test('an unset ARTIFACT_DIR is refused in production', () => {
    // Same delayed failure as APP_STORE_DIR, with a worse ending: the artifacts rows survive the
    // reboot that clears the blobs, so a failed run links to evidence that 404s — and the person
    // following the link is already having a bad day.
    const problems = refusal(prod({ ARTIFACT_DIR: undefined }));
    assert.ok(mentions(problems, 'ARTIFACT_DIR'));
    assert.ok(mentions(problems, 'reboot'));
  });

  test('ARTIFACT_DIR defaults to a temp directory outside production', () => {
    assert.match(parseConfig({}).artifactDir, /mfarm-artifacts/);
  });

  test('artifacts and apps never share a root', () => {
    // They have different lifetimes — apps live until deleted, artifacts expire — so the retention
    // sweep must never be able to walk into the app store.
    const c = parseConfig(prod({}));
    assert.notEqual(c.artifactDir, c.appStoreDir);
    assert.notEqual(parseConfig({}).artifactDir, parseConfig({}).appStoreDir);
  });

  test('a non-loopback bind with no token is refused in production', () => {
    // The realistic case: METRICS_HOST must be 0.0.0.0 for Prometheus to scrape across a container
    // network, and "only the docker network can reach it" stops being true the moment the port is
    // published.
    const problems = refusal(prod({ METRICS_HOST: '0.0.0.0' }));
    assert.ok(mentions(problems, 'METRICS_TOKEN'));
    // A token makes it acceptable.
    assert.equal(parseConfig(prod({ METRICS_HOST: '0.0.0.0', METRICS_TOKEN: 'x' })).metricsHost, '0.0.0.0');
    // So does staying on loopback.
    assert.equal(parseConfig(prod({ METRICS_HOST: '127.0.0.1' })).metricsPort, 9464);
  });

  test('collision with the API port is refused', () => {
    const problems = refusal(prod({ PORT: '9464' }));
    assert.ok(mentions(problems, 'METRICS_PORT'));
    // Which of the two listeners loses the bind is a race, so this must be caught before either.
    assert.ok(mentions(problems, 'WebDriver'));
  });

  test('a mistyped METRICS_ENABLED is a refusal, not a silent "off"', () => {
    // `x === 'true'` reads a typo as disabled, and a farm with no metrics does not announce itself.
    assert.ok(mentions(refusal(prod({ METRICS_ENABLED: 'flase' })), 'not a boolean'));
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      assert.equal(parseConfig({ METRICS_ENABLED: off }).metricsEnabled, false, off);
    }
    for (const on of ['1', 'true', 'yes', 'on']) {
      assert.equal(parseConfig({ METRICS_ENABLED: on }).metricsEnabled, true, on);
    }
  });

  test('a disabled listener cannot collide, so the port check does not fire', () => {
    assert.equal(parseConfig(prod({ METRICS_ENABLED: '0', PORT: '9464' })).metricsEnabled, false);
  });
});

/**
 * The drift guard for known issue 7. `db.ts` builds its pools at module load, so what it resolved
 * is observable on the pool objects themselves — which is the only way to prove the two files agree
 * without re-reading the source.
 */
describe('db.ts resolves its connections through config.ts', () => {
  test('the pools were built from the shared defaults, not from private literals', async () => {
    const { appPool, systemPool } = await import('../src/db.ts');
    const appOpts = (appPool as unknown as { options: { connectionString?: string; max?: number } }).options;
    const sysOpts = (systemPool as unknown as { options: { connectionString?: string; max?: number } }).options;
    const expected = parseDbConfig(process.env, []);

    assert.equal(appOpts.connectionString, expected.appDatabaseUrl);
    assert.equal(sysOpts.connectionString, expected.databaseUrl);
    assert.equal(appOpts.max, expected.poolMax);
    assert.equal(sysOpts.max, expected.systemPoolMax);
    assert.ok(!Number.isNaN(appOpts.max), 'a pool must never be constructed with NaN');
  });
});
