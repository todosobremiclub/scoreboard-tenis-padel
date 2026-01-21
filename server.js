
// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

// --- NUEVO: archivos para publicidad ---
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static('public'));


// Ruta raíz: redirige al Admin
app.get('/', (_req, res) => {
  res.redirect('/admin.html');
});


const PORT = process.env.PORT || 3000;

/* =========================================================
   Config / Constantes
   ========================================================= */
const MATCH_STAGES = [
  'Amistoso',
  'Fase de grupos',
  '32vos de final',
  '16vos de final',
  '8vos de final',
  '4tos de final',
  'Semi-Final',
  'Final'
];

// Carpeta de subidas para publicidad
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
ensureDir(UPLOADS_DIR);

/* =========================================================
   Subidas (Multer) - publicidad
   ========================================================= */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Guardamos en /public/uploads/:matchId/
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const matchId = req.params.id || req.body.matchId;
    const dest = path.join(UPLOADS_DIR, matchId);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_\-]/g, '');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 20 } // 10MB c/u, hasta 20 archivos
});

/* =========================================================
   Estado en memoria
   ========================================================= */
// Partidos activos (no finalizados): scheduled | running | paused
/** @type {Map<string, any>} */
const matches = new Map();

// Partidos finalizados (histórico)
/** @type {Map<string, any>} */
const matchesHistory = new Map();

/* =========================================================
   Utilidades
   ========================================================= */
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
  // Set corto 5-5 => 6-5; Estándar 6-6 => 7-6
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
  // Si está corriendo, acumulamos el último tramo
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

  // Sacar de activos y llevar a histórico
  matches.delete(match.id);
  matchesHistory.set(match.id, match);

  // Notificar a la sala
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

  // Nuevo set
  match.sets.push(newSet());
  // Alterna primer sacador del nuevo set (oficial)
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;
  touchUpdated(match);
}

function awardGame(match, winner) {
  const set = currentSet(match);
  if (winner === 'A') set.gamesA++;
  else set.gamesB++;

  // Reset del game actual
  match.currentGame = { pointsA: 0, pointsB: 0, advantage: null };
  // Cambia el sacador al iniciar el próximo game (uno y uno)
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;

  // ¿Se activa tie-break?
  checkActivateTieBreak(match, set);

  // ¿Se gana el set sin tie-break?
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
  if (side === 'A') tb.pointsA++; else tb.pointsB++;

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
    // Punto de oro: 0->1->2->3 (0/15/30/40) y el 4º punto gana (incluye 40-40)
    if (side === 'A') g.pointsA++;
    else g.pointsB++;

    if (g.pointsA >= 4 || g.pointsB >= 4) {
      awardGame(match, g.pointsA > g.pointsB ? 'A' : 'B');
      return;
    }
    touchUpdated(match);
    return;
  }

  // Con ventaja clásica
  if (g.pointsA === 3 && g.pointsB === 3) {
    if (g.advantage === null) {
      g.advantage = side;
    } else if (g.advantage === side) {
      awardGame(match, side);
      return;
    } else {
      g.advantage = null; // vuelve a deuce
    }
    touchUpdated(match);
    return;
  }

  if (side === 'A') {
    g.pointsA++;
    if (g.pointsA > 3) { awardGame(match, 'A'); return; }
  } else {
    g.pointsB++;
    if (g.pointsB > 3) { awardGame(match, 'B'); return; }
  }
  touchUpdated(match);
}

function addPoint(match, side) {
  if (isFinished(match)) return;
  const set = currentSet(match);

  if (set.tieBreak.active) {
    awardPointInTieBreak(match, side);
  } else {
    awardPointInRegularGame(match, side);
  }
}

