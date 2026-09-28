// Idle Mining — server: auth, server-side saves, leaderboard.
// Requires DATABASE_URL in production. Local dev (NODE_ENV != production)
// may run without it using a volatile in-memory store.

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

if (PROD && !DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required in production. Refusing to start with a volatile store.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is required. Set it to a long random string.');
  process.exit(1);
}

// ---------------- storage ----------------
let pgPool = null;
const memUsers = new Map(); // lower(username) -> { id, username, passhash }
const memSaves = new Map(); // userId -> { state, updatedAt }
let nextMemId = 1;

async function initDb() {
  if (!DATABASE_URL) {
    console.warn('WARN: no DATABASE_URL — using VOLATILE in-memory storage (dev only, data is lost on restart).');
    return;
  }
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username CITEXT UNIQUE NOT NULL,
      passhash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Postgres storage ready.');
}

async function findUser(username) {
  if (pgPool) {
    const r = await pgPool.query('SELECT id, username, passhash FROM users WHERE username = $1', [username]);
    return r.rows[0] || null;
  }
  return memUsers.get(String(username).toLowerCase()) || null;
}

async function createUser(username, passhash) {
  if (pgPool) {
    const r = await pgPool.query('INSERT INTO users (username, passhash) VALUES ($1, $2) RETURNING id, username', [
      username,
      passhash,
    ]);
    return r.rows[0];
  }
  const u = { id: nextMemId++, username, passhash };
  memUsers.set(username.toLowerCase(), u);
  return u;
}

async function loadSave(userId) {
  if (pgPool) {
    const r = await pgPool.query('SELECT state, updated_at AS "updatedAt" FROM saves WHERE user_id = $1', [userId]);
    return r.rows[0] || null;
  }
  return memSaves.get(userId) || null;
}

async function storeSave(userId, state) {
  const now = new Date().toISOString();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO saves (user_id, state, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [userId, JSON.stringify(state)]
    );
    return now;
  }
  memSaves.set(userId, { state, updatedAt: now });
  return now;
}

async function leaderboard(limit) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT u.username,
              COALESCE((s.state->>'totalOre')::double precision, 0) AS "totalOre",
              COALESCE((s.state->>'layer')::int, 0) AS layer,
              COALESCE((s.state->>'pickaxeTier')::int, 0) AS "pickaxeTier",
              s.updated_at AS "updatedAt"
       FROM users u JOIN saves s ON s.user_id = u.id
       ORDER BY "totalOre" DESC LIMIT $1`,
      [limit]
    );
    return r.rows;
  }
  return [...memSaves.entries()]
    .map(([uid, s]) => {
      const u = [...memUsers.values()].find((x) => x.id === uid);
      return {
        username: u ? u.username : '?',
        totalOre: s.state.totalOre || 0,
        layer: s.state.layer || 0,
        pickaxeTier: s.state.pickaxeTier || 0,
        updatedAt: s.updatedAt,
      };
    })
    .sort((a, b) => b.totalOre - a.totalOre)
    .slice(0, limit);
}

// ---------------- save validation (light anti-cheat) ----------------
const NUM_FIELDS = ['ore', 'totalOre', 'perStrike', 'perSecond', 'strikes', 'depth'];
const CAPS = { ore: 1e15, totalOre: 1e18, perStrike: 1e12, perSecond: 1e12, strikes: 1e12, depth: 1e9 };
function validSave(s) {
  if (!s || typeof s !== 'object') return false;
  for (const f of NUM_FIELDS) {
    const v = s[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > CAPS[f]) return false;
  }
  if (typeof s.layer !== 'number' || s.layer < 0 || s.layer > 50) return false;
  if (typeof s.pickaxeTier !== 'number' || s.pickaxeTier < 0 || s.pickaxeTier > 10) return false;
  if (s.equipment && typeof s.equipment === 'object') {
    for (const c of Object.values(s.equipment)) {
      if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1e6) return false;
    }
  }
  return true;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

// ---------------- boot ----------------
(async () => {
  await initDb();

  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '200kb' }));

  let store;
  if (pgPool) {
    const PgStore = require('connect-pg-simple')(session);
    store = new PgStore({ pool: pgPool, createTableIfMissing: true });
  }
  app.use(
    session({
      store,
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: PROD },
    })
  );

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
  const saveLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

  // ---- API ----
  app.post('/api/register', authLimiter, async (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(username))
        return res.status(400).json({ error: 'Username must be 3-16 chars: letters, numbers, _.' });
      if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      if (await findUser(username)) return res.status(409).json({ error: 'That name is taken.' });
      const passhash = await bcrypt.hash(password, 10);
      const u = await createUser(username, passhash);
      req.session.userId = u.id;
      req.session.username = u.username;
      res.json({ ok: true, username: u.username });
    } catch (e) {
      console.error('register', e.message);
      res.status(500).json({ error: 'Could not register right now.' });
    }
  });

  app.post('/api/login', authLimiter, async (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const u = await findUser(username);
      if (!u || !(await bcrypt.compare(password, u.passhash)))
        return res.status(401).json({ error: 'Wrong name or password.' });
      req.session.userId = u.id;
      req.session.username = u.username;
      res.json({ ok: true, username: u.username });
    } catch (e) {
      console.error('login', e.message);
      res.status(500).json({ error: 'Could not log in right now.' });
    }
  });

  app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

  app.get('/api/me', (req, res) => {
    res.json({ user: req.session.userId ? { username: req.session.username } : null });
  });

  app.get('/api/load', requireAuth, async (req, res) => {
    try {
      const row = await loadSave(req.session.userId);
      res.json({ ok: true, state: row ? row.state : null, updatedAt: row ? row.updatedAt : null });
    } catch (e) {
      console.error('load', e.message);
      res.status(500).json({ error: 'Could not load save.' });
    }
  });

  app.post('/api/save', requireAuth, saveLimiter, async (req, res) => {
    try {
      const state = req.body.state;
      if (!validSave(state)) return res.status(422).json({ error: 'Save rejected: impossible values.' });
      const updatedAt = await storeSave(req.session.userId, state);
      res.json({ ok: true, updatedAt });
    } catch (e) {
      console.error('save', e.message);
      res.status(500).json({ error: 'Could not save.' });
    }
  });

  app.get('/api/leaderboard', async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      res.json({ entries: await leaderboard(limit) });
    } catch (e) {
      console.error('leaderboard', e.message);
      res.status(500).json({ error: 'Could not load leaderboard.' });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({ ok: true, maintenance: false, storage: pgPool ? 'postgres' : 'memory', message: null });
  });

  app.get('/api/changelog', (req, res) => {
    res.json({
      ok: true,
      log: [
        {
          date: '2026-09-28',
          title: 'Launch',
          changes: [
            'Dark idle mining: tap & hold the rock, upgrade equipment, descend through mine layers',
            'Pickaxe evolves: Embersteel → Frostbite → Dragonfire',
            'Mine Shaft tab tracks your depth; Sunset Grove tab for relaxing with birds, water & wind ambience',
            'Offline earnings up to 8 hours with a welcome-back popup',
          ],
        },
      ],
    });
  });

  // ---- static client ----
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`Idle Mining listening on :${PORT} (${PROD ? 'prod' : 'dev'})`));
})().catch((e) => {
  console.error('Boot failed:', e);
  process.exit(1);
});
