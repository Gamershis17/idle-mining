// Idle Mining — game client.
(() => {
'use strict';

// ---------------- config ----------------
const LAYERS = [
  { name: 'Coal Hollow', at: 0 },
  { name: 'Iron Grotto', at: 250 },
  { name: 'Gold Deep', at: 2500 },
  { name: 'Crystal Cavern', at: 25000 },
  { name: 'Ember Core', at: 250000 },
  { name: 'Void Seam', at: 2500000 },
];
const PICKS = [
  { name: 'Embersteel Pick', img: 'assets/pickaxe-ember.png', at: 0 },
  { name: 'Frostbite Pick', img: 'assets/pickaxe-frost.png', at: 2000 },
  { name: 'Dragonfire Pick', img: 'assets/pickaxe-dragonfire.png', at: 50000 },
];
const EQUIP = [
  { id: 'pick', ico: '⛏️', name: 'Steel Pick', desc: '+1 ore per strike', base: 15, growth: 1.7, ps: 1, psec: 0 },
  { id: 'cart', ico: '🛒', name: 'Ore Cart', desc: '+2 ore per second', base: 100, growth: 1.7, ps: 0, psec: 2 },
  { id: 'drill', ico: '⚙️', name: 'Steam Drill', desc: '+12 ore per second', base: 1100, growth: 1.75, ps: 0, psec: 12 },
  { id: 'shaft', ico: '🕳️', name: 'Deep Shaft', desc: '+50 ore per second', base: 12000, growth: 1.8, ps: 0, psec: 50 },
];
const HITS_PER_ROCK = 15;
const OFFLINE_CAP = 8 * 3600; // seconds
const GUEST_KEY = 'idleMiningGuest';

// ---------------- helpers ----------------
const $ = (id) => document.getElementById(id);
function fmt(n) {
  n = Math.floor(n);
  if (n < 1000) return String(n);
  const units = ['K', 'M', 'B', 'T', 'Q'];
  let u = -1;
  let v = n;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + units[u];
}
let toastT = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}
async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---------------- state ----------------
function freshState() {
  return {
    ore: 0, totalOre: 0, perStrike: 1, perSecond: 0,
    strikes: 0, depth: 0, layer: 0, pickaxeTier: 0,
    equipment: { pick: 0, cart: 0, drill: 0, shaft: 0 },
    muted: false, groveEarned: 0, savedAt: Date.now(),
  };
}
let S = freshState();
let username = null;
let isGuest = false;
let rockHits = 0;
let groveSessionEarned = 0;
let activeTab = 'mine';

function layerIndex(total) {
  let li = 0;
  LAYERS.forEach((l, i) => { if (total >= l.at) li = i; });
  return li;
}
function pickIndex(total) {
  let pi = 0;
  PICKS.forEach((p, i) => { if (total >= p.at) pi = i; });
  return pi;
}
function eqCost(e) {
  const owned = S.equipment[e.id] || 0;
  return Math.floor(e.base * Math.pow(e.growth, owned));
}
function recalc() {
  const li = layerIndex(S.totalOre);
  const mult = 1 + li * 0.5;
  S.layer = li;
  S.perStrike = (1 + (S.equipment.pick || 0) * 1) * mult;
  S.perSecond = ((S.equipment.cart || 0) * 2 + (S.equipment.drill || 0) * 12 + (S.equipment.shaft || 0) * 50) * mult;
  S.depth = Math.floor(S.totalOre / 5);
  const pi = pickIndex(S.totalOre);
  if (pi !== S.pickaxeTier) {
    S.pickaxeTier = pi;
    $('pickaxe').src = PICKS[pi].img;
    $('pickaxe').dataset.tier = pi;
    $('pick-name').textContent = PICKS[pi].name;
    toast('⛏️ New pickaxe: ' + PICKS[pi].name + '!');
    Audio8.coin();
  }
}

// ---------------- rendering ----------------
function renderStats() {
  $('st-ore').textContent = fmt(S.ore);
  $('st-ps').textContent = fmt(S.perSecond);
  $('st-pstr').textContent = fmt(S.perStrike);
  $('layer-name').textContent = LAYERS[S.layer].name;
  $('depth-m').textContent = fmt(S.depth);
  const li = S.layer;
  const next = LAYERS[li + 1];
  if (next) {
    $('next-layer').textContent = next.name + ' (' + fmt(next.at) + ' total ore)';
    const prog = Math.min(1, (S.totalOre - LAYERS[li].at) / (next.at - LAYERS[li].at));
    $('layer-bar').style.width = (prog * 100).toFixed(1) + '%';
  } else {
    $('next-layer').textContent = 'Max depth reached!';
    $('layer-bar').style.width = '100%';
  }
  $('grove-earned').textContent = fmt(groveSessionEarned);
}
function renderEquip() {
  const el = $('eq-list');
  el.innerHTML = '';
  EQUIP.forEach((e) => {
    const cost = eqCost(e);
    const owned = S.equipment[e.id] || 0;
    const row = document.createElement('div');
    row.className = 'eq';
    row.innerHTML =
      '<div class="ico">' + e.ico + '</div>' +
      '<div class="meta"><div class="n">' + e.name + ' <span class="owned">×' + owned + '</span></div>' +
      '<div class="d">' + e.desc + '</div></div>';
    const b = document.createElement('button');
    b.className = 'buy';
    b.textContent = fmt(cost) + ' ore';
    b.disabled = S.ore < cost;
    b.onclick = () => buyEquip(e);
    row.appendChild(b);
    el.appendChild(row);
  });
}
function renderLayers() {
  const el = $('layer-list');
  el.innerHTML = '';
  LAYERS.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'lrow';
    d.innerHTML = '<span class="rk">' + (i <= S.layer ? '✅' : '🔒') + ' ' + l.name + '</span><span>' + fmt(l.at) + '+ ore</span>';
    el.appendChild(d);
  });
}
function renderLog() {
  const rows = [
    ['Total ore mined', fmt(S.totalOre)],
    ['Pickaxe strikes', fmt(S.strikes)],
    ['Depth', fmt(S.depth) + ' m'],
    ['Current layer', LAYERS[S.layer].name],
    ['Pickaxe', PICKS[S.pickaxeTier].name],
    ['Equipment', EQUIP.map((e) => e.ico + '×' + (S.equipment[e.id] || 0)).join(' ')],
  ];
  $('log-list').innerHTML = rows.map((r) => '<div class="lrow"><span class="rk">' + r[0] + '</span><span>' + r[1] + '</span></div>').join('');
}
async function renderLeaderboard() {
  try {
    const j = await api('/api/leaderboard?limit=20');
    if (!j.entries.length) { $('lb-list').innerHTML = '<div style="color:var(--dim);font-size:14px">No miners yet. Be the first!</div>'; return; }
    $('lb-list').innerHTML = j.entries.map((e, i) =>
      '<div class="lb-row"><span class="pos">' + (i + 1) + '</span><span style="flex:1;font-weight:700">' + escapeHtml(e.username) +
      '</span><span style="color:var(--dim);font-size:12px">' + escapeHtml(LAYERS[Math.min(e.layer, LAYERS.length - 1)].name) +
      '</span><span style="color:var(--gold);font-weight:800">' + fmt(e.totalOre) + '</span></div>'
    ).join('');
  } catch (e) {
    $('lb-list').innerHTML = '<div style="color:var(--dim);font-size:14px">Could not load leaderboard.</div>';
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------- mining ----------------
function floater(x, y, text) {
  const scene = $('mine-scene');
  const r = scene.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'floater';
  f.textContent = text;
  f.style.left = (x - r.left - 10) + 'px';
  f.style.top = (y - r.top - 10) + 'px';
  scene.appendChild(f);
  setTimeout(() => f.remove(), 950);
}
function burst(x, y) {
  const scene = $('mine-scene');
  const r = scene.getBoundingClientRect();
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div');
    b.className = 'burst';
    const a = Math.random() * Math.PI * 2;
    const d = 40 + Math.random() * 70;
    b.style.setProperty('--dx', Math.cos(a) * d + 'px');
    b.style.setProperty('--dy', Math.sin(a) * d + 'px');
    b.style.left = (x - r.left) + 'px';
    b.style.top = (y - r.top) + 'px';
    scene.appendChild(b);
    setTimeout(() => b.remove(), 650);
  }
}
function swingPick() {
  const p = $('pickaxe');
  p.classList.remove('swing');
  void p.offsetWidth;
  p.classList.add('swing');
}
function updateCracks() {
  const rock = $('rock');
  rock.classList.remove('c1', 'c2', 'c3');
  if (rockHits >= 13) rock.classList.add('c3');
  else if (rockHits >= 9) rock.classList.add('c2');
  else if (rockHits >= 5) rock.classList.add('c1');
}
function strike(x, y) {
  recalc();
  const gain = S.perStrike;
  S.ore += gain;
  S.totalOre += gain;
  S.strikes++;
  rockHits++;
  swingPick();
  Audio8.clink();
  floater(x, y, '+' + fmt(gain));
  const wrap = $('rock-wrap');
  wrap.classList.remove('shake');
  void wrap.offsetWidth;
  wrap.classList.add('shake');
  if (rockHits >= HITS_PER_ROCK) {
    const bonus = gain * 5;
    S.ore += bonus;
    S.totalOre += bonus;
    burst(x, y);
    floater(x, y - 40, '💥 +' + fmt(bonus));
    rockHits = 0;
  }
  updateCracks();
  recalc();
  renderStats();
}
function buyEquip(e) {
  const cost = eqCost(e);
  if (S.ore < cost) return;
  S.ore -= cost;
  S.equipment[e.id] = (S.equipment[e.id] || 0) + 1;
  recalc();
  Audio8.coin();
  renderEquip();
  renderStats();
  scheduleSave();
}

// hold-to-mine
let holdTimer = null;
function bindMining() {
  const scene = $('mine-scene');
  const start = (ev) => {
    Audio8.ensure();
    strike(ev.clientX, ev.clientY);
    clearInterval(holdTimer);
    holdTimer = setInterval(() => {
      const r = $('rock-wrap').getBoundingClientRect();
      strike(r.left + r.width / 2 + (Math.random() * 40 - 20), r.top + r.height / 2);
    }, 200);
  };
  const stop = () => clearInterval(holdTimer);
  scene.addEventListener('pointerdown', start);
  scene.addEventListener('pointerup', stop);
  scene.addEventListener('pointerleave', stop);
  scene.addEventListener('pointercancel', stop);
  scene.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------- tabs ----------------
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'grove') { startGrove(); if (!Audio8.isMuted()) Audio8.startAmbience(); }
  else { stopGrove(); Audio8.stopAmbience(); }
  if (name === 'stats') { renderLog(); renderLayers(); renderLeaderboard(); }
  if (name === 'shaft') renderLayers();
}

