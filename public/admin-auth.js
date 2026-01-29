// public/admin-auth.js
(() => {
  const byId = (id) => document.getElementById(id);

  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: 'include', ...opts });
    let data = null;
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }

  function showLogin(show) {
    const overlay = byId('loginOverlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
  }

  function showSessionBar(show) {
    const bar = byId('adminSessionBar');
    if (bar) bar.style.display = show ? 'flex' : 'none';
  }

  function showAdminApp(show) {
    const app = byId('adminApp');
    if (app) app.style.display = show ? '' : 'none';
  }

  function setMsg(msg, isError = false) {
    const node = byId('adminLoginMsg');
    if (!node) return;
    node.textContent = msg || '';
    node.style.color = isError ? '#ff9aa5' : '#8892a6';
  }

  function setMeLabel(user) {
    const node = byId('adminMeLabel');
    if (!node) return;
    node.textContent = user ? `${user.name || user.email} (${user.role})` : '';
  }

  function roleAllowed(role) {
    return ['admin', 'superadmin', 'staff'].includes(role);
  }

  async function checkSessionAndGate() {
    const me = await api('/api/auth/me');

    if (!me.ok) {
      showAdminApp(false);
      showSessionBar(false);
      showLogin(true);
      setMsg('Iniciá sesión para continuar.');
      return null;
    }

    const user = me.data?.user;
    if (!user || !roleAllowed(user.role)) {
      showAdminApp(false);
      showSessionBar(false);
      showLogin(true);
      setMsg('Tu usuario no tiene permisos para acceder a admin.', true);
      return null;
    }

    showLogin(false);
    showSessionBar(true);
    showAdminApp(true);
    setMeLabel(user);
    setMsg('');
    return user;
  }

  async function doLogin() {
    const email = byId('adminLoginEmail')?.value?.trim();
    const password = byId('adminLoginPassword')?.value;

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

    await checkSessionAndGate();
  }

  async function doLogout() {
    await api('/api/auth/logout', { method: 'POST' });
    showSessionBar(false);
    showAdminApp(false);
    showLogin(true);
    setMsg('Sesión cerrada.');
  }

  window.addEventListener('DOMContentLoaded', async () => {
    byId('adminBtnLogin')?.addEventListener('click', doLogin);
    byId('adminBtnLogout')?.addEventListener('click', doLogout);

    byId('adminLoginEmail')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    byId('adminLoginPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

    const badge = byId('loginEnvBadge');
    if (badge) badge.textContent = location.hostname.includes('onrender.com') ? 'Render' : 'Local';

    await checkSessionAndGate();
  });
})();