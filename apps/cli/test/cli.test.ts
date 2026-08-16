/**
 * The rest of the command surface, plus the two pure functions that decide whether a credential
 * ends up in a log.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  webdriverUrl, webdriverCredential, maskUrl, ControlPlaneClient, ApiError,
} from '../src/client.ts';
import { startControlPlane, runCli, API_KEY } from './harness.ts';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

describe('webdriverUrl', () => {
  test('embeds the key as basic-auth userinfo on the origin', () => {
    assert.equal(
      webdriverUrl('https://api.mfarm.dev', 'mfk_abc'),
      'https://mfk_abc@api.mfarm.dev/wd/hub',
    );
  });

  test('drops any path, query or fragment on the configured API base', () => {
    // A base of `…/v1` must not produce `/v1/wd/hub`: the hub is mounted at the origin, and the
    // resulting 404 would surface inside the customer's Appium client as an unhelpful protocol error.
    assert.equal(
      webdriverUrl('https://api.mfarm.dev/v1/?x=1#f', 'mfk_abc'),
      'https://mfk_abc@api.mfarm.dev/wd/hub',
    );
  });

  test('keeps a non-default port, so a local control plane works unchanged', () => {
    assert.equal(webdriverUrl('http://127.0.0.1:8080', 'mfk_abc'), 'http://mfk_abc@127.0.0.1:8080/wd/hub');
  });

  /**
   * The value in the URL is the value that must be masked.
   *
   * Whoever registers a redaction (GitHub's `::add-mask::`) matches a literal, so if the URL's
   * userinfo differs from the raw key by so much as one percent-escape, the credential prints in
   * full the first time an Appium client logs its configuration. `webdriverCredential` is the
   * single source of that string, exported so the masker and the URL cannot drift apart.
   */
  test('the credential in the URL is exactly webdriverCredential(key)', () => {
    // The last three are the ones that catch a regression to a bare `url.username = apiKey`: the
    // URL setter applies the *userinfo* percent-encode set, which leaves sub-delims (`&+,$`) and
    // even a lone `%` alone, so its output and `encodeURIComponent`'s diverge. Whichever is used,
    // the masker has to be handed the one that actually appears — that is what this pins.
    for (const key of ['mfk_abc', 'mfk_aB3-_xY', 'mfk_a/b:c@d#e', 'mfk_a&b+c,d$e', 'mfk_a%b', 'mfk_k\n']) {
      const url = webdriverUrl('https://api.mfarm.dev', key);
      assert.equal(
        new URL(url).username,
        webdriverCredential(key),
        `the userinfo in ${maskUrl(url)} is not the string a masker would be given for ${JSON.stringify(key)}`,
      );
    }
  });

  test('a real mfarm key is unchanged by the encoding', () => {
    // `generateApiKey` in apps/api/src/auth.ts mints `mfk_` + base64url(32 bytes). That alphabet
    // (A-Za-z0-9-_) has no character the userinfo component encodes, so the raw and encoded forms
    // are identical and today's single `::add-mask::` of the raw key does cover the URL.
    const realShaped = `mfk_${Buffer.from('x'.repeat(32)).toString('base64url')}`;
    assert.match(realShaped, /^mfk_[A-Za-z0-9_-]+$/);
    assert.equal(webdriverCredential(realShaped), realShaped);
  });

  test('every key round-trips, so the hub is handed the key the operator configured', () => {
    // Not reachable with today's key format, but the failure mode is a 401 nobody can explain —
    // the URL carries a *different* credential than the one we were given. A lone `%` is the sharp
    // case: the userinfo encode set leaves it as-is, producing a malformed escape that no longer
    // decodes back to the key at all.
    for (const key of ['mfk_a/b:c@d#e?f', 'mfk_a%b', 'mfk_a&b+c,d$e', 'mfk_abc\n', 'mfk_a b']) {
      const parsed = new URL(webdriverUrl('https://api.mfarm.dev', key));
      assert.equal(decodeURIComponent(parsed.username), key, `${JSON.stringify(key)} did not round-trip`);
      assert.equal(parsed.host, 'api.mfarm.dev');
      assert.equal(parsed.pathname, '/wd/hub');
    }
  });
});

describe('maskUrl', () => {
  test('removes the credential and leaves the URL readable', () => {
    assert.equal(maskUrl('https://mfk_abc@api.mfarm.dev/wd/hub'), 'https://***@api.mfarm.dev/wd/hub');
  });

  test('passes through anything that is not a URL, rather than throwing mid-error-report', () => {
    assert.equal(maskUrl('connection refused'), 'connection refused');
  });
});

