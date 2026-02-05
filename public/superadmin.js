// superadmin.js

const el = (id) => document.getElementById(id);
const state = {
  me: null,
  editingId: null, // null => crear
  q: '',
  limit: 50,
  offset: 0,

// === Clubs ===
  clubs: {
    list: [],
    q: '',
    limit: 50,
    offset: 0
// Cache de clubes para el selector del modal (multi-select)
  allClubs: [],
  allClubsLoaded: false,
  },
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

// ----------- Clubs (helpers para selector multi) -----------

async function fetchAllClubsForModal() {
  // Traemos hasta 200 clubes (si necesitás más, lo ajustamos luego)
  const params = new URLSearchParams();
  params.set('limit', '200');
  params.set('offset', '0');

  const r = await fetch(`/api/superadmin/clubs?${params}`, { credentials: 'include' });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data?.error || `No se pudo cargar clubes (${r.status})`);
  }
  const data = await r.json();
  return data.clubs ?? [];
}

function setClubsSelectOptions(clubs, selectedIds = []) {
  const sel = el('f_clubs');
  if (!sel) return;

  const selectedSet = new Set((selectedIds ?? []).map(String));

  sel.innerHTML = '';
  for (const c of clubs) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.slug ? `${c.name} (${c.slug})` : c.name;
    if (selectedSet.has(String(c.id))) opt.selected = true;
    sel.appendChild(opt);
  }
}

function getSelectedClubIdsFromSelect() {
  const sel = el('f_clubs');
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map(o => String(o.value));
}

async function fetchUserClubsActive(userId) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
    credentials: 'include'
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return data.clubs ?? [];
}

async function prepareClubsSelectForUser(userIdOrNull) {
  // 1) Asegurar cache de clubes
  if (!state.allClubsLoaded) {
    state.allClubs = await fetchAllClubsForModal();
    state.allClubsLoaded = true;
  }

  // 2) Si es “nuevo usuario”, no preseleccionamos nada
  if (!userIdOrNull) {
    setClubsSelectOptions(state.allClubs, []);
    return;
  }

  // 3) Si es edición, preseleccionar clubes activos del usuario
  const assigned = await fetchUserClubsActive(userIdOrNull);
  const selectedIds = assigned.map(c => c.id);
  setClubsSelectOptions(state.allClubs, selectedIds);
}

async function setUserClubs(userId, clubIds) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ clubIds })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Error set clubs (${r.status})`);
  return data;
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
setHidden(el('clubsCard'), false);
await loadUsers();
await loadClubs();
}

// ----------- Clubs -----------
async function loadClubs() {
  const params = new URLSearchParams();
  if (state.clubs.q) params.set('q', state.clubs.q);
  params.set('limit', String(state.clubs.limit));
  params.set('offset', String(state.clubs.offset));

  const url = `/api/superadmin/clubs?${params}`;
  const tbody = el('tbodyClubs');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td class="muted" colspan="5">Cargando…</td></tr>`;

  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({ error: 'Error' }));
      tbody.innerHTML = `<tr><td colspan="5" class="error">${error || 'Error'}</td></tr>`;
      return;
    }
    const data = await r.json();
    state.clubs.list = data.clubs || [];
    renderClubs(state.clubs.list);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">No se pudo cargar</td></tr>`;
  }
}

function renderClubs(clubs) {
  const tbody = el('tbodyClubs');
  if (!tbody) return;

  if (!clubs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Sin clubes.</td></tr>`;
    return;
  }

  tbody.innerHTML = clubs.map(c => {
    const activePill = c.active
      ? `<span class="pill on">Activo</span>`
      : `<span class="pill off">Inactivo</span>`;

    return `
      <tr data-id="${c.id}">
        <td>${c.id}</td>
        <td>${c.name || '—'}</td>
        <td>${c.slug || '—'}</td>
        <td>${activePill}</td>
        <td style="white-space:nowrap;">
          <button data-club-edit="${c.id}">Editar</button>
          <button class="btn-danger" data-club-toggle="${c.id}">${c.active ? 'Desactivar' : 'Activar'}</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-club-edit]').forEach(b => b.addEventListener('click', onEditClub));
  tbody.querySelectorAll('[data-club-toggle]').forEach(b => b.addEventListener('click', onToggleClub));
}

async function onNewClub() {
  const id = prompt('ID del club (ej: club2):');
  if (!id) return;

  const name = prompt('Nombre del club:');
  if (!name) return;

  const defaultSlug = name.toLowerCase().trim().replace(/\s+/g, '-');
  const slug = prompt('Slug (ej: mi-club):', defaultSlug);
  if (!slug) return;

  const r = await fetch('/api/superadmin/clubs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id: id.trim(), name: name.trim(), slug: slug.trim(), active: true })
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) return alert(data.error || 'No se pudo crear');
  await loadClubs();
}

