/**
 * The share page (migration 051) — one failure, shown to somebody with no account here.
 *
 * WHAT THIS FILE IS NOT. It is not the console: it boots no application, holds no state beyond one
 * fetch, opens no socket, and has no router. Every byte it renders comes from a single
 * `GET /v1/shares/<token>` whose payload was decided field by field in `routes/shares.ts` — so the
 * rule for changing this file is that it may only ever render LESS than that payload, never reach
 * for more. There is nothing else to reach for: the endpoint is the whole surface.
 *
 * THE TOKEN COMES OUT OF THE PATH AND STAYS THERE. It is never put in a query string, never logged,
 * never written into the document, and the page's `referrer-policy: no-referrer` keeps it out of
 * any onward request. The one place it appears is the `fetch` URL.
 *
 * `deviceName` IS IMPORTED RATHER THAN REIMPLEMENTED. A share that called an X1 Pro something the
 * console does not call it would be a second opinion about the product's own hardware, and the
 * failure mode is silent: a profile added to `profiles.js` would appear correctly in the console
 * and as a raw model string here, for as long as it took somebody to notice.
 */
import { deviceName } from '/profiles.js';

const root = document.getElementById('root');

/* ---------------------------------------------------------------- tiny dom helper */

/**
 * The console's `h`, cut down to what one page needs.
 *
 * NO `style` KEY, and that is not an omission. This page ships `style-src 'self'` with no
 * `'unsafe-inline'`, which kills the style ATTRIBUTE silently — it parses, computes to nothing, and
 * leaves an element with the spacing simply missing and no error anywhere. Every rule this page
 * needs is a class in `share.css`. The console's own `h()` solves the same problem by writing
 * through CSSOM; this page has nothing that changes at runtime, so it does not need to.
 *
 * `text` is assigned as a TEXT NODE, never as innerHTML, and that is the whole XSS story for this
 * page: every string it renders — a test name, a stack trace, a device model, a WebDriver path —
 * was written by a tenant's suite and arrives here unexamined. The CSP would stop an injected
 * script from running anyway; this stops it from being parsed as markup in the first place, which
 * is the lock that does not depend on a header surviving a proxy.
 */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.append(document.createTextNode(String(v)));
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

const show = (...nodes) => {
  root.replaceChildren(...nodes.flat().filter(Boolean));
  root.setAttribute('aria-busy', 'false');
};

/* ---------------------------------------------------------------- theme */

/**
 * THE VISITOR'S OWN PREFERENCE WINS, which is the opposite of the console's default.
 *
 * The console ships `data-theme="dark"` because it is a tool somebody chose to open and returns to
 * all day. A share is opened once, by somebody who has never seen this product, wherever they
 * happen to be — so the honest default is their operating system's, and the toggle is there for the
 * case where it is wrong. Nothing is persisted: a page visited once has no preferences to remember,
 * and `localStorage` on a link shared into a channel would be state about a stranger.
 */