// ---------------- grove canvas ----------------
let groveRAF = null;
let birds = [], leaves = [], flies = [];
let lastBird = 0;
function startGrove() {
  const cv = $('grove-canvas');
  const scene = $('grove-scene');
  const W = cv.width = scene.clientWidth;
  const H = cv.height = scene.clientHeight;
  birds = []; leaves = [];
  flies = Array.from({ length: 14 }, () => ({
    x: Math.random() * W, y: H * 0.35 + Math.random() * H * 0.6,
    p: Math.random() * 10, s: 0.3 + Math.random() * 0.7,
  }));
  stopGrove();
  let last = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, W, H);
    // birds
    if (t - lastBird > 3500) { lastBird = t; birds.push({ x: -30, y: 20 + Math.random() * H * 0.3, v: 40 + Math.random() * 40, p: Math.random() * 10 }); }
    birds = birds.filter((b) => b.x < W + 40);
    c.strokeStyle = 'rgba(20,12,20,0.85)';
    c.lineWidth = 2.5;
    birds.forEach((b) => {
      b.x += b.v * dt; b.p += dt * 8;
      const f = Math.sin(b.p) * 6;
      c.beginPath();
      c.moveTo(b.x - 10, b.y);
      c.quadraticCurveTo(b.x - 4, b.y - 5 - f, b.x, b.y);
      c.quadraticCurveTo(b.x + 4, b.y - 5 - f, b.x + 10, b.y);
      c.stroke();
    });
    // leaves 🍃
    if (Math.random() < 0.06) leaves.push({ x: Math.random() * W, y: -10, vy: 25 + Math.random() * 30, p: Math.random() * 10, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 3 });
    leaves = leaves.filter((l) => l.y < H + 20);
    leaves.forEach((l) => {
      l.y += l.vy * dt; l.p += dt * 2; l.r += l.vr * dt;
      l.x += Math.sin(l.p) * 30 * dt;
      c.save();
      c.translate(l.x, l.y);
      c.rotate(l.r);
      c.fillStyle = 'rgba(110,180,90,0.85)';
      c.beginPath();
      c.ellipse(0, 0, 7, 4, 0, 0, 6.29);
      c.fill();
      c.restore();
    });
    // fireflies
    flies.forEach((f) => {
      f.p += dt * f.s;
      f.x += Math.sin(f.p * 0.7) * 12 * dt;
      f.y += Math.cos(f.p * 0.5) * 10 * dt;
      const a = 0.35 + 0.65 * Math.abs(Math.sin(f.p * 2));
      c.fillStyle = 'rgba(255,240,160,' + a.toFixed(2) + ')';
      c.beginPath();
      c.arc(f.x, f.y, 2.2, 0, 6.29);
      c.fill();
    });
    groveRAF = requestAnimationFrame(loop);
  };
  groveRAF = requestAnimationFrame(loop);
}
function stopGrove() {
  if (groveRAF) cancelAnimationFrame(groveRAF);
  groveRAF = null;
}

