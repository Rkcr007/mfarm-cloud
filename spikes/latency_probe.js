// Spike 1 — pipeline lower bound. TUNING ONLY, NOT THE PASS/FAIL NUMBER.
//
// Paste into DevTools on the Cuttlefish WebRTC page while a stream is running.
//
// This measures jitter buffer + decode + paint, which is the part you can tune from the browser.
// It CANNOT see capture delay, encode delay, or display latency, so the real glass-to-glass figure
// is always higher. Use the camera protocol in README.md for the number that decides the spike.

(async () => {
  const pc = window.pc || [...(window.pcs || [])][0];
  if (!pc) return console.error('No RTCPeerConnection found. Set window.pc = <the connection> first.');

  const video = document.querySelector('video');
  if (!video) return console.error('No <video> element found.');

  // --- Lever L2: the single highest-value change in the whole project ---------------------------
  // Chrome defaults playout delay to conference-video settings (40-80 ms) where smoothness beats
  // latency. We want the opposite. Applying it live so you can see the before/after.
  const recv = pc.getReceivers().find(r => r.track && r.track.kind === 'video');
  if (recv) {
    const before = recv.playoutDelayHint;
    try { recv.playoutDelayHint = 0; } catch (e) { console.warn('playoutDelayHint unsupported:', e); }
    try { recv.jitterBufferTarget = 0; } catch (e) { /* newer API, may not exist */ }
    console.log(`playoutDelayHint: ${before} -> ${recv.playoutDelayHint}`);
  }

  const samples = [];
  let lastFrames = 0, lastDelay = 0;

  const poll = setInterval(async () => {
    const stats = await pc.getStats();
    stats.forEach(r => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const frames = r.framesDecoded || 0;
      const delta = frames - lastFrames;
      if (delta > 0) {
        // jitterBufferDelay is cumulative seconds; divide by emitted count for per-frame ms
        const jb = ((r.jitterBufferDelay - lastDelay) / delta) * 1000;
        const dec = (r.totalDecodeTime / frames) * 1000;
        samples.push({ jb, dec, fps: delta, keyframes: r.keyFramesDecoded, drops: r.framesDropped });
        lastDelay = r.jitterBufferDelay;
      }
      lastFrames = frames;
    });
  }, 1000);

  console.log('Sampling for 30s. Interact with the device so the encoder has real work to do.');
  await new Promise(r => setTimeout(r, 30000));
  clearInterval(poll);

  const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * q)]; };
  const jb = samples.map(s => s.jb), dec = samples.map(s => s.dec);

  console.table({
    'jitter buffer (ms)': { p50: p(jb, 0.5)?.toFixed(1), p95: p(jb, 0.95)?.toFixed(1) },
    'decode (ms)':        { p50: p(dec, 0.5)?.toFixed(1), p95: p(dec, 0.95)?.toFixed(1) },
    'fps':                { p50: p(samples.map(s => s.fps), 0.5) },
  });

  const total = p(jb, 0.5) + p(dec, 0.5) + 16; // +16ms for one display refresh
  console.log(`Browser-side lower bound: ~${total.toFixed(0)} ms (jitter + decode + one refresh).`);
  console.log(`Budget for these three lines is 44 ms. Real glass-to-glass will exceed this.`);

  const last = samples[samples.length - 1];
  if (last && last.drops > 0) console.warn(`${last.drops} frames dropped — check bitrate/CPU.`);
  console.log('Now go measure it with a camera. This number cannot pass or fail the spike.');
})();
