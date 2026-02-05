// public/admin.js
// =========================================================
// Admin App (Matches + Players + Top Tabs)
// Mantiene toda tu lógica actual de "Partidos" y agrega "Jugadores".
// =========================================================

/* ==============================
 Helpers
============================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const originBase = window.location.origin;

function two(n){ return String(n).padStart(2,'0'); }
function formatDateTime(ms){
  if (!ms) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = two(d.getMonth()+1);
  const day = two(d.getDate());
  const hh = two(d.getHours());
  const mm = two(d.getMinutes());
  const ss = two(d.getSeconds());
  return `${day}/${m}/${y} ${hh}:${mm}:${ss}`;
}
function formatHMS(ms){
  const sec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  return `${two(h)}:${two(m)}:${two(s)}`;
}
function computeElapsed(state, now = Date.now()){
  // acumulado + (si está corriendo) tramo actual
  let elapsed = state.accumulatedMs ?? 0;
  if (state.running) {
    const refStart = state.startedAt ?? now;
    elapsed += (now - refStart);
  }
  return elapsed;
}
function mapPointsDisplay(match){
  const set = match.sets[match.sets.length - 1];
  const tb = set?.tieBreak ?? {active:false};
  if (tb.active) {
    return `${tb.pointsA ?? 0}-${tb.pointsB ?? 0}`;
  }
  const g = match.currentGame ?? {pointsA:0, pointsB:0, advantage:null};
  const toStr = (p) => ['0','15','30','40'][Math.min(p,3)] ?? '0';
  if (!match.rules?.noAdvantage) {
    // Con ventaja
    if (g.pointsA === 3 && g.pointsB === 3) {
      if (g.advantage === 'A') return 'V-40';
      if (g.advantage === 'B') return '40-V';
      return '40-40';
    }
  }
  // Sin ventaja (punto de oro) u otros estados
  return `${toStr(g.pointsA??0)}-${toStr(g.pointsB??0)}`;
}

/* ==============================
 State global
============================== */
const state = {
  // Stages (Partidos)
  stages: [
    // fallback; se sobreescribe desde /api/meta/stages
    'Amistoso','Fase de grupos','32vos de final','16vos de final',
    '8vos de final','4tos de final','Semi-Final','Final'
  ],
  tab: 'active', // 'active' | 'history' (tabs internos de Partidos)
  filters: {
    q: '',
    stage: '',
    sort: '-createdAt'
  },
  // Diccionario de matchId -> último state recibido
  byId: new Map(),
  // Diccionario de matchId -> elemento DOM (tarjeta)
  elements: new Map(),
  // Socket único para unir múltiples salas
  socket: null,
  // Timer de cronómetros
  tickTimer: null,

  // === Players ===
  topTab: 'matches',  // 'players' | 'tournaments' | 'matches'
  players: {
    list: [],
    q: '',
    category: '',
    showInactive: false,
    limit: 50,
    offset: 0,
    editingId: null, // null => creando
    // cache de categorías (opcional)
    categories: ['C1','C2','C3','C4','C5','C6','C7','C8','C9','D1','D2','D3','D4','D5','D6','D7','D8','D9']
 },
tournaments: {
  list: [],
  q: '',
  category: '',
  status: '',
  limit: 50,
  offset: 0,
  editingId: null
}
};

// --- Publicidad (Ads)
const adsModal = document.querySelector('#adsModal');
const adsListEl = document.querySelector('#adsList');
const adsFilesInput = document.querySelector('#adsFiles');
let adsForId = null;

/* ==============================
 API wrappers
============================== */
async function apiGet(url){
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
async function apiPost(url, body){
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
async function apiPatch(url, body){
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    credentials: 'include',
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
async function apiDelete(url){
  const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  try { return await res.json(); } catch { return { ok: true }; }
}

/* ==============================
 Club Switcher (multi-club)
============================== */
async function fetchAuthClubsCtx() {
  return apiGet('/api/auth/clubs');
}

async function selectClub(clubId) {
  const r = await fetch('/api/auth/select-club', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ clubId })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `select-club ${r.status}`);
  return data;
}

function renderClubSwitcher(ctx) {
  const wrap = document.getElementById('clubSwitcher');
  const sel = document.getElementById('clubSelect');
  const btn = document.getElementById('clubApplyBtn');
  const label = document.getElementById('clubActiveLabel');
  if (!wrap || !sel || !btn || !label) return;

  const clubs = ctx?.clubs ?? [];
  const activeClubId = ctx?.activeClubId ?? null;
  const isImpersonating = !!ctx?.isImpersonating;
  const role = ctx?.role ?? '';

  if (!clubs.length) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';

  // options
  sel.innerHTML = '';
  for (const c of clubs) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.slug ? `${c.name} (${c.slug})` : c.name;
    if (String(c.id) === String(activeClubId)) opt.selected = true;
    sel.appendChild(opt);
  }

  const activeName = clubs.find(c => String(c.id) === String(activeClubId))?.name ?? '—';
  label.textContent = isImpersonating ? `Activo: ${activeName} (impersonando)` : `Activo: ${activeName}`;

  // Superadmin no usa select-club (usa impersonación)
  if (role === 'superadmin') {
    btn.disabled = true;
    btn.title = 'Superadmin no selecciona club activo: usa impersonación';
  } else {
    btn.disabled = false;
    btn.title = '';
  }

  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const clubId = sel.value;
      if (!clubId) return;

      const prevTxt = btn.textContent;
      btn.textContent = 'Cambiando...';
      btn.disabled = true;

      try {
        await selectClub(clubId);

        // Releer ctx para refrescar label/estado
        const nextCtx = await fetchAuthClubsCtx();
        renderClubSwitcher(nextCtx);

        // Refrescar datos
        await refreshLists();
        // Solo si existen (según pestaña/uso)
        try { await loadPlayers(); } catch {}
        try { await loadTournaments(); } catch {}
      } catch (e) {
        console.error(e);
        alert(e?.message || 'No se pudo cambiar el club');
      } finally {
        btn.textContent = prevTxt;
        // re-habilitar si no es superadmin
        if ((ctx?.role ?? '') !== 'superadmin') btn.disabled = false;
      }
    });
  }
}

