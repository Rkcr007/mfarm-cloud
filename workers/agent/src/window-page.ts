/**
 * The page the agent serves on loopback — ADR-0009 §1, milestone M2.
 *
 * ONE SELF-CONTAINED DOCUMENT, and that is a security decision rather than a packaging one. The
 * whole surface is token-gated (`window.ts`), and a second request for `/app.js` would need the
 * token too — either in the URL of every asset, or on a path exempted from the check. Both are
 * ways to get the exemption wrong. Inlining removes the question: there is exactly one GET that
 * returns anything, and it is checked like everything else.
 *
 * It also means the page never touches the network. No CDN, no webfont, no favicon fetch — so the
 * token in `location.search` cannot leak to a third party through a `Referer` header, which is the
 * one realistic way a local token escapes the machine.
 *
 * NOTHING IS BUILT WITH innerHTML. Every node is created and every string goes in through
 * `textContent`. Device models, adb remedies and host names all come from outside this process
 * (`getprop`, adb's own output, the control plane), and a page that pasted them into markup would
 * be an injection sink reachable by naming a phone. `h()` costs three lines and removes the class.
 *
 * The palette is the console's — graphite surfaces, 1px hairlines, system mono, one accent — so
 * this reads as the same product rather than a debug page that happens to be adjacent to one.
 */
export const WINDOW_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MFARM agent</title>
<style>
:root {
  --accent: #755EB8;
  --accent-soft: rgba(117, 94, 184, .16);
  --accent-line: rgba(117, 94, 184, .42);
  --s-app: #08080A;
  --s-card: #0D0D0F;
  --s-inset: #050506;
  --s-btn: #131315;
  --s-chip: #191919;
  --b-card: #1F1F22;
  --b-btn: #2B2B2E;
  --b-row: #151517;
  --b-hover: #3A3A3D;
  --t-primary: #F1F1F1;
  --t-body: #D4D4D4;
  --t-label: #8A8A8A;
  --t-help: #787878;
  --t-caption: #6A6A6A;
  --ok-dot: #6FCB63;
  --ok-text: #7FD873;
  --ok-bg: rgba(111, 203, 99, .10);
  --ok-line: rgba(111, 203, 99, .28);
  --warn: #E8A30E;
  --warn-bg: rgba(232, 163, 14, .06);
  --warn-line: rgba(232, 163, 14, .24);
  --bad-dot: #E0505F;
  --bad-text: #EE7C88;
  --bad-bg: rgba(224, 80, 95, .07);
  --bad-line: rgba(224, 80, 95, .30);
  --info: #7FA0D8;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh;
  background: var(--s-app); color: var(--t-body);
  font-family: var(--mono); font-size: 12.5px; letter-spacing: .01em; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
h1, h2, p, dl, dd { margin: 0; }
ul { margin: 0; padding: 0; list-style: none; }
button { font: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; }
button[disabled] { cursor: not-allowed; opacity: .45; }
code { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.wrap { max-width: 860px; margin: 0 auto; padding: 26px 20px 60px; }

/* ---------------------------------------------------------------------------- header */
header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.mark {
  width: 26px; height: 26px; border-radius: 5px; background: var(--accent);
  color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 14px; flex: none;
}
.wordmark { color: var(--t-primary); font-weight: 600; letter-spacing: .08em; }
.spacer { flex: 1; }
.pill {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--b-btn); background: var(--s-chip);
  border-radius: 999px; padding: 3px 11px 3px 9px; font-size: 11px; color: var(--t-label);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--t-caption); flex: none; }
