import { loadConfig } from '../config.ts';

/**
 * The cloud provider, as narrowly as this product needs one.
 *
 * ---------------------------------------------------------------- the credential story, first
 *
 * **THERE IS NO CREDENTIAL IN THIS REPOSITORY, IN ANY ENVIRONMENT VARIABLE, OR ON ANY DISK.**
 *
 * The token comes from the GCE metadata server — `169.254.169.254`, reachable only from the VM
 * itself, answering only to a request carrying `Metadata-Flavor: Google`. It is minted for the
 * service account ATTACHED TO THE INSTANCE, it lasts about an hour, and it is scoped by the
 * instance's own OAuth scopes on top of whatever IAM allows.
 *
 * That is four separate reasons a leak of this process's environment, its image, or its git history
 * yields nothing: there is no key file to exfiltrate, the token cannot be requested from anywhere
 * but the machine, it expires, and the machine's scopes cap it regardless of what IAM says. A JSON
 * key would have had none of those properties.
 *
 * ---------------------------------------------------------------- what it may touch
 *
 * `loadConfig().powerInstances` is an explicit allow-list and nothing outside it is reachable from
 * here. That is not defence in depth, it is the actual defence: `hosts.hostname` is a string a
 * WORKER chooses for itself at registration, so a driver that resolved a host name to an instance
 * name would let a misconfigured — or hostile — agent put a Stop button for the control plane on
 * somebody's console. See `config.ts`.
 *
 * The IAM role granted to the instance should be a custom one with exactly
 * `compute.instances.get`, `.start`, `.stop` and `.reset`, bound to the named instances rather than
 * to the project. `docs/RUNBOOK.md` carries the commands.
 *
 * ---------------------------------------------------------------- why this is hand-written
 *
 * `@google-cloud/compute` is a large dependency tree for four REST calls, in a service whose
 * production dependencies are fastify, pg and ws. Four `fetch` calls against a documented, stable
 * JSON API is less code than the wrapper's configuration would be, and every byte of it is
 * reviewable here.
 */

const METADATA_BASE = 'http://169.254.169.254/computeMetadata/v1';
const COMPUTE_BASE = 'https://compute.googleapis.com/compute/v1';

/** The provider's view of a machine. `unknown` when the provider itself could not say. */
export type PowerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'unknown';

export interface InstanceStatus {
  state: PowerState;
  /** The provider's own word for it, kept so a state this mapping does not know is still visible. */
  raw: string;
}

/**
 * GCE's instance statuses, mapped onto the five an operator thinks in.
 *
 * `SUSPENDED` and `SUSPENDING` map to stopped and stopping: a suspended instance is not running
 * anything and is not billed for CPU, which is what both words mean on this page. `REPAIRING` is an
 * error rather than a transition, because it is not on its way anywhere by itself.
 */
const GCE_STATUS: Record<string, PowerState> = {
  RUNNING: 'running',
  TERMINATED: 'stopped',
  SUSPENDED: 'stopped',
  PROVISIONING: 'starting',
  STAGING: 'starting',
  STOPPING: 'stopping',
  SUSPENDING: 'stopping',
  REPAIRING: 'error',
};

export class CloudError extends Error {
  /** True when the provider answered and said no; false when we could not reach it at all. */
  readonly answered: boolean;
  constructor(message: string, answered: boolean) {
    super(message);
    this.name = 'CloudError';
    this.answered = answered;
  }
}

/**
 * How long any single provider call may take.
 *
 * Shorter than a person's patience and longer than the API's p99. A request that hangs past this is
 * reported as `unknown` rather than as a failure — see `operations.ts` — because a `stop` whose
 * response was lost may well have been carried out.
 */
const CALL_TIMEOUT_MS = 10_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * An access token for the attached service account.
 *
 * CACHED UNTIL SHORTLY BEFORE IT EXPIRES, with sixty seconds of slack: a token that is valid when
 * this function returns and expired when the request reaches Google is a 401 that looks like a
 * permissions problem, and somebody would spend an afternoon on IAM.
 */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(`${METADATA_BASE}/instance/service-accounts/default/token`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch((e: Error) => {
    throw new CloudError(
      'The metadata server did not answer, so this process has no cloud credential. '
      + `That is normal off a GCE instance. (${e.message})`, false);
  });
  if (!res.ok) {
    throw new CloudError(
      `The metadata server refused to mint a token (${res.status}). The instance may have no `
      + 'service account attached.', true);
  }
  const body = await res.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new CloudError('The metadata server returned no token.', true);
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 0)) * 1000,
  };
  return cachedToken.value;
}

/**
 * WHICH INSTANCE THIS PROCESS IS RUNNING ON, so that it can refuse to switch itself off.
 *
 * The allow-list already makes that impossible by construction, and this is the second lock —
 * cheap, and covering the case where somebody adds the control plane to the list by mistake. A
 * console that can stop the machine serving it is a console with one working button.
 *
 * Null off a GCE instance, which is every development machine. Cached because it never changes.
 */