async function initClubSwitcher() {
  try {
    const ctx = await fetchAuthClubsCtx();
    renderClubSwitcher(ctx);
  } catch (e) {
    console.warn('[clubSwitcher] no se pudo iniciar:', e?.message || e);
  }
}

/* ==============================
 Socket.IO (un solo socket; múltiples salas)
============================== */
function ensureSocket(){
  if (state.socket) return state.socket;
  const socket = io(originBase, { transports: ['websocket'] });
  socket.on('connect', () => {
    // Reunirnos a todas las salas activas (por si recargamos)
    const ids = Array.from(state.byId.keys());
    ids.forEach(id => socket.emit('join', id));
  });
  socket.on('state', (match) => {
    // Actualización puntual de un match
    state.byId.set(match.id, match);
    updateMatchCard(match.id);
  });
  socket.on('finished', (_payload) => {
    // Cuando un match finaliza, refrescamos listas (mueve a histórico)
    // Para evitar demasiadas llamadas, hacemos un refresh suave
    refreshLists();
  });
  state.socket = socket;
  return socket;
}
function joinRoom(matchId){
  ensureSocket().emit('join', matchId);
}

/* ==============================
 Renderizado de listas y tarjetas (Partidos)
============================== */
function clearContainer(el){
  while (el.firstChild) el.removeChild(el.firstChild);
}
function fillStagesSelect(selectEl, withAllOption=false){
  if (!selectEl) return;
  if (withAllOption) {
    // Mantener la primera opción "Todas las instancias"
    const keepFirst = selectEl.querySelector('option[value=""]');
    selectEl.innerHTML = '';
    if (keepFirst) selectEl.appendChild(keepFirst);
  } else {
    selectEl.innerHTML = '';
  }
  state.stages.forEach(st => {
    const opt = document.createElement('option');
    opt.value = st;
    opt.textContent = st;
    selectEl.appendChild(opt);
  });
}
function buildQuery(base, { status, stage, q, sort }){
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (stage) params.set('stage', stage);
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  return `${base}?${params.toString()}`;
}
function renderLists(activeData, historyData){
  const activeList = $('#activeList');
  const historyList = $('#historyList');
  clearContainer(activeList);
  clearContainer(historyList);
  // Render Activos
  (activeData?.active ?? []).forEach(m => {
    const el = renderMatchItem(m, /*isHistory*/false);
    activeList.appendChild(el);
  });
  // Render Histórico
  (historyData?.finished ?? []).forEach(m => {
    const el = renderMatchItem(m, /*isHistory*/true);
    historyList.appendChild(el);
  });
  // Después de poblar listas, unir salas activas
  (activeData?.active ?? []).forEach(m => joinRoom(m.id));
  // Actualizar mapa de elementos (para updates puntuales)
  state.elements.clear();
  $$('#activeList .match, #historyList .match').forEach(card => {
    const id = card.dataset.id;
    state.elements.set(id, card);
  });
}
function renderMatchItem(match, isHistory){
  // Guardar el último estado
  state.byId.set(match.id, match);
  const tpl = $('#matchItemTemplate');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = match.id;
  // Referencias
  const badgeStage = node.querySelector('.badge.stage');
  const badgeStatus = node.querySelector('.badge.status');
  const title = node.querySelector('.match-title');
  const teamsLine = node.querySelector('.teams-line');
  const metaServe = node.querySelector('.meta .serve');
  const metaSets = node.querySelector('.meta .sets');
  const metaGames = node.querySelector('.meta .games');
  const metaPoints = node.querySelector('.meta .points');
  const elapsedEl = node.querySelector('.elapsed');
  const stateEl = node.querySelector('.state');
  const idEl = node.querySelector('.matchId');
  const updatedEl = node.querySelector('.updatedAt');
  // Botones
  const btnOpen = node.querySelector('.btn-open');
  const btnStart = node.querySelector('.btn-start');
  const btnPause = node.querySelector('.btn-pause');
  const btnResume = node.querySelector('.btn-resume');
  const btnA = node.querySelector('.btn-a');
  const btnB = node.querySelector('.btn-b');
  const btnReset = node.querySelector('.btn-reset');
  const btnToggle = node.querySelector('.btn-toggle-serve');
  const btnFinish = node.querySelector('.btn-finish');
  const btnEdit = node.querySelector('.btn-edit');
  const btnAds = node.querySelector('.btn-ads');
  const btnDelete = node.querySelector('.btn-delete');

  btnAds.addEventListener('click', () => openAdsModal(match.id));

  // Contenido
  badgeStage.textContent = match.stage ?? 'Amistoso';
  badgeStatus.textContent = match.status ?? 'scheduled';
  title.textContent = match.name ?? 'Partido';
  teamsLine.textContent = `${match.teams?.[0]?.name ?? 'Equipo A'} vs ${match.teams?.[1]?.name ?? 'Equipo B'}`;
  metaServe.textContent = match.teams?.[match.serverIndex]?.name ?? '—';
  const set = match.sets[match.sets.length - 1] ?? {gamesA:0, gamesB:0, tieBreak:{active:false}};
  metaSets.textContent = `${match.setsWonA??0}-${match.setsWonB??0}`;
  metaGames.textContent = `${set.gamesA??0}-${set.gamesB??0}`;
  metaPoints.textContent = mapPointsDisplay(match);
  elapsedEl.textContent = formatHMS(computeElapsed(match));
  stateEl.textContent = match.status ?? (match.running ? 'running' : 'scheduled');
  idEl.textContent = match.id;
  updatedEl.textContent = formatDateTime(match.updatedAt);

  // Estados de botones (habilitar/deshabilitar)
  const finished = match.status === 'finished';
  btnOpen.disabled = false;
  btnStart.disabled = finished || match.running || match.status === 'running';
  btnPause.disabled = finished || !match.running;
  btnResume.disabled = finished || match.running || match.status === 'running';
  btnA.disabled = finished;
  btnB.disabled = finished;
  btnReset.disabled = finished;
  btnToggle.disabled = finished;
  btnFinish.disabled = finished;
  btnEdit.disabled = finished; // histórico no editable
  if (isHistory) {
    // En histórico, forzamos deshabilitados (salvo abrir TV)
    btnStart.disabled = true;
    btnPause.disabled = true;
    btnResume.disabled = true;
    btnA.disabled = true;
    btnB.disabled = true;
    btnReset.disabled = true;
    btnToggle.disabled = true;
    btnFinish.disabled = true;
    btnEdit.disabled = true;
  }

  // Eventos (Partidos)
  btnOpen.addEventListener('click', () => {
    const url = `${originBase}/display.html?match=${match.id}`;
    window.open(url, '_blank');
  });
  btnStart.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/start`);
    softRefreshMatch(match.id);
  });
  btnPause.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/pause`);
    softRefreshMatch(match.id);
  });
  btnResume.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/resume`);
    softRefreshMatch(match.id);
  });
  btnA.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/point/A`);
    softRefreshMatch(match.id);
  });
  btnB.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/point/B`);
    softRefreshMatch(match.id);
  });
  btnReset.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/reset-game`);
    softRefreshMatch(match.id);
  });
  btnToggle.addEventListener('click', async () => {
    await apiPost(`/api/matches/${match.id}/toggle-server`);
    softRefreshMatch(match.id);
  });
  btnFinish.addEventListener('click', async () => {
    if (!confirm('¿Finalizar el partido? Pasará al histórico.')) return;
    await apiPost(`/api/matches/${match.id}/finish`);
    await refreshLists();
  });
  btnEdit.addEventListener('click', () => openEditModal(match.id));

  if (btnDelete){
    btnDelete.addEventListener('click', async () => {
      const ok = confirm('¿Eliminar este partido? Se borrará definitivamente (activos/históricos) y sus publicidades.');
      if (!ok) return;
      try {
        const r = await fetch(`/api/matches/${match.id}?deleteAds=1`, { method: 'DELETE', credentials: 'include' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(data.error ?? 'No se pudo eliminar');
          return;
        }
        // remover del DOM
        node.remove();
      } catch (e) {
        alert('Error de red al eliminar');
      }
    });
  }

  return node;
}
// Actualiza SOLO la tarjeta de un match ya renderizado
function updateMatchCard(matchId){
  const card = state.elements.get(matchId);
  if (!card) return; // no visible en esta pestaña
  const match = state.byId.get(matchId);
  if (!match) return;

  // Referencias dentro de la tarjeta
  const badgeStatus = card.querySelector('.badge.status');
  const title = card.querySelector('.match-title');
  const teamsLine = card.querySelector('.teams-line');
  const metaServe = card.querySelector('.meta .serve');
  const metaSets = card.querySelector('.meta .sets');
  const metaGames = card.querySelector('.meta .games');
  const metaPoints = card.querySelector('.meta .points');
  const elapsedEl = card.querySelector('.elapsed');
  const stateEl = card.querySelector('.state');
  const updatedEl = card.querySelector('.updatedAt');

  // Actualizar textos
  badgeStatus.textContent = match.status ?? (match.running ? 'running' : 'scheduled');
  title.textContent = match.name ?? 'Partido';
  teamsLine.textContent = `${match.teams?.[0]?.name ?? 'Equipo A'} vs ${match.teams?.[1]?.name ?? 'Equipo B'}`;
  metaServe.textContent = match.teams?.[match.serverIndex]?.name ?? '—';
  const set = match.sets[match.sets.length - 1] ?? {gamesA:0, gamesB:0, tieBreak:{active:false}};
  metaSets.textContent = `${match.setsWonA??0}-${match.setsWonB??0}`;
  metaGames.textContent = `${set.gamesA??0}-${set.gamesB??0}`;
  metaPoints.textContent = mapPointsDisplay(match);
  elapsedEl.textContent = formatHMS(computeElapsed(match));
  stateEl.textContent = match.status ?? (match.running ? 'running' : 'scheduled');
  updatedEl.textContent = formatDateTime(match.updatedAt);

  // Estados de botones
  const finished = match.status === 'finished';
  const btnStart = card.querySelector('.btn-start');
  const btnPause = card.querySelector('.btn-pause');
  const btnResume = card.querySelector('.btn-resume');
  const btnA = card.querySelector('.btn-a');
  const btnB = card.querySelector('.btn-b');
  const btnReset = card.querySelector('.btn-reset');
  const btnToggle = card.querySelector('.btn-toggle-serve');
  const btnFinish = card.querySelector('.btn-finish');
  const btnEdit = card.querySelector('.btn-edit');

  if (btnStart) btnStart.disabled = finished || match.running || match.status === 'running';
  if (btnPause) btnPause.disabled = finished || !match.running;
  if (btnResume) btnResume.disabled = finished || match.running || match.status === 'running';
  if (btnA) btnA.disabled = finished;
  if (btnB) btnB.disabled = finished;
  if (btnReset) btnReset.disabled = finished;
  if (btnToggle) btnToggle.disabled = finished;
  if (btnFinish) btnFinish.disabled = finished;
  if (btnEdit) btnEdit.disabled = finished;
}

