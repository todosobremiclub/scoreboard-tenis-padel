// public/superadmin.js
// Superadmin — Usuarios + Clubes (con modal de clubes y campos ubicación)
// - Crea/edita clubes con: name, address, city, province
// - El ID/slug se autoasignan en backend (lo implementamos en server.js luego)

const el = (id) => document.getElementById(id);

const state = {
  me: null,

  // Users
  editingId: null,     // user id o null
  q: '',
  limit: 50,
  offset: 0,

  // Clubs panel
  clubs: {
    list: [],
    q: '',
    limit: 200,
    offset: 0,
    editingId: null,   // club id o null
  },

  // Cache de clubes para selector multi-select de usuarios
  allClubs: [],
  allClubsLoaded: false,
};

// -----------------------
// Utils
// -----------------------
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
  node.textContent = msg || '';
  node.className = type; // 'muted' | 'error' | 'success'
}

function escHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pill(active) {
  return active
    ? `<span class="pill on">Activo</span>`
    : `<span class="pill off">Inactivo</span>`;
}

// -----------------------
// Auth
// -----------------------
async function fetchMe() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    const { user } = await r.json();
    return user;
  } catch {
    return null;
  }
}

async function doLogin() {
  const email = el('loginEmail')?.value?.trim() ?? '';
  const password = el('loginPassword')?.value ?? '';

  toast(el('loginMsg'), 'Autenticando…', 'muted');

  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      toast(el('loginMsg'), data?.error || 'Credenciales inválidas', 'error');
      return;
    }

    const data = await r.json().catch(() => ({}));
    state.me = data.user ?? null;
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
  const me = state.me ?? (await fetchMe());
  if (!me) {
    setHidden(el('usersCard'), true);
    setHidden(el('clubsCard'), true);
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
    setHidden(el('clubsCard'), true);
    toast(el('loginMsg'), 'Necesitás rol superadmin para acceder a esta consola.', 'error');
    return;
  }

  setHidden(el('loginCard'), true);
  setHidden(el('usersCard'), false);
  setHidden(el('clubsCard'), false);

  await loadClubs();  // primero clubs (sirve para selector del modal usuarios)
  await loadUsers();
}

