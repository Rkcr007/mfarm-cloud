import WebSocket from 'ws';
const [url, out, w, h, scrollTo] = process.argv.slice(2);
const t = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res, rej) => { const n = ++id; pend.set(n, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 2500));
if (scrollTo) {
  await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scrollTo})` });
  await new Promise((r) => setTimeout(r, 700));
}
const { data } = await send('Page.captureScreenshot', { format: 'png' });
const { writeFile } = await import('node:fs/promises');
await writeFile(out, Buffer.from(data, 'base64'));
console.log(out.split('/').pop()); ws.close();