/* ==============================
 Carga de datos (Partidos)
============================== */
async function loadStages(){
  try {
    const data = await apiGet('/api/meta/stages');
    if (Array.isArray(data.stages) && data.stages.length) {
      state.stages = data.stages;
    }
  } catch (e) {
    console.warn('No se pudo cargar /api/meta/stages; uso fallback', e);
  }
  // Poblar selects
  fillStagesSelect($('#matchStage')); // crear
  fillStagesSelect($('#filterStage'), /*withAllOption*/true); // filtro (mantiene "todas")
  // Para el modal de edición se llena on-demand
}
async function loadActive(){
  const url = buildQuery('/api/matches', {
    status: 'active',
    stage: state.filters.stage,
    q: state.filters.q,
    sort: state.filters.sort
  });
  return apiGet(url);
}
async function loadHistory(){
  const url = buildQuery('/api/matches', {
    status: 'finished',
    stage: state.filters.stage,
    q: state.filters.q,
    sort: state.filters.sort
  });
  return apiGet(url);
}
async function refreshLists(){
  try {
    const [activeData, historyData] = await Promise.all([
      loadActive(),
      loadHistory()
    ]);
    renderLists(activeData, historyData);
  } catch (e) {
    console.error('Error al refrescar listas', e);
  }
}
async function softRefreshMatch(id){
  // Obtener el estado por REST solo de ese id y refrescar tarjeta
  try {
    const data = await apiGet(`/api/matches/${id}`);
    state.byId.set(id, data);
    updateMatchCard(id);
  } catch (e) {
    console.warn('softRefreshMatch falló', e);
  }
}