// ---------------- saving ----------------
function setSaveInd(txt) { $('save-ind').textContent = txt; }
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 1500);
}
async function saveNow(keepalive) {
  S.savedAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(S));
  if (isGuest) {
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify({ username, state: snapshot }));
      setSaveInd('● saved locally');
    } catch (e) { setSaveInd('● local save failed'); }
    return;
  }
  setSaveInd('… saving');
  try {
    await api('/api/save', { method: 'POST', body: JSON.stringify({ state: snapshot }), keepalive: !!keepalive });
    setSaveInd('● saved');
  } catch (e) {
    setSaveInd('● save failed');
  }
}

// ---------------- auth ----------------
function showAuth() { $('auth-veil').classList.remove('hidden'); }
function hideAuth() { $('auth-veil').classList.add('hidden'); }
function authError(m) { $('auth-err').textContent = m || ''; }

async function afterAuth(name, guest) {
  username = name;
  isGuest = guest;
  hideAuth();
  authError('');
  $('acct-line').textContent = guest ? 'Playing as Guest (saves on this device only)' : 'Signed in as ' + name;
  await loadGame();
  bootLoops();
}

async function loadGame() {
  let loaded = null;
  if (isGuest) {
    try {
      const g = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null');
      if (g && g.state) loaded = g.state;
    } catch (e) { /* fresh */ }
  } else {
    try {
      const j = await api('/api/load');
      if (j.state) loaded = j.state;
    } catch (e) { toast('Could not load cloud save — starting fresh.'); }
  }
  if (loaded) {
    S = Object.assign(freshState(), loaded);
    // offline earnings
    const elapsed = Math.min(OFFLINE_CAP, Math.max(0, (Date.now() - (S.savedAt || Date.now())) / 1000));
    const earned = Math.floor((S.perSecond || 0) * elapsed);
    if (earned >= 1) {
      S.ore += earned;
      S.totalOre += earned;
      $('wb-amount').textContent = fmt(earned);
      $('wb-veil').classList.remove('hidden');
    }
  }
  Audio8.setMuted(!!S.muted);
  $('mute-btn').textContent = S.muted ? '🔇' : '🔊';
  recalc();
  $('pickaxe').src = PICKS[S.pickaxeTier].img;
  $('pickaxe').dataset.tier = S.pickaxeTier;
  $('pick-name').textContent = PICKS[S.pickaxeTier].name;
  renderEquip();
  renderLayers();
  renderStats();
  setSaveInd(isGuest ? '● guest' : '● saved');
}

