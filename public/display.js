// public/display.js — layout 3 columnas + banner grande + responsive (ads estable)
(() => {
  const qs = new URLSearchParams(window.location.search);
  const matchId = qs.get('match') || qs.get('id') || qs.get('m'); // soporta varias keys
  const originBase = window.location.origin;

  const adDurationSec = Math.max(1, parseInt(qs.get('adSec') || '6', 10));
  const adObjectFit = (qs.get('adFit') || 'contain').toLowerCase(); // contain|cover
  const pauseAdsWithMatch = (qs.get('pauseAds') || '0') === '1'; // default: NO pausa

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
    el.clock.textContent = `${two(now.getHours())}:${two(now.getMinutes())}`;
    if (state) el.elapsed.textContent = formatHMS(computeElapsed(state));
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
    const map = ['0','15','30','40'];
    return map[Math.min(p, 3)] || '0';
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- Render
  function renderHeader(st) {
    el.matchTitle.textContent = st.name || 'Partido';
    el.matchStage.textContent = (st.stage || 'Amistoso').toUpperCase();
    el.matchCourt.textContent = st.courtName && st.courtName.trim() ? `Cancha ${st.courtName}` : 'Cancha —';
  }

  function renderNames(st) {
    const a = splitName(st.teams?.[0]?.name || 'Equipo A');
    const b = splitName(st.teams?.[1]?.name || 'Equipo B');

    el.nameA_first.textContent = a.first;
    el.nameA_last.textContent = a.last;
    el.nameB_first.textContent = b.first;
    el.nameB_last.textContent = b.last;

    el.serveA.classList.toggle('on', st.serverIndex === 0);
    el.serveB.classList.toggle('on', st.serverIndex === 1);
  }

  // previous sets = games por set
  function prevCell(val, empty=false) {
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
        el.prevRowA.appendChild(prevCell(0, true));
        el.prevRowB.appendChild(prevCell(0, true));
      } else {
        el.prevRowA.appendChild(prevCell(s.gamesA ?? 0));
        el.prevRowB.appendChild(prevCell(s.gamesB ?? 0));
      }
    }
  }

  function renderMetrics(st) {
    el.setsA.textContent = String(st.setsWonA ?? 0);
    el.setsB.textContent = String(st.setsWonB ?? 0);

    const set = st.sets?.[st.sets.length - 1] ?? { gamesA: 0, gamesB: 0, tieBreak: { active:false } };
    el.gamesA.textContent = String(set.gamesA ?? 0);
    el.gamesB.textContent = String(set.gamesB ?? 0);

    const tb = set.tieBreak ?? { active:false };
    if (tb.active) {
      el.pointsA.textContent = String(tb.pointsA ?? 0);
      el.pointsB.textContent = String(tb.pointsB ?? 0);
      return;
    }

    const g = st.currentGame || { pointsA: 0, pointsB: 0, advantage: null };
    if (!st.rules?.noAdvantage && g.pointsA === 3 && g.pointsB === 3) {
      if (g.advantage === 'A') { el.pointsA.textContent = 'V'; el.pointsB.textContent = '40'; return; }
      if (g.advantage === 'B') { el.pointsA.textContent = '40'; el.pointsB.textContent = 'V'; return; }
      el.pointsA.textContent = '40'; el.pointsB.textContent = '40';
      return;
    }

    el.pointsA.textContent = mapPoints(g.pointsA ?? 0);
    el.pointsB.textContent = mapPoints(g.pointsB ?? 0);
  }

  // ---- Ads (estable + placeholder)
  let ads = [];
  let adIdx = 0;
  let adTimer = null;
  let slides = [];
  let adsPaused = false;

  function clearAdTimer() { if (adTimer) clearInterval(adTimer); adTimer = null; }

  function setActive(i) {
    slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
    Array.from(el.adsDots.children).forEach((d, idx) => d.classList.toggle('active', idx === i));
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
      dot.addEventListener('click', () => { adIdx = i; setActive(adIdx); restartAdsTimer(); });
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
    if (!pauseAdsWithMatch) {
      adsPaused = false;
      restartAdsTimer();
      return;
    }
    function applyAdsPauseFromState(st){
  // Para TV: por defecto NO pausamos nunca.
  // Si querés pausar, lo implementamos con ?pauseAds=1
  adsPaused = false;
  restartAdsTimer();
}
  }

  function render(st) {
    state = st;
    renderHeader(st);
    renderNames(st);
    renderPreviousSets(st);
    renderMetrics(st);

    updateAds(st.ads || []);
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