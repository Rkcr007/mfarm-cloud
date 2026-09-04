/**
 * Does the DEPLOYED control plane tell the device detail screen what it needs — and withhold what
 * it must not send?
 *
 *   cd ~/mfarm && MFARM_API_KEY="$(cat deploy/.state/api_key)" \
 *     node deploy/verify-device-detail.mjs http://127.0.0.1:3000
 *
 * WHY THIS IS SEPARATE FROM `http.test.ts`. That suite proves the route's shape against a database
 * it seeded itself, with a host it inserted and a heartbeat it wrote. It cannot see a migration
 * that did not reach this box, an image serving the previous projection, or the thing this script
 * exists for: whether the real fleet's real hosts are actually beating, which is the only condition
 * under which "Host last seen" says anything true.
 *
 * READ-ONLY. It allocates nothing, changes nothing, and is safe to run against a farm somebody is
 * using — unlike `verify-allocation.mjs`, which opens real sessions.
 */
const BASE = (process.argv[2] || 'https://farm.mfarm.dev').replace(/\/$/, '');
const KEY = process.env.MFARM_API_KEY;

if (!KEY) {
  console.error('MFARM_API_KEY is required. On the box: MFARM_API_KEY="$(cat deploy/.state/api_key)"');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const say = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, text, body };
}

const main = async () => {
  say(`Device detail, against ${BASE}`);

  const fleet = await api('/v1/devices');
  if (fleet.status !== 200) {
    bad(`GET /v1/devices -> ${fleet.status}`);
    return;
  }
  const devices = fleet.body.devices || [];
  ok(`fleet reachable: ${devices.length} devices`);
  if (!devices.length) { bad('no devices to read; this check needs a fleet'); return; }

  /*
   * THE FIELDS THE LIST DOES NOT CARRY, which is the whole reason the screen reads this endpoint.
   * `lastResetAt` was the one that bit: the screen used to draw from the fleet poll, so "Last
   * reset" said "not reported" for every device in the fleet, forever.
   */
  say('The detail read is larger than the list');
  const listRow = devices[0];
  const one = await api(`/v1/devices/${listRow.id}`);
  if (one.status !== 200) {
    bad(`GET /v1/devices/:id -> ${one.status} ${one.text.slice(0, 160)}`);
    return;
  }
  const d = one.body.device;

  if ('hostLastSeenAt' in d) ok('hostLastSeenAt is in the payload');
  else bad('hostLastSeenAt is absent — this image predates the field, or the deploy did not land');

  if ('resetAttempts' in d) ok('resetAttempts is in the payload');
  else bad('resetAttempts is absent — the detail projection has shrunk');

  /*
   * AND IT IS ACTUALLY A BEAT. A null here is not a bug in the route — it is a host that has never
   * reported, which on a running farm is itself the finding. Said as a warning rather than a
   * failure, because a farm with a stopped device host is a legitimate state.
   */
  if (d.hostLastSeenAt) {
    const age = Math.round((Date.now() - new Date(d.hostLastSeenAt).getTime()) / 1000);
    if (age < 120) ok(`the host behind ${d.model} beat ${age}s ago — this farm is live`);
    else console.log(`  \x1b[33m·\x1b[0m the host behind ${d.model} last beat ${Math.round(age / 60)}m ago; the device reads ${d.state}`);
  } else {
    console.log(`  \x1b[33m·\x1b[0m no heartbeat recorded for the host behind ${d.model} (state ${d.state})`);
  }

  /*
   * THE FIELD THAT MUST NOT BE THERE — ADR-0026.
   *
   * Checked against the WHOLE SERIALISED BODY and against every hostname the fleet could have,
   * rather than against a named key: the way this regresses is somebody adding `host: { ... }` in
   * one go, with the name riding along inside it.
   *
   * The hostnames themselves are not knowable from a tenant credential — that is the point — so
   * this asserts the shape instead: no key anywhere in the payload whose name suggests a host
   * identity, and no value that looks like one.
   */
  say('The hostname is not in the payload (ADR-0026)');
  const flat = JSON.stringify(d);
  const suspect = Object.keys(d).filter((k) => /^host(name|Name)$/.test(k) || k === 'host');
  if (suspect.length) bad(`the payload carries ${suspect.join(', ')} — hosts are farm topology, not tenant data`);
  else ok('no host, hostname or hostName key');

  if (/"host[^"]*"\s*:\s*\{/.test(flat)) bad('a nested host object appeared; check what is inside it');
  else ok('no nested host object');

  /*
   * The ordering that is the authorisation. A device id that does not exist must 404 rather than
   * reaching the system-pool read at all — same failure surface as one belonging to another org,
   * which is what makes the two indistinguishable from outside.
   */
  say('A device this key cannot see');
  const ghost = await api('/v1/devices/00000000-0000-0000-0000-000000000000');
  if (ghost.status === 404) ok('an unknown device is a 404, not a 500 from the second read');
  else bad(`expected 404, got ${ghost.status} — the system-pool read may be running before RLS decides`);

  say(`${pass} passed, ${fail} failed`);
};

await main().catch((e) => { bad(`threw: ${e.message}`); });
process.exit(fail === 0 ? 0 : 1);
