// Failure injection: does the farm come back, and does it come back CLEAN?
//
// `AutomationExecutionPlan.md` §41 asks for this and ranks it 41st of 46. It should be first. This
// repo has 1022 green tests alongside a feature that worked 0% of the time in production, and one
// hour of manual use that found five defects — the suite cannot see the failures that matter here,
// because all of them are about what happens when a process dies, and `app.inject()` and a mocked
// device cannot die.
//
// So every check below breaks something real on real hardware and then asks one question: **is the
// farm in a consistent state afterwards, and did it say so honestly?**
//
//   MFARM_API_KEY=mfk_... node deploy/verify-failure.mjs          # all non-disruptive scenarios
//   node deploy/verify-failure.mjs --only=abandon                 # one scenario
//   node deploy/verify-failure.mjs --disruptive                   # include the control-plane restart
//
// With no MFARM_API_KEY it reads the key off the control plane with `gcloud`, so the secret never
// has to be pasted into a shell history.
//
// WHY THIS ONE RUNS FROM THE LAPTOP, unlike every other `verify-*` script. The others run ON the
// control plane because that is where the interesting view is. Injection needs a shell on BOTH
// boxes — the API lives on `mfarm-cp` and Appium and adb live on `mfarm-lab` — and the control
// plane has no SSH key for the device host (verified: `Permission denied (publickey)`). The laptop
// is the only place with `gcloud` reach to both.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const PROJECT = process.env.MFARM_PROJECT ?? 'mfarm-lab';
const ZONE    = process.env.MFARM_ZONE    ?? 'asia-south1-c';
const SSH_USER= process.env.MFARM_SSH_USER?? 'rkcr070707';
const CP      = process.env.MFARM_CP      ?? 'mfarm-cp';
const LAB     = process.env.MFARM_LAB     ?? 'mfarm-lab';
const HUB     = process.env.HUB           ?? 'https://farm.mfarm.dev';
const REGION  = process.env.REGION        ?? 'lab';

const argv = process.argv.slice(2);
const DISRUPTIVE = argv.includes('--disruptive');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length) || null;

let failed = 0, ran = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const note = (m) => console.log(`    ${m}`);
const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A shell on one of the two boxes. stderr is swallowed because gcloud narrates onto it. */
const onBox = async (host, cmd) => {
  const { stdout } = await exec('gcloud', [
    'compute', 'ssh', `${SSH_USER}@${host}`, '--project', PROJECT, '--zone', ZONE, '--command', cmd,
  ], { maxBuffer: 8 << 20 });
  return stdout.trim();
};
const onLab = (cmd) => onBox(LAB, cmd);
const onCp  = (cmd) => onBox(CP, cmd);

// ---------------------------------------------------------------- the farm's own API

let KEY = process.env.MFARM_API_KEY;
const basic  = () => 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const bearer = () => `Bearer ${KEY}`;

