import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { AgentWindow, type WindowState } from '../src/window.ts';

/**
 * The agent's window — ADR-0009 §1/§3, milestone M2.
 *
 * MOSTLY ABOUT WHAT IT REFUSES, like the gateway tests, and for a sharper reason: this listener is
 * on the machine somebody's phone is plugged into, and a page on ANY website the user visits can
 * send it requests. Three checks stand between a browser tab on `evil.com` and this agent, and each
 * one is tested for the exact bypass it exists to stop.
 *
 * A REAL SERVER ON A REAL SOCKET, never an injected request. `app.inject()` has already shipped a
 * feature in this repo that worked 0% of the time because the suite could not see socket lifecycle,
 * and half of what is checked here — the event stream staying open, a client going away, the
 * `Host` header a browser actually sends — exists nowhere but on a socket.
 */

const HOST = 'SM-S918B';

let state: WindowState;

function fresh(): WindowState {
  return {
    host: {
      hostname: 'laptop.local',
      region: 'local',
      controlPlaneUrl: 'http://127.0.0.1:3000',
      hostId: 'host-1',
      endpoint: 'mfarm+tunnel:/dp',
      tunnel: true,
    },
    devices: [{
      serial: HOST,
      localId: 'phone-SM-S918B',
      model: 'SM-S918B',
      adbState: 'device',
      shared: true,
      status: 'ready',
      installVerification: 'on',
      sessions: 0,
    }],
    notices: [],
  };
}

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';