.pill.live { border-color: var(--ok-line); background: var(--ok-bg); color: var(--ok-text); }
.pill.live .dot { background: var(--ok-dot); animation: breathe 2.2s ease-in-out infinite; }
.pill.lost { border-color: var(--bad-line); background: var(--bad-bg); color: var(--bad-text); }
.pill.lost .dot { background: var(--bad-dot); }
@keyframes breathe { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
@media (prefers-reduced-motion: reduce) { .pill.live .dot { animation: none } }

/* ---------------------------------------------------------------------------- cards */
.card {
  border: 1px solid var(--b-card); background: var(--s-card);
  border-radius: 6px; padding: 15px; margin-bottom: 16px;
}
.eyebrow {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .13em;
  color: var(--t-caption); margin-bottom: 11px;
}
dl.facts { display: grid; grid-template-columns: 128px 1fr; gap: 5px 14px; }
dl.facts dt { color: var(--t-label); }
dl.facts dd { color: var(--t-body); overflow-wrap: anywhere; }

/* ---------------------------------------------------------------------------- devices */
.device { border: 1px solid var(--b-card); background: var(--s-card); border-radius: 6px; margin-bottom: 12px; }
.device .head { display: flex; align-items: baseline; gap: 10px; padding: 13px 15px; flex-wrap: wrap; }
.device .name { color: var(--t-primary); font-weight: 600; }
.device .serial { color: var(--t-caption); font-size: 11px; }
.device .meta { padding: 0 15px 13px; color: var(--t-help); font-size: 11.5px; }
.tag {
  border: 1px solid var(--b-btn); background: var(--s-inset); border-radius: 3px;
  padding: 1px 7px; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--t-label);
}
.tag.ok { border-color: var(--ok-line); background: var(--ok-bg); color: var(--ok-text); }
.tag.warn { border-color: var(--warn-line); background: var(--warn-bg); color: var(--warn); }
.tag.bad { border-color: var(--bad-line); background: var(--bad-bg); color: var(--bad-text); }
.tag.busy { border-color: var(--accent-line); background: var(--accent-soft); color: #B8A6E8; }

.note {
  margin: 0 15px 13px; padding: 11px 13px; border-radius: 4px;
  border: 1px solid var(--b-row); background: var(--s-inset);
  border-left-width: 2px; color: var(--t-body);
}
.note.warn { border-color: var(--warn-line); border-left-color: var(--warn); background: var(--warn-bg); }
.note.bad { border-color: var(--bad-line); border-left-color: var(--bad-dot); background: var(--bad-bg); }
.note .title { color: var(--t-primary); margin-bottom: 4px; }
.note .body { color: var(--t-body); }
.note .body code { color: var(--info); }

.actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.btn {
  border: 1px solid var(--b-btn); background: var(--s-btn); color: var(--t-primary);
  border-radius: 4px; padding: 5px 12px; font-size: 11.5px;
}
.btn:hover:not([disabled]) { border-color: var(--b-hover); }
.btn.primary { border-color: var(--accent-line); background: var(--accent-soft); }
.btn-note { color: var(--t-caption); font-size: 11px; }

/* ---------------------------------------------------------------------------- pairing */
.pair {
  border: 1px solid var(--accent-line); background: var(--accent-soft);
  border-radius: 6px; padding: 26px 22px; margin-bottom: 18px; text-align: center;
}
.pair .lead { color: var(--t-primary); font-size: 14px; margin-bottom: 4px; }
.pair .sub { color: var(--t-body); margin-bottom: 20px; }
.code {
  font-size: clamp(28px, 8vw, 46px); font-weight: 700; letter-spacing: .22em;
  color: var(--t-primary); margin: 0 0 6px; line-height: 1.15;
  /* The dash is the only place the code may break, and it should not wrap at all if it fits. */
  white-space: nowrap; overflow-x: auto;
}
.pair .expiry { color: var(--t-caption); font-size: 11.5px; }
.pair ol {
  text-align: left; max-width: 460px; margin: 20px auto 0; padding: 0;
  counter-reset: step; color: var(--t-body);
}
.pair ol li { counter-increment: step; padding: 5px 0 5px 28px; position: relative; }
.pair ol li::before {
  content: counter(step); position: absolute; left: 0; top: 5px;
  width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--accent-line);
  color: #B8A6E8; font-size: 10.5px; display: grid; place-items: center;
}
.pair .waiting { margin-top: 18px; color: var(--t-label); font-size: 11.5px; }

