// =======================
// server.js (ESM / Node)
// =======================
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
const { Pool } = pg;

// -------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-secret'));
app.use(express.static('public'));

app.get('/', (_req, res) => res.redirect('/admin.html'));

const PORT = process.env.PORT ?? 3000;

// =========================================================
// PostgreSQL
// =========================================================
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('[DB] Falta DATABASE_URL. Auth/CRUD no funcionarán sin DB.');
}
const hasDB = !!DATABASE_URL;
const db = hasDB
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const requireDB = (res) => {
  if (!hasDB || !db) {
    res.status(503).json({ error: 'DB no configurada' });
    return false;
  }
  return true;
};

// =========================================================
// Config / Constantes (partidos)
// =========================================================
const MATCH_STAGES = [
  'Amistoso',
  'Fase de grupos',
  '32vos de final',
  '16vos de final',
  '8vos de final',
  '4tos de final',
  'Semi-Final',
  'Final',
];

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
ensureDir(UPLOADS_DIR);

// =========================================================
// Subidas (Multer) - Publicidad
// =========================================================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
const storage = multer.diskStorage({
  destination: function (req, _file, cb) {
    const matchId = req.params.id ?? req.body.matchId;
    const dest = path.join(UPLOADS_DIR, matchId);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_\-]/g, '');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
});

// =========================================================
// Estado en memoria (partidos)
// =========================================================
/** @type {Map<string, any>} */ const matches = new Map();
/** @type {Map<string, any>} */ const matchesHistory = new Map();

