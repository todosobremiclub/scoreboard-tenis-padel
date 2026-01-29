// public/display.js — layout 3 columnas + banner grande + responsive (ads estable + fix desktop)
(() => {
  const qs = new URLSearchParams(window.location.search);
  const matchId = qs.get('match') || qs.get('id') || qs.get('m'); // soporta varias keys
  const originBase = window.location.origin;

  const adDurationSec = Math.max(1, parseInt(qs.get('adSec') || '6', 10));
  const adObjectFit = (qs.get('adFit') || 'contain').toLowerCase(); // contain|cover
  const pauseAdsWithMatch = (qs.get('pauseAds') || '0') === '1'; // si 1, pausa con el partido

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

    prevRowA: document.getElementById('prevRowA'),
    prevRowB: document.getElementById('prevRowB'),

    setsA: document.getElementById('setsA'),
    setsB: document.getElementById('setsB'),
    gamesA: document.getElementById('gamesA'),
    gamesB: document.getElementById('gamesB'),
    pointsA: document.getElementById('pointsA'),
    pointsB: document.getElementById('pointsB'),

    adsContainer: document.getElementById('adsContainer'),
    adsDots: document.getElementById('adsDots'),
  };

  let state = null;

  // =========================
  // FIX INFALIBLE: Desktop oculta #adsContainer con display:none
  // => Forzamos visible desde JS con !important
  // =========================
  function forceShowAds() {
    if (!el.adsContainer) return;
    el.adsContainer.style.setProperty('display', 'block', 'important');
    el.adsContainer.style.setProperty('visibility', 'visible', 'important');
    el.adsContainer.style.setProperty('opacity', '1', 'important');
  }
  forceShowAds();

  // ---- Clock
  const two = (n) => String(n).padStart(2, '0');
  const formatHMS = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${two(h)}:${two(m)}:${two(s)}`;
  };

  function computeElapsed(st) {
    let elapsed = st.accumulatedMs || 0;
    if (st.running) {
      const refStart = st.startedAt ?? Date.now();
      elapsed += (Date.now() - refStart);
    }
    return elapsed;
  }

  function tick() {
    const now = new Date();
    if (el.clock) el.clock.textContent = `${two(now.getHours())}:${two(now.getMinutes())}`;
    if (state && el.elapsed) el.elapsed.textContent = formatHMS(computeElapsed(state));
  }
  setInterval(tick, 1000);
  tick();

  // ---- Helpers
  function splitName(raw) {
    const name = (raw || '').trim();
    if (!name) return { first: '', last: '' };
    if (name.includes('/') && !name.includes(' ')) return { first: '', last: name.toUpperCase() };
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

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- Render
  function renderHeader(st) {
    if (el.matchTitle) el.matchTitle.textContent = st.name || 'Partido';
    if (el.matchStage) el.matchStage.textContent = (st.stage || 'Amistoso').toUpperCase();
    if (el.matchCourt) el.matchCourt.textContent = (st.courtName && st.courtName.trim())
      ? `Cancha ${st.courtName}`
      : 'Cancha —';
  }

  function renderNames(st) {
    const a = splitName(st.teams?.[0]?.name || 'Equipo A');
    const b = splitName(st.teams?.[1]?.name || 'Equipo B');

    if (el.nameA_first) el.nameA_first.textContent = a.first;
    if (el.nameA_last) el.nameA_last.textContent = a.last;
    if (el.nameB_first) el.nameB_first.textContent = b.first;
    if (el.nameB_last) el.nameB_last.textContent = b.last;

    if (el.serveA) el.serveA.classList.toggle('on', st.serverIndex === 0);
    if (el.serveB) el.serveB.classList.toggle('on', st.serverIndex === 1);
  }

  // previous sets = games por set
  function prevCell(val, empty = false) {
    const d = document.createElement('div');
    d.className = `prevcell${empty ? ' empty' : ''}`;
    d.textContent = empty ? ' ' : String(val ?? 0);
    return d;
  }

  function renderPreviousSets(st) {
    const sets = st.sets || [];
    const finished = st.status === 'finished';
    const prev = finished ? sets : sets.slice(0, Math.max(0, sets.length - 1));

    clear(el.prevRowA);
    clear(el.prevRowB);

    const SLOTS = 5;
    for (let i = 0; i < SLOTS; i++) {
      const s = prev[i];
      if (!s) {
        el.prevRowA?.appendChild(prevCell(0, true));
        el.prevRowB?.appendChild(prevCell(0, true));
      } else {
        el.prevRowA?.appendChild(prevCell(s.gamesA ?? 0));
        el.prevRowB?.appendChild(prevCell(s.gamesB ?? 0));
      }
    }
  }

  function renderMetrics(st) {
    if (el.setsA) el.setsA.textContent = String(st.setsWonA ?? 0);
    if (el.setsB) el.setsB.textContent = String(st.setsWonB ?? 0);

    const set = st.sets?.[st.sets.length - 1] ?? { gamesA: 0, gamesB: 0, tieBreak: { active: false } };
    if (el.gamesA) el.gamesA.textContent = String(set.gamesA ?? 0);
    if (el.gamesB) el.gamesB.textContent = String(set.gamesB ?? 0);

    const tb = set.tieBreak ?? { active: false };
    if (tb.active) {
      if (el.pointsA) el.pointsA.textContent = String(tb.pointsA ?? 0);
      if (el.pointsB) el.pointsB.textContent = String(tb.pointsB ?? 0);
      return;
    }

    const g = st.currentGame || { pointsA: 0, pointsB: 0, advantage: null };

    // ventaja clásica
    if (!st.rules?.noAdvantage && g.pointsA === 3 && g.pointsB === 3) {
      if (g.advantage === 'A') { if (el.pointsA) el.pointsA.textContent = 'V'; if (el.pointsB) el.pointsB.textContent = '40'; return; }
      if (g.advantage === 'B') { if (el.pointsA) el.pointsA.textContent = '40'; if (el.pointsB) el.pointsB.textContent = 'V'; return; }
      if (el.pointsA) el.pointsA.textContent = '40';
      if (el.pointsB) el.pointsB.textContent = '40';
      return;
    }

    if (el.pointsA) el.pointsA.textContent = mapPoints(g.pointsA ?? 0);
    if (el.pointsB) el.pointsB.textContent = mapPoints(g.pointsB ?? 0);
  }

  // ---- Ads (estable + placeholder)
  let ads = [];
  let adIdx = 0;
  let adTimer = null;
  let slides = [];
  let adsPaused = false;

  function clearAdTimer() {
    if (adTimer) clearInterval(adTimer);
    adTimer = null;
  }

  function setActive(i) {
    slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
    Array.from(el.adsDots?.children || []).forEach((d, idx) => d.classList.toggle('active', idx === i));
  }

  function nextAd() {
    if (slides.length <= 1) return;
    adIdx = (adIdx + 1) % slides.length;
    setActive(adIdx);
  }

  function restartAdsTimer() {
    clearAdTimer();
    if (adsPaused) return;
    if (slides.length > 1) adTimer = setInterval(nextAd, adDurationSec * 1000);
  }

  function normalizeAds(urls) {
    return (urls || [])
      .filter(Boolean)
      .map(String)
      .filter((u, i, arr) => arr.indexOf(u) === i);
  }

  function buildAds(urls) {
    if (!el.adsContainer || !el.adsDots) return;

    // FIX desktop: por si algo lo vuelve a ocultar
    forceShowAds();

    // limpiar
    el.adsContainer.querySelectorAll('.ads-slide').forEach(n => n.remove());
    el.adsDots.innerHTML = '';
    slides = [];

    if (!urls.length) {
      const empty = document.createElement('div');
      empty.className = 'ads-slide active';
      empty.innerHTML = `<div class="ads-empty">Sin publicidades cargadas</div>`;
      el.adsContainer.insertBefore(empty, el.adsDots);
      slides = [empty];
      adIdx = 0;
      adsPaused = false;
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
      slides.push(slide);

      const dot = document.createElement('div');
      dot.className = 'ads-dot';
      dot.addEventListener('click', () => {
        adIdx = i;
        setActive(adIdx);
        restartAdsTimer();
      });
      el.adsDots.appendChild(dot);
    });

    adIdx = 0;
    setActive(0);
    restartAdsTimer();
  }

  function updateAds(urls) {
    const incoming = normalizeAds(urls);
    if (incoming.join('|') === ads.join('|')) return; // NO reset
    ads = incoming;
    buildAds(ads);
  }

  async function refreshAdsFromApi() {
    try {
      const r = await fetch(`/api/matches/${matchId}/ads`);
      if (!r.ok) return;
      const { urls } = await r.json();
      updateAds(urls || []);
    } catch {}
  }

  function applyAdsPauseFromState(st) {
    // Default: NO pausa (mejor para TV)
    if (!pauseAdsWithMatch) {
      adsPaused = false;
      restartAdsTimer();
      return;
    }
    // si está habilitado pauseAds=1, pausamos cuando el partido no corre
    const shouldPause = !st.running;
    if (shouldPause !== adsPaused) {
      adsPaused = shouldPause;
      restartAdsTimer();
    }
  }

  function render(st) {
    state = st;

    renderHeader(st);
    renderNames(st);
    renderPreviousSets(st);
    renderMetrics(st);

    // actualiza ads sin resetear
    updateAds(st.ads || []);
    // fallback extra si el estado vino sin ads
    if (!st.ads || !st.ads.length) refreshAdsFromApi();

    applyAdsPauseFromState(st);
    tick();
  }

  async function bootstrap() {
    if (!matchId) {
      alert('Falta ?match=ID o ?id=ID en la URL');
      return;
    }

    // estado inicial
    try {
      const res = await fetch(`/api/matches/${matchId}`);
      if (res.ok) render(await res.json());
    } catch (e) {
      console.error('No se pudo obtener estado inicial', e);
    }

    // fallback ads
    refreshAdsFromApi();

    const socket = io(originBase, { transports: ['websocket'] });
    socket.on('connect', () => socket.emit('join', matchId));
    socket.on('state', (s) => render(s));
  }

  bootstrap();
})();