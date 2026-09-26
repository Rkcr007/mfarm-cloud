/**
 * `mfarm mcp` — the real binary, speaking real JSON-RPC over real stdio, to a fake hub on a real port.
 *
 * Same reasoning as `harness.ts`: what matters about an MCP server is that stdout carries nothing
 * but protocol, that a device goes back when the client goes away, and that the commands it sends
 * are the ones the hub forwards. A unit test of `McpServer` with a mocked transport can see none of
 * those. The parser gets unit tests of its own at the bottom, because its inputs are fixtures.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BIN, API_KEY } from './harness.ts';
import { parseUiTree, formatUiTree } from '../src/wire.ts';

const WD_SESSION = 'wd-0001';

const ANDROID_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" package="com.acme" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false" focusable="false" focused="false" bounds="[0,0][1080,2400]" displayed="true">
    <android.widget.TextView index="0" package="com.acme" class="android.widget.TextView" text="Welcome &amp; hello" resource-id="com.acme:id/title" content-desc="" clickable="false" focusable="false" focused="false" bounds="[40,200][1040,300]" displayed="true" />
    <android.widget.EditText index="1" package="com.acme" class="android.widget.EditText" text="" resource-id="com.acme:id/email" content-desc="Email" clickable="true" focusable="true" focused="false" bounds="[40,400][1040,520]" displayed="true" />
    <android.widget.Button index="2" package="com.acme" class="android.widget.Button" text="Log in" resource-id="com.acme:id/login" content-desc="" clickable="true" focusable="true" focused="false" bounds="[390,1160][690,1260]" displayed="true" />
    <android.widget.Button index="3" package="com.acme" class="android.widget.Button" text="Hidden" resource-id="" content-desc="" clickable="true" focusable="true" focused="false" bounds="[0,0][0,0]" displayed="true" />
  </android.widget.FrameLayout>
</hierarchy>`;

interface Recorded { method: string; path: string; auth: string; body: unknown }

async function startHub(): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 300 && !(path.startsWith('/v1/')) ? { value } : value));
      };
      if (path.startsWith('/v1/devices')) {
        return send(200, { available: 1, devices: [{
          id: 'dev-1', state: 'ALLOCATED', platform: 'android', tier: 'cuttlefish', model: 'MFARM X1 Pro',
          osVersion: '17', region: 'us-east', dedicated: false,
        }] });
      }
      if (path === `/v1/sessions/${WD_SESSION}`) {
        return send(200, { session: { id: WD_SESSION, state: 'ACTIVE', deviceId: 'dev-1', region: 'us-east' } });
      }
      if (path === '/wd/hub/session' && req.method === 'POST') {
        // What Appium on the farm really answers: the ADB serial as the device name (2026-09-24).
        return send(200, { sessionId: WD_SESSION, capabilities: { 'appium:deviceName': '0.0.0.0:6520', 'appium:platformVersion': '17' } });
      }
      const s = `/wd/hub/session/${WD_SESSION}`;
      if (path === s && req.method === 'DELETE') return send(200, null);
      if (path === `${s}/screenshot`) return send(200, 'iVBORw0KGgo=');
      if (path === `${s}/source`) return send(200, ANDROID_SOURCE);
      if (path === `${s}/actions`) return send(200, null);
      // Only the W3C GET, as Appium 2 does — accepting POST here is how a broken type_text tested green.
      if (path === `${s}/element/active` && req.method === 'GET') return send(200, { 'element-6066-11e4-a52e-4f735466cecf': 'el-7' });
      if (path === `${s}/element/el-7/value`) return send(200, null);
      if (path === `${s}/execute/sync`) return send(200, null);
      if (path === `${s}/se/log`) {
        return send(200, [{ message: 'I/ActivityManager: start' }, { message: 'E/AndroidRuntime: FATAL EXCEPTION' }]);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: { error: 'unknown command', message: `no ${req.method} ${path}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A JSON-RPC client over the child's stdio. Any non-JSON line on stdout fails the test. */
function connect(child: ChildProcessWithoutNullStreams) {
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  const stray: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { stray.push(line); return; }
    const resolve = waiting.get(msg.id as number);
    if (resolve) { waiting.delete(msg.id as number); resolve(msg); }
  });
  let next = 1;
  return {
    stray,
    request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = await this.request('tools/call', { name, arguments: args });
      return r.result as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
    },
  };
}