// =========================================================
// Utilidades (partidos)
// =========================================================
function generateId() {
  return Math.random().toString(36).slice(2, 8);
}
function newSet() {
  return { gamesA: 0, gamesB: 0, tieBreak: { active: false, pointsA: 0, pointsB: 0 } };
}
function nowMs() {
  return Date.now();
}
function touchUpdated(match) {
  match.updatedAt = nowMs();
}
function isFinished(match) {
  return match.status === 'finished';
}
function gamesNeededToWinSetWithTB(tieBreakAt) {
  return tieBreakAt === '5-5' ? 6 : 7;
}
function currentSet(match) {
  return match.sets[match.sets.length - 1];
}
function checkActivateTieBreak(match, set) {
  const { tieBreakAt } = match.rules;
  if (tieBreakAt === 'none') return;
  if (!set.tieBreak.active) {
    if (tieBreakAt === '6-6' && set.gamesA === 6 && set.gamesB === 6) {
      set.tieBreak.active = true;
      set.tieBreak.pointsA = 0;
      set.tieBreak.pointsB = 0;
    }
    if (tieBreakAt === '5-5' && set.gamesA === 5 && set.gamesB === 5) {
      set.tieBreak.active = true;
      set.tieBreak.pointsA = 0;
      set.tieBreak.pointsB = 0;
    }
  }
}
function moveToHistory(match) {
  if (match.running) {
    const endNow = nowMs();
    const refStart = match.startedAt ?? endNow;
    match.accumulatedMs += endNow - refStart;
  }
  match.running = false;
  match.status = 'finished';
  match.pausedAt = null;
  match.endedAt = nowMs();
  touchUpdated(match);
  matches.delete(match.id);
  matchesHistory.set(match.id, match);
  io.to(match.id).emit('state', formatState(match));
  io.to(match.id).emit('finished', { id: match.id });
}
function awardSet(match, winner, viaTB = false) {
  if (winner === 'A') match.setsWonA++;
  else match.setsWonB++;
  const set = currentSet(match);
  const { tieBreakAt } = match.rules;
  if (viaTB) {
    if (winner === 'A') {
      set.gamesA = gamesNeededToWinSetWithTB(tieBreakAt);
      set.gamesB = tieBreakAt === '5-5' ? 5 : 6;
    } else {
      set.gamesB = gamesNeededToWinSetWithTB(tieBreakAt);
      set.gamesA = tieBreakAt === '5-5' ? 5 : 6;
    }
    set.tieBreak.active = false;
  }
  const setsToWin = Math.ceil(match.rules.bestOf / 2);
  if (match.setsWonA >= setsToWin || match.setsWonB >= setsToWin) {
    moveToHistory(match);
    return;
  }
  match.sets.push(newSet());
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;
  touchUpdated(match);
}
function awardGame(match, winner) {
  const set = currentSet(match);
  if (winner === 'A') set.gamesA++;
  else set.gamesB++;
  match.currentGame = { pointsA: 0, pointsB: 0, advantage: null };
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;
  checkActivateTieBreak(match, set);
  if (!set.tieBreak.active) {
    const gA = set.gamesA, gB = set.gamesB;
    if ((gA >= 6 || gB >= 6) && Math.abs(gA - gB) >= 2) {
      awardSet(match, gA > gB ? 'A' : 'B');
      return;
    }
  }
  touchUpdated(match);
}
function awardPointInTieBreak(match, side) {
  const set = currentSet(match);
  const tb = set.tieBreak;
  const target = match.rules.tieBreakPoints;
  if (side === 'A') tb.pointsA++;
  else tb.pointsB++;
  const pA = tb.pointsA, pB = tb.pointsB;
  if ((pA >= target || pB >= target) && Math.abs(pA - pB) >= 2) {
    awardSet(match, pA > pB ? 'A' : 'B', true);
    return;
  }
  touchUpdated(match);
}
function awardPointInRegularGame(match, side) {
  const { noAdvantage } = match.rules;
  const g = match.currentGame;
  if (noAdvantage) {
    if (side === 'A') g.pointsA++;
    else g.pointsB++;
    if (g.pointsA >= 4 || g.pointsB >= 4) {
      awardGame(match, g.pointsA > g.pointsB ? 'A' : 'B');
      return;
    }
    touchUpdated(match);
    return;
  }
  if (g.pointsA === 3 && g.pointsB === 3) {
    if (g.advantage === null) g.advantage = side;
    else if (g.advantage === side) {
      awardGame(match, side);
      return;
    } else g.advantage = null;
    touchUpdated(match);
    return;
  }
  if (side === 'A') {
    g.pointsA++;
    if (g.pointsA > 3) {
      awardGame(match, 'A');
      return;
    }
  } else {
    g.pointsB++;
    if (g.pointsB > 3) {
      awardGame(match, 'B');
      return;
    }
  }
  touchUpdated(match);
}
function addPoint(match, side) {
  if (isFinished(match)) return;
  const set = currentSet(match);
  if (set.tieBreak.active) awardPointInTieBreak(match, side);
  else awardPointInRegularGame(match, side);
}
function createMatch({ name, teamA, teamB, rules, firstServerIndex = 0, stage, courtName }) {
  const id = generateId();
  const created = nowMs();
  const match = {
    id,
    name,
    stage: MATCH_STAGES.includes(stage) ? stage : 'Amistoso',
    courtName: (courtName ?? '').trim(),
    createdAt: created,
    updatedAt: created,
    endedAt: null,
    startedAt: null,
    pausedAt: null,
    accumulatedMs: 0,
    running: false,
    status: 'scheduled',
    rules: {
      bestOf: rules.bestOf ?? 3,
      tieBreakAt: rules.tieBreakAt ?? '6-6',
      tieBreakPoints: rules.tieBreakPoints ?? 7,
      noAdvantage: rules.noAdvantage ?? false,
    },
    teams: [{ name: teamA ?? 'Equipo A' }, { name: teamB ?? 'Equipo B' }],
    serverIndex: firstServerIndex,
    sets: [newSet()],
    setsWonA: 0,
    setsWonB: 0,
    currentGame: { pointsA: 0, pointsB: 0, advantage: null },
    ads: [],
  };
  matches.set(id, match);
  return match;
}
function formatState(match) {
  return match;
}

// =========================================================
// Helpers Ads (archivos)
// =========================================================
function publicUrlForFile(matchId, filename) {
  return `/uploads/${matchId}/${filename}`;
}
function safeFilenameFromUrl(matchId, publicUrl) {
  const prefix = `/uploads/${matchId}/`;
  if (!publicUrl || !publicUrl.startsWith(prefix)) return null;
  const name = publicUrl.slice(prefix.length);
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  return name;
}
app.get('/uploads/:matchId/:filename', (req, res) => {
  try {
    const { matchId, filename } = req.params;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Bad request');
    }
    const abs = path.join(UPLOADS_DIR, matchId, filename);
    if (!fs.existsSync(abs)) return res.status(404).send('Not found');
    res.sendFile(abs);
  } catch (e) {
    console.error('[UPLOADS GET] error', e);
    res.status(500).send('Server error');
  }
});

