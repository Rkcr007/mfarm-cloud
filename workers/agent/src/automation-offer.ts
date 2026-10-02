/**
 * Whether a device is offered for WebDriver — one answer from the two things that can withdraw it.
 *
 * `webdriver` used to follow Appium alone: the supervisor reported healthy, the endpoint was
 * advertised. A phone that refuses adb's privileged commands has a perfectly healthy Appium and
 * cannot start a session on it, so the farm sent it work and the customer was sent a stack trace
 * (D60). The device has a say as well.
 *
 * ONE PLACE, because these two change independently and on different clocks — Appium on its own
 * probe, the phone on the discovery tick. Each calling `setAutomationEndpoint` directly would make
 * the capability whatever the LAST caller said: Appium recovering would re-advertise a phone that
 * is still blocked, and the phone being unblocked would advertise an Appium that is still down.
 */
export class AutomationOffer {
  private readonly server = new Map<string, string>();
  private readonly blocked = new Map<string, string>();
  private readonly apply: (localId: string, url: string | undefined) => void;

  /** `apply` is `agent.setAutomationEndpoint`; it is called only when the answer changes. */
  constructor(apply: (localId: string, url: string | undefined) => void) {
    this.apply = apply;
  }

  /** The automation server for this device is reachable at `url`, or (undefined) is not there. */
  serverIs(localId: string, url: string | undefined): void {
    const before = this.offered(localId);
    if (url === undefined) this.server.delete(localId);
    else this.server.set(localId, url);
    this.settle(localId, before);
  }

  /** The device itself cannot serve a session, for `reason`; or (undefined) it now can. */
  blockedBy(localId: string, reason: string | undefined): void {
    const before = this.offered(localId);
    if (reason === undefined) this.blocked.delete(localId);
    else this.blocked.set(localId, reason);
    this.settle(localId, before);
  }

  /** What is advertised for this device right now. */
  offered(localId: string): string | undefined {
    return this.blocked.has(localId) ? undefined : this.server.get(localId);
  }

  /** Why a device with a working server is not being offered, if that is the case. */
  blockerOf(localId: string): string | undefined { return this.blocked.get(localId); }

  private settle(localId: string, before: string | undefined): void {
    const now = this.offered(localId);
    if (now !== before) this.apply(localId, now);
  }
}
