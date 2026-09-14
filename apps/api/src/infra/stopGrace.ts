/**
 * How long after a stop was asked for the control plane keeps believing the stop.
 *
 * TWO READERS, ONE NUMBER. `lift_host_down` refuses to let a beat lift DOWN inside this window
 * (migration 059), and the snapshot reports `power: 'stopping'` for the same span while the machine
 * is still audible. If they drifted apart the card would say "stopped" about a host whose devices
 * were being handed back, or the other way round.
 *
 * THREE MINUTES, measured rather than chosen: a GCE stop on this farm silences the agent in about
 * ninety seconds, and the beat is every ten. Past the window a beat lifts DOWN as it always has, so
 * a stop that never took effect costs a couple of minutes rather than stranding a running machine.
 *
 * Read on every call, never at module scope: a test that cannot wind this down cannot tell the rule
 * from the bug it fixes, and `import` is hoisted past any env a test sets.
 */
export function stopGraceMs(): number {
  return Number(process.env.INFRA_STOP_GRACE_MS ?? 180_000);
}
