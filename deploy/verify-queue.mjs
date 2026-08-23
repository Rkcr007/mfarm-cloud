// Does `mfarm:queueTimeoutSeconds` actually QUEUE?
//
// WHY THIS EXISTS. It never did. The hub's wait used `req.raw.destroyed` as its "the client hung
// up" predicate, and that flag goes true at the first `await` on a perfectly healthy request — so
// the wait returned on its first poll and every caller was told "no device is free" instantly. The
// capability had been shipped, documented, and set by the example suite and the CI workflow, and
// nothing anywhere noticed, because a farm with a free device never reaches the waiting path and a
// farm without one produces the same message either way.
//
// So the only honest check is the one that is annoying to set up: FILL the farm, ask for one more
// device with a timeout, and prove the request is still open some seconds later.
//
//   MFARM_API_KEY=mfk_... node deploy/verify-queue.mjs
const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) { console.error('MFARM_API_KEY is required'); process.exit(2); }

const basic = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const bearer = `Bearer ${KEY}`;
let failed = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const note = (m) => console.log(`    ${m}`);
const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const hub = async (method, path, body) => {
  const res = await fetch(`${HUB}/wd/hub${path}`, {
    method,
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not every error page is JSON */ }
  return { status: res.status, json, text };
};
const api = async (p) => (await (await fetch(`${HUB}${p}`, { headers: { authorization: bearer } })).json());
const caps = (extra) => ({ capabilities: { alwaysMatch: {
  platformName: 'Android', 'appium:automationName': 'UiAutomator2',
  'appium:newCommandTimeout': 300, 'mfarm:region': REGION, ...extra,
}, firstMatch: [{}] } });
const sid = (r) => r.json?.value?.sessionId ?? r.json?.sessionId;
const why = (r) => r.json?.value?.message ?? r.text?.slice(0, 160) ?? '';

const held = [];
try {
  say('Filling the farm');
  const free = (await api('/v1/devices')).available ?? 0;
  note(`${free} device(s) free`);
  if (free < 1) { console.error('nothing free to fill with'); process.exit(2); }

  for (let i = 0; i < free; i++) {
    const r = await hub('POST', '/session', caps({}));
    if (r.status === 200) held.push(sid(r));
    else bad(`could not fill slot ${i + 1}: ${why(r)}`);
  }
  const nowFree = (await api('/v1/devices')).available ?? -1;
  nowFree === 0 ? ok(`farm is full (${held.length} session(s) holding every device)`)
                : bad(`expected 0 free, got ${nowFree}`);

  // ---------------------------------------------------------------- the check

  say('Asking for one more, with a 120s queue timeout');
  const t0 = Date.now();
  const queued = hub('POST', '/session', caps({ 'mfarm:queueTimeoutSeconds': 120 }));
  let settled = false;
  void queued.then(() => { settled = true; }, () => { settled = true; });

  // The bug returned on the FIRST poll — inside a second. Five is far outside that, and far inside
  // the 120s the caller asked for, so a request still open here is genuinely waiting.
  await new Promise((r) => setTimeout(r, 5000));
  settled
    ? bad('the request came back within 5s — it did not queue, it gave up')
    : ok('still waiting after 5s, rather than answering "no capacity" instantly');

  say('Releasing one device; the queued request should be promoted onto it');
  const releasing = held.shift();
  await hub('DELETE', `/session/${releasing}`);
  note(`released ${releasing} — it must powerwash before it can be handed over`);

  const r = await queued;
  const waited = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 200) {
    held.push(sid(r));
    ok(`promoted onto the freed device after ${waited}s — the queue works`);
  } else {
    bad(`the queued request failed after ${waited}s: ${why(r)}`);
    note('if this says "no device became free", the wait is still abandoning itself early.');
  }
} finally {
  say('Releasing');
  for (const id of held) {
    const r = await hub('DELETE', `/session/${id}`).catch(() => null);
    r && r.status < 400 ? ok(`released ${id}`) : bad(`could not release ${id}`);
  }
}

say(failed === 0 ? '\x1b[32mAll checks passed\x1b[0m' : `\x1b[31m${failed} check(s) failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
