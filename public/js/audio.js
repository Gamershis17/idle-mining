// Idle Mining — procedural WebAudio: pickaxe clinks + grove ambience (water + wind).
const Audio8 = (() => {
  let ctx = null;
  let master = null;
  let ambience = null; // { nodes to stop }
  let muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noiseBuffer(sec = 2) {
    const c = ensure();
    const buf = c.createBuffer(1, c.sampleRate * sec, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02; // pinkish
      d[i] = last * 3.2;
    }
    return buf;
  }

  // Short metallic pickaxe clink, slightly randomized.
  function clink() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const base = 1900 + Math.random() * 900;
    [1, 2.76, 5.4].forEach((m, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = base * m;
      g.gain.setValueAtTime(0.22 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + i * 0.03);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.3);
    });
    // strike noise tick
    const n = c.createBufferSource();
    n.buffer = noiseBuffer(0.1);
    const nf = c.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 4000;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(nf).connect(ng).connect(master);
    n.start(t);
    n.stop(t + 0.1);
  }

  function coin() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.setValueAtTime(1318, t + 0.07);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.3);
  }

  // Grove ambience: water burbles + wind through leaves. Generative, looped.
  function startAmbience() {
    const c = ensure();
    if (!c || ambience) return;
    const t = c.currentTime;

    const out = c.createGain();
    out.gain.value = 0;
    out.connect(master);
    out.gain.linearRampToValueAtTime(0.5, t + 3);

    // water: lowpassed noise with slow burble LFO
    const water = c.createBufferSource();
    water.buffer = noiseBuffer(4);
    water.loop = true;
    const wf = c.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 420;
    const wg = c.createGain();
    wg.gain.value = 0.16;
    const wlfo = c.createOscillator();
    wlfo.frequency.value = 0.23;
    const wlg = c.createGain();
    wlg.gain.value = 0.07;
    wlfo.connect(wlg).connect(wg.gain);
    water.connect(wf).connect(wg).connect(out);
    water.start();
    wlfo.start();

    // wind: bandpassed noise with slow swells
    const wind = c.createBufferSource();
    wind.buffer = noiseBuffer(4);
    wind.loop = true;
    wind.playbackRate.value = 0.6;
    const bf = c.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 700;
    bf.Q.value = 0.6;
    const bg = c.createGain();
    bg.gain.value = 0.05;
    const blfo = c.createOscillator();
    blfo.frequency.value = 0.09;
    const blg = c.createGain();
    blg.gain.value = 0.045;
    blfo.connect(blg).connect(bg.gain);
    wind.connect(bf).connect(bg).connect(out);
    wind.start();
    blfo.start();

    // occasional leaf rustle: short filtered noise puffs on a timer
    const rustleTimer = setInterval(() => {
      if (!ctx || muted) return;
      const tt = ctx.currentTime;
      const r = ctx.createBufferSource();
      r.buffer = noiseBuffer(0.5);
      const rf = ctx.createBiquadFilter();
      rf.type = 'bandpass';
      rf.frequency.value = 2500 + Math.random() * 2000;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.0, tt);
      rg.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, tt + 0.15);
      rg.gain.linearRampToValueAtTime(0.0, tt + 0.5);
      r.connect(rf).connect(rg).connect(master);
      r.start(tt);
      r.stop(tt + 0.6);
    }, 3800);

    ambience = { out, stop() {
      clearInterval(rustleTimer);
      try {
        out.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
        setTimeout(() => { water.stop(); wind.stop(); wlfo.stop(); blfo.stop(); out.disconnect(); }, 1200);
      } catch (e) { /* already stopped */ }
    } };
  }

  function stopAmbience() {
    if (ambience) { ambience.stop(); ambience = null; }
  }

  function setMuted(m) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
  }
  function isMuted() { return muted; }

  return { ensure, clink, coin, startAmbience, stopAmbience, setMuted, isMuted };
})();
