
// public/display.js — Paso 4/4 (ajustes finales tablero moderno)

// ====== Parámetros por query ======
const qs = new URLSearchParams(window.location.search);
const matchId = qs.get('match');
const originBase = window.location.origin;

// Config carrusel
const adDurationSec = Math.max(1, parseInt(qs.get('adSec') || '6', 10)); // default 6s
const adObjectFit  = (qs.get('adFit') || 'contain').toLowerCase();       // contain | cover

// ====== Elementos del DOM ======
const el = {
  // Top
  clock: document.getElementById('clock'),
  elapsed: document.getElementById('elapsed'),
  matchTitle: document.getElementById('matchTitle'),
  matchStage: document.getElementById('matchStage'),
  matchCourt: document.getElementById('matchCourt'),

  // Nombres

  nameA_first: document.getElementById('nameA_first'),
  nameA_last:  document.getElementById('nameA_last'),
  nameB_first: document.getElementById('nameB_first'),
  nameB_last:  document.getElementById('nameB_last'),

  // Saque
  serveA: document.getElementById('serveA'),
  serveB: document.getElementById('serveB'),

  // Sets por fila
  setsRowA: document.getElementById('setsRowA'),
  setsRowB: document.getElementById('setsRowB'),

  // Puntos del game (caja roja)
  pointsA: document.getElementById('pointsA'),
  pointsB: document.getElementById('pointsB'),

  // Ads
  adsContainer: document.getElementById('adsContainer'),
  adsDots: document.getElementById('adsDots')
};

// ====== State local ======
let state = null;

// Carrusel
let ads = [];              // array de URLs
let adIdx = 0;
let adTimer = null;
let adsSlides = [];        // nodos de slides
let adsPaused = false;     // pausa automática cuando el partido está pausado

// ====== Utilidades ======
function two(n){ return String(n).padStart(2,'0'); }
function formatHMS(ms){
  const sec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec % 60;
  return `${two(h)}:${two(m)}:${two(s)}`;
}
function computeElapsed(st){
  let elapsed = st.accumulatedMs || 0;
  if (st.running) {
    const refStart = st.startedAt ?? Date.now();
    elapsed += (Date.now() - refStart);
  }
  return elapsed;
}
function tickClocks() {
  const now = new Date();
  el.clock.textContent = `${two(now.getHours())}:${two(now.getMinutes())}`;
  if (!state) return;
  el.elapsed.textContent = formatHMS(computeElapsed(state));
}
setInterval(tickClocks, 1000);
tickClocks();

// Split de nombre “Nombre Apellido” → { first, last: UPPER }
function splitName(raw){
  const name = (raw || '').trim();
  if (!name) return { first: '', last: '' };

  // Si es formato “X/Y” (pareja), lo mostramos todo como "last" en mayúscula
  if (name.includes('/') && !name.includes(' ')) {
    return { first: '', last: name.toUpperCase() };
  }
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0].toUpperCase() };
  const last = parts.pop().toUpperCase();
  const first = parts.join(' ');
  return { first, last };
}
function mapPoints(p) {
  const map = ['0','15','30','40'];
  return map[Math.min(p, 3)] || '0';
}

// ====== Render Top/Meta ======
function renderInfoBar(st) {
  el.matchTitle.textContent = st.name || 'Partido';
  el.matchStage.textContent = st.stage || 'Amistoso';
  // Si no hay cancha, mostrar “—” (evita ver “Cancha undefined”)
  el.matchCourt.textContent = `Cancha ${st.courtName && st.courtName.trim() ? st.courtName : '—'}`;
}

// ====== Render nombres + saque ======
function renderNamesAndServe(st){
  const a = splitName(st.teams[0]?.name || 'Equipo A');
  const b = splitName(st.teams[1]?.name || 'Equipo B');

  el.nameA_first.textContent = a.first;
  el.nameA_last.textContent  = a.last;
  el.nameB_first.textContent = b.first;
  el.nameB_last.textContent  = b.last;

  // Pelotita amarilla
  el.serveA.classList.toggle('on', st.serverIndex === 0);
  el.serveB.classList.toggle('on', st.serverIndex === 1);
}

// ====== Render sets (incluye el set actual y resalta el último) ======
function clearChildren(node){ while (node.firstChild) node.removeChild(node.firstChild); }
function makeSetCell(value, isCurrent){
  const c = document.createElement('div');
  c.className = 'setcell';
  c.textContent = value ?? 0;
  if (isCurrent) {
    // resaltar sutilmente el set en juego
    c.style.boxShadow = '0 0 0 2px rgba(225,211,110,.25), inset 0 0 0 1px #0b2f23';
    c.style.background = '#135843';
  }
  return c;
}
function renderSets(st){
  const sets = st.sets || [];
  const lastIdx = Math.max(0, sets.length - 1);

  clearChildren(el.setsRowA);
  clearChildren(el.setsRowB);

  if (!sets.length) {
    el.setsRowA.appendChild(makeSetCell(0, true));
    el.setsRowB.appendChild(makeSetCell(0, true));
    return;
  }

  sets.forEach((s, i) => {
    const gA = s.gamesA ?? 0;
    const gB = s.gamesB ?? 0;
    el.setsRowA.appendChild(makeSetCell(gA, i === lastIdx));
    el.setsRowB.appendChild(makeSetCell(gB, i === lastIdx));
  });
}