describe('ControlPlaneClient', () => {
  test('surfaces the server code and requestId on a 4xx', async () => {
    const api = await startControlPlane({ createStatuses: [400] });
    try {
      const client = new ControlPlaneClient({ baseUrl: api.url, apiKey: API_KEY });
      const err = await client.createSession({ region: 'us-east', platform: 'android' })
        .then(() => null, (e: unknown) => e);

      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.equal(err.requestId, 'req-400');
      assert.match(err.message, /req-400/);
    } finally {
      await api.close();
    }
  });

  test('treats a 404 on release as already released, not as an error', async () => {
    const api = await startControlPlane({ deleteStatus: 404 });
    try {
      const client = new ControlPlaneClient({ baseUrl: api.url, apiKey: API_KEY });
      assert.equal(await client.deleteSession(SESSION_ID), false);
    } finally {
      await api.close();
    }
  });

  test('reports a refused connection instead of hanging', async () => {
    // Port 1 is reserved and nothing listens on it; this is the "control plane is down" path.
    const client = new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY, retries: 1, backoffBaseMs: 1 });
    const err = await client.listDevices().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /after 2 attempt/);
  });

  test('normalises a trailing slash on the base URL', async () => {
    const api = await startControlPlane();
    try {
      const client = new ControlPlaneClient({ baseUrl: `${api.url}/`, apiKey: API_KEY });
      await client.listDevices();
      assert.equal(api.of('GET', '/v1/devices')[0]?.path, '/v1/devices');
    } finally {
      await api.close();
    }
  });
});

describe('mfarm devices / session', () => {
  test('devices --json prints one object on stdout and nothing on stdout otherwise', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(['devices', '--api', api.url, '--json']);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.available, 1);
      assert.equal(parsed.devices[0].model, 'Pixel 8');
    } finally {
      await api.close();
    }
  });

  test('devices prints a human line per device, with the summary on stderr', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(['devices', '--api', api.url]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Pixel 8/);
      assert.match(r.stderr, /1 of 1 ready/);
    } finally {
      await api.close();
    }
  });

  test('session get prints the session', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(['session', 'get', SESSION_ID, '--api', api.url, '--json']);
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout.trim()).session.id, SESSION_ID);
    } finally {
      await api.close();
    }
  });

  test('session rm releases, and reports an already-released session as success', async () => {
    const api = await startControlPlane({ deleteStatus: 404 });
    try {
      const r = await runCli(['session', 'rm', SESSION_ID, '--api', api.url, '--json']);
      // Exit 0: a cleanup step that fails when the reaper got there first is a cleanup step people
      // delete from their pipeline.
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout.trim()).released, false);
    } finally {
      await api.close();
    }
  });
});