let selfInstance: string | null | undefined;
export async function thisInstanceName(): Promise<string | null> {
  if (selfInstance !== undefined) return selfInstance;
  try {
    const res = await fetch(`${METADATA_BASE}/instance/name`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2_000),
    });
    selfInstance = res.ok ? (await res.text()).trim() : null;
  } catch {
    selfInstance = null;
  }
  return selfInstance;
}

/**
 * Test seam. Drops the token and the instance-name caches.
 *
 * Both are cached for the life of the process because neither changes for the life of a VM — which
 * is correct in production and makes the module a single-scenario module in a test file. Named and
 * exported rather than reached around, following `resetCommandLog`.
 */
export function resetCloudCache(): void {
  cachedToken = null;
  selfInstance = undefined;
}

/** Resolve a host NAME to the instance it is allowed to control, or null if it is not on the list. */
export function instanceFor(hostname: string): { instance: string; zone: string; project: string } | null {
  const cfg = loadConfig();
  const entry = cfg.powerInstances.get(hostname);
  if (!entry || !cfg.gcpProject) return null;
  return { ...entry, project: cfg.gcpProject };
}

/** Whether this deployment can power anything at all. Read by the console's `capabilities`. */
export function powerConfigured(): boolean {
  const cfg = loadConfig();
  return cfg.powerInstances.size > 0 && cfg.gcpProject !== null;
}

type Target = { instance: string; zone: string; project: string };

async function call(method: 'GET' | 'POST', path: string): Promise<Record<string, unknown>> {
  const token = await accessToken();
  const res = await fetch(`${COMPUTE_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch((e: Error) => {
    /**
     * NOT ANSWERED. The distinction is carried all the way to the audit row: a `stop` that timed out
     * settles as `unknown`, because the request may have been received and acted on. Reporting it as
     * a failure is how somebody presses Stop a second time on a machine that is already stopping.
     */
    throw new CloudError(`The cloud API did not answer in time (${e.message}).`, false);
  });

  if (res.status === 403) {
    throw new CloudError(
      'The cloud API refused this operation. The control plane\'s service account needs '
      + 'compute.instances.get/start/stop/reset on this instance, AND the instance\'s own OAuth '
      + 'scopes must permit compute — scopes cap IAM, and changing them requires the VM to be '
      + 'stopped. See docs/RUNBOOK.md.', true);
  }
  if (res.status === 404) throw new CloudError('The cloud provider has no such instance.', true);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CloudError(`The cloud API answered ${res.status}. ${text.slice(0, 200)}`, true);
  }
  return await res.json() as Record<string, unknown>;
}

/**
 * A read against the compute API, by full path.
 *
 * EXPORTED FOR THE INVENTORY, which lists whole collections rather than acting on one named machine
 * — a list cannot be scoped to an instance, so it needs its own project-level role. Keeping it on
 * `call` means both paths share one token, one timeout and one error taxonomy, which is what makes
 * `answered` mean the same thing everywhere.
 */
export const cloudGet = (path: string): Promise<Record<string, unknown>> => call('GET', path);

const url = (t: Target, suffix = '') =>
  `/projects/${encodeURIComponent(t.project)}/zones/${encodeURIComponent(t.zone)}`
  + `/instances/${encodeURIComponent(t.instance)}${suffix}`;

export async function instanceStatus(t: Target): Promise<InstanceStatus> {
  const body = await call('GET', url(t));
  const raw = String(body.status ?? '');
  return { state: GCE_STATUS[raw] ?? 'unknown', raw };
}

/**
 * Ask the provider to start, stop or reset an instance.
 *
 * RETURNS AS SOON AS THE REQUEST IS ACCEPTED, not when the machine has finished moving. A GCE start
 * is minutes — the devices cold boot after it — and holding an HTTP request open for that would
 * time out somewhere in the middle and tell the operator nothing. The caller polls; the console
 * shows the state moving.
 */
export async function powerAction(t: Target, action: 'start' | 'stop' | 'reset'): Promise<void> {
  await call('POST', url(t, `/${action}`));
}

/**
 * Watch an instance until it reaches one of `want`, or the deadline passes.
 *
 * RESOLVES WITH WHAT IT LAST SAW, never throws on the deadline. "It did not get there within thirty
 * seconds" is not a failure — a GCE start legitimately takes longer — and the caller turns a
 * non-arrival into `accepted`/`unknown` rather than into red text.
 */
export async function awaitState(
  t: Target, want: PowerState[], timeoutMs: number,
): Promise<InstanceStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: InstanceStatus = { state: 'unknown', raw: '' };
  for (;;) {
    try {
      last = await instanceStatus(t);
      if (want.includes(last.state)) return last;
    } catch (e) {
      // A transient failure while watching must not become the operation's verdict. The last state
      // we actually saw is returned, and the caller decides what that means.
      if (e instanceof CloudError && e.answered) throw e;
    }
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