// ====== Render puntos del game (caja roja) ======
function renderPoints(st){
  const set = st.sets[st.sets.length - 1] || { tieBreak: { active:false } };
  const tb = set.tieBreak || { active:false };

  if (tb.active) {
    el.pointsA.textContent = set.tieBreak.pointsA ?? 0;
    el.pointsB.textContent = set.tieBreak.pointsB ?? 0;
    return;
  }

  if (st.rules.noAdvantage) {
    el.pointsA.textContent = mapPoints(st.currentGame.pointsA || 0);
    el.pointsB.textContent = mapPoints(st.currentGame.pointsB || 0);
  } else {
    const g = st.currentGame;
    if (g.pointsA === 3 && g.pointsB === 3) {
      if (g.advantage === 'A') { el.pointsA.textContent = 'V'; el.pointsB.textContent = '40'; }
      else if (g.advantage === 'B') { el.pointsA.textContent = '40'; el.pointsB.textContent = 'V'; }
      else { el.pointsA.textContent = '40'; el.pointsB.textContent = '40'; }
    } else {
      el.pointsA.textContent = mapPoints(g.pointsA || 0);
      el.pointsB.textContent = mapPoints(g.pointsB || 0);
    }
  }
}

// ====== Carrusel de Publicidades ======
function clearAdTimer(){
  if (adTimer) clearInterval(adTimer);
  adTimer = null;
}
function setActiveSlide(idx){
  adsSlides.forEach((slide, i) => {
    slide.classList.toggle('active', i === idx);
  });
  Array.from(el.adsDots.children).forEach((dot, i) => {
    dot.classList.toggle('active', i === idx);
  });
}
function buildAdsSlides(urls){
  el.adsContainer.querySelectorAll('.ads-slide').forEach(n => n.remove());
  el.adsDots.innerHTML = '';
  adsSlides = [];

  if (!urls.length) {
    el.adsContainer.style.display = 'none';
    return;
  }
  el.adsContainer.style.display = '';

  urls.forEach((url, i) => {
    const slide = document.createElement('div');
    slide.className = 'ads-slide';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Publicidad';
    img.decoding = 'async';
    img.loading = 'eager';
    img.style.objectFit = adObjectFit === 'cover' ? 'cover' : 'contain';
    slide.appendChild(img);
    el.adsContainer.appendChild(slide);
    adsSlides.push(slide);

    const dot = document.createElement('div');
    dot.className = 'ads-dot';
    dot.addEventListener('click', () => {
      adIdx = i;
      setActiveSlide(adIdx);
      // Reiniciar sólo si no está pausado por “match paused”
      if (!adsPaused) {
        clearAdTimer();
        adTimer = setInterval(nextAd, adDurationSec * 1000);
      }
    });
    el.adsDots.appendChild(dot);
  });

  adIdx = 0;
  setActiveSlide(adIdx);
  restartAdsTimer();
}
function nextAd(){
  if (!adsSlides.length) return;
  adIdx = (adIdx + 1) % adsSlides.length;
  setActiveSlide(adIdx);
}
function updateAds(urls){
  const curr = (ads || []).slice().sort().join('|');
  const incoming = (urls || []).slice().sort().join('|');
  if (curr === incoming) return; // no cambios
  ads = urls || [];
  buildAdsSlides(ads);
}


async function refreshAdsFromApi(){
  try {
    const r = await fetch(`/api/matches/${matchId}/ads`);
    if (!r.ok) return;
    const { urls } = await r.json();
    // Fuerza reconstrucción con lo que diga el backend
    buildAdsSlides(urls || []);
  } catch (e) {
    console.warn('No se pudieron cargar ads por REST', e);
  }
}


// Control de pausa/reanudación del carrusel según estado del partido
function restartAdsTimer(){
  clearAdTimer();
  if (adsPaused) return;
  if (adsSlides.length) adTimer = setInterval(nextAd, adDurationSec * 1000);
}
function applyAdsPauseFromState(st){
  const shouldPause = !st.running; // si el partido está pausado o finalizado, pausamos
  if (shouldPause !== adsPaused) {
    adsPaused = shouldPause;
    restartAdsTimer();
  }
}

// ====== Render general ======
function render(st){
  state = st;
  renderInfoBar(st);
  renderNamesAndServe(st);
  renderSets(st);
  renderPoints(st);
  buildAdsSlides(st.ads || []); // Fuerza reconstruir siempre las slides con lo que llega
  applyAdsPauseFromState(st);
  tickClocks();
}

// ====== Bootstrap / Socket ======
async function bootstrap(){
  if (!matchId) {
    alert('Falta ?match=ID en la URL');
    return;
  }

  const socket = io(originBase, { transports: ['websocket'] });
  socket.on('connect', () => {
    socket.emit('join', matchId);
  });
  socket.on('state', (s) => {
    render(s);
  });

  // Estado inicial
  try {
    const res = await fetch(`/api/matches/${matchId}`);
    if (res.ok) {
      const s = await res.json();
      render(s);
    }
  } catch (e) {
    console.error('No se pudo obtener estado inicial', e);
  }
}
bootstrap();


