# ADR-0041 — the console is a workspace, not a page

**Status:** Accepted · 2026-09-14 · amends ADR-0038 (the top bar) · no migration

## Context

`design_handoff_mfarm_console 2/` (README + `MFARM Console v2.dc.html`) is a usability revamp of the
shell, the Session cockpit, Apps and Run detail. Its palette, type and radii are already
`design-tokens.css`'s — it is a re-layout of the console customers use today, not a new look.

The problem it names is real and was visible on the deployed farm: on the session screen the stage
sits on top, logcat is a full scroll below it, and actions and evidence below that, beside a rail of
six cards. **Reading a log line scrolls the phone out of sight**, and the phone is the thing the log
is about.

## Decision

1. **The page never scrolls; panels do.** The shell is fixed chrome — a 50px top bar and a 198px
   (54px collapsed) rail — and every screen scrolls inside `.main`, except the cockpit, which
   scrolls inside its own panels.
2. **The cockpit is two panels**: the device on the left, one tabbed dock on the right (Logs,
   Steps, Actions, Evidence, Inspector, Connect). Lease and stream health are facts in the header
   strip, not cards. Below 1000px of USABLE width — the window minus the rail — it stacks, measured
   by a container query on the workspace rather than a window media query, because collapsing the
   rail changes the space without changing the window.
3. **The top bar gives things up in a fixed order** as the window narrows (search trigger < 760px,
   rail forced collapsed < 900px, who block < 980px, two status segments < 1180px, email and build
   < 1240px). Nothing it hides is a capability: ⌘K still opens the palette, and the palette carries
   Sign out.

### Amending ADR-0038: one host fact returns, for operators only

ADR-0038 took `host up 20h · ~₹410` off the top bar because a member cannot act on it and a single
fact is not enough for anybody to act on. The product owner chose on 2026-09-14 to bring back
exactly one fact — `Host on · ₹65/hr` — **for fleet operators only**. The 2026-09-11 twenty-hour
burn happened to somebody who could have stopped it and was looking at a different screen; the nav
dot is a signal you have to look at the rail to see.

What does not change: the Infrastructure page is still where you act, its nav dot stays, a member's
markup ships an empty hidden slot (so nothing flashes before the script runs), and a refused
`/v1/hosts` request renders nothing rather than "Hosts off" — an unread fleet is not a switched-off
one.

## Deliberate divergences from the handoff

- **Lucide icons, not the prototype's Unicode glyphs** (`▦ ◳ ⏻ ⟳ ⎙`). `icons.test.ts` bans
  pictographs in the chrome because they render at whatever weight and baseline each platform
  picks.
- **Tunnels and Infrastructure keep their nav items**; the handoff predates both.
- **The light theme stays.** Every value goes through a token, so the handoff's dark hexes are the
  dark theme's and the light theme re-derives them.
- **The build badge stays** in the top bar (hidden < 1240px): it is how a deploy is verified.
- **Session shortcuts follow the handoff** — `L` Logs, `S` Steps, `E` Evidence, `I` Inspector. `S`
  used to take a screenshot and `L` to pause logcat; both remain as controls and palette commands.
- The width-preview chips and the "What changed" drawer are review tools and do not ship.

## Consequences

- The cockpit's six rail cards and the stacked cards under the stage are gone as cards; their
  contents are tab bodies. A screen test that looked for a card title now looks inside a tab.
- ADR-0038's "the top bar loses its infrastructure segments" is true for members and no longer
  for operators; `console-screens.test.ts` pins both halves.