describe('the agent window', () => {
  let win: AgentWindow;
  let base: string;
  let calls: Array<{ localId: string; enabled: boolean }>;
  let refuse: Error | undefined;

  before(async () => {
    win = new AgentWindow({
      snapshot: () => state,
      token: TOKEN,
      keepAliveMs: 60_000,
      actions: {
        setInstallVerification: async (localId, enabled) => {
          if (refuse) throw refuse;
          calls.push({ localId, enabled });
        },
      },
    });
    // Port 0: the tests must not fight whatever is on 7317 on the machine running them, and the
    // fallback path that picks an ephemeral port has its own test below.
    const port = await win.listen(0);
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => { await win.close(); });

  beforeEach(() => { state = fresh(); calls = []; refuse = undefined; });

  /** A request shaped the way the page's own `fetch` shapes it. */
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}) } });

  const withToken = (path: string) => `${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`;

  // ------------------------------------------------------------------------------- the token

  test('serves the page when the token matches', async () => {
    const res = await get(withToken('/'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /MFARM agent/);
  });

  test('refuses a request with no token at all', async () => {
    const res = await get('/');
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { error: string }).error, 'bad_token');
  });

  test('refuses a token of the right length but the wrong bytes', async () => {
    // Same length on purpose: `timingSafeEqual` throws on a mismatch, so the length is checked
    // separately, and a bug there would show up only for a token that gets past that first gate.
    const wrong = 'x'.repeat(TOKEN.length);
    assert.equal(wrong.length, TOKEN.length);
    const res = await get(`/?t=${wrong}`);
    assert.equal(res.status, 401);
  });

  test('refuses a prefix of the real token', async () => {
    const res = await get(`/?t=${TOKEN.slice(0, -1)}`);
    assert.equal(res.status, 401);
  });

  test('accepts the token as a bearer header, for a client that is not a browser', async () => {
    const res = await get('/api/state', { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
  });

  test('the page does not contain the token', async () => {
    // It arrives in `location.search` and is read there. Templating it into the document would put
    // a credential into anything that saves or screenshots the page.
    const body = await (await get(withToken('/'))).text();
    assert.ok(!body.includes(TOKEN), 'the token must not be baked into the page');
  });

  // ------------------------------------------------------------------------------- Origin

  test('refuses a request from another origin', async () => {
    const res = await get(withToken('/api/state'), { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: string }).error, 'bad_origin');
  });

  test('refuses a loopback origin on the wrong port', async () => {
    // Another local app's page is still another origin, and on a developer's laptop there are
    // several. The port is part of the origin precisely so this is a different one.
    const res = await get(withToken('/api/state'), { headers: { origin: 'http://127.0.0.1:1' } });
    assert.equal(res.status, 403);
  });

  test('allows its own origin, in both spellings', async () => {
    const port = win.port;
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const res = await get(withToken('/api/state'), { headers: { origin } });
      assert.equal(res.status, 200, origin);
    }
  });

  test('allows a GET with no Origin, which is what loading the page is', async () => {
    const res = await get(withToken('/'));
    assert.equal(res.status, 200);
  });

  test('refuses a write with no Origin', async () => {
    // `fetch` always sends one on a POST, so requiring it costs the page nothing and closes the
    // shape where a missing header is indistinguishable from a request smuggled in by another site.
    const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: string }).error, 'origin_required');
    assert.deepEqual(calls, []);
  });

  // ------------------------------------------------------------------------------- Host

  /**
   * `Host` is a forbidden header name for `fetch` — the browser owns it, which is exactly what
   * makes it worth checking — so these three go out over a raw socket instead. That is also the
   * honest shape of the attack: the attacker is not using our page's fetch, they are pointing a
   * name they control at 127.0.0.1 and letting the browser fill this header in for them.
   */
  function rawHost(host: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: win.port, path, method: 'GET', headers: { host } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  test('refuses a rebound DNS name pointed at loopback', async () => {
    // The attack the Origin check alone does not stop: `evil.example` resolves to 127.0.0.1, so the
    // attacker's page IS same-origin with us and its Origin header is its own name. Only the Host
    // header still says where the browser thought it was going.
    const res = await rawHost('evil.example', withToken('/api/state'));
    assert.equal(res.status, 421);
    assert.equal((JSON.parse(res.body) as { error: string }).error, 'bad_host');
  });

  test('refuses a Host on the right name and the wrong port', async () => {
    const res = await rawHost('127.0.0.1:1', withToken('/api/state'));
    assert.equal(res.status, 421);
  });

  test('the Host check runs before the token check', async () => {
    // Order matters for what an attacker learns: a rebinding probe must not be able to tell a
    // guessed token from a rejected one by the status code it gets back.
    const res = await rawHost('evil.example', '/api/state');
    assert.equal(res.status, 421);
  });

  // ------------------------------------------------------------------------------- state

  test('serves the composed state as json', async () => {
    const res = await get(withToken('/api/state'));
    const body = await res.json() as WindowState;
    assert.equal(body.host.hostId, 'host-1');
    assert.equal(body.devices[0].serial, HOST);
    assert.equal(body.devices[0].installVerification, 'on');
  });

  test('unknown paths are 404, not the page', async () => {
    const res = await get(withToken('/api/anything'));
    assert.equal(res.status, 404);
  });

  test('sets the headers that keep a local page local', async () => {
    const res = await get(withToken('/'));
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
  });

  // ------------------------------------------------------------------------------- the offer

  test('a button press turns install verification off', async () => {
    const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${win.port}` },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ localId: 'phone-SM-S918B', enabled: false }]);
  });

  test('and can put it back', async () => {
    const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${win.port}` },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ localId: 'phone-SM-S918B', enabled: true }]);
  });

  test('a phone that refuses is reported as the phone refusing', async () => {
    refuse = new Error('device offline');
    const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${win.port}` },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { error: string; message: string };
    assert.equal(body.error, 'device_refused');
    // The message renders next to the button, so it has to be the device's own words.
    assert.match(body.message, /device offline/);
  });

  test('a body without `enabled` is refused rather than guessed at', async () => {
    for (const body of ['{}', '{"enabled":"false"}', 'not json']) {
      const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${win.port}` },
        body,
      });
      assert.equal(res.status, 400, body);
    }
    assert.deepEqual(calls, []);
  });

  test('GET on the action path is a 404, so a link cannot trigger it', async () => {
    // A bare <img src> or a link is a GET. Nothing that changes a device may be reachable by one.
    const res = await get(withToken('/api/devices/phone-SM-S918B/install-verification'));
    assert.equal(res.status, 404);
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------------------------- event stream

describe('the window event stream', () => {
  let win: AgentWindow;
  let base: string;

  before(async () => {
    win = new AgentWindow({ snapshot: () => state, token: TOKEN, keepAliveMs: 60_000 });
    const port = await win.listen(0);
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => { await win.close(); });
  beforeEach(() => { state = fresh(); });

  /** Read SSE frames off a live socket until `want` of them have arrived. */
  async function frames(want: number, act?: () => void): Promise<string[]> {
    const res = await fetch(`${base}/api/events?t=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const out: string[] = [];
    let buf = '';
    let acted = false;
    const decoder = new TextDecoder();
    while (out.length < want) {
      if (!acted && out.length === 1 && act) { acted = true; act(); }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.startsWith('event: state')) out.push(frame);
        if (!acted && out.length === 1 && act) { acted = true; act(); }
      }
    }
    await reader.cancel();
    return out;
  }

  test('a new tab is sent the current state immediately, not on the next change', async () => {
    const [first] = await frames(1);
    const payload = JSON.parse(first.split('\ndata: ')[1]) as WindowState;
    assert.equal(payload.devices[0].status, 'ready');
  });

  test('a change reaches an open tab', async () => {
    const got = await frames(2, () => {
      state.devices[0].status = 'busy';
      state.devices[0].sessions = 1;
      win.push();
    });
    assert.equal(got.length, 2);
    const payload = JSON.parse(got[1].split('\ndata: ')[1]) as WindowState;
    assert.equal(payload.devices[0].status, 'busy');
    assert.equal(payload.devices[0].sessions, 1);
  });

  test('an unchanged snapshot wakes nobody', async () => {
    // The discovery poll pushes on every tick whether or not anything moved. Re-rendering a page
    // every ten seconds forever is how a window that is meant to be left open becomes a thing
    // people close. The tab has already been sent the current state as its first frame, so an
    // identical push must be swallowed — and the next real change must still get through.
    const got = await frames(2, () => {
      win.push();            // identical to what this client already has — must not send
      state.host.hostId = 'host-2';
      win.push();            // this one must
    });
    assert.equal(got.length, 2);
    const payload = JSON.parse(got[1].split('\ndata: ')[1]) as WindowState;
    assert.equal(payload.host.hostId, 'host-2');
  });

  test('a frame pushed immediately before close still reaches the client', async () => {
    /**
     * THE DRAIN RACE. A phone arriving pushes a row and drains the agent in the same tick, so the
     * frame the window exists to deliver is written microseconds before the server is torn down.
     * `closeAllConnections()` destroys sockets and discards whatever is queued on them.
     *
     * Its own window, because it closes the server.
     */
    const own = new AgentWindow({ snapshot: () => state, token: TOKEN, keepAliveMs: 60_000 });
    const port = await own.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/api/events?t=${TOKEN}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Drain the first frame, so what follows is unambiguously the pushed one.
    await reader.read();

    // BIG, on purpose. A short frame on loopback is absorbed by the kernel buffer during the
    // synchronous `write`, so a small payload cannot tell a flushed socket from a destroyed one —
    // the first version of this test passed with the fix reverted. A payload past the buffer leaves
    // bytes genuinely pending, which is the state the drain has to survive.
    for (let i = 0; i < 4000; i += 1) {
      state.devices.push({
        serial: `RZCX61ANKGE-${i}`, localId: `phone-${i}`, model: 'SM-S918B',
        adbState: 'device', shared: false, status: 'starting', sessions: 0,
        remedy: 'x'.repeat(200),
      });
    }
    own.push();
    await own.close();       // the race: destroy on the heels of the write

    const dec = new TextDecoder();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    assert.match(rest, /RZCX61ANKGE-3999/, 'the last frame before a close must not be truncated or discarded');
  });

  test('a stream needs the token like everything else', async () => {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------------- binding

describe('where the window binds', () => {
  test('loopback only, never a public interface', async () => {
    const win = new AgentWindow({ snapshot: () => fresh(), token: TOKEN });
    const port = await win.listen(0);
    try {
      // ADR-0009 §3's first mitigation, and the one with no configuration knob: there is no
      // deployment where the agent's own control surface should answer another machine.
      const res = await fetch(`http://127.0.0.1:${port}/?t=${TOKEN}`);
      assert.equal(res.status, 200);
      assert.equal(win.url, `http://127.0.0.1:${port}/?t=${TOKEN}`);
    } finally {
      await win.close();
    }
  });

  test('a busy port is taken over by an ephemeral one rather than failing', async () => {
    // Two agents on one laptop is an ordinary thing to do while testing, and refusing to open a
    // window over a port number would be the wrong trade — the url is printed and opened either way.
    const first = new AgentWindow({ snapshot: () => fresh(), token: TOKEN });
    const port = await first.listen(0);
    const second = new AgentWindow({ snapshot: () => fresh(), token: TOKEN });
    try {
      const got = await second.listen(port);
      assert.notEqual(got, port);
      assert.ok(got > 0);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('an action the agent cannot perform is a 501, not a crash', async () => {
    const win = new AgentWindow({ snapshot: () => fresh(), token: TOKEN });
    const port = await win.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/devices/cf-1/install-verification?t=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(res.status, 501);
    } finally {
      await win.close();
    }
  });
});