function createMatch({ name, teamA, teamB, rules, firstServerIndex = 0, stage, courtName }) {
  const id = generateId();
  const created = nowMs();
  const match = {
    id,
    name,
    stage: MATCH_STAGES.includes(stage) ? stage : 'Amistoso',
    courtName: (courtName || '').trim(), // NUEVO: cancha
    createdAt: created,
    updatedAt: created,
    endedAt: null,

    startedAt: null,    // marca inicio del tramo "running"
    pausedAt: null,
    accumulatedMs: 0,   // suma de tramos running previos
    running: false,
    status: 'scheduled', // scheduled | running | paused | finished

    rules: {
      bestOf: rules.bestOf ?? 3,
      tieBreakAt: rules.tieBreakAt ?? '6-6',
      tieBreakPoints: rules.tieBreakPoints ?? 7,
      noAdvantage: rules.noAdvantage ?? false
    },

    teams: [{ name: teamA || 'Equipo A' }, { name: teamB || 'Equipo B' }],
    serverIndex: firstServerIndex,   // 0 o 1
    sets: [newSet()],
    setsWonA: 0,
    setsWonB: 0,
    currentGame: { pointsA: 0, pointsB: 0, advantage: null },

    ads: [] // NUEVO: URLs públicas de imágenes
  };

  matches.set(id, match);
  return match;
}

function formatState(match) {
  return match; // devolvemos el objeto completo
}

/* =========================================================
   Helpers para URLs públicas de ads
   ========================================================= */
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

/* =========================================================
   Endpoints Meta
   ========================================================= */
// Opciones para el desplegable de instancias
app.get('/api/meta/stages', (_req, res) => {
  res.json({ stages: MATCH_STAGES });
});

/* =========================================================
   Endpoints de Partidos
   ========================================================= */

// Crear partido
// body: { name, teamA, teamB, rules, firstServer, stage, courtName }
app.post('/api/matches', (req, res) => {
  const { name, teamA, teamB, rules, firstServer, stage, courtName } = req.body || {};
  const firstServerIndex = firstServer === 'B' ? 1 : 0;

  const match = createMatch({
    name: name || 'Partido',
    teamA: teamA || 'Equipo A',
    teamB: teamB || 'Equipo B',
    rules: rules || {},
    firstServerIndex,
    stage: stage || 'Amistoso',
    courtName: courtName || ''
  });
  res.json({ id: match.id });
});

// Listar partidos
// GET /api/matches?status=active|finished|all&stage=...&q=...&sort=-createdAt
app.get('/api/matches', (req, res) => {
  const { status = 'active', stage, q = '', sort = '-createdAt' } = req.query;

  const norm = (s) => (s || '').toString().toLowerCase();
  const query = norm(q);
  const filterByStage = stage && MATCH_STAGES.includes(stage) ? stage : null;

  const mapToArray = (m) => Array.from(m.values());

  let active = mapToArray(matches);
  let finished = mapToArray(matchesHistory);

  // Filtro por stage
  if (filterByStage) {
    active = active.filter(m => m.stage === filterByStage);
    finished = finished.filter(m => m.stage === filterByStage);
  }

  // Filtro por texto (nombre del partido o equipos)
  const matchesFilter = (arr) => {
    if (!query) return arr;
    return arr.filter(m => {
      const pool = `${m.name} ${m.teams[0].name} ${m.teams[1].name}`.toLowerCase();
      return pool.includes(query);
    });
  };

  active = matchesFilter(active);
  finished = matchesFilter(finished);

  // Orden
  const sortField = sort.replace(/^-/, '');
  const sortDir = sort.startsWith('-') ? -1 : 1;
  const cmp = (a, b, field) =>
    (a[field] === b[field] ? 0 : (a[field] > b[field] ? 1 : -1)) * sortDir;

  const sortArray = (arr) => {
    if (['createdAt', 'updatedAt', 'endedAt', 'name'].includes(sortField)) {
      return arr.sort((a, b) => cmp(a, b, sortField));
    }
    // default: createdAt desc
    return arr.sort((a, b) => cmp(a, b, 'createdAt'));
  };

  active = sortArray(active);
  finished = sortArray(finished);

  if (status === 'active') return res.json({ active });
  if (status === 'finished') return res.json({ finished });
  if (status === 'all') return res.json({ active, finished });

  return res.json({ active }); // por defecto
});