async function onEditClub(ev) {
  const id = ev.currentTarget.getAttribute('data-club-edit');
  const c = state.clubs.list.find(x => String(x.id) === String(id));
  if (!c) return;

  const name = prompt('Nuevo nombre:', c.name || '');
  if (name == null) return;

  const slug = prompt('Nuevo slug:', c.slug || '');
  if (slug == null) return;

  const r = await fetch(`/api/superadmin/clubs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name: name.trim(), slug: slug.trim() })
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) return alert(data.error || 'No se pudo editar');
  await loadClubs();
}

async function onToggleClub(ev) {
  const id = ev.currentTarget.getAttribute('data-club-toggle');
  const c = state.clubs.list.find(x => String(x.id) === String(id));
  if (!c) return;

  const next = !c.active;
  const ok = confirm(`${next ? 'Activar' : 'Desactivar'} el club ${id}?`);
  if (!ok) return;

  const r = await fetch(`/api/superadmin/clubs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ active: next })
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) return alert(data.error || 'No se pudo actualizar');
  await loadClubs();
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
          <button data-clubs="${u.id}">Clubes</button>
          <button class="btn-danger" data-del="${u.id}">${u.active ? 'Desactivar' : 'Desactivado'}</button>
        </td>
      </tr>
    `;
  }).join('');
  // wire actions
  tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', onEdit));
  tbody.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', onResetPwd));
  tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', onDeactivate));
tbody.querySelectorAll('[data-clubs]').forEach(btn => btn.addEventListener('click', onManageUserClubs));
}

// ----------- User Clubs (asignación de clubes) -----------

async function fetchUserClubs(userId) {
  try {
    const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
      credentials: 'include'
    });
    if (!r.ok) return [];
    const data = await r.json().catch(() => ({}));
    return data.clubs ?? [];
  } catch {
    return [];
  }
}

async function assignClubToUser(userId, clubId) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ clubId })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
  return data;
}

async function deactivateUserClub(userId, clubId) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs/${encodeURIComponent(clubId)}/deactivate`, {
    method: 'PATCH',
    credentials: 'include'
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
  return data;
}

async function onManageUserClubs(ev) {
  const userId = ev.currentTarget.getAttribute('data-clubs');
  if (!userId) return;

  // 1) Traer clubes asignados actuales
  const current = await fetchUserClubs(userId);
  const listTxt = current.length
    ? current.map(c => `- ${c.id} (${c.name || '—'})`).join('\n')
    : '(sin clubes asignados)';

  // 2) Mostrar opciones básicas
  const action = prompt(
    `Clubes del usuario ${userId}:\n\n${listTxt}\n\n` +
    `Escribí:\n` +
    `  A = Asignar club\n` +
    `  D = Desasignar (active=false)\n` +
    `  (Cancelar para salir)\n\n` +
    `Acción:`
  );

  if (!action) return;

  const act = action.trim().toUpperCase();
  if (act === 'A') {
    const clubId = prompt('ID del club a asignar (ej: club1):');
    if (!clubId) return;
    try {
      await assignClubToUser(userId, clubId.trim());
      alert(`OK: asignado club ${clubId} a ${userId}`);
    } catch (e) {
      alert(`No se pudo asignar: ${e.message}`);
    }
    return;
  }

  if (act === 'D') {
    const clubId = prompt('ID del club a desasignar (active=false):');
    if (!clubId) return;
    try {
      await deactivateUserClub(userId, clubId.trim());
      alert(`OK: desasignado club ${clubId} (active=false)`);
    } catch (e) {
      alert(`No se pudo desasignar: ${e.message}`);
    }
    return;
  }

  alert('Acción inválida');
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
// Cargar selector de clubes (multi) y preseleccionar si es edición
  prepareClubsSelectForUser(state.editingId).catch((e) => {
    console.error('[clubs select]', e);
  });
}
function closeModal() {
  el('modalBackdrop').style.display = 'none';
}
async function onEdit(e) {
 const id = String(e.currentTarget.getAttribute('data-edit'));
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
    const data = await r.json().catch(() => ({}));

  // Determinar el userId (si edito: state.editingId, si creo: data.user.id)
  const userId = isEdit ? String(state.editingId) : String(data?.user?.id ?? '');
  if (!userId) {
    toast(el('modalMsg'), 'Guardado, pero no se obtuvo el ID del usuario', 'warn');
    closeModal();
    await loadUsers();
    return;
  }

  // Tomar selección de clubes del multi-select
  const selectedClubIds = getSelectedClubIdsFromSelect();

  // Regla pedida: solo admin tiene clubes. Si no es admin -> vaciamos (desasigna todo = active=false)
  const finalClubIds = (payload.role === 'admin') ? selectedClubIds : [];

  try {
    await setUserClubs(userId, finalClubIds);
  } catch (e) {
    // No bloqueamos el guardado del usuario, pero informamos
    toast(el('modalMsg'), `Usuario guardado, pero clubes fallaron: ${e.message}`, 'error');
    // NO return: dejamos que cierre/recargue igual
  }

  toast(el('modalMsg'), 'Guardado', 'success');
  closeModal();
  await loadUsers();
  await loadClubs?.(); // si existe
  } catch (e) {
    toast(el('modalMsg'), 'No se pudo guardar', 'error');
  } finally {
    el('btnSave').disabled = false;
  }
}

async function onResetPwd(e) {
const id = String(e.currentTarget.getAttribute('data-reset'));  
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
const id = String(e.currentTarget.getAttribute('data-del')); 
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

// === Clubs UI ===
  el('btnClubSearch')?.addEventListener('click', () => {
    state.clubs.q = el('club_q')?.value?.trim() ?? '';
    state.clubs.offset = 0;
    loadClubs();
  });

  el('btnClubNew')?.addEventListener('click', onNewClub);

  el('club_q')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('btnClubSearch')?.click();
  });


  // Arranque
  await enterApp();
});