const hub = async (method, path, body) => {
  const res = await fetch(`${HUB}/wd/hub${path}`, {
    method,
    headers: { authorization: basic(), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* an error page need not be JSON */ }
  return { status: res.status, json, text };
};
const api = async (p) => {
  const res = await fetch(`${HUB}${p}`, { headers: { authorization: bearer() } });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const caps = (extra = {}) => ({ capabilities: { alwaysMatch: {
  platformName: 'Android', 'appium:automationName': 'UiAutomator2',
  'appium:newCommandTimeout': 300, 'mfarm:region': REGION, ...extra,
}, firstMatch: [{}] } });
const sid = (r) => r.json?.value?.sessionId ?? r.json?.sessionId;
const why = (r) => r.json?.value?.message ?? r.json?.error?.message ?? r.text?.slice(0, 200) ?? '';
const available = async () => (await api('/v1/devices')).json?.available ?? -1;

/** Wait for a predicate, polling. Returns seconds waited, or null on timeout. */
const waitFor = async (predicate, timeoutMs, stepMs = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return (Date.now() - t0) / 1000;
    await sleep(stepMs);
  }
  return null;
};

// ================================================================ scenarios

const scenarios = {};

/**
 * A CLIENT THAT DIES MID-SESSION.
 *
 * WebDriver is stateless HTTP, so there is no connection whose loss the farm could notice: a crashed
 * suite and a suite that is merely slow between two commands look identical from here. That leaves
 * exactly one backstop, the 30-minute lease TTL, and one CI job that crashes on every run therefore
 * takes a device out of the pool for half an hour at a time.
 *
 * `webdriver_sessions.last_command_at` is updated on EVERY proxied command and migration 006 builds
 * `webdriver_sessions_idle_idx` over it — but nothing in the codebase ever reads either. The signal
 * needed to fix this is already being recorded, and paid for on every command, for a sweep that was
 * never written. That is the inverse of invariant 5 in docs/INDEX.md, and it is the finding this
 * scenario exists to pin.
 *
 * The check is bounded at 90s rather than waiting out the TTL: proving "not reclaimed quickly" is
 * enough, and a 30-minute assertion is one nobody would run.
 */
scenarios.abandon = async () => {
  say('Scenario: a client crashes mid-session and never releases');

  const before = await available();
  note(`${before} device(s) available before`);
  if (before < 1) { bad('no free device to run this scenario against'); return; }

  const opened = await hub('POST', '/session', caps());
  if (opened.status !== 200) { bad(`could not open a session: ${why(opened)}`); return; }
  const id = sid(opened);
  ok(`session ${id} opened`);

  // THE INJECTION: we simply stop. No deleteSession, no further commands — which is precisely what
  // a `kill -9` on the test runner leaves behind.
  note('abandoning it — no DELETE, no further commands, exactly as a killed runner would');

  const during = await available();
  during === before - 1
    ? ok(`device is held (${during} available, was ${before})`)
    : bad(`expected ${before - 1} available while held, got ${during}`);

  const reclaimed = await waitFor(async () => (await available()) >= before, 90_000);
  if (reclaimed === null) {
    // This is the EXPECTED result today, and it is a defect, so it is reported as one.
    bad('device not reclaimed within 90s of the client vanishing');
    note('The only backstop is the 30-minute lease TTL, so a crash-looping CI job holds a device');
    note('for half an hour per run. `last_command_at` and `webdriver_sessions_idle_idx` already');
    note('exist and are written on every command — nothing reads them. The fix is an idle sweep');
    note('in reap() using the index that is already being maintained.');
  } else {
    ok(`device came back after ${reclaimed}s — something DOES reclaim an abandoned session`);
    note('If this passes, the 30-minute-lease finding in HANDOFF is stale and should be corrected.');
  }

  // Give the device back regardless, so the scenario does not cost the farm a lease.
  const r = await hub('DELETE', `/session/${id}`).catch(() => null);
  note(r && r.status < 400 ? 'cleaned up: session released' : 'cleanup: session was already gone');
};

/**
 * APPIUM DIES AND STAYS DEAD — is a lease spent on a device that cannot automate?
 *
 * ADR-0003 is the claim under test: a host advertises `webdriver` only while a supervised Appium is
 * *actually* ready, so "a device that claims what it cannot do fails at connect time, AFTER a lease
 * is spent" cannot happen. Run against real hardware on 2026-09-01, it can.
 *
 * TWO EARLIER VERSIONS OF THIS CHECK WERE WRONG, and both mistakes are worth keeping:
 *
 *   1. Killing Appium once proves nothing. The supervisor has all four servers back in ~8s and the
 *      host heartbeat is 10s, so the outage closes inside one reporting interval and a poller sees
 *      an unbroken farm. An injection has to outlast the OBSERVATION interval, not merely happen.
 *   2. Asserting on the capability alone is the weaker question and it invites a vacuous pass: a
 *      "capability is present again" check after a withdrawal that never occurred passes hardest
 *      exactly when the feature is broken. So the assertion below is the CONSEQUENCE — ask for a
 *      session and see whether the farm refuses honestly or hands over a device it cannot serve.
 *
 * What it found: with Appium at zero processes for 26s, `GET /v1/devices` still reported
 * `webdriver` on every device and `POST /session` returned **HTTP 500 automation_unreachable**
 * having already allocated one. The agent-side logic is right — `setAutomationEndpoint(undefined)`
 * drops the capability from what the agent reports — but its own comment says the rest: "nothing
 * here reaches the control plane until the next registration", and `capabilityFingerprint()` is
 * only consulted in `start()`. A RUNNING agent never re-registers, so `devices.capabilities` keeps
 * saying `webdriver` and `requireCapabilities` filters on a stale column.
 *
 * THIS SCENARIO IS DISRUPTIVE, and that is itself a finding. Holding Appium down trips the
 * supervisor's own bounded-recovery limit — 6 consecutive failed starts — which files an
 * `appium-failure` incident and exits the agent; systemd restarts it and every Cuttlefish device
 * COLD BOOTS. Measured cost: ~2 minutes with the farm at `available: 0`. The recovery is correct
 * and is exactly what §11 asks for, but it is not something to run against a farm somebody is using.
 */
scenarios.appium = async () => {
  say('Scenario: Appium dies and stays dead — is a lease spent anyway?');
  note('DISRUPTIVE: this trips the supervisor\'s give-up limit and cold boots every device (~2 min)');

  // Bracketed so the pattern never matches the shell running it. `pkill -f appium` matches its own
  // `bash -c` cmdline and kills the SSH session, surfacing as `ssh exited with return code [255]`,
  // which reads exactly like a network fault. Every literal occurrence in a remote command has to
  // be bracketed — including one in an unrelated `grep` later in the same script.
  //
  // `|| true` is load-bearing: `grep -c` exits 1 when the count is ZERO, so without it this command
  // fails in exactly the case the scenario is trying to detect — appium successfully killed — and
  // `execFile` rejects. That surfaced as "the injection did not take" on runs where the injection
  // had worked perfectly, which is the most expensive kind of wrong: a check that reports the
  // opposite of what happened.
  const countCmd = "ps -eo args | grep -c '[a]ppium' || true";
  const KILL_SECONDS = 45;

  // WAIT FOR A HEALTHY FARM BEFORE BREAKING IT. Running this twice in a row injected into a farm
  // still cold-booting from the previous run, and the resulting "no appium process found" reads as
  // a discovery about the product when it is only a discovery about the last two minutes. A
  // precondition that is merely asserted, rather than waited for, turns every re-run into a lie.
  const healthy = await waitFor(async () =>
    Number(await onLab(countCmd).catch(() => '0')) >= 1 && (await available()) > 0, 240_000, 10_000);
  if (healthy === null) {
    bad('farm is not healthy enough to inject into (no appium, or no free device) after 240s');
    note('If a previous run of this scenario just fired, the fleet is still cold booting. Wait.');
    return;
  }

  const webdriverDevices = async () =>
    (await api('/v1/devices')).json?.devices?.filter((d) => (d.capabilities ?? []).includes('webdriver')).length ?? 0;
  const capsBefore = await webdriverDevices();
  note(`${capsBefore} device(s) advertising webdriver before`);

  // Shipped as base64 rather than as an inline heredoc. Nesting a kill loop inside
  // `gcloud ssh --command` needs three layers of quoting (JS, local shell, remote shell) and
  // produced two silently-inert killers and one that reported -1 before this. base64 has no
  // metacharacters, so there is nothing left for a shell to reinterpret.
  const KILLER = [
    '#!/bin/sh',
    'end=$(($(date +%s) + ${1:-60}))',
    'while [ "$(date +%s)" -lt "$end" ]; do',
    "  p=$(ps -eo pid,args | grep '[a]ppium' | awk '{print $1}')",
    '  [ -n "$p" ] && kill -9 $p 2>/dev/null',
    '  sleep 1',
    'done',
  ].join('\n') + '\n';
  const b64 = Buffer.from(KILLER, 'utf8').toString('base64');
  await onLab(
    `echo ${b64} | base64 -d > /tmp/mfarm-killer.sh && chmod +x /tmp/mfarm-killer.sh && `
    + `setsid nohup /tmp/mfarm-killer.sh ${KILL_SECONDS} >/dev/null 2>&1 </dev/null & `
    + `sleep 6; echo armed`,
  );
  const downNow = Number(await onLab(countCmd).catch(() => '-1'));
  downNow === 0
    ? ok('appium is at 0 processes and being held down')
    : bad(`expected appium down, found ${downNow} process(es) — the injection did not take`);
  if (downNow !== 0) return;

  // Two heartbeats of dead Appium before asking anything, so the farm has had every chance to notice.
  await sleep(20_000);

  const stillAdvertising = await webdriverDevices();
  note(`${stillAdvertising} device(s) still advertising webdriver with no automation server alive`);

  const r = await hub('POST', '/session', caps());
  if (r.status === 200) {
    bad('a session was OPENED against a farm with no Appium running at all');
    await hub('DELETE', `/session/${sid(r)}`).catch(() => null);
  } else if (r.json?.value?.['mfarm:code'] === 'automation_unreachable') {
    // The precise defect: allocation succeeded, then the hop to the driver failed.
    bad('a device was ALLOCATED and the session then failed with automation_unreachable — the lease '
      + 'was spent before the farm admitted it had no driver, which is what ADR-0003 exists to prevent');
    note('Cause: `setAutomationEndpoint(undefined)` withdraws the capability from what the AGENT');
    note('reports, but that only reaches the control plane at REGISTRATION, and a running agent');
    note('never re-registers. `devices.capabilities` stays stale and requireCapabilities trusts it.');
  } else {
    ok(`the farm refused honestly before spending a lease (${r.status}: ${why(r)})`);
  }

  // RECOVERY MEANS APPIUM IS BACK, not that a device is free. Killing appium never took a device
  // out of the pool — `available` stayed non-zero throughout — so the obvious "wait for a device"
  // check passed in 0.125s while the farm was still entirely unable to automate anything. Third
  // instance of the same trap in this one scenario: assert on the thing the injection actually
  // broke, or the assertion is decoration.
  say('  Waiting for the farm to come back (supervisor gives up, systemd restarts, devices cold boot)');
  const back = await waitFor(
    async () => Number(await onLab(countCmd).catch(() => '0')) >= 1 && (await available()) > 0,
    300_000, 10_000);
  back === null
    ? bad('no appium server came back within 300s of the injection stopping — the farm did not self-heal')
    : ok(`appium back and a device available after ${back}s — the farm self-healed`);
};

/**
 * THE CONTROL PLANE RESTARTS WHILE A SESSION IS LIVE.
 *
 * The session lives in Postgres, so it should survive; the risk is the device, which must not be
 * left claimed by a session the API has forgotten. Disruptive because the console and the API go
 * away for a few seconds, so it is opt-in.
 */
scenarios.cprestart = async () => {
  say('Scenario: the control plane restarts mid-session');

  const before = await available();
  const opened = await hub('POST', '/session', caps());
  if (opened.status !== 200) { bad(`could not open a session: ${why(opened)}`); return; }
  const id = sid(opened);
  ok(`session ${id} open, ${await available()} device(s) left`);

  await onCp('cd ~/mfarm && docker compose -f deploy/docker-compose.prod.yml restart api 2>&1 | tail -2');
  ok('api container restarted');

  const back = await waitFor(async () => (await api('/v1/devices')).status === 200, 120_000);
  back === null ? bad('API never came back within 120s') : ok(`API answering again after ${back}s`);

  // The device must still be attributed to the session. The bad outcome is not "the session died" —
  // it is a device nobody owns and nobody will release.
  const after = await available();
  after === before - 1
    ? ok(`the lease survived the restart (${after} available, as before the restart)`)
    : bad(`device accounting changed across the restart: ${before - 1} expected, ${after} found`);

  const rel = await hub('DELETE', `/session/${id}`);
  rel.status < 400 ? ok('session still releasable after the restart')
                   : bad(`could not release after restart: ${why(rel)}`);
};

// ================================================================ run

// `appium` is here rather than in the safe set because it trips the supervisor's give-up
// limit and cold boots every device — measured at ~2 minutes of `available: 0`.
const NON_DISRUPTIVE = ['abandon'];
const DISRUPTIVE_ONLY = ['appium', 'cprestart'];

const main = async () => {
  if (!KEY) {
    // Read it off the box rather than asking for it on a command line, where it would land in shell
    // history and in this process's argv.
    KEY = await onCp('cat ~/mfarm/deploy/.state/api_key').catch(() => '');
    if (!KEY) { console.error('no MFARM_API_KEY, and could not read one from the control plane'); process.exit(2); }
    note('using the API key from the control plane');
  }

  const health = await api('/v1/devices');
  if (health.status !== 200) {
    console.error(`the farm is not answering at ${HUB} (status ${health.status}). Run deploy/farm-check.sh.`);
    process.exit(2);
  }
  say(`Farm at ${HUB}: ${health.json?.available ?? '?'} of ${health.json?.devices?.length ?? '?'} device(s) available`);

  const chosen = ONLY ? [ONLY]
    : DISRUPTIVE ? [...NON_DISRUPTIVE, ...DISRUPTIVE_ONLY]
    : NON_DISRUPTIVE;

  for (const name of chosen) {
    const fn = scenarios[name];
    if (!fn) { bad(`no such scenario: ${name}`); continue; }
    ran++;
    try { await fn(); }
    catch (e) { bad(`${name} threw: ${e.message}`); }
  }

  if (!ONLY && !DISRUPTIVE) {
    note('');
    note(`skipped ${DISRUPTIVE_ONLY.join(', ')} — pass --disruptive to include them`);
  }

  say(failed === 0
    ? `\x1b[32mAll checks passed across ${ran} scenario(s)\x1b[0m`
    : `\x1b[31m${failed} check(s) failed across ${ran} scenario(s)\x1b[0m`);
  say('A ✗ here is a finding, not necessarily a regression — several of these are known gaps that');
  say('this script exists to keep visible until they are fixed.');
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(2); });
