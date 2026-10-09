import { loadConfig, type Config } from '../config.ts';

/**
 * Whose machine a host is, and therefore what an hour of it costs this farm.
 *
 * ---------------------------------------------------------------- the defect this closes (D73)
 *
 * Every host was costed at `HOST_HOURLY_COST` and every silent host was an incident, because the
 * product had one model of a host: a cloud VM the farm rents. Then a laptop enrolled an agent to
 * share two phones. Found on the live farm on 2026-10-09:
 *
 *   34.4 powered hours for a MacBook in October, shown as about ₹2,236 of spend — in a month where
 *     the device host itself had not run for one hour;
 *   "Infrastructure down" whenever the lab was switched off, because the laptop was either awake
 *     with its phones unplugged (no usable device) or asleep (a host not answering);
 *   418 "stopped responding" warnings and 834 device-quarantine rows in a week, as the sleeping
 *     laptop woke about 85 times a day, which pushed every real event out of the feed.
 *
 * ---------------------------------------------------------------- why ownership is the test
 *
 * `hosts.org_id` is set from the CREDENTIAL a host registered with — the fleet's registration token
 * leaves it NULL, an org's enrollment token sets it — and never from anything the worker sends
 * (`routes/workers.ts`). So it is already the answer to "is this the farm's machine": a host with an
 * org is somebody's own computer that they connected, and a host without one is infrastructure the
 * operator stood up. No column is added for this; the fact was in the row.
 */
export type HostKind = 'fleet' | 'enrolled';

export function hostKind(orgId: string | null): HostKind {
  return orgId === null ? 'fleet' : 'enrolled';
}

/**
 * What one hour of this host costs the farm, or null when that is not a number the farm has.
 *
 * NULL FOR AN ENROLLED HOST, never zero. The farm does not pay for a customer's laptop, and a zero
 * would be rendered as a measurement of something nobody measured — the same rule `config.ts` keeps
 * for an unset rate. Every sum that reads this skips a null.
 *
 * A FLEET HOST GETS ITS OWN INSTANCE'S RATE WHEN ONE IS NAMED. `CLOUD_INSTANCE_RATES` already says
 * what each cloud instance costs and `MFARM_POWER_INSTANCES` already maps a registered host name to
 * its instance, so a farm with two sizes of device host prices each correctly with no new
 * configuration. Anything unnamed falls back to `HOST_HOURLY_COST`, which is what every host got
 * before.
 */
export function hostHourlyRate(
  host: { hostname: string; orgId: string | null },
  // A parameter so a test can price a host against a configuration it states, rather than against
  // whatever this process happened to start with — `loadConfig` parses once and keeps the answer.
  cfg: Pick<Config, 'powerInstances' | 'cloudInstanceRates' | 'hostHourlyCost'> = loadConfig(),
): number | null {
  if (hostKind(host.orgId) === 'enrolled') return null;
  const instance = cfg.powerInstances.get(host.hostname)?.instance;
  const named = instance === undefined ? undefined : cfg.cloudInstanceRates.get(instance);
  return named ?? cfg.hostHourlyCost;
}
