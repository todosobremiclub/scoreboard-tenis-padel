// superadmin.js

const el = (id) => document.getElementById(id);
const state = {
  me: null,
  editingId: null, // null => crear
  q: '',
  limit: 50,
  offset: 0,
};

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  return d.toLocaleString();
}
function setHidden(node, hidden) {
  if (!node) return;
  node.classList.toggle('hidden', !!hidden);
}
function toast(node, msg, type = 'muted') {
  if (!node) return;
  node.textContent = msg;
  node.className = type; // 'muted' | 'error' | 'success'
}

// ----------- Auth -----------
async function fetchMe() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    const { user } = await r.json();
    return user;
  } catch { return null; }
}

async function doLogin() {
  const email = el('loginEmail').value.trim();
  const password = el('loginPassword').value;
  toast(el('loginMsg'), 'Autenticando…', 'muted');
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({ error: 'Error' }));
      toast(el('loginMsg'), error || 'Credenciales inválidas', 'error');
      return;
    }
    const data = await r.json();
    state.me = data.user;
    await enterApp();
  } catch (e) {
    toast(el('loginMsg'), 'No se pudo conectar al servidor', 'error');
  }
}

async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {}
  location.reload();
}

async function enterApp() {
  const me = state.me || (await fetchMe());
  if (!me) {
    setHidden(el('usersCard'), true);
    setHidden(el('loginCard'), false);
    el('meBadge').textContent = 'No autenticado';
    setHidden(el('btnLogout'), true);
    return;
  }
  el('meBadge').textContent = `${me.name || me.email} (${me.role})`;
  setHidden(el('btnLogout'), false);

  if (me.role !== 'superadmin') {
    setHidden(el('loginCard'), true);
    setHidden(el('usersCard'), true);
    toast(el('loginMsg'), 'Necesitás rol superadmin para acceder a esta consola.', 'error');
    return;
  }

  setHidden(el('loginCard'), true);
  setHidden(el('usersCard'), false);
  await loadUsers();
}

// ----------- Users -----------
async function loadUsers() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  params.set('limit', String(state.limit));
  params.set('offset', String(state.offset));
  const url = `/api/superadmin/users?${params}`;

  const tbody = el('tbodyUsers');
  tbody.innerHTML = `<tr><td class="muted" colspan="7">Cargando…</td></tr>`;
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) {
      if (r.status === 401) {
        toast(el('loginMsg'), 'Sesión vencida. Volvé a iniciar sesión.', 'error');
        setHidden(el('usersCard'), true);
        setHidden(el('loginCard'), false);
        return;
      }
      if (r.status === 403) {
        tbody.innerHTML = `<tr><td colspan="7" class="error">No autorizado.</td></tr>`;
        return;
      }
      const { error } = await r.json().catch(()=>({error:'Error'}));
      tbody.innerHTML = `<tr><td colspan="7" class="error">${error || 'Error'}</td></tr>`;
      return;
    }
    const data = await r.json();
    renderUsers(data.users || []);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="error">No se pudo cargar</td></tr>`;
  }
}

function renderUsers(users) {
  const tbody = el('tbodyUsers');
  if (!users.length) {
    tbody.innerHTML = `<tr><td class="muted" colspan="7">Sin usuarios.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const active = u.active ? `<span class="pill on">Activo</span>` : `<span class="pill off">Inactivo</span>`;
    return `
      <tr>
        <td>${u.id}</td>
        <td>${u.name || '—'}</td>
        <td>${u.email}</td>
        <td><span class="kbd">${u.role}</span></td>
        <td>${active}</td>
        <td class="muted">${fmtDate(u.last_login_at)}</td>
        <td>
          <button data-edit="${u.id}">Editar</button>
          <button class="btn-warn" data-reset="${u.id}">Reset clave</button>
          <button class="btn-danger" data-del="${u.id}">${u.active ? 'Desactivar' : 'Desactivado'}</button>
        </td>
      </tr>
    `;
  }).join('');
  // wire actions
  tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', onEdit));
  tbody.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', onResetPwd));
  tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', onDeactivate));
}

