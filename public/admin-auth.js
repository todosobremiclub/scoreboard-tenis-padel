// public/admin-auth.js
const $ = (id) => document.getElementById(id);

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'include', ...opts });
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}

function showLogin(show) {
  const overlay = $('loginOverlay');
  if (!overlay) return;
  overlay.style.display = show ? 'flex' : 'none';
}

function showSessionBar(show) {
  const bar = $('adminSessionBar');
  if (!bar) return;
  bar.style.display = show ? 'flex' : 'none';
}

function setMsg(msg, isError = false) {
  const node = $('adminLoginMsg');
  if (!node) return;
  node.textContent = msg || '';
  node.style.color = isError ? '#ff9aa5' : '#8892a6';
}

function setMeLabel(user) {
  const node = $('adminMeLabel');
  if (!node) return;
  node.textContent = user ? `${user.name || user.email} (${user.role})` : '';
}

function roleAllowed(role) {
  // Ajustá si querés limitar más
  return ['admin', 'superadmin', 'staff'].includes(role);
}

async function checkSessionAndGate() {
  const me = await api('/api/auth/me');
  if (!me.ok) {
    // No autenticado => mostrar login y bloquear UI
    showLogin(true);
    showSessionBar(false);
    return null;
  }

  const user = me.data?.user;
  if (!user || !roleAllowed(user.role)) {
    showLogin(true);
    showSessionBar(false);
    setMsg('Tu usuario no tiene permisos para acceder a admin.', true);
    return null;
  }

  // OK
  showLogin(false);
  showSessionBar(true);
  setMeLabel(user);
  return user;
}

async function doLogin() {
  const email = $('adminLoginEmail')?.value?.trim();
  const password = $('adminLoginPassword')?.value;

  if (!email || !password) {
    setMsg('Email y contraseña son requeridos.', true);
    return;
  }

  setMsg('Autenticando…');
  const r = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!r.ok) {
    setMsg(r.data?.error || 'No se pudo iniciar sesión.', true);
    return;
  }

  // Validamos sesión y rol
  const user = await checkSessionAndGate();
  if (user) setMsg('');
}

async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' });
  // Vuelve al login
  showSessionBar(false);
  showLogin(true);
  setMsg('Sesión cerrada.');
}

window.addEventListener('DOMContentLoaded', async () => {
  // Bind eventos
  $('adminBtnLogin')?.addEventListener('click', doLogin);
  $('adminBtnLogout')?.addEventListener('click', doLogout);

  $('adminLoginEmail')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('adminLoginPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  // Badge entorno (opcional)
  const badge = $('loginEnvBadge');
  if (badge) badge.textContent = location.hostname.includes('onrender.com') ? 'Render' : 'Local';

  // Gate inicial
  await checkSessionAndGate();
});