// =========================================================
// Endpoints Meta
// =========================================================
app.get('/api/meta/stages', (_req, res) => res.json({ stages: MATCH_STAGES }));

// =========================================================
 // Endpoints Partidos (REST)
// =========================================================
app.post('/api/matches', (req, res) => {
  const { name, teamA, teamB, rules, firstServer, stage, courtName } = req.body ?? {};
  const firstServerIndex = firstServer === 'B' ? 1 : 0;
  const match = createMatch({
    name: name ?? 'Partido',
    teamA: teamA ?? 'Equipo A',
    teamB: teamB ?? 'Equipo B',
    rules: rules ?? {},
    firstServerIndex,
    stage: stage ?? 'Amistoso',
    courtName: courtName ?? '',
  });
  res.json({ id: match.id });
});

app.get('/api/matches', (req, res) => {
  const { status = 'active', stage, q = '', sort = '-createdAt' } = req.query;
  const norm = (s) => (s ?? '').toString().toLowerCase();
  const query = norm(q);
  const filterByStage = stage && MATCH_STAGES.includes(stage) ? stage : null;
  const mapToArray = (m) => Array.from(m.values());
  let active = mapToArray(matches);
  let finished = mapToArray(matchesHistory);
  if (filterByStage) {
    active = active.filter((m) => m.stage === filterByStage);
    finished = finished.filter((m) => m.stage === filterByStage);
  }
  const matchesFilter = (arr) => {
    if (!query) return arr;
    return arr.filter((m) => {
      const pool = `${m.name} ${m.teams[0].name} ${m.teams[1].name}`.toLowerCase();
      return pool.includes(query);
    });
  };
  active = matchesFilter(active);
  finished = matchesFilter(finished);
  const sortField = sort.replace(/^-/, '');
  const sortDir = sort.startsWith('-') ? -1 : 1;
  const cmp = (a, b, field) => (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1) * sortDir;
  const sortArray = (arr) => {
    if (['createdAt', 'updatedAt', 'endedAt', 'name'].includes(sortField)) {
      return arr.sort((a, b) => cmp(a, b, sortField));
    }
    return arr.sort((a, b) => cmp(a, b, 'createdAt'));
  };
  active = sortArray(active);
  finished = sortArray(finished);
  if (status === 'active') return res.json({ active });
  if (status === 'finished') return res.json({ finished });
  if (status === 'all') return res.json({ active, finished });
  return res.json({ active });
});

app.get('/api/matches/:id', (req, res) => {
  const { id } = req.params;
  let match = matches.get(id) ?? matchesHistory.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado' });
  res.json(formatState(match));
});

app.patch('/api/matches/:id', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado o ya finalizado' });
  const { name, teamA, teamB, stage, courtName } = req.body ?? {};
  if (typeof name === 'string' && name.trim()) match.name = name.trim();
  if (typeof teamA === 'string' && teamA.trim()) match.teams[0].name = teamA.trim();
  if (typeof teamB === 'string' && teamB.trim()) match.teams[1].name = teamB.trim();
  if (typeof stage === 'string' && MATCH_STAGES.includes(stage)) match.stage = stage;
  if (typeof courtName === 'string') match.courtName = courtName.trim();
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

app.post('/api/matches/:id/start', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  if (!match.running) {
    match.running = true;
    match.status = 'running';
    match.startedAt = nowMs();
    match.pausedAt = null;
    touchUpdated(match);
  }
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

app.post('/api/matches/:id/pause', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  if (match.running) {
    match.running = false;
    match.status = 'paused';
    match.pausedAt = nowMs();
    match.accumulatedMs += match.pausedAt - (match.startedAt ?? match.pausedAt);
    match.startedAt = null;
    touchUpdated(match);
  }
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

app.post('/api/matches/:id/resume', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  if (!match.running) {
    match.running = true;
    match.status = 'running';
    match.startedAt = nowMs();
    match.pausedAt = null;
    touchUpdated(match);
  }
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

app.post('/api/matches/:id/finish', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o ya finalizado' });
  moveToHistory(match);
  res.json({ ok: true });
});

app.post('/api/matches/:id/point/:side', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  const { side } = req.params;
  if (side !== 'A' && side !== 'B') return res.status(400).json({ error: 'Side inválido' });
  addPoint(match, side);
  if (!isFinished(match)) {
    touchUpdated(match);
    io.to(match.id).emit('state', formatState(match));
  }
  res.json({ ok: true });
});

app.post('/api/matches/:id/reset-game', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  match.currentGame = { pointsA: 0, pointsB: 0, advantage: null };
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

app.post('/api/matches/:id/toggle-server', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

// =========================================================
// Publicidad (Ads)
// =========================================================
app.get('/api/matches/:id/ads', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id) ?? matchesHistory.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado' });
  res.json({ urls: match.ads ?? [] });
});

app.post('/api/matches/:id/ads', upload.array('files', 20), (req, res) => {
  const { id } = req.params;
  const match = matches.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  const files = req.files ?? [];
  const urls = files.map((f) => publicUrlForFile(match.id, path.basename(f.path)));
  match.ads.push(...urls);
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ urls: match.ads });
});

