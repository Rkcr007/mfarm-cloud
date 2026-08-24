// Does the live-view data plane survive a hostile client, and does a viewer actually reach the AGENT?
//
//   node deploy/verify-dataplane.mjs <hostId>                 # through the public TLS name
//   DP_ORIGIN=http://127.0.0.1:3000 node deploy/verify-dataplane.mjs <hostId>
//
// WHY THIS EXISTS. `/dp/<hostId>` takes NO credential, deliberately: the credential is the Ed25519
// grant inside the hello, which only the agent can verify and only the agent does verify, offline.
// That is a sound design and it has one consequence worth testing on purpose — the first thing to
// touch an anonymous stranger's bytes is the agent's own message handler, on the machine holding
// every device.
//
// It is not hypothetical. A hello with the token under the wrong key sent `undefined` into
// `verifySessionToken`, which did `token.split('.')`, inside an async handler whose rejection
// index.ts treats as a broken invariant. One frame from anyone on the internet drained the agent
// and exited it, taking two Cuttlefish devices, two Appium servers, the automation gateway and the
// tunnel with it — and systemd's StartLimitBurst turns five of those into a farm that stays down.
//
// The unit tests for this cannot see it: `node --test` catches unhandledRejection, so the crash
// that is fatal in production is a passing test in a runner. This speaks to the real thing.
//
// Zero dependencies, like verify-webdriver.mjs. `ws` is not installed on the control plane, and a
// library here would sit between the test and the wire that is under test.
import { createHash, randomBytes } from 'node:crypto';

const hostId = process.argv[2];
if (!hostId) {
  console.error('usage: node deploy/verify-dataplane.mjs <hostId>');
  console.error('  the host id is the path segment the console uses: wss://<farm>/dp/<hostId>');
  process.exit(2);
}

const ORIGIN = process.env.DP_ORIGIN ?? 'https://farm.mfarm.dev';
const { protocol, hostname, port } = new URL(ORIGIN);
const tls = protocol === 'https:';
const { request } = await import(tls ? 'node:https' : 'node:http');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
let failures = 0;

/** One masked client text frame. Every payload here is tiny, so only the 7-bit length case exists. */
function textFrame(s) {
  const body = Buffer.from(s);
  if (body.length > 125) throw new Error('probe payload outgrew the simple framing');
  const mask = randomBytes(4);
  const out = Buffer.alloc(6 + body.length);
  out[0] = 0x81;                  // FIN + text
  out[1] = 0x80 | body.length;    // MASK + length
  mask.copy(out, 2);
  for (let i = 0; i < body.length; i++) out[6 + i] = body[i] ^ mask[i % 4];
  return out;
}

/** Server frames are unmasked. Enough of a parser for one text or close frame. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode, payload: buf.subarray(off, off + len) };
}

/**
 * Open one viewer channel, send `payload`, and report what came back.
 *
 * Resolves `{ kind: 'message' | 'close' | 'timeout', ... }` rather than throwing, because every one
 * of those is a result this script has an opinion about.
 */
function speak(id, payload, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const req = request({
      host: hostname, port: port || (tls ? 443 : 80), path: `/dp/${id}`, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });

    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
    const done = (v) => { clearTimeout(timer); resolve(v); };

    req.on('response', (res) => done({ kind: 'http', status: res.statusCode }));
    req.on('error', (e) => done({ kind: 'error', message: e.message }));

    req.on('upgrade', (res, socket) => {
      if (res.headers['sec-websocket-accept'] !== accept) return done({ kind: 'badaccept' });
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const f = readFrame(buf);
        if (!f) return;
        socket.destroy();
        if (f.opcode === 8) {
          return done({
            kind: 'close',
            code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 0,
            reason: f.payload.subarray(2).toString(),
          });
        }
        done({ kind: 'message', text: f.payload.toString() });
      });
      socket.on('error', () => done({ kind: 'error', message: 'socket error' }));
      if (payload !== null) socket.write(textFrame(payload));
    });

    req.end();
  });
}

const ok = (msg) => console.log(`  ${green('✓')} ${msg}`);
const bad = (msg) => { failures++; console.log(`  ${red('✗')} ${msg}`); };

console.log(`\ndata plane  ${ORIGIN}/dp/${hostId}\n`);

// ---------------------------------------------------------------- 1. is anyone home
console.log('\x1b[1mReachability\x1b[0m');
{
  const r = await speak(hostId, JSON.stringify({ t: 'hello', token: 'v1.not.real' }));
  if (r.kind === 'close' && r.code === 1013) {
    bad(`no agent is connected for ${hostId} — start the device host, or check its tunnel`);
    console.log('\nNothing below can be meaningful without an agent. Stopping.\n');
    process.exit(1);
  }
  if (r.kind === 'message') ok('a viewer reaches the agent, and the AGENT answers it');
  else if (r.kind === 'timeout') bad('nothing answered in 12s — is /dp routed anywhere?');
  else bad(`unexpected: ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------- 2. hostile shapes
//
// Each of these was, at one point, a way to end the process on the other side of this socket. The
// second assertion in each round is the one that matters: the host is still serving afterwards.
console.log('\n\x1b[1mHostile hellos\x1b[0m');
const HOSTILE = [
  ['no token field', { t: 'hello' }],
  ['a null token', { t: 'hello', token: null }],
  ['a number token', { t: 'hello', token: 12345 }],
  ['an object token', { t: 'hello', token: { a: 1 } }],
  ['an array token', { t: 'hello', token: ['v1', 'a', 'b'] }],
  ['a token under the wrong key', { t: 'hello', grant: 'v1.a.b' }],
  ['no t at all', { token: 'v1.a.b' }],
  ['not an object', 'just a string'],
];

for (const [name, body] of HOSTILE) {
  const r = await speak(hostId, typeof body === 'string' ? body : JSON.stringify(body));
  // A timeout here is the auth timer answering instead of the handler, which is what a dead or
  // wedged handler looks like from out here — the exact symptom the crash produced.
  if (r.kind === 'message') ok(`${name} — refused: ${r.text.slice(0, 72)}`);
  else if (r.kind === 'timeout') bad(`${name} — NOTHING ANSWERED; the handler died or hung`);
  else bad(`${name} — ${JSON.stringify(r).slice(0, 100)}`);

  const alive = await speak(hostId, JSON.stringify({ t: 'hello', token: 'v1.still.here' }));
  if (alive.kind === 'close' && alive.code === 1013) {
    bad(`  …and the host went down. "${name}" is a remote kill.`);
    break;
  }
  if (alive.kind !== 'message') bad(`  …and the host stopped answering after "${name}"`);
}

// ---------------------------------------------------------------- 3. the control
console.log('\n\x1b[1mA host that is not connected\x1b[0m');
{
  const r = await speak('00000000-0000-0000-0000-000000000000', JSON.stringify({ t: 'hello', token: 'v1.a.b' }));
  if (r.kind === 'close' && r.code === 1013) ok('answered 1013 with a reason, not silence');
  else bad(`expected a 1013 close, got ${JSON.stringify(r).slice(0, 100)}`);
}

console.log(
  failures === 0
    ? `\n\x1b[1mThe data plane reaches the agent and survives being spoken to badly.\x1b[0m\n`
    : `\n\x1b[1m${failures} problem(s) — see the ✗ lines.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