describe('mfarm usage', () => {
  test('--version prints the package version on stdout', async () => {
    const r = await runCli(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('--help prints usage on stdout and exits 0', async () => {
    const r = await runCli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /mfarm run \[options\]/);
  });

  test('no arguments prints usage on stderr and exits 1', async () => {
    const r = await runCli([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /mfarm run \[options\]/);
    assert.equal(r.stdout, '');
  });

  test('run without a `--` separator says what to do about it', async () => {
    const r = await runCli(['run', '--region', 'us-east']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Put your command after/);
  });

  test('a missing API key is a usage error, not an auth round trip', async () => {
    const r = await runCli(['devices'], { env: { MFARM_API_KEY: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No API key/);
  });

  test('a missing region is a usage error', async () => {
    const r = await runCli(['run', '--', 'true'], { env: { MFARM_REGION: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No region/);
  });

  /**
   * An empty string is an absence, not a value.
   *
   * This is reachable from CI, not just by hand. A composite action interpolates its inputs
   * unconditionally — `--platform "${IN_PLATFORM}"` — and GitHub does not apply an input's
   * `required:`/`default:` when the caller passes an explicitly empty expression. So `--region ''`
   * and `--platform ''` are things the CLI is actually handed, and treating them as values sends an
   * empty region to the API or fails with a message about a platform nobody typed.
   */
  describe('an empty string flag is an absence', () => {
    test('--region \'\' is a missing region, not an empty one', async () => {
      const api = await startControlPlane();
      try {
        const r = await runCli(['run', '--api', api.url, '--region', '', '--', 'true'], {
          env: { MFARM_REGION: undefined },
        });
        assert.equal(r.code, 1);
        assert.match(r.stderr, /No region/);
        assert.equal(api.requests.length, 0, 'an empty region must never reach the API');
      } finally {
        await api.close();
      }
    });

    test('--platform \'\' falls back to the default instead of failing the setup', async () => {
      const api = await startControlPlane();
      try {
        const r = await runCli([
          'run', '--api', api.url, '--region', 'us-east', '--platform', '', '--tier', '', '--',
          'node', '-e', 'process.exit(0)',
        ], { env: { MFARM_PLATFORM: undefined, MFARM_TIER: undefined } });

        assert.equal(r.code, 0);
        assert.doesNotMatch(r.stderr, /--platform must be/);
        const body = api.of('POST', '/v1/sessions')[0]?.body as Record<string, unknown>;
        assert.deepEqual(body, { region: 'us-east', platform: 'android', ttlMinutes: 30,
                                 requireCapabilities: ['webdriver'] });
      } finally {
        await api.close();
      }
    });

    test('an empty flag defers to the environment, exactly as an omitted one does', async () => {
      const api = await startControlPlane();
      try {
        const r = await runCli([
          'run', '--api', '', '--region', '', '--platform', '', '--ttl', '', '--',
          'node', '-e', 'process.exit(0)',
        ], { env: { MFARM_API_URL: api.url, MFARM_REGION: 'eu-west', MFARM_PLATFORM: 'ios', MFARM_TTL: '5' } });

        assert.equal(r.code, 0);
        const body = api.of('POST', '/v1/sessions')[0]?.body as Record<string, unknown>;
        assert.deepEqual(body, { region: 'eu-west', platform: 'ios', ttlMinutes: 5,
                               requireCapabilities: ['webdriver'] });
      } finally {
        await api.close();
      }
    });

    test('--api-key \'\' is a missing key, and is reported before any round trip', async () => {
      const api = await startControlPlane();
      try {
        const r = await runCli(['devices', '--api', api.url, '--api-key', ''], {
          env: { MFARM_API_KEY: undefined },
        });
        assert.equal(r.code, 1);
        assert.match(r.stderr, /No API key/);
        assert.equal(api.requests.length, 0);
      } finally {
        await api.close();
      }
    });
  });

  test('an out-of-range --ttl is rejected before anything is allocated', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(['run', '--api', api.url, '--region', 'us-east', '--ttl', '999', '--', 'true']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--ttl must be a whole number between 1 and 240/);
      assert.equal(api.requests.length, 0);
    } finally {
      await api.close();
    }
  });

  test('an unknown flag is reported rather than passed to the child', async () => {
    const r = await runCli(['run', '--nope']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nope/);
  });

  test('only the first `--` is a separator; the rest belongs to the child', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', 'us-east', '--',
        'node', '-e', 'process.exit(process.argv.includes("--json") ? 0 : 9)', '--', '--json',
      ]);
      // If mfarm had eaten the child's `--json`, the child would exit 9 — and mfarm would have
      // printed a JSON summary of its own to stdout.
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '', 'mfarm must not have treated the child\'s --json as its own');
    } finally {
      await api.close();
    }
  });

  test('reads configuration from the environment when no flags are given', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(['run', '--', 'node', '-e', 'process.exit(0)'], {
        env: { MFARM_API_URL: api.url, MFARM_REGION: 'eu-west', MFARM_PLATFORM: 'ios', MFARM_TTL: '5' },
      });
      assert.equal(r.code, 0);
      const body = api.of('POST', '/v1/sessions')[0]?.body as Record<string, unknown>;
      assert.deepEqual(body, { region: 'eu-west', platform: 'ios', ttlMinutes: 5,
                               requireCapabilities: ['webdriver'] });
    } finally {
      await api.close();
    }
  });

  /**
   * The device this allocates is the device the hub is then told to drive, so it has to be one that
   * can run Appium — otherwise the run fails at the first `POST /session`, after allocation, which
   * is the worst possible place to discover it. `--no-webdriver` is the opt-out for suites that
   * only speak the raw data plane.
   */
  test('--no-webdriver stops demanding a device that can serve Appium', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', 'us-east', '--no-webdriver', '--',
        'node', '-e', 'process.exit(0)',
      ]);
      assert.equal(r.code, 0);
      const body = api.of('POST', '/v1/sessions')[0]?.body as Record<string, unknown>;
      assert.equal(body.requireCapabilities, undefined);
    } finally {
      await api.close();
    }
  });
});
