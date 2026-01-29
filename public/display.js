// public/display.js — tablero moderno + carrusel ads (robusto)
(() => {
  // ====== Parámetros por query ======
  const qs = new URLSearchParams(window.location.search);
  const matchId = qs.get('match') || qs.get('id') || qs.get('m');
  const originBase = window.location.origin;

  // Config carrusel
  const adDurationSec = Math.max(1, parseInt(qs.get('adSec') || '6', 10)); // default 6s
  const adObjectFit = (qs.get('adFit') || 'contain').toLowerCase(); // contain | cover
  const pauseAdsWithMatch = (qs.get('pauseAds') || '0') === '1'; // default: NO pausa

  // ====== Elementos del DOM ======
  const el = {
    clock: document.getElementById('clock'),
    elapsed: document.getElementById('elapsed'),
    matchTitle: document.getElementById('matchTitle'),
    matchStage: document.getElementById('matchStage'),
    matchCourt: document.getElementById('matchCourt'),

    nameA_first: document.getElementById('nameA_first'),
    nameA_last: document.getElementById('nameA_last'),
    nameB_first: document.getElementById('nameB_first'),
    nameB_last: document.getElementById('nameB_last'),

    serveA: document.getElementById('serveA'),
    serveB: document.getElementById('serveB'),

    setsRowA: document.getElementById('setsRowA'),
    setsRowB: document.getElementById('setsRowB'),

    pointsA: document.getElementById('pointsA'),
    pointsB: document.getElementById('pointsB'),

    adsContainer: document.getElementById('adsContainer'),
    adsDots: document.getElementById('adsDots'),
  };

  // ====== State local ======
  let state = null;

  // Carrusel
  let ads = [];
  let adIdx = 0;
  let adTimer = null;
  let adsSlides = [];
  let adsPaused = false;

  // ====== Utilidades ======
  const two = (n) => String(n).padStart(2, '0');

  function formatHMS(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${two(h)}:${two(m)}:${two(s)}`;
  }

  function computeElapsed(st) {
    let elapsed = st.accumulatedMs || 0;
    if (st.running) {
      const refStart = st.startedAt ?? Date.now();
      elapsed += (Date.now() - refStart);
    }
    return elapsed;
  }

  function tickClocks() {
    const now = new Date();
    if (el.clock) el.clock.textContent = `${two(now.getHours())}:${two(now.getMinutes())}`;
    if (!state) return;
    if (el.elapsed) el.elapsed.textContent = formatHMS(computeElapsed(state));
  }
  setInterval(tickClocks, 1000);
  tickClocks();

  // Split de nombre “Nombre Apellido” → { first, last: UPPER }
  function splitName(raw) {
    const name = (raw || '').trim();
    if (!name) return { first: '', last: '' };

    // formato “X/Y” pareja sin espacios -> todo como last
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
    const map = ['0', '15', '30', '40'];
    return map[Math.min(p, 3)] || '0';
  }

  // ====== Render Top/Meta ======
  function renderInfoBar(st) {
    el.matchTitle.textContent = st.name || 'Partido';
    el.matchStage.textContent = st.stage || 'Amistoso';
    el.matchCourt.textContent = `Cancha ${st.courtName && st.courtName.trim() ? st.courtName : '—'}`;
  }

  // ====== Render nombres + saque ======
  function renderNamesAndServe(st) {
    const a = splitName(st.teams?.[0]?.name || 'Equipo A');
    const b = splitName(st.teams?.[1]?.name || 'Equipo B');

    el.nameA_first.textContent = a.first;
    el.nameA_last.textContent = a.last;
    el.nameB_first.textContent = b.first;
    el.nameB_last.textContent = b.last;

    el.serveA.classList.toggle('on', st.serverIndex === 0);
    el.serveB.classList.toggle('on', st.serverIndex === 1);
  }

  // ====== Render sets ======
  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function makeSetCell(value, isCurrent) {
    const c = document.createElement('div');
    c.className = 'setcell';
    c.textContent = value ?? 0;
    if (isCurrent) {
      c.style.boxShadow = '0 0 0 2px rgba(225,211,110,.25), inset 0 0 0 1px #0b2f23';
      c.style.background = '#135843';
    }
    return c;
  }

  function renderSets(st) {
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
  function renderPoints(st) {
    const set = st.sets?.[st.sets.length - 1] ?? { tieBreak: { active: false } };
    const tb = set.tieBreak ?? { active: false };

    if (tb.active) {
      el.pointsA.textContent = set.tieBreak.pointsA ?? 0;
      el.pointsB.textContent = set.tieBreak.pointsB ?? 0;
      return;
    }

    const g = st.currentGame || { pointsA: 0, pointsB: 0, advantage: null };

    if (st.rules?.noAdvantage) {
      el.pointsA.textContent = mapPoints(g.pointsA ?? 0);
      el.pointsB.textContent = mapPoints(g.pointsB ?? 0);
      return;
    }

    // ventaja clásica
    if (g.pointsA === 3 && g.pointsB === 3) {
      if (g.advantage === 'A') { el.pointsA.textContent = 'V'; el.pointsB.textContent = '40'; return; }
      if (g.advantage === 'B') { el.pointsA.textContent = '40'; el.pointsB.textContent = 'V'; return; }
      el.pointsA.textContent = '40'; el.pointsB.textContent = '40';
      return;
    }

    el.pointsA.textContent = mapPoints(g.pointsA ?? 0);
    el.pointsB.textContent = mapPoints(g.pointsB ?? 0);
  }

  // ====== Carrusel de Publicidades (robusto) ======
  function clearAdTimer() {
    if (adTimer) clearInterval(adTimer);
    adTimer = null;
  }

  function setActiveSlide(idx) {
    adsSlides.forEach((slide, i) => slide.classList.toggle('active', i === idx));
    Array.from(el.adsDots.children).forEach((dot, i) => dot.classList.toggle('active', i === idx));
  }

  function restartAdsTimer() {
    clearAdTimer();
    if (adsPaused) return;
    if (adsSlides.length) adTimer = setInterval(nextAd, adDurationSec * 1000);
  }

  function applyAdsPauseFromState(st) {
    if (!pauseAdsWithMatch) {
      adsPaused = false;
      restartAdsTimer();
      return;
    }
    const shouldPause = !st.running;
    if (shouldPause !== adsPaused) {
      adsPaused = shouldPause;
      restartAdsTimer();
    }
  }

  function buildAdsSlides(urls) {
    el.adsContainer.style.display = '';

    // borrar slides anteriores
    el.adsContainer.querySelectorAll('.ads-slide').forEach((n) => n.remove());
    el.adsDots.innerHTML = '';
    adsSlides = [];

    if (!urls || !urls.length) {
      const empty = document.createElement('div');
      empty.className = 'ads-slide active';
      empty.innerHTML = `<div class="ads-empty">Sin publicidades cargadas</div>`;
      el.adsContainer.insertBefore(empty, el.adsDots);
      adsSlides = [empty];
      adIdx = 0;
      restartAdsTimer();
      return;
    }

    urls.forEach((url, i) => {
      const slide = document.createElement('div');
      slide.className = 'ads-slide';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Publicidad';
      img.decoding = 'async';
      img.loading = 'eager';
      img.style.objectFit = (adObjectFit === 'cover') ? 'cover' : 'contain';
      slide.appendChild(img);

      el.adsContainer.insertBefore(slide, el.adsDots);
      adsSlides.push(slide);

      const dot = document.createElement('div');
      dot.className = 'ads-dot';
      dot.addEventListener('click', () => {
        adIdx = i;
        setActiveSlide(adIdx);
        restartAdsTimer();
      });
      el.adsDots.appendChild(dot);
    });

    adIdx = 0;
    setActiveSlide(adIdx);
    restartAdsTimer();
  }

  function nextAd() {
    if (!adsSlides.length) return;
    adIdx = (adIdx + 1) % adsSlides.length;
    setActiveSlide(adIdx);
  }

  function normalizeAds(urls) {
    return (urls || [])
      .filter(Boolean)
      .map(String)
      .filter((u, i, arr) => arr.indexOf(u) === i); // unique stable
  }

  function updateAds(urls) {
    const incoming = normalizeAds(urls);
    const curr = ads.join('|');
    const next = incoming.join('|');
    if (curr === next) return; // no cambia => NO tocar timer/DOM

    ads = incoming;
    buildAdsSlides(ads);
  }

  async function refreshAdsFromApi() {
    if (!matchId) return;
    try {
      const r = await fetch(`/api/matches/${matchId}/ads`);
      if (!r.ok) return;
      const data = await r.json();
      updateAds(data.urls || []);
    } catch (e) {
      console.warn('No se pudieron cargar ads por REST', e);
    }
  }

  // ====== Render general ======
  function render(st) {
    state = st;

    renderInfoBar(st);
    renderNamesAndServe(st);
    renderSets(st);
    renderPoints(st);

    // ✅ clave: solo reconstruir carrusel si cambió la lista
    updateAds(st.ads || []);

    applyAdsPauseFromState(st);
    tickClocks();
  }

  // ====== Bootstrap / Socket ======
  async function bootstrap() {
    if (!matchId) {
      alert('Falta ?match=ID o ?id=ID en la URL');
      return;
    }

    // Estado inicial (incluye ads normalmente)
    try {
      const res = await fetch(`/api/matches/${matchId}`);
      if (res.ok) render(await res.json());
    } catch (e) {
      console.error('No se pudo obtener estado inicial', e);
    }

    // Fallback adicional para ads (por si el estado inicial vino sin ads)
    refreshAdsFromApi();

    const socket = io(originBase, { transports: ['websocket'] });
    socket.on('connect', () => socket.emit('join', matchId));
    socket.on('state', (s) => render(s));
  }

  bootstrap();
})();