/* ==============================
 Crear partido
============================== */
function showTvUrl(id){
  const tvUrl = `${originBase}/display.html?match=${id}`;
  $('#tvUrl').textContent = tvUrl;
  $('#tvUrlWrap').style.display = 'block';
}
async function onCreateMatch(){
  try {
    const body = {
      name: $('#matchName').value.trim() ?? 'Partido',
      teamA: $('#teamA').value.trim() ?? 'Equipo A',
      teamB: $('#teamB').value.trim() ?? 'Equipo B',
      firstServer: $('#firstServer').value, // 'A' o 'B'
      stage: $('#matchStage').value,
      courtName: $('#courtName').value.trim(), // ← IMPORTANTE: enviar la cancha
      rules: {
        bestOf: parseInt($('#bestOf').value, 10),
        tieBreakAt: $('#tieBreakAt').value,
        tieBreakPoints: 7,
        noAdvantage: $('#noAdvantage').value === 'true'
      }
    };
    const { id } = await apiPost('/api/matches', body);
    if (id) {
      showTvUrl(id);
      await refreshLists();
      joinRoom(id);
    }
  } catch (e) {
    alert('No se pudo crear el partido. Revisá la consola.');
    console.error(e);
  }
}

/* ==============================
 Tabs / Filtros / Búsqueda (Partidos internos)
============================== */
function setTab(tab){
  state.tab = tab; // 'active' | 'history'
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#activeList').style.display = tab === 'active' ? '' : 'none';
  $('#historyList').style.display = tab === 'history' ? '' : 'none';
}
let searchDebounce = null;
function onSearchInput(ev){
  const q = ev.target.value ?? '';
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.filters.q = q.trim();
    refreshLists();
  }, 350);
}
function onFilterStage(ev){
  state.filters.stage = ev.target.value ?? '';
  refreshLists();
}
function onSortChange(ev){
  state.filters.sort = ev.target.value ?? '-createdAt';
  refreshLists();
}

/* ==============================
 Editar partido (modal)
============================== */
const editModal = $('#editModal');
let editingId = null;
function openEditModal(matchId){
  const m = state.byId.get(matchId);
  if (!m) return;
  editingId = matchId;
  // Poblar campos
  $('#editName').value = m.name ?? '';
  $('#editTeamA').value = m.teams?.[0]?.name ?? '';
  $('#editTeamB').value = m.teams?.[1]?.name ?? '';
  $('#editCourt').value = m.courtName ?? '';
  // Poblar instancias
  const editStageSelect = $('#editStage');
  if (!editStageSelect.options.length) fillStagesSelect(editStageSelect, false);
  editStageSelect.value = m.stage ?? 'Amistoso';
  editModal.style.display = 'flex';
}
function closeEditModal(){
  editModal.style.display = 'none';
  editingId = null;
}
async function onEditSave(){
  if (!editingId) return;
  try {
    await apiPatch(`/api/matches/${editingId}`, {
      name: $('#editName').value.trim(),
      teamA: $('#editTeamA').value.trim(),
      teamB: $('#editTeamB').value.trim(),
      stage: $('#editStage').value,
      courtName: $('#editCourt').value.trim()
    });
    closeEditModal();
    await refreshLists();
  } catch (e) {
    alert('No se pudo guardar. Revisá la consola.');
    console.error(e);
  }
}

/* ==============================
 Tick de cronómetros en listado
============================== */
function startTicker(){
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    const now = Date.now();
    // Actualizamos el cronómetro visible en las tarjetas renderizadas
    state.elements.forEach((card, id) => {
      const m = state.byId.get(id);
      if (!m) return;
      const el = card.querySelector('.elapsed');
      if (!el) return;
      el.textContent = formatHMS(computeElapsed(m, now));
    });
  }, 1000);
}

