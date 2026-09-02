# `mfarm` — this is not the MFARM CLI

**The MFARM command-line tool is [`@mfarm/cli`](https://www.npmjs.com/package/@mfarm/cli).**

```sh
npm install --save-dev @mfarm/cli
```

This package exists so that the unscoped name `mfarm` belongs to the MFARM project and cannot be
registered by anyone else. It contains no functionality. If you install it and run `mfarm`, it
prints the line above and exits 1.

## Why it exists at all

`mfarm run` executes inside a process holding `MFARM_API_KEY`, and derives `MFARM_WEBDRIVER_URL`,
which embeds that key. So `npx mfarm …` — a command MFARM's own README suggested until 2026-09-03 —
would hand a customer's credential to whoever happened to own this name. Leaving it unregistered
made that a matter of who got there first.

Publishing an inert package is the cheapest permanent fix. See
[ADR-0023](https://github.com/Rkcr007/mfarm-cloud/blob/main/docs/adrs/0023-the-published-cli-is-compiled-and-scoped.md).