function initTheme() {
  const dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  apply(dark ? 'dark' : 'light');
  document.getElementById('theme').addEventListener('click', () =>
    apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // The button names where it GOES, not where it is — a control labelled with the current state
    // reads as a status display and gets pressed by accident.
    document.getElementById('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
  }
}

/* ---------------------------------------------------------------- formatting */

const pad = (n) => String(n).padStart(2, '0');

/** An absolute instant, in the READER's timezone — they are in a different one often enough that a
 *  UTC stamp with no zone would be quietly misread, and a relative "3 hours ago" is useless on a
 *  link opened next Tuesday. */
function when(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long the test took, in the unit a person would say it in. */
function took(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const STATUS_TONE = { failed: 'bad', passed: 'ok', skipped: 'warn' };

/* ---------------------------------------------------------------- the states */

/**
 * ONE PAGE FOR EVERY WAY A LINK CAN BE DEAD — unknown, malformed, revoked, expired — because the
 * API deliberately cannot tell them apart and this page must not appear to. Saying "this link was
 * withdrawn" would confirm to the holder of a withdrawn link that they once held a real one, which
 * is exactly the fact revocation is trying to take back.
 *
 * IN PROSE, not as a framework 404. The person reading this is usually a colleague opening a link
 * from a channel three weeks later, and "Ask whoever sent it for a new one" is the sentence that
 * actually ends their problem.
 */
function renderGone() {
  show(h('div', { class: 'sh-gone' },
    h('h1', { text: 'This link is no longer live' }),
    h('p', { class: 'sh-caption', text:
      'Shared results expire, and whoever created this one can withdraw it at any time. '
      + 'Ask them for a new link.' }),
  ));
}

function renderBroken(detail) {
  show(h('div', { class: 'sh-gone' },
    h('h1', { text: 'This result could not be loaded' }),
    h('p', { class: 'sh-caption', text:
      'Something went wrong reaching the farm that holds it, which is different from the link being '
      + 'expired — trying again in a moment is worth it.' }),
    detail ? h('p', { class: 'sh-caption', text: detail }) : null,
  ));
}

/* ---------------------------------------------------------------- the result */

function verdictCard(d) {
  const tone = STATUS_TONE[d.test.status] || '';
  const name = d.device ? deviceName(d.device) : null;

  /**
   * THE IDENTITY STRIP, and every part of it is omitted rather than faked when absent.
   *
   * A share whose device row has been deleted, or whose result carried no duration, must not render
   * "unknown device" or "0 ms" — those are assertions. `filter(Boolean)` is the whole rule.
   */
  const ident = [
    name,
    d.device ? `${d.device.platform} ${d.device.osVersion}` : null,
    d.session.region,
    took(d.test.durationMs),
  ].filter(Boolean).join(' · ');

  return h('div', { class: 'sh-card' },
    h('div', { class: 'sh-verdict' },
      h('div', { class: 'sh-row' },
        h('span', { class: `sh-pill ${tone}` }, h('span', { class: 'dot' }), h('span', { text: d.test.status })),
        // The suite's OWN classification of why it failed, where it sent one (migration 042).
        // Absent is never rendered as "the product's fault" — it is rendered as nothing.
        d.test.failureClass
          ? h('span', { class: 'sh-pill', text: d.test.failureClass.replace(/-/g, ' ') })
          : null,
      ),
      h('h1', { class: 'sh-testname', text: d.test.name || 'unnamed test' }),
      ident ? h('p', { class: 'sh-ident', text: ident }) : null,
    ),
    h('p', { class: 'sh-caption', text: [
      `Reported ${when(d.test.reportedAt)}`,
      // The run's readable name (migration 048), never its uuid. This is the only place the
      // recipient learns the failure came out of a CI run at all.
      d.run ? `on ${d.run.name || d.run.externalId}` : null,
    ].filter(Boolean).join(' ') }),
  );
}

function stackCard(d) {
  if (!d.test.failure) {
    return h('div', { class: 'sh-card' },
      h('div', { class: 'sh-card-head' }, h('span', { class: 'sh-card-title', text: 'Failure' })),
      h('p', { class: 'sh-caption', text: 'No message was reported with this result.' }));
  }

  const copy = h('button', {
    class: 'sh-copy', type: 'button', text: 'Copy',
    on: {
      click: async (e) => {
        // `navigator.clipboard` is absent over plain http and in some embedded browsers. A button
        // that silently does nothing is worse than one that says so, and there is no toast on this
        // page to say it in — so the button itself is the message.
        try {
          await navigator.clipboard.writeText(d.test.failure);
          e.target.textContent = 'Copied';
        } catch {
          e.target.textContent = 'Press ⌘C';
        }
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
      },
    },
  });

  return h('div', { class: 'sh-card' },
    h('div', { class: 'sh-card-head' },
      h('span', { class: 'sh-card-title', text: 'Failure' }), copy),
    h('pre', { class: 'sh-stack', text: d.test.failure }),
  );
}

function screenshotCard(d, token) {
  if (!d.screenshot) return null;
  return h('div', { class: 'sh-card' },
    h('div', { class: 'sh-card-head' },
      h('span', { class: 'sh-card-title', text: 'The screen when it failed' })),
    h('img', {
      class: 'sh-shot',
      // Reached through the TOKEN, never through an artifact id — see the route's comment. The
      // token is already in this page's own URL, so putting it in an image src discloses nothing
      // the reader does not already hold.
      src: `/v1/shares/${encodeURIComponent(token)}/screenshot`,
      alt: 'The device screen at the moment this test failed',
      loading: 'lazy',
    }),
    h('p', { class: 'sh-caption sh-mt', text:
      'Captured when the suite reported the failure — up to a few seconds after the assertion, '
      + 'so the screen may have moved on. The steps below are what got it there.' }),
  );
}

function stepsCard(d) {
  const items = d.steps.items || [];
  const failed = items.filter((s) => s.failed).length;

  return h('div', { class: 'sh-card' },
    h('div', { class: 'sh-card-head' },
      h('span', { class: 'sh-card-title', text: 'Steps' }),
      h('span', { class: 'sh-caption', text:
        `${items.length}${d.steps.truncated ? '+' : ''} step${items.length === 1 ? '' : 's'}`
        + (failed ? `, ${failed} failed` : '') })),

    items.length
      ? h('div', { class: 'sh-tablewrap' }, h('table', { class: 'sh-table' },
          h('thead', null, h('tr', null,
            ['#', 'Command', 'Status', 'Took'].map((t) => h('th', { text: t })))),
          h('tbody', null, items.map((s) => h('tr', { class: s.failed ? 'failed' : null },
            h('td', { class: 'num', text: s.seq }),
            h('td', { class: 'path' },
              h('span', { class: 'sh-method', text: s.method }),
              h('span', { text: s.path })),
            // "sent, never answered" rather than an empty cell: a NULL status is the most alarming
            // thing that can happen to a session and an empty cell reads as ordinary.
            h('td', { text: s.status === null ? 'no answer' : s.status }),
            h('td', { class: 'num', text: took(s.durationMs) || '' }),
          )))))
      : h('p', { class: 'sh-caption', text:
          'No WebDriver commands were recorded in this test’s window — a session driven by '
          + 'hand, or one whose steps have passed their retention window, has none.' }),

    /**
     * THE TWO SENTENCES THAT MAKE THE TABLE HONEST, and neither is optional.
     *
     * The first says what the window IS, because a reader who knows the session ran eight scenarios
     * would otherwise wonder where the other seven went — and because a reader who does NOT know
     * that would otherwise assume this is the whole session.
     *
     * The second says what MFARM stores, because "you have my selectors and my test data" is the
     * first thing a person thinks when they are sent a step trace of their own suite by a stranger.
     */
    items.length
      ? h('p', { class: 'sh-caption sh-mt', text:
          'Only the commands between the previous test on this session and this one — the rest of '
          + 'the session is not part of this link.' })
      : null,
    h('p', { class: `sh-caption${items.length ? '' : ' sh-mt'}`, text:
      'MFARM records what each command WAS, never what it carried — selectors, test data and '
      + 'passwords live in the request body and are not stored.' }),
  );
}

/**
 * What the link does not carry, said on the page rather than only in the code.
 *
 * A RECIPIENT SHOULD NOT HAVE TO GUESS WHAT ELSE THEY WERE GIVEN, and neither should the person who
 * sent it. Saying "no device log" out loud is what turns the omission from a limitation into the
 * decision it is — and it is the sentence that stops somebody asking for the logcat to be added
 * here without reading why it is not.
 */
function footer(d) {
  const expires = when(d.share.expiresAt);
  return h('div', { class: 'sh-foot' },
    h('p', { class: 'sh-caption', text:
      `Shared from ${d.org.name}’s MFARM device farm`
      + (expires ? `. This link stops working on ${expires}.` : '.') }),
    h('p', { class: 'sh-caption', text:
      'It carries this one test result and nothing else — no device log, no recording, and no '
      + 'other test from the same session.' }),
  );
}

/* ---------------------------------------------------------------- boot */

async function main() {
  initTheme();

  /**
   * The token is the last path segment of `/s/<token>`, taken from `location` rather than handed in
   * by the server. That keeps the shell a static file — identical for every token, which is a
   * property `shares.test.ts` asserts — and it means the server never renders a token into HTML it
   * might later log.
   */
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  if (!token) return renderGone();

  let res;
  try {
    res = await fetch(`/v1/shares/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      /**
       * `omit`, explicitly. A person who happens to ALSO be signed into this farm in another tab
       * must see exactly what a stranger sees — otherwise the page is tested by its author under
       * conditions no recipient will ever be in, and a route that quietly required a cookie would
       * look like it worked.
       */
      credentials: 'omit',
    });
  } catch (e) {
    return renderBroken(e && e.message);
  }

  // 404 is every way of being invalid: unknown, malformed, revoked, expired. One page for all of
  // them, on purpose — see `renderGone`.
  if (res.status === 404) return renderGone();
  if (!res.ok) return renderBroken(`The farm answered ${res.status}.`);

  let d;
  try {
    d = await res.json();
  } catch {
    return renderBroken('The farm sent something this page could not read.');
  }

  show(
    verdictCard(d),
    // Ordered as a person reads a failure: what broke, what it looked like, how it got there.
    d.test.status === 'failed' ? stackCard(d) : null,
    screenshotCard(d, token),
    stepsCard(d),
    footer(d),
  );
}

void main();