.empty {
  border: 1px dashed #303033; border-radius: 6px; padding: 34px 20px; text-align: center;
  color: var(--t-help);
}
.empty strong { display: block; color: var(--t-primary); font-weight: 600; margin-bottom: 6px; }

footer { margin-top: 26px; color: var(--t-caption); font-size: 11px; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="mark">M</span>
    <span class="wordmark">MFARM agent</span>
    <span class="spacer"></span>
    <span class="pill" id="conn"><span class="dot"></span><span id="conn-text">connecting</span></span>
  </header>

  <div id="pair"></div>

  <div id="rest">
    <section class="card">
      <p class="eyebrow">This machine</p>
      <dl class="facts" id="facts"></dl>
    </section>

    <div id="notices"></div>

    <p class="eyebrow">Devices</p>
    <div id="devices"></div>
  </div>

  <footer id="foot"></footer>
</div>

<script>
(function () {
  'use strict';

  // The token the agent minted at start-up and put in the URL it opened. Kept in memory only.
  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var q = function (path) { return path + '?t=' + encodeURIComponent(TOKEN); };

  /** Build a node. Text always goes through textContent — never markup. See the file header. */
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var connEl = document.getElementById('conn');
  var connText = document.getElementById('conn-text');
  function conn(cls, text) {
    connEl.className = 'pill' + (cls ? ' ' + cls : '');
    connText.textContent = text;
  }

  // -------------------------------------------------------------------------- host facts
  function renderFacts(host) {
    var dl = document.getElementById('facts');
    clear(dl);
    var rows = [
      ['Host', host.hostname],
      ['Region', host.region],
      ['Control plane', host.controlPlaneUrl],
      ['Registered as', host.hostId || 'not registered yet'],
      ['Reached by', host.tunnel ? 'outbound tunnel (no inbound port on this machine)' : host.endpoint]
    ];
    for (var i = 0; i < rows.length; i++) {
      dl.appendChild(h('dt', null, rows[i][0]));
      dl.appendChild(h('dd', null, rows[i][1]));
    }
  }

  // -------------------------------------------------------------------------- notices
  function noteEl(level, title, body) {
    var n = h('div', 'note ' + (level === 'error' ? 'bad' : level === 'warn' ? 'warn' : ''));
    n.style.margin = '0 0 12px';
    n.appendChild(h('div', 'title', title));
    n.appendChild(h('div', 'body', body));
    return n;
  }
  function renderNotices(notices) {
    var box = document.getElementById('notices');
    clear(box);
    for (var i = 0; i < notices.length; i++) {
      box.appendChild(noteEl(notices[i].level, notices[i].title, notices[i].detail));
    }
  }

  // -------------------------------------------------------------------------- devices
  var STATUS_TAG = {
    ready: ['ok', 'ready'],
    busy: ['busy', 'in use'],
    starting: ['', 'starting'],
    unhealthy: ['bad', 'unhealthy'],
    blocked: ['warn', 'needs attention']
  };

  function deviceEl(d) {
    var card = h('div', 'device');

    var head = h('div', 'head');
    head.appendChild(h('span', 'name', d.model || d.serial));
    var tag = STATUS_TAG[d.status] || ['', d.status];
    head.appendChild(h('span', 'tag ' + tag[0], tag[1]));
    head.appendChild(h('span', 'tag ' + (d.shared ? 'ok' : ''), d.shared ? 'shared' : 'private'));
    var sp = h('span', 'spacer'); sp.style.flex = '1'; head.appendChild(sp);
    head.appendChild(h('span', 'serial', d.serial));
    card.appendChild(head);

    var bits = [];
    if (d.manufacturer) bits.push(d.manufacturer);
    if (d.osVersion) bits.push('Android ' + d.osVersion);
    if (d.adbState) bits.push('adb: ' + d.adbState);
    if (d.localId) bits.push(d.localId);
    if (d.sessions > 0) bits.push(d.sessions + (d.sessions === 1 ? ' live session' : ' live sessions'));
    card.appendChild(h('div', 'meta', bits.join('  \\u00b7  ')));

    if (d.remedy) {
      var r = h('div', 'note warn');
      r.appendChild(h('div', 'title', 'What to do'));
      r.appendChild(h('div', 'body', d.remedy));
      card.appendChild(r);
    }

    if (d.installVerification === 'on' && d.localId) {
      card.appendChild(verificationEl(d));
    }
    if (d.shareable) card.appendChild(shareEl(d));

    return card;
  }

  /**
   * The share decision — ADR-0009 §2.
   *
   * OFF IS THE DEFAULT AND OFF IS SAFE, so the copy leads with what is true right now rather than
   * with what the button does. Somebody who plugged in their own phone should be able to read one
   * line and stop worrying; somebody who meant to share a test device should see one control.
   */
  function shareEl(d) {
    var n = h('div', 'note');
    n.appendChild(h('div', 'title', d.shared ? 'Shared with your team' : 'Not shared'));
    n.appendChild(h('div', 'body', d.shared
      ? 'Anyone in your organisation can run tests on this device from the console. Their apps '
        + 'install here, and what a session installs is removed when it ends.'
      : 'Nothing about this phone is sent anywhere, and nobody can reach it. Plugging it in was '
        + 'not a decision to share it.'));
    var row = h('div', 'actions');
    var btn = h('button', 'btn' + (d.shared ? '' : ' primary'),
      d.shared ? 'Stop sharing' : 'Share this device');
    var note = h('span', 'btn-note', '');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      note.textContent = 'saving\u2026';
      fetch(q('/api/devices/' + encodeURIComponent(d.serial) + '/shared'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shared: !d.shared })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (r.ok) {
          // The agent restarts to re-register. The stream drops and EventSource reconnects on its
          // own, so say what is happening rather than letting the page look broken for a second.
          note.textContent = 'saved \u2014 reconnecting\u2026';
          return;
        }
        btn.disabled = false;
        note.textContent = (r.body && r.body.message) || 'could not save that';
      }).catch(function (e) {
        btn.disabled = false;
        note.textContent = String(e && e.message || e);
      });
    });
    row.appendChild(btn);
    row.appendChild(note);
    n.appendChild(row);
    return n;
  }

  /**
   * The Play Protect offer (M1's other half). Shown BEFORE the phone shows its own dialog, because
   * "Harmful app blocked" arriving 90 seconds into somebody's first test is the moment they stop
   * trusting this. The agent never flips this setting on its own — the button is the consent.
   */
  function verificationEl(d) {
    var n = h('div', 'note warn');
    n.appendChild(h('div', 'title', 'Android will refuse to install test builds on this phone'));
    n.appendChild(h('div', 'body',
      'Play Protect vets every APK pushed over USB and rejects debug-signed builds \\u2014 including '
      + 'the automation helpers \\u2014 so it shows "Harmful app blocked" and no session can run. '
      + 'Turning off adb-install verification for this phone fixes it. It is your phone and your '
      + 'call: the agent changes nothing unless you press this, and puts the setting back exactly '
      + 'as it found it when the agent stops.'));
    var row = h('div', 'actions');
    var btn = h('button', 'btn primary', 'Turn off install verification');
    var note = h('span', 'btn-note', '');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      note.textContent = 'asking the phone\\u2026';
      fetch(q('/api/devices/' + encodeURIComponent(d.localId) + '/install-verification'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (r.ok) { note.textContent = 'done \\u2014 restored when the agent stops'; return; }
        btn.disabled = false;
        note.textContent = (r.body && r.body.message) || 'the phone refused';
      }).catch(function (e) {
        btn.disabled = false;
        note.textContent = String(e && e.message || e);
      });
    });
    row.appendChild(btn);
    row.appendChild(note);
    n.appendChild(row);
    return n;
  }

  function renderDevices(devices) {
    var box = document.getElementById('devices');
    clear(box);
    if (devices.length === 0) {
      var e = h('div', 'empty');
      e.appendChild(h('strong', null, 'No devices yet'));
      e.appendChild(h('div', null,
        'Plug a phone into this machine over USB. It appears here on its own \\u2014 there is '
        + 'nothing to press.'));
      box.appendChild(e);
      return;
    }
    for (var i = 0; i < devices.length; i++) box.appendChild(deviceEl(devices[i]));
  }

  /**
   * The pairing panel — ADR-0014.
   *
   * When it is present it is the ONLY thing worth reading, so everything else on the page is hidden
   * behind it. An unpaired agent showing an empty device list next to a code invites somebody to
   * start debugging the empty list.
   */
  function renderPairing(state) {
    var box = document.getElementById('pair');
    var rest = document.getElementById('rest');
    clear(box);
    var p = state.pairing;
    rest.hidden = Boolean(p);
    if (!p) return;

    var el = h('section', 'pair');
    if (p.status === 'approved') {
      el.appendChild(h('div', 'lead', 'Paired'));
      el.appendChild(h('div', 'sub', 'Connecting to the farm\u2026'));
      box.appendChild(el);
      return;
    }

    el.appendChild(h('div', 'lead', 'Connect this machine to your farm'));
    el.appendChild(h('div', 'sub', 'Type this code into the MFARM console.'));
    el.appendChild(h('div', 'code', p.userCode));

    var mins = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60000));
    el.appendChild(h('div', 'expiry',
      mins > 0 ? 'Expires in about ' + mins + (mins === 1 ? ' minute' : ' minutes')
        + ' \u2014 a new one appears here automatically.'
        : 'Expired \u2014 a new code is on its way.'));

    var steps = h('ol');
    steps.appendChild(h('li', null, 'Open the MFARM console and sign in.'));
    steps.appendChild(h('li', null, 'Go to Agents and choose Pair a machine.'));
    steps.appendChild(h('li', null, 'Enter the code above and confirm this machine.'));
    el.appendChild(steps);

    var waiting = h('div', 'waiting',
      'Waiting for someone to approve it\u2026 this machine is '
      + (state.host.hostname || 'unnamed')
      + (state.agentVersion ? ' \u00b7 agent ' + state.agentVersion : ''));
    el.appendChild(waiting);
    box.appendChild(el);
  }

  function render(state) {
    renderPairing(state);
    renderFacts(state.host);
    renderNotices(state.notices || []);
    renderDevices(state.devices || []);
    document.getElementById('foot').textContent =
      'Served by the agent on this machine at ' + location.host + '. Nothing on this page leaves '
      + 'your computer, and the link only works with the key in its address.';
  }

  // -------------------------------------------------------------------------- live
  if (!TOKEN) {
    conn('lost', 'no key');
    document.getElementById('devices').appendChild(
      noteEl('error', 'This page needs the key the agent put in its link',
        'Open the address the agent printed when it started \\u2014 the part after "?t=" is what '
        + 'proves the request came from you and not from a web page you happen to have open.'));
    return;
  }

  var es = new EventSource(q('/api/events'));
  es.addEventListener('state', function (ev) {
    conn('live', 'live');
    try { render(JSON.parse(ev.data)); } catch (e) { conn('lost', 'bad payload'); }
  });
  es.addEventListener('open', function () { conn('live', 'live'); });
  es.addEventListener('error', function () { conn('lost', 'reconnecting'); });
})();
</script>
</body>
</html>
`;
