// What does an AI run cost, and how many model calls does it take? — ADR-0046's measuring stick.
//
// ADR-0046 says no model, prompt or pricing change ships without its numbers. This runs a fixed set
// of tasks through the public API, one after another, waits for each, and prints per task: the
// verdict, the MODEL CALLS it took (the billable unit — a call can take several steps), the steps,
// the input and output tokens, the rupees billed and the wall time. The tasks are ones the farm can
// always run: Android's own Settings, and API Demos from the app library — whose "Text Entry dialog"
// (a name, a password, OK) is the shape of a login.
//
// Run it on the control plane, where the key lives, with the device host up:
//
//   MFARM_API_KEY=$(cat ~/mfarm/deploy/.state/api_key) node deploy/ai-eval.mjs
//   MFARM_API_KEY=… HUB=https://farm.mfarm.dev REGION=lab PROFILE=pro TASKS=api-demos-form node deploy/ai-eval.mjs
//
// Each task costs model calls and device time. Exits non-zero when a task did not pass.

import { pathToFileURL } from 'node:url';

export const TASKS = [
  {
    id: 'api-demos-form',
    appId: 'io.appium.android.apis@latest',
    prompt: 'In API Demos, open App, then Alert Dialogs, then "Text Entry dialog". Type asha into the Name '
      + 'field and hunter2 into the Password field, press OK, and check that the dialog has closed.',
  },
  {
    id: 'settings-search',
    appId: null,
    prompt: 'Open the Settings app, search for "Display", and check that a result named Display is shown.',
  },
  {
    id: 'android-version',
    appId: null,
    prompt: 'Open the Settings app, go to About phone, and check that an Android version is shown.',
  },
];

/**
 * One run, in the numbers ADR-0046 is judged by. A CALL is a step that carries tokens: the first step
 * of each model call does, the other actions that call named do not, and neither does a step the
 * runner took by rule (its action says `rule`).
 */
export function summarise(taskId, run, steps) {
  const calls = steps.filter((s) => (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0) > 0);
  const byRule = steps.filter((s) => s.action?.input?.rule);
  const sum = (k) => calls.reduce((n, s) => n + (s.tokens?.[k] ?? 0), 0);
  const seconds = run.startedAt && run.endedAt
    ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 100) / 10
    : null;
  return {
    task: taskId,
    status: run.status,
    stopReason: run.stopReason ?? null,
    calls: calls.length,
    steps: steps.length,
    byRule: byRule.length,
    inputTokens: sum('input'),
    outputTokens: sum('output'),
    costInr: run.costInr,
    seconds,
    model: run.model ?? null,
  };
}

export function table(rows) {
  const head = ['task', 'status', 'calls', 'steps', 'rule', 'in tok', 'out tok', '₹', 'sec'];
  const body = rows.map((r) => [r.task, r.stopReason ? `${r.status} (${r.stopReason})` : r.status, r.calls, r.steps,
    r.byRule, r.inputTokens, r.outputTokens, r.costInr, r.seconds ?? '—'].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

async function main() {
  const HUB = (process.env.HUB ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const KEY = process.env.MFARM_API_KEY;
  if (!KEY) {
    console.error('MFARM_API_KEY is required (deploy/.state/api_key on the control plane)');
    process.exit(2);
  }
  const REGION = process.env.REGION || undefined;
  const PROFILE = process.env.PROFILE ?? 'flash';
  const only = (process.env.TASKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = only.length ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  const api = async (method, path, body) => {
    const res = await fetch(`${HUB}/v1${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };

  const pricing = await api('GET', '/ai/pricing');
  console.log(`model ${pricing.model} · billing ${pricing.billing} · margin ${pricing.margin}× · `
    + `about ₹${pricing.profiles?.[PROFILE]?.estimateInr} a ${PROFILE} call · profile ${PROFILE}\n`);

  const rows = [];
  for (const t of tasks) {
    const started = await api('POST', '/ai/runs', {
      prompt: t.prompt, profile: PROFILE, ...(REGION ? { region: REGION } : {}), ...(t.appId ? { appId: t.appId } : {}),
    });
    const id = started.aiRun.id;
    process.stdout.write(`${t.id}: run ${id} `);
    const deadline = Date.now() + 15 * 60_000;
    let done;
    for (;;) {
      done = await api('GET', `/ai/runs/${id}`);
      if (!['queued', 'running'].includes(done.aiRun.status)) break;
      if (Date.now() > deadline) throw new Error(`run ${id} did not finish in 15 minutes`);
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 3000));
    }
    const row = summarise(t.id, done.aiRun, done.steps);
    rows.push(row);
    console.log(` ${row.status}${row.stopReason ? ` (${row.stopReason})` : ''}${done.aiRun.summary ? ` — ${done.aiRun.summary.slice(0, 120)}` : ''}`);
  }
  console.log(`\n${table(rows)}\n`);
  console.log(JSON.stringify({ at: new Date().toISOString(), profile: PROFILE, model: pricing.model, rows }));
  process.exit(rows.every((r) => r.status === 'passed') ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(2); });
}