app.delete('/api/matches/:id/ads', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  const { url } = req.query;
  const filename = safeFilenameFromUrl(id, String(url ?? ''));
  if (!filename) return res.status(400).json({ error: 'URL inválida' });
  const absPath = path.join(UPLOADS_DIR, id, filename);
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {}
  match.ads = (match.ads ?? []).filter((u) => u !== url);
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ urls: match.ads });
});

// =========================================================
// Socket.IO (partidos)
// =========================================================
io.on('connection', (socket) => {
  socket.on('join', (matchId) => {
    const match = matches.get(matchId) ?? matchesHistory.get(matchId);
    if (!match) return;
    socket.join(matchId);
    socket.emit('state', formatState(match));
  });
});

// =========================================================
// Autenticación (email + contraseña)
// =========================================================
const SESSION_COOKIE = 'sid';
const isProd = process.env.NODE_ENV === 'production';
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS ?? '7', 10);
const daysToMs = (d) => d * 24 * 60 * 60 * 1000;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? '';
}
async function findUserByEmail(email) {
  const { rows } = await db.query(
    'SELECT id, email, password_hash, name, role, active, last_login_at FROM users WHERE lower(email)=lower($1) LIMIT 1',
    [email]
  );
  return rows[0] ?? null;
}
async function getUserPublicById(userId) {
  const { rows } = await db.query(
    'SELECT id, email, name, role, active, last_login_at FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  return rows[0] ?? null;
}
async function issueSession(res, user, req) {
  const rawToken = `${uuidv4()}.${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = sha256Hex(rawToken);
  const createdAt = nowMs();
  const expiresAt = createdAt + daysToMs(SESSION_TTL_DAYS);
  await db.query(
    `INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tokenHash, user.id, createdAt, createdAt, expiresAt, req.get('user-agent') ?? '', clientIp(req)]
  );
  res.cookie(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: daysToMs(SESSION_TTL_DAYS),
    signed: true,
  });
  await db.query('UPDATE users SET last_login_at=$1, updated_at=$1 WHERE id=$2', [createdAt, user.id]);
  return { token: rawToken, expiresAt };
}
async function readSession(req) {
  const rawToken = req.signedCookies && req.signedCookies[SESSION_COOKIE];
  if (!rawToken) return null;
  const tokenHash = sha256Hex(rawToken);
  const { rows } = await db.query(
    'SELECT token_hash, user_id, created_at, last_seen_at, expires_at FROM user_sessions WHERE token_hash=$1 LIMIT 1',
    [tokenHash]
  );
  const session = rows[0];
  if (!session) return null;
  if (session.expires_at <= nowMs()) {
    await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash]);
    return null;
  }
  const user = await getUserPublicById(session.user_id);
  if (!user || user.active === false) {
    await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash]);
    return null;
  }
  await db.query('UPDATE user_sessions SET last_seen_at=$1 WHERE token_hash=$2', [nowMs(), tokenHash]);
  return { session, user, tokenHash };
}
async function authOptional(req, _res, next) {
  try {
    if (!hasDB) return next();
    const ctx = await readSession(req);
    if (ctx) {
      req.user = ctx.user;
      req.sessionHash = ctx.tokenHash;
    }
  } catch {}
  next();
}
async function authRequired(req, res, next) {
  try {
    if (!hasDB) return res.status(503).json({ error: 'DB no configurada' });
    const ctx = await readSession(req);
    if (!ctx) return res.status(401).json({ error: 'No autenticado' });
    req.user = ctx.user;
    req.sessionHash = ctx.tokenHash;
    next();
  } catch {
    return res.status(401).json({ error: 'No autenticado' });
  }
}
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
}

