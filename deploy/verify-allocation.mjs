/**
 * Does the deployed farm hand over the device CLASS the console asks for?
 *
 *   MFARM_API_KEY=... node deploy/verify-allocation.mjs [https://farm.mfarm.dev]
 *
 * Run it ON THE CONTROL PLANE, where `deploy/.state/api_key` already exists:
 *
 *   cd ~/mfarm && MFARM_API_KEY="$(cat deploy/.state/api_key)" node deploy/verify-allocation.mjs http://127.0.0.1:3000
 *
 * WHY A LIVE CHECK AND NOT ONLY `allocator.test.ts`. That suite proves the SQL does what it says
 * against a database it seeded itself. It cannot see a migration that did not reach this box, an
 * API image serving the previous signature, or a real fleet whose devices differ from the fixtures
 * in ways that matter — and "the button on the deployed console names a device you will actually
 * get" is a claim about this farm, not about a test database.
 *
 * IT ALLOCATES REAL DEVICES on a farm somebody may be using, so:
 *   - every session it opens is released in a `finally`, including on assertion failure;
 *   - it never touches a device that is already busy — it reads the fleet first and skips a class
 *     with nothing free rather than queueing, because a queued session on a full farm waits for
 *     somebody else's lease and this is a check, not a workload;
 *   - the lease is the shortest the API accepts, so an abandoned session from a crashed run expires
 *     in minutes rather than hours.
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

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

/** Release, and never let a failure here mask the assertion that was actually being made. */
async function release(id) {
  if (!id) return;
  const r = await api(`/v1/sessions/${id}`, { method: 'DELETE' });
  if (r.status >= 400) console.log(`  \x1b[33m·\x1b[0m could not release ${id.slice(0, 8)} (${r.status}); it expires on its own`);
}

/**
 * Open a session for one class and report which device came back.
 *
 * `matchProfile` with a null `profile` is not the same as omitting both — it means "one of the
 * devices that have no profile", which is a class this farm genuinely has two of.
 */
async function claim({ region, platform, tier, profile, matchProfile }) {
  const r = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ region, platform, tier, ttlMinutes: 1, profile, matchProfile }),
  });
  return r;
}

const main = async () => {
  say(`Allocation by class, against ${BASE}`);

  const fleet = await api('/v1/devices');
  if (fleet.status !== 200) {
    bad(`GET /v1/devices -> ${fleet.status}. ${JSON.stringify(fleet.body).slice(0, 200)}`);
    return;
  }
  const devices = fleet.body.devices || [];
  const ready = devices.filter((d) => d.state === 'READY');
  ok(`fleet reachable: ${devices.length} devices, ${ready.length} READY`);

  // Group the READY devices the way the allocator now does, so the checks below are chosen from
  // what this farm actually has rather than from what it had the day this was written.
  const classes = new Map();
  for (const d of ready) {
    const key = d.tier === 'physical' ? `physical:${d.model}` : (d.profile ?? '(unprofiled)');
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push(d);
  }
  for (const [k, v] of classes) console.log(`      ${k}: ${v.length} free`);

  const profiled = [...classes.entries()].find(([k, v]) => k !== '(unprofiled)' && !k.startsWith('physical:') && v.length);
  const unprofiled = classes.get('(unprofiled)') || [];

  /* ------------------------------------------------------------- a named class ------------- */
  if (!profiled) {
    console.log('  \x1b[33m·\x1b[0m no profiled class is free; skipping the named-class check');
  } else {
    const [name, members] = profiled;
    say(`Asking for the class "${name}"`);
    let id = null;
    try {
      const d = members[0];
      const r = await claim({ region: d.region, platform: d.platform, tier: d.tier, profile: name, matchProfile: true });
      id = r.body?.session?.id ?? null;
      const got = devices.find((x) => x.id === r.body?.session?.deviceId);

      if (r.status !== 201 && r.status !== 200) {
        bad(`POST /v1/sessions -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      } else if (!got) {
        bad(`queued or no device returned: ${JSON.stringify(r.body?.session)}`);
      } else if (got.profile === name) {
        ok(`asked for ${name}, got ${got.model} (${got.profile}) — the button's promise holds`);
      } else {
        bad(`asked for ${name}, got ${got.model} (profile ${got.profile ?? 'none'}) — the allocator is still tier-only here`);
      }
    } finally {
      await release(id);
    }
  }

  /* ------------------------------------------------------------- the unprofiled class ------- */
  //
  // THE CASE THAT LOOKS HARDEST TO NOTICE. With a single nullable parameter this request would be
  // indistinguishable from "any device", so it would be satisfied by an X1 Pro — a nicer device
  // than was asked for, still not the one the button named, and a kind of wrong nobody reports.
  if (!unprofiled.length) {
    console.log('  \x1b[33m·\x1b[0m no unprofiled device is free; skipping the unprofiled-class check');
  } else {
    say('Asking for the unprofiled class');
    let id = null;
    try {
      const d = unprofiled[0];
      const r = await claim({ region: d.region, platform: d.platform, tier: d.tier, profile: null, matchProfile: true });
      id = r.body?.session?.id ?? null;
      const got = devices.find((x) => x.id === r.body?.session?.deviceId);

      if (!got) {
        bad(`queued or no device returned: ${JSON.stringify(r.body?.session)}`);
      } else if (got.profile == null) {
        ok(`asked for the unprofiled class, got ${got.model} with no profile — correct`);
      } else {
        bad(`asked for the unprofiled class, got ${got.model} (${got.profile}) — a nicer device than was asked for, and still the wrong one`);
      }
    } finally {
      await release(id);
    }
  }

  /* ------------------------------------------------------------- the unchanged callers ------ */
  //
  // The CLI and the WebDriver hub name no class. They must allocate exactly what they always did,
  // which is what makes the migration safe to deploy ahead of a console that uses it.
  say('A caller that names no class (the CLI and the hub)');
  {
    let id = null;
    try {
      const d = ready[0];
      const r = await claim({ region: d.region, platform: d.platform, tier: d.tier });
      id = r.body?.session?.id ?? null;
      const got = devices.find((x) => x.id === r.body?.session?.deviceId);
      if (got) ok(`got ${got.model} — unchanged`);
      else bad(`no device: ${r.status} ${JSON.stringify(r.body?.session ?? r.body).slice(0, 200)}`);
    } finally {
      await release(id);
    }
  }

  say(`${pass} passed, ${fail} failed`);
};

await main().catch((e) => { bad(`threw: ${e.message}`); });
process.exit(fail === 0 ? 0 : 1);
