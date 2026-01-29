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
    limit: 50,
    offset: 0,
    editingId: null, // null => creando
    // cache de categorías (opcional)
    categories: ['C1','C2','C3','C4','C5','C6','C7','C8','C9','D1','D2','D3','D4','D5','D6','D7','D8','D9']
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
 Jugadores (Players)
========================================================= */
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

// Render de listado de jugadores
function renderPlayersList(players){
  const list = $('#playersList');
  list.innerHTML = '';
  if (!players || !players.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No hay jugadores (o no coinciden con el filtro).';
    list.appendChild(empty);
    return;
  }
  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '10px';
    const fullName = `${p.last_name ?? ''}, ${p.first_name ?? ''}`.trim();
    const birthStr = p.birthdate ? new Date(Number(p.birthdate)).toLocaleDateString() : '—';
    const ageStr = (p.age ?? '') === '' ? '—' : String(p.age ?? '—');
    const cat = p.category ?? '—';
    const phone = p.phone ?? '—';
    const dni = p.dni ?? '—';
    const active = p.active !== false;

    card.innerHTML = `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div style="min-width:260px;">
          <div><strong>${fullName}</strong></div>
          <div class="muted">DNI: ${dni} • Tel: ${phone}</div>
          <div class="muted">Nac: ${birthStr} • Edad: ${ageStr} • Cat: ${cat}</div>
          <div class="muted">ID: ${p.id}</div>
        </div>
        <div class="right">
          <span class="badge">${active ? 'Activo' : 'Inactivo'}</span>
        </div>
      </div>
      <div class="actions wrap" style="margin-top:8px;">
        <button class="btn btn-pl-edit">Editar</button>
        <button class="btn btn-pl-del">Desactivar</button>
      </div>
    `;

    // wire actions
    card.querySelector('.btn-pl-edit').addEventListener('click', () => {
      // Setear edición en el form
      state.players.editingId = p.id;
      $('#pl_first').value = p.first_name ?? '';
      $('#pl_last').value  = p.last_name ?? '';
      $('#pl_dni').value   = p.dni ?? '';
      $('#pl_tel').value   = p.phone ?? '';
      // Birthdate -> yyyy-mm-dd
      if (p.birthdate) {
        const dt = new Date(Number(p.birthdate));
        const y = dt.getFullYear();
        const m = two(dt.getMonth()+1);
        const d = two(dt.getDate());
        $('#pl_birth').value = `${y}-${m}-${d}`;
      } else {
        $('#pl_birth').value = '';
      }
      $('#pl_age').value   = p.age ?? '';
      $('#pl_cat').value   = p.category ?? '';
      // Cambiamos texto del botón
      $('#pl_save').textContent = 'Guardar cambios';
      // Scroll al form
      document.getElementById('playersSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    card.querySelector('.btn-pl-del').addEventListener('click', async () => {
      if (!confirm('¿Desactivar este jugador?')) return;
      try {
        await apiDelete(`/api/players/${p.id}`);
        await loadPlayers(); // refresco
      } catch (e) {
        alert('No se pudo desactivar');
      }
    });

    list.appendChild(card);
  });
}

async function loadPlayers(){
  const params = new URLSearchParams();
  if (state.players.q) params.set('q', state.players.q);
  if (state.players.category) params.set('category', state.players.category);
  params.set('active', 'true');
  params.set('limit', String(state.players.limit));
  params.set('offset', String(state.players.offset));
  // sort default -created_at
  params.set('sort', '-created_at');

  try {
    const { players } = await apiGet(`/api/players?${params.toString()}`);
    state.players.list = players ?? [];
    renderPlayersList(state.players.list);
  } catch (e) {
    console.error('No se pudo cargar jugadores', e);
    renderPlayersList([]);
  }
}

function onPlayerBirthChange(){
  const ms = parseBirthToMs($('#pl_birth').value);
  const age = calcAgeFromMs(ms);
  $('#pl_age').value = age === '' ? '' : String(age);
}

async function savePlayer(){
  const payload = {
    first_name: $('#pl_first').value.trim(),
    last_name:  $('#pl_last').value.trim(),
    dni:        $('#pl_dni').value.trim(),
    phone:      $('#pl_tel').value.trim(),
    birthdate:  parseBirthToMs($('#pl_birth').value),
    category:   $('#pl_cat').value
  };

  if (!payload.first_name || !payload.last_name) {
    alert('Nombre y Apellido son requeridos');
    return;
  }

  try {
    if (!state.players.editingId) {
      // Crear
      await apiPost('/api/players', payload);
      clearPlayerForm();
    } else {
      // Editar
      await apiPatch(`/api/players/${state.players.editingId}`, payload);
      clearPlayerForm();
    }
    await loadPlayers();
  } catch (e) {
    alert('No se pudo guardar el jugador');
    console.error(e);
  }
}

function clearPlayerForm(){
  state.players.editingId = null;
  $('#pl_first').value = '';
  $('#pl_last').value  = '';
  $('#pl_dni').value   = '';
  $('#pl_tel').value   = '';
  $('#pl_birth').value = '';
  $('#pl_age').value   = '';
  $('#pl_cat').value   = '';
  $('#pl_save').textContent = 'Guardar jugador';
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
}

async function bootstrap(){
  bindUI();
  await loadStages();
  await refreshLists();
  setTab('active');
  ensureSocket();
  startTicker();

  // Cargar jugadores si la pestaña actual es players (no lo es por defecto)
  // pero si querés precargar la data, descomentá la siguiente línea:
  // await loadPlayers();
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
bootstrap();