app.use(authOptional);

app.post('/api/auth/login', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { email = '', password = '' } = req.body ?? {};
    const emailTrim = String(email).trim();
    if (!emailTrim || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    const user = await findUserByEmail(emailTrim);
    if (!user || user.active === false || !user.password_hash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
    await issueSession(res, user, req);
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        active: user.active,
        last_login_at: user.last_login_at,
      },
    });
  } catch (e) {
    console.error('[auth/login] error', e);
    return res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const rawToken = req.signedCookies && req.signedCookies[SESSION_COOKIE];
    if (rawToken) {
      const tokenHash = sha256Hex(rawToken);
      await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash]);
    }
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[auth/logout] error', e);
    return res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  return res.json({ user: req.user });
});

// =========================================================
// Super Admin - Gestión de Usuarios (CRUD)
// =========================================================
app.get('/api/superadmin/users', authRequired, requireSuperAdmin, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10), 0);
    const q = String(req.query.q ?? '').trim().toLowerCase();

    let sql = `SELECT id, email, name, role, active, last_login_at, created_at, updated_at FROM users`;
    const params = [];
    if (q) {
      sql += ` WHERE lower(email) LIKE $1 OR lower(name) LIKE $1`;
      params.push(`%${q}%`);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);
    res.json({ users: rows, limit, offset });
  } catch (e) {
    console.error('[superadmin list users]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/superadmin/users', authRequired, requireSuperAdmin, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { email = '', name = '', role = 'admin', password = '' } = req.body ?? {};
    const emailTrim = String(email).trim().toLowerCase();
    const nameTrim = String(name).trim();
    if (!emailTrim || !password) return res.status(400).json({ error: 'Email y password son requeridos' });
    if (!['admin', 'superadmin', 'staff'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
    const hash = await bcrypt.hash(password, saltRounds);

    const now = Date.now();
    const { rows } = await db.query(
      `INSERT INTO users (email, name, role, active, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id, email, name, role, active`,
      [emailTrim, nameTrim, role, true, hash, now]
    );
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'El email ya existe' });
    }
    console.error('[superadmin create user]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.patch('/api/superadmin/users/:id', authRequired, requireSuperAdmin, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { email, name, role, active, password } = req.body ?? {};
    const fields = [];
    const params = [];
    if (typeof email === 'string' && email.trim()) {
      fields.push(`email=$${fields.length + 1}`);
      params.push(email.trim().toLowerCase());
    }
    if (typeof name === 'string') {
      fields.push(`name=$${fields.length + 1}`);
      params.push(name.trim());
    }
    if (typeof role === 'string') {
      if (!['admin', 'superadmin', 'staff'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
      fields.push(`role=$${fields.length + 1}`);
      params.push(role);
    }
    if (typeof active === 'boolean') {
      fields.push(`active=$${fields.length + 1}`);
      params.push(active);
    }
    if (typeof password === 'string' && password.length) {
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
      const hash = await bcrypt.hash(password, saltRounds);
      fields.push(`password_hash=$${fields.length + 1}`);
      params.push(hash);
    }
    if (!fields.length) return res.json({ ok: true });

    fields.push(`updated_at=$${fields.length + 1}`);
    params.push(Date.now());
    params.push(id);

    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id=$${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'El email ya existe' });
    }
    console.error('[superadmin patch user]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/superadmin/users/:id', authRequired, requireSuperAdmin, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    await db.query(`UPDATE users SET active=false, updated_at=$1 WHERE id=$2`, [Date.now(), id]);
    await db.query(`DELETE FROM user_sessions WHERE user_id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[superadmin delete user]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// =========================================================
// Startup
// =========================================================
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
``