/* =========================================================
 Torneos (Tournaments)
========================================================= */
// UI helpers (form colapsable)
function openTournamentForm(mode = 'new') {
  const wrap = document.getElementById('tr_formWrap');
  const title = document.getElementById('tr_formTitle');
  if (wrap) wrap.style.display = 'block';
  if (title) title.textContent = (mode === 'edit') ? 'Editar torneo' : 'Nuevo torneo';
  wrap?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeTournamentForm() {
  const wrap = document.getElementById('tr_formWrap');
  if (wrap) wrap.style.display = 'none';
  clearTournamentForm();
}

function renderTournamentsTable(tournaments) {
  const tbody = document.getElementById('tournamentsTbody');
  if (!tbody) return;

  if (!tournaments || !tournaments.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No hay torneos (o no coinciden con el filtro).</td></tr>`;
    return;
  }

  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const fmtDate = (val) => {
    if (!val) return '—';
    // soporta ms epoch o yyyy-mm-dd
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return esc(val);
    return d.toLocaleDateString();
  };

  const statusLabel = (st) => {
    const map = {
      draft: 'Borrador',
      open: 'Inscripción',
      running: 'En curso',
      finished: 'Finalizado'
    };
    return map[st] ?? (st ?? '—');
  };

  const formatLabel = (f) => {
    const map = {
      league: 'Liga',
      groups: 'Grupos',
      knockout: 'Eliminación'
    };
    return map[f] ?? (f ?? '—');
  };

  tbody.innerHTML = tournaments.map(t => `
    <tr data-id="${esc(t.id)}" style="border-bottom:1px solid rgba(255,255,255,.10);">
      <td style="padding:10px 8px;">${esc(statusLabel(t.status))}</td>
      <td style="padding:10px 8px;">${esc(t.name)}</td>
      <td style="padding:10px 8px;">${esc(t.category ?? '—')}</td>
      <td style="padding:10px 8px;">${esc(formatLabel(t.format))}</td>
      <td style="padding:10px 8px;">${esc(t.pairs ?? '—')}</td>
      <td style="padding:10px 8px;">${fmtDate(t.date)}</td>
      <td style="padding:10px 8px; white-space:nowrap;">
        <button class="btn btn-tr-edit" title="Editar">✏️</button>
        <button class="btn btn-tr-del" title="Eliminar">🗑️</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-tr-edit').forEach(b => b.addEventListener('click', onEditTournamentFromRow));
  tbody.querySelectorAll('.btn-tr-del').forEach(b => b.addEventListener('click', onDeleteTournamentFromRow));
}

async function loadTournaments() {
  const params = new URLSearchParams();
  if (state.tournaments.q) params.set('q', state.tournaments.q);
  if (state.tournaments.category) params.set('category', state.tournaments.category);
  if (state.tournaments.status) params.set('status', state.tournaments.status);
  params.set('limit', String(state.tournaments.limit));
  params.set('offset', String(state.tournaments.offset));
  params.set('sort', '-created_at');

  try {
    const data = await apiGet(`/api/tournaments?${params.toString()}`);
    const list = data.tournaments ?? data.items ?? [];
    state.tournaments.list = list;
    renderTournamentsTable(list);
  } catch (e) {
    console.error('No se pudo cargar torneos', e);
    renderTournamentsTable([]);
  }
}

function fillTournamentFormFromTournament(t) {
  state.tournaments.editingId = t.id;

  const name = document.getElementById('tr_name');
  const cat = document.getElementById('tr_category');
  const format = document.getElementById('tr_format');
  const pairs = document.getElementById('tr_pairs');
  const status = document.getElementById('tr_status');
  const date = document.getElementById('tr_date');

  if (name) name.value = t.name ?? '';
  if (cat) cat.value = t.category ?? '';
  if (format) format.value = t.format ?? 'league';
  if (pairs) pairs.value = String(t.pairs ?? 8);
  if (status) status.value = t.status ?? 'draft';

  // date: soportar ms o string yyyy-mm-dd
  if (date) {
    if (!t.date) date.value = '';
    else {
      const d = new Date(t.date);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        date.value = `${y}-${m}-${day}`;
      } else {
        date.value = String(t.date);
      }
    }
  }

  const saveBtn = document.getElementById('tr_save');
  if (saveBtn) saveBtn.textContent = 'Guardar cambios';
}

function onEditTournamentFromRow(ev) {
  const tr = ev.currentTarget.closest('tr');
  const id = tr?.dataset?.id;
  const t = state.tournaments.list.find(x => String(x.id) === String(id));
  if (!t) return;
  fillTournamentFormFromTournament(t);
  openTournamentForm('edit');
}

async function onDeleteTournamentFromRow(ev) {
  const tr = ev.currentTarget.closest('tr');
  const id = tr?.dataset?.id;
  if (!id) return;
  if (!confirm('¿Eliminar este torneo?')) return;

  try {
    await apiDelete(`/api/tournaments/${id}`);
    await loadTournaments();
  } catch (e) {
    alert('No se pudo eliminar el torneo');
    console.error(e);
  }
}

async function saveTournament() {
  const payload = {
    name: document.getElementById('tr_name')?.value?.trim() ?? '',
    category: document.getElementById('tr_category')?.value ?? '',
    format: document.getElementById('tr_format')?.value ?? 'league',
    pairs: parseInt(document.getElementById('tr_pairs')?.value ?? '8', 10),
    status: document.getElementById('tr_status')?.value ?? 'draft',
    date: document.getElementById('tr_date')?.value ?? ''
  };

  if (!payload.name) {
    alert('El nombre del torneo es requerido');
    return;
  }

  try {
    if (!state.tournaments.editingId) {
      await apiPost('/api/tournaments', payload);
    } else {
      await apiPatch(`/api/tournaments/${state.tournaments.editingId}`, payload);
    }

    closeTournamentForm();
    await loadTournaments();
  } catch (e) {
    alert('No se pudo guardar el torneo');
    console.error(e);
  }
}

function clearTournamentForm() {
  state.tournaments.editingId = null;
  const name = document.getElementById('tr_name');
  const cat = document.getElementById('tr_category');
  const format = document.getElementById('tr_format');
  const pairs = document.getElementById('tr_pairs');
  const status = document.getElementById('tr_status');
  const date = document.getElementById('tr_date');
  if (name) name.value = '';
  if (cat) cat.value = '';
  if (format) format.value = 'league';
  if (pairs) pairs.value = '8';
  if (status) status.value = 'draft';
  if (date) date.value = '';
  const saveBtn = document.getElementById('tr_save');
  if (saveBtn) saveBtn.textContent = 'Guardar torneo';
  const title = document.getElementById('tr_formTitle');
  if (title) title.textContent = 'Nuevo torneo';
}

/* =========================================================
 Jugadores (Players)
========================================================= */

// --- UI helpers (form colapsable) ---
function openPlayerForm(mode = 'new') {
  const wrap = document.getElementById('pl_formWrap');
  const title = document.getElementById('pl_formTitle');
  if (wrap) wrap.style.display = 'block';
  if (title) title.textContent = (mode === 'edit') ? 'Editar jugador' : 'Nuevo jugador';
  wrap?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePlayerForm() {
  const wrap = document.getElementById('pl_formWrap');
  if (wrap) wrap.style.display = 'none';
  clearPlayerForm();
}

// Helpers
function parseBirthToMs(val){
  // val viene yyyy-mm-dd => ms (local TZ)
  if (!val) return null;
  const ms = Date.parse(val);
  return Number.isNaN(ms) ? null : ms;
}
function calcAgeFromMs(ms){
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function escHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusDot(active) {
  const color = active ? '#2ecc71' : '#e74c3c';
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>`;
}

function renderPlayersTable(players) {
  const tbody = document.getElementById('playersTbody');
  if (!tbody) return;

  if (!players || !players.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="muted">No hay jugadores (o no coinciden con el filtro).</td></tr>`;
    return;
  }

  tbody.innerHTML = players.map(p => {
    const active = (p.active !== false);
    const birthStr = p.birthdate ? new Date(Number(p.birthdate)).toLocaleDateString() : '—';
    const ageStr = (p.age ?? '') === '' ? '—' : String(p.age);
    const photoUrl = p.photo_url ? escHtml(p.photo_url) : '';

    return `
      <tr data-id="${escHtml(p.id)}" style="border-bottom:1px solid rgba(255,255,255,.10);">
        <td style="padding:10px 8px;">${statusDot(active)}</td>
        <td style="padding:10px 8px;">${escHtml(p.dni ?? '—')}</td>
        <td style="padding:10px 8px;">${escHtml(p.first_name ?? '')}</td>
        <td style="padding:10px 8px;">${escHtml(p.last_name ?? '')}</td>
        <td style="padding:10px 8px;">${escHtml(p.category ?? '—')}</td>
        <td style="padding:10px 8px;">${escHtml(p.phone ?? '—')}</td>
        <td style="padding:10px 8px;">${escHtml(birthStr)}</td>
        <td style="padding:10px 8px;">${escHtml(ageStr)}</td>
        <td style="padding:10px 8px;">${active ? '✅' : '—'}</td>
        <td style="padding:10px 8px;">
          ${
            photoUrl
              ? `<img src="${photoUrl}" alt="Foto" style="width:34px;height:34px;border-radius:8px;object-fit:cover;border:1px solid rgba(255,255,255,.15);" />`
              : `<span class="muted">—</span>`
          }
        </td>
        <td style="padding:10px 8px; white-space:nowrap;">
          <button class="btn btn-pl-edit" title="Editar">✏️</button>
          ${
            active
              ? `<button class="btn btn-pl-del" title="Desactivar">🗑️</button>`
              : `<button class="btn btn-pl-react" title="Reactivar">♻️</button>`
          }
        </td>
      </tr>
    `;
  }).join('');

  // wire actions
  tbody.querySelectorAll('.btn-pl-edit').forEach(b => b.addEventListener('click', onEditPlayerFromRow));
  tbody.querySelectorAll('.btn-pl-del').forEach(b => b.addEventListener('click', onDeactivatePlayerFromRow));
  tbody.querySelectorAll('.btn-pl-react').forEach(b => b.addEventListener('click', onReactivatePlayerFromRow));
}
async function loadPlayers(){
  const params = new URLSearchParams();
  if (state.players.q) params.set('q', state.players.q);
  if (state.players.category) params.set('category', state.players.category);
  params.set('active', state.players.showInactive ? 'false' : 'true');
  params.set('limit', String(state.players.limit));
  params.set('offset', String(state.players.offset));
  // sort default -created_at
  params.set('sort', '-created_at');

  try {
    const { players } = await apiGet(`/api/players?${params.toString()}`);
    state.players.list = players ?? [];
    renderPlayersTable(state.players.list);
  } catch (e) {
    console.error('No se pudo cargar jugadores', e);
    renderPlayersTable([]);
  }
}

function onPlayerBirthChange(){
  const ms = parseBirthToMs($('#pl_birth').value);
  const age = calcAgeFromMs(ms);
  $('#pl_age').value = age === '' ? '' : String(age);
}

async function uploadPhoto(playerId, file) {
  const fd = new FormData();
  fd.append('file', file);

  const res = await fetch(`/api/players/${playerId}/photo`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Upload foto ${res.status}: ${txt}`);
  }

  return res.json();
}


async function savePlayer() {
  const payload = {
    first_name: document.getElementById('pl_first').value.trim(),
    last_name: document.getElementById('pl_last').value.trim(),
    dni: document.getElementById('pl_dni').value.trim(),
    phone: document.getElementById('pl_tel').value.trim(),
    birthdate: parseBirthToMs(document.getElementById('pl_birth').value),
    category: document.getElementById('pl_cat').value
  };

  const photoFile = document.getElementById('pl_photo')?.files?.[0] ?? null;

  if (!payload.first_name || !payload.last_name) {
    alert('Nombre y Apellido son requeridos');
    return;
  }

  try {
    let playerId = state.players.editingId;

    if (!playerId) {
      // Crear
      const created = await apiPost('/api/players', payload);
      playerId = created?.id;
    } else {
      // Editar
      await apiPatch(`/api/players/${playerId}`, payload);
    }

    // Subir foto si hay archivo
    if (photoFile && playerId) {
      await uploadPhoto(playerId, photoFile);
    }

    closePlayerForm();
    await loadPlayers();
  } catch (e) {
    alert('No se pudo guardar el jugador');
    console.error(e);
  }
}

function clearPlayerForm() {
  state.players.editingId = null;

  document.getElementById('pl_first').value = '';
  document.getElementById('pl_last').value = '';
  document.getElementById('pl_dni').value = '';
  document.getElementById('pl_tel').value = '';
  document.getElementById('pl_birth').value = '';
  document.getElementById('pl_age').value = '';
  document.getElementById('pl_cat').value = '';

  const photo = document.getElementById('pl_photo');
  if (photo) photo.value = '';

  const saveBtn = document.getElementById('pl_save');
  if (saveBtn) saveBtn.textContent = 'Guardar jugador';

  const title = document.getElementById('pl_formTitle');
  if (title) title.textContent = 'Nuevo jugador';
}

let playersSearchDebounce = null;
function onPlayersSearch(ev){
  const q = ev.target.value ?? '';
  if (playersSearchDebounce) clearTimeout(playersSearchDebounce);
  playersSearchDebounce = setTimeout(() => {
    state.players.q = q.trim();
    loadPlayers();
  }, 350);
}
function onPlayersFilterCat(ev){
  state.players.category = ev.target.value ?? '';
  loadPlayers();
}

function fillPlayerFormFromPlayer(p) {
  state.players.editingId = p.id;

  document.getElementById('pl_first').value = p.first_name ?? '';
  document.getElementById('pl_last').value = p.last_name ?? '';
  document.getElementById('pl_dni').value = p.dni ?? '';
  document.getElementById('pl_tel').value = p.phone ?? '';
  document.getElementById('pl_cat').value = p.category ?? '';

  // birthdate -> yyyy-mm-dd
  if (p.birthdate) {
    const dt = new Date(Number(p.birthdate));
    const y = dt.getFullYear();
    const m = two(dt.getMonth() + 1);
    const d = two(dt.getDate());
    document.getElementById('pl_birth').value = `${y}-${m}-${d}`;
  } else {
    document.getElementById('pl_birth').value = '';
  }

  document.getElementById('pl_age').value = p.age ?? '';
  document.getElementById('pl_save').textContent = 'Guardar cambios';
}

function onEditPlayerFromRow(ev) {
  const tr = ev.currentTarget.closest('tr');
  const id = tr?.dataset?.id;
  const p = state.players.list.find(x => x.id === id);
  if (!p) return;

  fillPlayerFormFromPlayer(p);
  openPlayerForm('edit');
}

async function onDeactivatePlayerFromRow(ev) {
  const tr = ev.currentTarget.closest('tr');
  const id = tr?.dataset?.id;
  if (!id) return;

  if (!confirm('¿Desactivar este jugador?')) return;
  try {
    await apiDelete(`/api/players/${id}`);
    await loadPlayers();
  } catch (e) {
    alert('No se pudo desactivar');
    console.error(e);
  }
}

async function onReactivatePlayerFromRow(ev) {
  const tr = ev.currentTarget.closest('tr');
  const id = tr?.dataset?.id;
  if (!id) return;

  if (!confirm('¿Reactivar este jugador?')) return;
  try {
    await apiPatch(`/api/players/${id}`, { active: true });
    await loadPlayers();
  } catch (e) {
    alert('No se pudo reactivar');
    console.error(e);
  }
}

/* =========================================================
 Top Tabs (Jugadores / Torneos / Partidos)
========================================================= */
function activateTopTab(name){
  state.topTab = name;
  $$('.top-tab').forEach(t => t.classList.toggle('active', t.dataset.top === name));
  const sections = {
    players: document.getElementById('playersSection'),
    tournaments: document.getElementById('tournamentsSection'),
    matches: document.getElementById('matchesSection'),
  };
  Object.entries(sections).forEach(([k,el]) => el?.classList.toggle('active', k === name));
}
function bindTopTabs(){
  const topTabs = document.getElementById('topTabs');
  if (!topTabs) return;
  topTabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.top-tab');
    if (!btn) return;
    activateTopTab(btn.dataset.top);
    // on change, si voy a jugadores => refresco
    if (btn.dataset.top === 'players') loadPlayers();
if (btn.dataset.top === 'tournaments') loadTournaments();
  });
  // por defecto matches
  activateTopTab('matches');
}

/* ==============================
 Bootstrap
============================== */
function bindUI(){
  // === Top Tabs (nuevas)
  bindTopTabs();

  // === Partidos
  // Tabs internos
  $('#tabs')?.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab');
    if (!tab) return;
    setTab(tab.dataset.tab);
  });
  // Filtros
  $('#searchQ')?.addEventListener('input', onSearchInput);
  $('#filterStage')?.addEventListener('change', onFilterStage);
  $('#sortBy')?.addEventListener('change', onSortChange);
  $('#refreshBtn')?.addEventListener('click', refreshLists);
  // Crear partido
  $('#createBtn')?.addEventListener('click', onCreateMatch);
  // Modal partidos
  $('#editSaveBtn')?.addEventListener('click', onEditSave);
  $('#editCancelBtn')?.addEventListener('click', closeEditModal);
  // Modal Ads
  $('#adsUploadBtn')?.addEventListener('click', uploadAdsForMatch);
  $('#adsCloseBtn')?.addEventListener('click', closeAdsModal);
  // Cerrar adsModal clickeando el fondo
  adsModal?.addEventListener('click', (ev) => { if (ev.target === adsModal) closeAdsModal(); });
  // Cerrar modal partidos clickeando fuera
  editModal?.addEventListener('click', (ev) => { if (ev.target === editModal) closeEditModal(); });

  // === Jugadores
  $('#pl_birth')?.addEventListener('change', onPlayerBirthChange);
  $('#pl_q')?.addEventListener('input', onPlayersSearch);
  $('#pl_filter_cat')?.addEventListener('change', onPlayersFilterCat);
  $('#pl_refreshBtn')?.addEventListener('click', loadPlayers);
  $('#pl_save')?.addEventListener('click', savePlayer);
document.getElementById('pl_newBtn')?.addEventListener('click', () => {
  clearPlayerForm();
  openPlayerForm('new');
});

document.getElementById('pl_cancel')?.addEventListener('click', () => {
  closePlayerForm();
});

document.getElementById('pl_showInactive')?.addEventListener('change', (ev) => {
  state.players.showInactive = !!ev.target.checked;
  loadPlayers();
});

// === Torneos
  document.getElementById('tr_newBtn')?.addEventListener('click', () => {
    clearTournamentForm();
    openTournamentForm('new');
  });

  document.getElementById('tr_cancel')?.addEventListener('click', () => {
    closeTournamentForm();
  });

  document.getElementById('tr_save')?.addEventListener('click', saveTournament);

  document.getElementById('tr_q')?.addEventListener('input', (ev) => {
    const q = ev.target.value ?? '';
    clearTimeout(window.__trSearchDebounce);
    window.__trSearchDebounce = setTimeout(() => {
      state.tournaments.q = q.trim();
      loadTournaments();
    }, 350);
  });

  document.getElementById('tr_filter_cat')?.addEventListener('change', (ev) => {
    state.tournaments.category = ev.target.value ?? '';
    loadTournaments();
  });

  document.getElementById('tr_filter_status')?.addEventListener('change', (ev) => {
    state.tournaments.status = ev.target.value ?? '';
    loadTournaments();
  });

  document.getElementById('tr_refreshBtn')?.addEventListener('click', loadTournaments);

}



async function bootstrap(){
 bindUI();
 await loadStages();
 // await refreshLists();
 setTab('active');
 ensureSocket();
 startTicker();
}


/* =========================================================
 Ads modal helpers
========================================================= */
async function openAdsModal(matchId){
  adsForId = matchId;
  if (adsFilesInput) adsFilesInput.value = '';
  await refreshAdsList();
  adsModal.style.display = 'flex';
}
function closeAdsModal(){
  adsModal.style.display = 'none';
  adsForId = null;
}
async function refreshAdsList(){
  if (!adsForId) return;
  try {
    const { urls } = await apiGet(`/api/matches/${adsForId}/ads`);
    renderAdsGrid(urls ?? []);
  } catch (e) {
    console.error('No se pudo cargar publicidad', e);
    renderAdsGrid([]);
  }
}
function renderAdsGrid(urls){
  adsListEl.innerHTML = '';
  if (!urls.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No hay imágenes cargadas aún.';
    adsListEl.appendChild(empty);
    return;
  }
  urls.forEach(url => {
    const cell = document.createElement('div');
    cell.style.background = '#0f4b38';
    cell.style.border = '1px solid #093628';
    cell.style.borderRadius = '6px';
    cell.style.padding = '8px';
    cell.style.display = 'flex';
    cell.style.flexDirection = 'column';
    cell.style.gap = '6px';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Publicidad';
    img.style.width = '100%';
    img.style.maxHeight = '120px';
    img.style.objectFit = 'contain';
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    const urlSmall = document.createElement('small');
    urlSmall.className = 'muted';
    urlSmall.style.display = 'inline-block';
    urlSmall.style.maxWidth = '75%';
    urlSmall.style.overflow = 'hidden';
    urlSmall.style.textOverflow = 'ellipsis';
    urlSmall.title = url;
    urlSmall.textContent = url;
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Eliminar';
    del.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta imagen?')) return;
      await apiDeleteAd(adsForId, url);
      await refreshAdsList();
      await softRefreshMatch(adsForId);
    });
    row.appendChild(urlSmall);
    row.appendChild(del);
    cell.appendChild(img);
    cell.appendChild(row);
    adsListEl.appendChild(cell);
  });
}
async function uploadAdsForMatch(){
  if (!adsForId) return;
  const files = adsFilesInput.files;
  if (!files || !files.length) {
    alert('Seleccioná una o más imágenes.');
    return;
  }
  const fd = new FormData();
  Array.from(files).forEach(f => fd.append('files', f));
  try {
    const res = await fetch(`/api/matches/${adsForId}/ads`, {
      method: 'POST',
      body: fd,
      credentials: 'include'
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      console.error('Upload error:', res.status, txt);
      alert('No se pudieron subir las imágenes.');
      return;
    }
    await refreshAdsList();
    await softRefreshMatch(adsForId);
  } catch (e) {
    console.error(e);
    alert('Error de red al subir imágenes.');
  }
}
async function apiDeleteAd(matchId, url){
  const res = await fetch(`/api/matches/${matchId}/ads?` + new URLSearchParams({ url }), {
    method: 'DELETE',
    credentials: 'include'
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Go!
// Go! (espera a que admin-auth habilite la sesión)
window.addEventListener('admin:ready', async () => {
  if (window.__adminBootstrapped) return;
  window.__adminBootstrapped = true;

  await initClubSwitcher();
 await bootstrap();
 await refreshLists();
});