// -----------------------
// Clubs — API
// -----------------------
async function fetchClubs({ q = '', limit = 200, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const r = await fetch(`/api/superadmin/clubs?${params.toString()}`, { credentials: 'include' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `No se pudo cargar clubes (${r.status})`);
  return data.clubs ?? [];
}

async function createClub(payload) {
  // Backend deberá autoasignar id + slug. Nosotros mandamos solo datos requeridos.
  const r = await fetch('/api/superadmin/clubs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `No se pudo crear club (${r.status})`);
  return data;
}

async function updateClub(clubId, payload) {
  const r = await fetch(`/api/superadmin/clubs/${encodeURIComponent(clubId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `No se pudo editar club (${r.status})`);
  return data;
}

async function toggleClub(clubId, active) {
  // Usamos PATCH para activar/desactivar
  return updateClub(clubId, { active });
}

// -----------------------
// Clubs — UI / render
// -----------------------
async function loadClubs() {
  const tbody = el('tbodyClubs');
  if (tbody) tbody.innerHTML = `<tr><td class="muted" colspan="6">Cargando…</td></tr>`;

  try {
    const clubs = await fetchClubs({
      q: state.clubs.q,
      limit: state.clubs.limit,
      offset: state.clubs.offset,
    });

    state.clubs.list = clubs;
    renderClubs(clubs);

    // cache para selector del modal usuarios (multi-select)
    state.allClubs = clubs;
    state.allClubsLoaded = true;
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="error">${escHtml(e.message || 'Error')}</td></tr>`;
  }
}

function renderClubs(clubs) {
  const tbody = el('tbodyClubs');
  if (!tbody) return;

  if (!clubs?.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Sin clubes.</td></tr>`;
    return;
  }

  tbody.innerHTML = clubs.map((c) => {
    const name = escHtml(c.name || '—');
    const address = escHtml(c.address || '—');
    const city = escHtml(c.city || '—');
    const prov = escHtml(c.province || '—');

    return `
      <tr data-id="${escHtml(c.id)}">
        <td><strong>${name}</strong></td>
        <td>${address}</td>
        <td>${city}</td>
        <td>${prov}</td>
        <td>${pill(!!c.active)}</td>
        <td style="white-space:nowrap;">
          <button data-club-edit="${escHtml(c.id)}">Editar</button>
          <button class="btn-danger" data-club-toggle="${escHtml(c.id)}">
            ${c.active ? 'Desactivar' : 'Activar'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-club-edit]').forEach((b) => b.addEventListener('click', onEditClub));
  tbody.querySelectorAll('[data-club-toggle]').forEach((b) => b.addEventListener('click', onToggleClub));
}

function openClubModal({ title = 'Nuevo club', club = null } = {}) {
  state.clubs.editingId = club?.id ?? null;

  el('clubModalTitle').textContent = title;
  el('club_name').value = club?.name ?? '';
  el('club_address').value = club?.address ?? '';
  el('club_city').value = club?.city ?? '';
  el('club_province').value = club?.province ?? '';

  toast(el('clubModalMsg'), '', 'muted');
  el('clubModalBackdrop').style.display = 'flex';
}

function closeClubModal() {
  el('clubModalBackdrop').style.display = 'none';
  state.clubs.editingId = null;
}

async function onNewClub() {
  openClubModal({ title: 'Nuevo club', club: null });
}

async function onEditClub(ev) {
  const id = ev.currentTarget.getAttribute('data-club-edit');
  const club = state.clubs.list.find((x) => String(x.id) === String(id));
  if (!club) return;

  openClubModal({
    title: `Editar club`,
    club,
  });
}

async function onToggleClub(ev) {
  const id = ev.currentTarget.getAttribute('data-club-toggle');
  const club = state.clubs.list.find((x) => String(x.id) === String(id));
  if (!club) return;

  const next = !club.active;
  const ok = confirm(`${next ? 'Activar' : 'Desactivar'} el club "${club.name}"?`);
  if (!ok) return;

  try {
    await toggleClub(id, next);
    await loadClubs();
  } catch (e) {
    alert(e.message || 'No se pudo actualizar el club');
  }
}

function validateClubForm() {
  const name = el('club_name')?.value?.trim() ?? '';
  if (!name) return { ok: false, error: 'El nombre del club es requerido.' };

  // address/city/province son opcionales, pero recomendados
  return { ok: true };
}

async function onSaveClub() {
  const v = validateClubForm();
  if (!v.ok) {
    toast(el('clubModalMsg'), v.error, 'error');
    return;
  }

  const payload = {
    name: el('club_name').value.trim(),
    address: el('club_address').value.trim(),
    city: el('club_city').value.trim(),
    province: el('club_province').value.trim(),
  };

  const btn = el('clubBtnSave');
  btn.disabled = true;
  toast(el('clubModalMsg'), 'Guardando…', 'muted');

  try {
    if (!state.clubs.editingId) {
      await createClub(payload);
    } else {
      await updateClub(state.clubs.editingId, payload);
    }

    toast(el('clubModalMsg'), 'Guardado', 'success');
    closeClubModal();
    await loadClubs();

    // refresca selector del modal de usuarios (clubes)
    state.allClubs = state.clubs.list;
    state.allClubsLoaded = true;
  } catch (e) {
    toast(el('clubModalMsg'), e.message || 'No se pudo guardar', 'error');
  } finally {
    btn.disabled = false;
  }
}

// -----------------------
// Users — Clubs selector helpers
// -----------------------
function setClubsSelectOptions(clubs, selectedIds = []) {
  const sel = el('f_clubs');
  if (!sel) return;

  const selectedSet = new Set((selectedIds ?? []).map(String));
  sel.innerHTML = '';

  for (const c of clubs) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    if (selectedSet.has(String(c.id))) opt.selected = true;
    sel.appendChild(opt);
  }
}

function getSelectedClubIdsFromSelect() {
  const sel = el('f_clubs');
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map((o) => String(o.value));
}

async function fetchAllClubsForModal() {
  // Para el multi-select de clubes en el modal usuarios
  // Si ya están cargados en state.allClubs, lo usamos.
  if (state.allClubsLoaded && state.allClubs.length) return state.allClubs;

  const clubs = await fetchClubs({ q: '', limit: 500, offset: 0 });
  state.allClubs = clubs;
  state.allClubsLoaded = true;
  return clubs;
}

async function fetchUserClubsActive(userId) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
    credentials: 'include',
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return data.clubs ?? [];
}

async function setUserClubs(userId, clubIds) {
  const r = await fetch(`/api/superadmin/users/${encodeURIComponent(userId)}/clubs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ clubIds }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Error set clubs (${r.status})`);
  return data;
}

async function prepareClubsSelectForUser(userIdOrNull) {
  const clubs = await fetchAllClubsForModal();
  if (!userIdOrNull) {
    setClubsSelectOptions(clubs, []);
    return;
  }
  const assigned = await fetchUserClubsActive(userIdOrNull);
  const selectedIds = assigned.map((c) => c.id);
  setClubsSelectOptions(clubs, selectedIds);
}

// -----------------------
// Users — API
// -----------------------
async function loadUsers() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  params.set('limit', String(state.limit));
  params.set('offset', String(state.offset));

  const tbody = el('tbodyUsers');
  if (tbody) tbody.innerHTML = `<tr><td class="muted" colspan="7">Cargando…</td></tr>`;

  try {
    const r = await fetch(`/api/superadmin/users?${params.toString()}`, { credentials: 'include' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error('Sesión vencida. Volvé a iniciar sesión.');
      if (r.status === 403) throw new Error('No autorizado.');
      throw new Error(data?.error || 'Error al cargar usuarios');
    }
    const data = await r.json().catch(() => ({}));
    renderUsers(data.users ?? []);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td class="error" colspan="7">${escHtml(e.message || 'Error')}</td></tr>`;
  }
}

function renderUsers(users) {
  const tbody = el('tbodyUsers');
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `<tr><td class="muted" colspan="7">Sin usuarios.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((u) => {
    const active = u.active ? `<span class="pill on">Activo</span>` : `<span class="pill off">Inactivo</span>`;
    return `
      <tr>
        <td>${escHtml(u.id)}</td>
        <td>${escHtml(u.name || '—')}</td>
        <td>${escHtml(u.email || '')}</td>
        <td><span class="kbd">${escHtml(u.role || '')}</span></td>
        <td>${active}</td>
        <td class="muted">${escHtml(fmtDate(u.last_login_at))}</td>
        <td style="white-space:nowrap;">
          <button data-edit="${escHtml(u.id)}">Editar</button>
          <button class="btn-warn" data-reset="${escHtml(u.id)}">Reset clave</button>
          <button class="btn-danger" data-del="${escHtml(u.id)}">${u.active ? 'Desactivar' : 'Desactivado'}</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', onEditUserFromRow));
  tbody.querySelectorAll('[data-reset]').forEach((btn) => btn.addEventListener('click', onResetPwd));
  tbody.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', onDeactivateUser));
}

// -----------------------
// Users — Modal (mejorado)
// -----------------------
function openUserModal({ title, user } = {}) {
  state.editingId = user?.id ?? null;

  el('modalTitle').textContent = title || (state.editingId ? 'Editar usuario' : 'Nuevo usuario');
  el('f_name').value = user?.name ?? '';
  el('f_email').value = user?.email ?? '';
  el('f_role').value = user?.role ?? 'admin';
  el('f_active').value = String(user?.active ?? true);
  el('f_password').value = '';

  toast(el('modalMsg'), '', 'muted');
  el('modalBackdrop').style.display = 'flex';

  // Clubes multi-select: precargar y preseleccionar si es edición
  prepareClubsSelectForUser(state.editingId).catch((e) => console.error('[clubs select]', e));
}

function closeUserModal() {
  el('modalBackdrop').style.display = 'none';
  state.editingId = null;
}

function validateUserForm(payload, pwd) {
  if (!payload.name) return { ok: false, error: 'El nombre es requerido.' };
  if (!payload.email) return { ok: false, error: 'El email es requerido.' };
  if (!payload.email.includes('@')) return { ok: false, error: 'El email no parece válido.' };

  if (!state.editingId && !pwd) {
    return { ok: false, error: 'Para crear un usuario, la contraseña es requerida.' };
  }
  if (pwd && pwd.length < 6) {
    return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  return { ok: true };
}

async function onEditUserFromRow(e) {
  const id = String(e.currentTarget.getAttribute('data-edit'));
  const row = e.currentTarget.closest('tr')?.children;
  if (!row) return;

  const roleTxt = row[3]?.innerText?.trim() ?? 'admin';
  const role = roleTxt.replace(/\s+/g, '').toLowerCase(); // "admin" etc.
  const user = {
    id,
    name: row[1]?.textContent === '—' ? '' : row[1]?.textContent,
    email: row[2]?.textContent,
    role,
    active: row[4]?.innerText?.includes('Activo'),
  };

  openUserModal({ title: 'Editar usuario', user });
}

function onNewUser() {
  openUserModal({ title: 'Nuevo usuario', user: null });
}

async function onSaveUser() {
  const payload = {
    name: el('f_name').value.trim(),
    email: el('f_email').value.trim().toLowerCase(),
    role: el('f_role').value,
    active: el('f_active').value === 'true',
  };
  const pwd = el('f_password').value;

  const v = validateUserForm(payload, pwd);
  if (!v.ok) {
    toast(el('modalMsg'), v.error, 'error');
    return;
  }

  if (pwd) payload.password = pwd;

  const isEdit = !!state.editingId;
  const url = isEdit ? `/api/superadmin/users/${encodeURIComponent(state.editingId)}` : `/api/superadmin/users`;
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

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(el('modalMsg'), data?.error || 'Error al guardar', 'error');
      el('btnSave').disabled = false;
      return;
    }

    // Determinar userId (si creo, viene en data.user.id)
    const userId = isEdit ? String(state.editingId) : String(data?.user?.id ?? '');
    if (userId) {
      const selectedClubIds = getSelectedClubIdsFromSelect();
      // Regla existente: solo admin tiene clubes (staff/superadmin no)
      const finalClubIds = (payload.role === 'admin') ? selectedClubIds : [];
      try {
        await setUserClubs(userId, finalClubIds);
      } catch (e) {
        toast(el('modalMsg'), `Usuario guardado, pero clubes fallaron: ${e.message}`, 'error');
      }
    }

    toast(el('modalMsg'), 'Guardado', 'success');
    closeUserModal();
    await loadUsers();
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
    const r = await fetch(`/api/superadmin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password: newPwd }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert('No se pudo resetear: ' + (data?.error || 'Error'));
      return;
    }
    alert('Contraseña actualizada');
  } catch {
    alert('Error de red');
  }
}

async function onDeactivateUser(e) {
  const id = String(e.currentTarget.getAttribute('data-del'));
  if (!confirm('¿Desactivar usuario ' + id + '?')) return;

  try {
    const r = await fetch(`/api/superadmin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert('No se pudo desactivar: ' + (data?.error || 'Error'));
      return;
    }
    await loadUsers();
  } catch {
    alert('Error de red');
  }
}

// -----------------------
// Bind events
// -----------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Login
  el('btnLogin')?.addEventListener('click', doLogin);
  el('btnLogout')?.addEventListener('click', doLogout);
  el('loginPassword')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLogin(); });
  el('loginEmail')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLogin(); });

  // Users
  el('btnSearch')?.addEventListener('click', () => {
    state.q = el('q')?.value?.trim() ?? '';
    state.offset = 0;
    loadUsers();
  });
  el('btnNew')?.addEventListener('click', onNewUser);
  el('btnCancel')?.addEventListener('click', closeUserModal);
  el('btnSave')?.addEventListener('click', onSaveUser);

  // Clubs
  el('btnClubSearch')?.addEventListener('click', () => {
    state.clubs.q = el('club_q')?.value?.trim() ?? '';
    state.clubs.offset = 0;
    loadClubs();
  });
  el('club_q')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('btnClubSearch')?.click();
  });
  el('btnClubNew')?.addEventListener('click', onNewClub);

  // Club modal
  el('clubBtnCancel')?.addEventListener('click', closeClubModal);
  el('clubBtnSave')?.addEventListener('click', onSaveClub);

  // Cerrar modales clic fuera
  el('modalBackdrop')?.addEventListener('click', (ev) => {
    if (ev.target === el('modalBackdrop')) closeUserModal();
  });
  el('clubModalBackdrop')?.addEventListener('click', (ev) => {
    if (ev.target === el('clubModalBackdrop')) closeClubModal();
  });

  // Arranque
  await enterApp();
});