// Obtener estado del partido (activos o históricos)
app.get('/api/matches/:id', (req, res) => {
  const { id } = req.params;
  let match = matches.get(id);
  if (!match) match = matchesHistory.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado' });
  res.json(formatState(match));
});

// Actualizar datos básicos (nombre, equipos, stage, courtName)
app.patch('/api/matches/:id', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id); // sólo partidos activos son editables
  if (!match) return res.status(404).json({ error: 'No encontrado o ya finalizado' });

  const { name, teamA, teamB, stage, courtName } = req.body || {};
  if (typeof name === 'string' && name.trim()) match.name = name.trim();
  if (typeof teamA === 'string' && teamA.trim()) match.teams[0].name = teamA.trim();
  if (typeof teamB === 'string' && teamB.trim()) match.teams[1].name = teamB.trim();
  if (typeof stage === 'string' && MATCH_STAGES.includes(stage)) match.stage = stage;
  if (typeof courtName === 'string') match.courtName = courtName.trim();

  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

// Iniciar
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

// Pausar
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

// Reanudar
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

// Finalizar manualmente (por si necesitás cerrar un partido)
app.post('/api/matches/:id/finish', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o ya finalizado' });

  moveToHistory(match);
  res.json({ ok: true });
});

// Sumar punto
app.post('/api/matches/:id/point/:side', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });

  const { side } = req.params;
  if (side !== 'A' && side !== 'B') return res.status(400).json({ error: 'Side inválido' });

  addPoint(match, side);
  // Si addPoint terminó el partido, ya lo movió a histórico y emitió.
  if (!isFinished(match)) {
    touchUpdated(match);
    io.to(match.id).emit('state', formatState(match));
  }
  res.json({ ok: true });
});

// Reset del game actual (sólo activos)
app.post('/api/matches/:id/reset-game', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });

  match.currentGame = { pointsA: 0, pointsB: 0, advantage: null };
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

// Cambiar servidor (toggle manual) - sólo activos
app.post('/api/matches/:id/toggle-server', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });
  match.serverIndex = match.serverIndex === 0 ? 1 : 0;
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ ok: true });
});

/* =========================================================
   Endpoints de Publicidad (ads)
   ========================================================= */

// Listar ads del partido (activo o histórico)
app.get('/api/matches/:id/ads', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id) || matchesHistory.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado' });
  res.json({ urls: match.ads || [] });
});

// Subir múltiples imágenes (hasta 20) - sólo partidos activos
app.post('/api/matches/:id/ads', upload.array('files', 20), (req, res) => {
  const { id } = req.params;
  const match = matches.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });

  const files = req.files || [];
  const urls = files.map(f => publicUrlForFile(match.id, path.basename(f.path)));
  match.ads.push(...urls);
  touchUpdated(match);

  io.to(match.id).emit('state', formatState(match));
  res.json({ urls: match.ads });
});

// Eliminar una imagen por su URL pública (?url=/uploads/:id/:file) - sólo activos
app.delete('/api/matches/:id/ads', (req, res) => {
  const { id } = req.params;
  const match = matches.get(id);
  if (!match) return res.status(404).json({ error: 'No encontrado o finalizado' });

  const { url } = req.query;
  const filename = safeFilenameFromUrl(id, String(url || ''));
  if (!filename) return res.status(400).json({ error: 'URL inválida' });

  const absPath = path.join(UPLOADS_DIR, id, filename);
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {
    // ignorar error de fs
  }
  match.ads = (match.ads || []).filter(u => u !== url);
  touchUpdated(match);
  io.to(match.id).emit('state', formatState(match));
  res.json({ urls: match.ads });
});

/* =========================================================
   Socket.IO
   ========================================================= */
io.on('connection', (socket) => {
  socket.on('join', (matchId) => {
    // Puede ser activo o histórico (para replays/consulta)
    const match = matches.get(matchId) || matchesHistory.get(matchId);
    if (!match) return;
    socket.join(matchId);
    socket.emit('state', formatState(match));
  });
});

/* =========================================================
   Startup
   ========================================================= */
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
``