// ---------------- main loops ----------------
let booted = false;
function bootLoops() {
  if (booted) return;
  booted = true;
  setInterval(() => {
    if (S.perSecond > 0) {
      const gain = S.perSecond * 0.1;
      S.ore += gain;
      S.totalOre += gain;
      if (activeTab === 'grove') groveSessionEarned += gain;
    }
    renderStats();
  }, 100);
  setInterval(() => { renderEquip(); }, 1000);
  setInterval(() => { recalc(); renderStats(); }, 5000);
  setInterval(() => saveNow(), 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(true); });
  window.addEventListener('beforeunload', () => saveNow(true));
  window.addEventListener('pagehide', () => saveNow(true));
}

// ---------------- wire up ----------------
function init() {
  bindMining();
  document.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
  $('mute-btn').onclick = () => {
    const m = !Audio8.isMuted();
    Audio8.setMuted(m);
    S.muted = m;
    $('mute-btn').textContent = m ? '🔇' : '🔊';
    if (!m && activeTab === 'grove') Audio8.startAmbience();
    if (m) Audio8.stopAmbience();
    scheduleSave();
  };
  $('wb-ok').onclick = () => { $('wb-veil').classList.add('hidden'); Audio8.coin(); saveNow(); };
  $('logout-btn').onclick = async () => {
    await saveNow();
    if (!isGuest) { try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ } }
    location.reload();
  };

  $('login-btn').onclick = async () => {
    const u = $('auth-user').value.trim();
    const p = $('auth-pass').value;
    authError('');
    try {
      const j = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      afterAuth(j.username, false);
    } catch (e) { authError(e.message); }
  };
  $('register-btn').onclick = async () => {
    const u = $('auth-user').value.trim();
    const p = $('auth-pass').value;
    authError('');
    try {
      const j = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      afterAuth(j.username, false);
    } catch (e) { authError(e.message); }
  };
  $('guest-btn').onclick = () => afterAuth('Guest', true);

  // boot: already signed in?
  api('/api/me').then((j) => {
    if (j.user) afterAuth(j.user.username, false);
    else showAuth();
  }).catch(() => showAuth());
}

document.addEventListener('DOMContentLoaded', init);
})();