function spawnMcp(hubUrl: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', BIN, 'mcp'], {
    // The bare origin, as a user configures it (`mfarm` appends `/v1/...` itself). The hub is found at
    // the origin regardless — `HubClient` takes `URL.origin`, so a base with a path cannot move it.
    env: { ...process.env, MFARM_API_KEY: API_KEY, MFARM_API_URL: hubUrl, MFARM_REGION: 'us-east' },
    stdio: 'pipe',
  });
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((r) => child.on('exit', (code) => r(code)));
}

describe('mfarm mcp', () => {
  test('a whole agent turn: initialize, borrow, read, act, give back', async () => {
    const hub = await startHub();
    const child = spawnMcp(hub.url);
    const rpc = connect(child);
    try {
      const init = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const result = init.result as { protocolVersion: string; serverInfo: { name: string } };
      assert.equal(result.protocolVersion, '2025-06-18');
      assert.equal(result.serverInfo.name, 'mfarm');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const tools = (await rpc.request('tools/list')).result as { tools: { name: string }[] };
      assert.ok(tools.tools.some((t) => t.name === 'start_session'));

      const started = await rpc.call('start_session', { appId: 'com.acme@latest' });
      assert.ok(!started.isError, started.content[0]?.text);
      assert.match(started.content[0]!.text!, /open on MFARM X1 Pro · Android 17/, 'named by the control plane');
      assert.doesNotMatch(started.content[0]!.text!, /0\.0\.0\.0:6520/, 'never the ADB serial Appium calls it');

      // The allocation is the hub's: Basic `key:` (empty password = allocate), and the MFARM
      // capabilities the hub knows, with the region from the environment.
      const create = hub.requests.find((r) => r.path === '/wd/hub/session')!;
      assert.equal(create.auth, `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
      const caps = (create.body as { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
      assert.equal(caps['mfarm:region'], 'us-east');
      assert.equal(caps['mfarm:appId'], 'com.acme@latest');
      assert.equal(caps.platformName, 'Android');

      const shot = await rpc.call('screenshot');
      assert.deepEqual(shot.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });

      const tree = await rpc.call('ui_tree');
      assert.match(tree.content[0]!.text!, /\[2\] Button "Log in" id=login \(540,1210 300x100\) tap/);

      const tap = await rpc.call('tap', { index: 2 });
      assert.match(tap.content[0]!.text!, /Tapped 540,1210/);
      const actions = hub.requests.filter((r) => r.path.endsWith('/actions')).at(-1)!;
      const moves = (actions.body as { actions: { actions: { type: string; x?: number; y?: number }[] }[] }).actions[0]!.actions;
      assert.deepEqual([moves[0]!.x, moves[0]!.y], [540, 1210]);

      const typed = await rpc.call('type_text', { text: 'a@b.co', index: 1 });
      assert.ok(!typed.isError, typed.content[0]?.text);
      const value = hub.requests.find((r) => r.path.endsWith('/element/el-7/value'))!;
      assert.deepEqual(value.body, { text: 'a@b.co', value: ['a', '@', 'b', '.', 'c', 'o'] });

      await rpc.call('press_key', { key: 'back' });
      const exec = hub.requests.filter((r) => r.path.endsWith('/execute/sync')).at(-1)!;
      assert.deepEqual(exec.body, { script: 'mobile: pressKey', args: [{ keycode: 4 }] });

      const logs = await rpc.call('device_logs', { grep: 'fatal' });
      assert.equal(logs.content[0]!.text, 'E/AndroidRuntime: FATAL EXCEPTION');

      const ended = await rpc.call('end_session');
      assert.match(ended.content[0]!.text!, /Released/);
      assert.ok(hub.requests.some((r) => r.method === 'DELETE' && r.path === `/wd/hub/session/${WD_SESSION}`));

      assert.deepEqual(rpc.stray, [], 'stdout must carry nothing but protocol');
    } finally {
      child.stdin.end();
      await exited(child);
      await hub.close();
    }
  });

  test('a client that just goes away still gives the device back', async () => {
    const hub = await startHub();
    const child = spawnMcp(hub.url);
    const rpc = connect(child);
    await rpc.request('initialize', { protocolVersion: '2025-06-18' });
    await rpc.call('start_session');
    child.stdin.end();
    const code = await exited(child);
    await hub.close();
    assert.equal(code, 0);
    assert.ok(
      hub.requests.some((r) => r.method === 'DELETE' && r.path === `/wd/hub/session/${WD_SESSION}`),
      'closing stdin must release the device',
    );
  });

  test('a second device is refused while one is held, and tool failures are results, not protocol errors', async () => {
    const hub = await startHub();
    const child = spawnMcp(hub.url);
    const rpc = connect(child);
    try {
      await rpc.request('initialize', {});
      const noSession = await rpc.call('screenshot');
      assert.equal(noSession.isError, true);
      assert.match(noSession.content[0]!.text!, /start_session first/);

      // Two at once: exactly one device may be allocated.
      const [a, b] = await Promise.all([rpc.call('start_session'), rpc.call('start_session')]);
      assert.equal([a, b].filter((r) => r.isError).length, 1);
      assert.equal(hub.requests.filter((r) => r.path === '/wd/hub/session').length, 1);

      const badIndex = await rpc.call('tap', { index: 5 });
      assert.equal(badIndex.isError, true);
      assert.match(badIndex.content[0]!.text!, /ui_tree first/);

      const unknown = await rpc.request('tools/call', { name: 'format_disk', arguments: {} });
      assert.equal((unknown.error as { code: number }).code, -32602);
    } finally {
      child.stdin.end();
      await exited(child);
      await hub.close();
    }
  });
});

describe('parseUiTree', () => {
  test('keeps what says or does something, drops layout and zero-area elements', () => {
    const els = parseUiTree(ANDROID_SOURCE);
    assert.deepEqual(els.map((e) => e.kind), ['TextView', 'EditText', 'Button']);
    assert.equal(els[0]!.text, 'Welcome & hello', 'entities are decoded');
    assert.equal(els[1]!.label, 'Email');
    assert.equal(els[2]!.id, 'com.acme:id/login');
  });

  test('reads XCUITest geometry and names', () => {
    const els = parseUiTree(`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Acme" label="Acme" enabled="true" visible="true" x="0" y="0" width="390" height="844">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="login" label="Log in" enabled="true" visible="true" x="95" y="600" width="200" height="44"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Offscreen" label="Offscreen" visible="false" x="0" y="900" width="100" height="20"/>
    </XCUIElementTypeApplication></AppiumAUT>`);
    const button = els.find((e) => e.kind === 'Button')!;
    assert.equal(button.text, 'Log in');
    assert.equal(button.id, 'login');
    assert.equal(button.clickable, true);
    assert.ok(!els.some((e) => e.text === 'Offscreen'), 'invisible elements are dropped');
    assert.match(formatUiTree(els), /Button "Log in" id=login \(195,622 200x44\) tap/);
  });

  /** The launcher tree the first hardware run returned, 2026-09-24 — trimmed, attributes verbatim. */
  test('an id alone does not make a layout container worth listing', () => {
    const els = parseUiTree(`<hierarchy>
      <android.widget.FrameLayout class="android.widget.FrameLayout" text="" resource-id="android:id/content" content-desc="" clickable="false" focusable="false" bounds="[0,0][720,1280]" displayed="true">
      <android.widget.FrameLayout class="android.widget.FrameLayout" text="" resource-id="com.android.launcher3:id/launcher" content-desc="" clickable="false" focusable="false" bounds="[0,0][720,1280]" displayed="true">
      <android.widget.ImageView class="android.widget.ImageView" text="" resource-id="com.android.gallery3d:id/home" content-desc="" clickable="false" focusable="false" bounds="[24,64][88,128]" displayed="true"/>
      <android.widget.TextView class="android.widget.TextView" text="Gallery" resource-id="" content-desc="Gallery" clickable="true" focusable="true" bounds="[188,700][360,910]" displayed="true"/>
      </android.widget.FrameLayout></android.widget.FrameLayout></hierarchy>`);
    assert.deepEqual(els.map((e) => e.text ?? e.label ?? e.id), ['Gallery'], 'containers and an inert icon are not things to tap');
  });

  test('an empty screen says to use the screenshot rather than printing nothing', () => {
    assert.match(formatUiTree(parseUiTree('<hierarchy/>')), /use the screenshot/);
  });
});