// ----------- Modal -----------
function openModal({ title, user } = {}) {
  state.editingId = user?.id ?? null;
  el('modalTitle').textContent = title || (state.editingId ? 'Editar usuario' : 'Nuevo usuario');
  el('f_name').value = user?.name ?? '';
  el('f_email').value = user?.email ?? '';
  el('f_role').value = user?.role ?? 'admin';
  el('f_active').value = String(user?.active ?? true);
  el('f_password').value = '';
  toast(el('modalMsg'), '', 'muted');
  el('modalBackdrop').style.display = 'flex';
}
function closeModal() {
  el('modalBackdrop').style.display = 'none';
}
async function onEdit(e) {
  const id = Number(e.currentTarget.getAttribute('data-edit'));
  // Buscamos el usuario desde la tabla renderizada (simplificamos)
  const row = e.currentTarget.closest('tr').children;
  const user = {
    id,
    name: row[1].textContent === '—' ? '' : row[1].textContent,
    email: row[2].textContent,
    role: row[3].innerText.trim(),
    active: row[4].innerText.includes('Activo'),
  };
  openModal({ title: 'Editar usuario', user });
}
function onNew() {
  openModal({ title: 'Nuevo usuario' });
}

async function onSave() {
  const payload = {
    name: el('f_name').value.trim(),
    email: el('f_email').value.trim().toLowerCase(),
    role: el('f_role').value,
    active: el('f_active').value === 'true',
  };
  const pwd = el('f_password').value;
  if (pwd) payload.password = pwd;

  const isEdit = !!state.editingId;
  const url = isEdit ? `/api/superadmin/users/${state.editingId}` : `/api/superadmin/users`;
  const method = isEdit ? 'PATCH' : 'POST';

  el('btnSave').disabled = true;
  toast(el('modalMsg'), 'Guardando…', 'muted');
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(()=>({error:'Error'}));
      toast(el('modalMsg'), error || 'Error al guardar', 'error');
      el('btnSave').disabled = false;
      return;
    }
    toast(el('modalMsg'), 'Guardado', 'success');
    closeModal();
    await loadUsers();
  } catch (e) {
    toast(el('modalMsg'), 'No se pudo guardar', 'error');
  } finally {
    el('btnSave').disabled = false;
  }
}

async function onResetPwd(e) {
  const id = Number(e.currentTarget.getAttribute('data-reset'));
  const newPwd = prompt('Nueva contraseña para el usuario ID ' + id + ':');
  if (!newPwd) return;
  try {
    const r = await fetch(`/api/superadmin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password: newPwd }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(()=>({error:'Error'}));
      alert('No se pudo resetear: ' + (error || 'Error'));
      return;
    }
    alert('Contraseña actualizada');
  } catch {
    alert('Error de red');
  }
}

async function onDeactivate(e) {
  const id = Number(e.currentTarget.getAttribute('data-del'));
  if (!confirm('¿Desactivar usuario ' + id + '?')) return;
  try {
    const r = await fetch(`/api/superadmin/users/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!r.ok) {
      const { error } = await r.json().catch(()=>({error:'Error'}));
      alert('No se pudo desactivar: ' + (error || 'Error'));
      return;
    }
    await loadUsers();
  } catch {
    alert('Error de red');
  }
}

// ----------- Events -----------
window.addEventListener('DOMContentLoaded', async () => {
  // Botones
  el('btnLogin').addEventListener('click', doLogin);
  el('btnLogout').addEventListener('click', doLogout);
  el('btnSearch').addEventListener('click', () => {
    state.q = el('q').value.trim();
    state.offset = 0;
    loadUsers();
  });
  el('btnNew').addEventListener('click', onNew);
  el('btnCancel').addEventListener('click', closeModal);
  el('btnSave').addEventListener('click', onSave);

  // Enter en login
  el('loginPassword').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLogin(); });
  el('loginEmail').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLogin(); });

  // Arranque
  await enterApp();
});