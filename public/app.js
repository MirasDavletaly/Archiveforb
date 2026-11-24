// Company Files client. Plain DOM, no framework. User data is only ever inserted as text, never as HTML.

const LEVEL = ['', 'Read', 'Edit', 'Manage'];
const AREA = {
  general: { no: '01', label: 'General', all: 'All documents' },
  departments: { no: '02', label: 'Departments', all: 'All departments' },
  projects: { no: '03', label: 'Projects', all: 'All projects' },
  confidential: { no: '04', label: 'Confidential', all: 'All confidential folders' },
  management: { no: '05', label: 'Management', all: 'Management files' },
  archive: { no: '06', label: 'Archive', all: 'Whole archive' },
  personal: { no: '', label: 'Personal', all: 'My files' },
};
const CAT = { auth: 'sign-in', admin: 'admin', acl: 'access', file: 'file', share: 'link' };
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|pdf)$/i;
const EDITABLE = /\.(docx?|odt|rtf|xlsx?|ods|csv|pptx?|odp)$/i;
const NAME_BAD = /[^\p{L}\p{M}\p{N} ._()\[\],+&'№-]/gu;
// tree: folder id -> its subfolders (loaded on demand); open: expanded folders; active: folder on screen.
const state = { me: null, stage: null, appName: 'Company Files', spaces: [], tree: new Map(), open: new Set(), active: null };
const app = document.getElementById('app');

// ---------------------------------------------------------------- DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const ICONS = {
  folder: 'M1.75 4.25a1 1 0 0 1 1-1h3.6l1.5 1.75h5.4a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z',
  file: 'M3.75 1.75h5.5l3 3v9.5h-8.5z M9.25 1.75v3h3',
  lock: 'M4.25 7.25h7.5v6.5h-7.5z M5.75 7.25V5.5a2.25 2.25 0 0 1 4.5 0v1.75',
  upload: 'M8 10.75V2.5 M4.75 5.75 8 2.5l3.25 3.25 M2.75 10.5v2.75h10.5V10.5',
  download: 'M8 2.5v8.25 M4.75 7.5 8 10.75l3.25-3.25 M2.75 10.5v2.75h10.5V10.5',
  plus: 'M8 3.25v9.5 M3.25 8h9.5',
  search: 'M7 11.75a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5z M10.5 10.5l3.25 3.25',
  dots: 'M3.5 8h.01 M8 8h.01 M12.5 8h.01',
  people: 'M6 7a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 6 7z M1.75 13.25c.35-2.2 2-3.5 4.25-3.5s3.9 1.3 4.25 3.5 M10.5 2.75a2.25 2.25 0 0 1 0 4.25 M11.75 9.9c1.25.45 2.1 1.6 2.5 3.35',
  link: 'M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 1 0-3.9-3.9l-.6.6 M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 1 0 3.9 3.9l.6-.6',
  trash: 'M2.75 4.25h10.5 M6.25 4.25V2.75h3.5v1.5 M4.25 4.25l.6 9h6.3l.6-9',
  menu: 'M2.5 4.25h11 M2.5 8h11 M2.5 11.75h11',
  close: 'M4.25 4.25l7.5 7.5 M11.75 4.25l-7.5 7.5',
  activity: 'M1.75 8.25h2.75l1.75-4.5 3.5 8.5 1.75-4h2.75',
  person: 'M8 7.25a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M3 13.75c.4-2.5 2.4-4 5-4s4.6 1.5 5 4',
  eye: 'M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z M8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z',
  history: 'M2.25 8a5.75 5.75 0 1 0 1.7-4.1 M2.25 2.75v2.5h2.5 M8 5v3.25l2.25 1.25',
  pen: 'M10.25 2.75l3 3-8 8H2.25v-3z',
  move: 'M1.75 4.25a1 1 0 0 1 1-1h3.6l1.5 1.75h5.4a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z M6 9.25h4 M8.5 7.5l1.75 1.75L8.5 11',
  back: 'M9.75 3.5 5.25 8l4.5 4.5',
  check: 'M3.25 8.5l3 3 6.5-7',
  chev: 'M6 3.5 10.5 8 6 12.5',
  blank: '',
};

// Theme choice is a per-browser convenience; "auto" follows the device (theme.js applies it before paint).
const theme = () => document.documentElement.dataset.theme || 'auto';
function setTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch {}
}
const themeItems = () => [['light', 'Light theme'], ['dark', 'Dark theme'], ['auto', 'Theme as on this device']]
  .map(([t, label]) => ({ label, icon: theme() === t ? 'check' : 'blank', run: () => setTheme(t) }));
const NS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ico') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  s.append(p);
  return s;
}
function folderGlyph() {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'glyph');
  s.setAttribute('aria-hidden', 'true');
  for (const [cls, d] of [['g-body', 'M2.5 6.25a1 1 0 0 1 1-1h5.4l2.1 2.4h9.5a1 1 0 0 1 1 1v10.6a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1z'], ['g-line', 'M2.5 11h19']]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

const fmtSize = n => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${Math.round(n / 1024)} KB` : n < 2 ** 30 ? `${+(n / 2 ** 20).toFixed(1)} MB` : `${+(n / 2 ** 30).toFixed(2)} GB`);
// Made once: toLocaleString with options builds a new formatter on every call, which took seconds for a big folder.
const F_TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const F_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const F_DAY_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const F_FULL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function fmtDate(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return F_TIME.format(d);
  return (d.getFullYear() !== now.getFullYear() ? F_DAY_YEAR : F_DAY).format(d);
}
const fmtDateTime = t => F_FULL.format(new Date(t));
// Your own personal folder is the only one you Manage there; someone else's shows by its name.
const spaceLabel = s => (s.area === 'personal' && s.level === 3 ? 'My files' : s.root ? AREA[s.area].all : s.name);
const copy = text => navigator.clipboard.writeText(text);

function mount(node) {
  app.replaceChildren(node);
  app.querySelector('[autofocus]')?.focus();
}

// ---------------------------------------------------------------- server calls
async function api(method, url, body) {
  const init = { method, headers: { 'x-requested-with': 'fetch' }, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('No connection to the server. Check your network and try again.');
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (data?.code === 'auth' && state.me) {
      state.me = null;
      renderLogin('Your session has ended. Sign in again.');
    } else if (data?.code === 'stage' && state.stage === 'full') {
      refreshMe().then(route);
    }
    throw new Error(data?.error || `Request failed (${res.status}).`);
  }
  return data;
}

function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- feedback
function toast(msg, kind = '', action) {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, h('span', {}, msg),
    action ? h('button', { type: 'button', class: 'toast-act', onClick: () => { t.remove(); act(action.run)(); } }, action.label) : null);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), action ? 8000 : kind === 'bad' ? 7000 : 4000);
}
const act = fn => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, 'bad');
  }
};

function form(cls, onSubmit, ...kids) {
  const f = h('form', { class: cls }, ...kids);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    const err = f.querySelector('.form-error');
    if (btn) btn.disabled = true;
    if (err) err.textContent = '';
    try {
      await onSubmit(Object.fromEntries(new FormData(f)), f);
    } catch (x) {
      if (err) err.textContent = x.message;
      else toast(x.message, 'bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return f;
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
const errorLine = () => h('p', { class: 'form-error', role: 'alert' });

function dialog(title, body, actions = [], cls = '') {
  const d = h('dialog', { class: `dlg ${cls}` },
    h('header', { class: 'dlg-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => d.close() }, icon('close'))),
    h('div', { class: 'dlg-body' }, body),
    actions.length ? h('footer', { class: 'dlg-foot' }, actions) : null);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function formDialog(title, fields, submitLabel, onSubmit) {
  let d;
  const f = form('stack', async v => {
    await onSubmit(v);
    d.close();
  }, fields, errorLine(), h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => d.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, submitLabel)));
  d = dialog(title, f);
  f.querySelector('input, select')?.focus();
}

function confirmDialog(title, text, label, danger = false) {
  return new Promise(resolve => {
    let yes = false;
    const d = dialog(title, h('p', {}, text), [
      h('button', { type: 'button', class: 'btn', onClick: () => d.close() }, 'Cancel'),
      h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => { yes = true; d.close(); } }, label),
    ]);
    d.addEventListener('close', () => resolve(yes));
  });
}

let menuEl = null, menuAnchor = null;
function openMenu(anchor, items) {
  closeMenu();
  const list = items.filter(Boolean);
  menuEl = h('ul', { class: 'menu', role: 'menu' }, list.map(it => it === '-'
    ? h('li', { role: 'separator' }, h('hr'))
    : h('li', {}, h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onClick: () => { closeMenu(); act(it.run)(); } }, it.icon ? icon(it.icon) : null, it.label))));
  menuAnchor = anchor;
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + menuEl.offsetHeight > innerHeight ? r.top - menuEl.offsetHeight - 4 : r.bottom + 4;
  menuEl.style.top = `${Math.max(8, top)}px`;
  menuEl.style.left = `${Math.max(8, Math.min(r.right - menuEl.offsetWidth, innerWidth - menuEl.offsetWidth - 8))}px`;
  menuEl.querySelector('button')?.focus();
}
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
document.addEventListener('pointerdown', e => {
  if (menuEl && !menuEl.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !menuEl) return;
  closeMenu();
  menuAnchor?.focus();
});
// Enter sends the selected files and folders to the person's computers, unless Enter means something else here
// (a text field, a button or link, an open dialog, menu or editor).
document.addEventListener('keydown', e => {
  const s = state.selection;
  if (e.key !== 'Enter' || e.repeat || !s?.ids.size || menuEl || document.querySelector('dialog[open], .editor')) return;
  if (e.target.closest?.('input:not([type=checkbox]), textarea, select, button, a, [contenteditable]')) return;
  e.preventDefault();
  act(s.send)();
});
addEventListener('resize', closeMenu);

// ---------------------------------------------------------------- session and routing
// The server puts who is signed in and their places into the start page (saves two round trips); read once.
const BOOT = (() => {
  const el = document.getElementById('boot');
  el?.remove();
  try { return el && JSON.parse(el.textContent); } catch { return null; }
})();

async function refreshMe(boot = null) {
  const me = boot?.me || await api('GET', '/api/me'); // none when the browser may have held back the session cookie
  Object.assign(state, { appName: me.appName, me: me.user, stage: me.stage, office: me.office, pdfEdit: me.pdfEdit });
  document.title = state.appName;
  state.spaces = state.me && state.stage === 'full' && !state.me.admin ? boot?.spaces || await api('GET', '/api/spaces') : [];
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null;
  history.replaceState(null, '', '/');
  renderLogin();
}

async function route() {
  closeMenu();
  document.body.classList.remove('nav-open');
  state.active = null;
  state.selection = null;
  if (!state.me) return renderLogin();
  if (state.stage !== 'full') return renderStage();
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, arg] = path.split('/');
  try {
    if (state.me.admin) {
      if (page === 'groups') return await viewGroups();
      if (page === 'structure') return await viewStructure();
      if (page === 'activity') return await viewActivity();
      if (page === 'account') return await viewAccount();
      return await viewPeople();
    }
    if (!up.checked) {
      up.checked = true;
      api('GET', '/api/tus').then(list => { up.unfinished = list; if (list.length) paintUploads(); }).catch(() => {});
    }
    if (page === 'f') return await viewFolder(Number(arg));
    if (page === 'shared') return await viewShared();
    if (page === 'trash') return await viewTrash();
    if (page === 'search') return await viewSearch(new URLSearchParams(qs || '').get('q') || '');
    if (page === 'activity') return await viewActivity();
    if (page === 'account') return await viewAccount();
    return viewHome();
  } catch (e) {
    if (!state.me || state.stage !== 'full') return;
    shell(h('div', { class: 'empty' }, h('strong', {}, 'This page cannot be opened'), h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to my folders')));
  }
}

addEventListener('hashchange', () => route());

(async function boot() {
  try {
    if (location.pathname.startsWith('/s/')) return await renderShare(location.pathname.slice(3));
    if (location.pathname.startsWith('/join/')) return await renderJoin(location.pathname.slice(6));
    await refreshMe(BOOT);
    await route();
  } catch (e) {
    document.body.className = 'gate';
    mount(h('div', { class: 'card-folder' }, h('div', { class: 'card-body' }, h('h1', { class: 'gate-title' }, 'The server is not answering'), h('p', { class: 'gate-sub' }, e.message), h('button', { type: 'button', class: 'btn', onClick: () => location.reload() }, 'Try again'))));
  }
})();

// ---------------------------------------------------------------- sign-in screens
function gate(...content) {
  document.body.className = 'gate';
  mount(h('div', { class: 'card-folder' }, h('div', { class: 'tab' }, folderGlyph(), h('span', {}, state.appName)), h('div', { class: 'card-body' }, content)));
}

function renderLogin(msg = '') {
  gate(
    h('h1', { class: 'gate-title' }, 'Sign in'),
    h('p', { class: 'gate-sub' }, 'Use your login (or the email you signed up with) and your password.'),
    form('stack', async v => {
      await api('POST', '/api/login', { login: v.login.trim(), password: v.password });
      await refreshMe();
      await route();
    },
      field('Login or email', h('input', { name: 'login', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, autofocus: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('p', { class: 'form-error', role: 'alert' }, msg),
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Sign in')),
    h('p', { class: 'gate-foot muted' }, 'Forgot your password? IT can reset it.'));
}

function renderStage() {
  const done = async () => {
    await refreshMe();
    await route();
  };
  const foot = h('p', { class: 'gate-foot' }, h('span'), h('button', { type: 'button', class: 'linkish muted', onClick: act(logout) }, 'Sign out'));
  return gate(
    h('h1', { class: 'gate-title' }, 'Choose your own password'),
    h('p', { class: 'gate-sub' }, 'The password from IT was temporary. Pick one that only you know.'),
    passwordForm(done, 'Save and continue'),
    foot);
}

function passwordForm(onDone, label = 'Change password') {
  return form('stack', async (v, f) => {
    if (v.next !== v.repeat) throw new Error('The two new passwords do not match.');
    await api('POST', '/api/password', { current: v.current, next: v.next });
    f.reset();
    toast('Password changed. Your other devices were signed out.');
    await onDone?.();
  },
    field('Current password', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
    field('New password', h('input', { name: 'next', type: 'password', autocomplete: 'new-password', minlength: 12, required: true }), 'At least 12 characters. A short phrase is easier to remember than a jumble.'),
    field('Repeat the new password', h('input', { name: 'repeat', type: 'password', autocomplete: 'new-password', required: true })),
    errorLine(),
    h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, label)));
}

// ---------------------------------------------------------------- app shell
function shell(content, active = null) {
  document.body.className = 'app';
  const admin = state.me.admin;
  const sideLink = (href, ico, label, key) => h('a', { class: 'side-link' + (active === key ? ' on' : ''), href }, icon(ico), label);
  mount(h('div', { class: 'shell' },
    h('aside', { class: 'cabinet', 'aria-label': 'Navigation' },
      h('a', { class: 'brand', href: '#/' }, folderGlyph(), h('span', {}, state.appName)),
      admin ? adminNav(active) : drawers(),
      h('nav', { class: 'side-foot', 'aria-label': 'More' },
        admin ? null : sideLink('#/shared', 'people', 'Shared with me', 'shared'),
        admin ? null : sideLink('#/trash', 'trash', 'Trash', 'trash'),
        admin || state.me.manager ? sideLink('#/activity', 'activity', 'Activity log', 'activity') : null,
        sideLink('#/account', 'person', 'Account and security', 'account'))),
    h('div', { class: 'scrim', onClick: () => document.body.classList.remove('nav-open') }),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Open navigation', onClick: () => document.body.classList.add('nav-open') }, icon('menu')),
        admin ? h('span', { class: 'top-note' }, 'IT administration. Admin accounts have no access to file contents.') : searchBox(),
        h('button', { type: 'button', class: 'who', 'aria-haspopup': 'menu', onClick: e => openMenu(e.currentTarget, [
          { label: 'Account and security', icon: 'person', run: () => { location.hash = '#/account'; } },
          '-',
          ...themeItems(),
          '-',
          { label: 'Sign out', icon: 'blank', run: logout },
        ]) }, h('span', { class: 'who-name' }, state.me.name), h('span', { class: 'who-login mono' }, state.me.login))),
      h('main', { class: 'view', id: 'view' }, content))));
}

// Sidebar: the cabinet's drawers, each holding the folders you can open, as an expandable tree.
function drawers() {
  const byArea = new Map();
  for (const s of state.spaces) {
    if (!byArea.has(s.area)) byArea.set(s.area, []);
    byArea.get(s.area).push(s);
  }
  return h('nav', { class: 'drawers', id: 'tree', 'aria-label': 'Folders' }, [...byArea].map(([area, list]) => h('section', { class: `drawer area-${area}` },
    h('h2', { class: 'plate' }, AREA[area].no ? h('span', { class: 'plate-no' }, AREA[area].no) : null, AREA[area].label),
    list.map(s => treeNode(s.id, spaceLabel(s), s.context)))));
}

function treeNode(id, label, context) {
  const kids = state.tree.get(id);
  const open = state.open.has(id) && kids?.length;
  const on = id === state.active;
  const toggle = kids && !kids.length
    ? h('span', { class: 'tree-tog', 'aria-hidden': 'true' })
    : h('button', { type: 'button', class: 'tree-tog' + (open ? ' open' : ''), 'aria-expanded': String(!!open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${label}`, onClick: () => toggleNode(id) }, icon('chev'));
  return h('div', { class: 'tree-item' },
    h('div', { class: 'tree-row' + (on ? ' on' : '') }, toggle,
      h('a', { class: 'tree-link', href: `#/f/${id}`, 'aria-current': on ? 'page' : null }, label, context ? h('span', { class: 'space-ctx' }, context) : null)),
    open ? h('div', { class: 'tree-kids' }, kids.map(k => treeNode(k.id, k.name))) : null);
}

async function loadKids(id) {
  try {
    const d = await api('GET', `/api/nodes/${id}`);
    state.tree.set(id, d.children.filter(c => c.dir).map(c => ({ id: c.id, name: c.name })));
  } catch {
    state.tree.set(id, []);
  }
}

async function toggleNode(id) {
  if (state.open.has(id) && state.tree.get(id)?.length) state.open.delete(id);
  else {
    state.open.add(id);
    if (!state.tree.has(id)) await loadKids(id);
  }
  paintTree();
}

const paintTree = () => document.getElementById('tree')?.replaceWith(drawers());

// After creating, renaming, moving or deleting folders the cached tree is stale.
const changed = () => {
  state.tree.clear();
  return route();
};

function adminNav(active) {
  return h('nav', { class: 'drawers', 'aria-label': 'Administration' }, h('section', { class: 'drawer' },
    h('h2', { class: 'plate' }, 'Administration'),
    [['people', 'People'], ['groups', 'Groups'], ['structure', 'Folders and quotas']].map(([k, label]) =>
      h('a', { class: 'space' + (active === k ? ' on' : ''), href: `#/${k}` }, label))));
}

function searchBox() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  return form('search', v => { location.hash = `#/search?q=${encodeURIComponent(v.q.trim())}`; },
    icon('search'), h('input', { type: 'search', name: 'q', value: q, placeholder: 'Search file and folder names', 'aria-label': 'Search' }));
}

const page = (title, sub, ...content) => h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'page-title' }, title), sub ? h('p', { class: 'muted page-sub' }, sub) : null)), content);
const panel = (...c) => h('div', { class: 'panel' }, c);
const card = (title, text, ...c) => h('section', { class: 'card' }, h('h3', {}, title), text ? h('p', { class: 'muted card-text' }, text) : null, c);
const empty = (title, text) => h('div', { class: 'empty' }, h('strong', {}, title), text ? h('p', {}, text) : null);

// cols: 'Label' or ['Label', 'class']; cells: content, or { v, cls } for an extra class.
function table(cols, rows) {
  const spec = c => (typeof c === 'string' ? [c, ''] : c);
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, cols.map(c => {
      const [label, cls] = spec(c);
      return h('th', { scope: 'col', class: cls || null }, label || h('span', { class: 'sr' }, 'Actions'));
    }))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map((v, i) => {
      const cls = spec(cols[i])[1];
      return v && typeof v === 'object' && !(v instanceof Node) && 'v' in v
        ? h('td', { class: `${cls} ${v.cls || ''}`.trim() || null, title: v.title }, v.v)
        : h('td', { class: cls || null }, v);
    })))));
}

// ---------------------------------------------------------------- folders
function viewHome() {
  const first = state.spaces.find(s => s.area === 'departments') || state.spaces[0];
  if (first) return location.replace(`#/f/${first.id}`);
  shell(empty('No folders yet', 'You have no access to any folder. Ask your department head.'));
}

async function viewFolder(id) {
  const d = await api('GET', `/api/nodes/${id}`);
  if (!d.node.dir) return location.replace(d.crumbs.length > 1 ? `#/f/${d.crumbs.at(-2).id}` : '#/');
  // The sidebar follows you: the path to this folder is expanded and its subfolders show underneath.
  state.active = d.node.id;
  state.tree.set(d.node.id, d.children.filter(c => c.dir).map(c => ({ id: c.id, name: c.name })));
  for (const c of d.crumbs) state.open.add(c.id);
  const missing = d.crumbs.slice(0, -1).filter(c => !state.tree.has(c.id));
  shell(folderView(d));
  if (missing.length) Promise.all(missing.map(c => loadKids(c.id))).then(paintTree);
}

function folderView(d) {
  const n = d.node;
  const title = d.area === 'personal' && d.crumbs.length === 1 && n.level === 3 ? 'My files' : n.name;
  // Selection for auto-save (not in confidential folders: those files never go to computers). Enter sends it.
  const sel = d.area === 'confidential' ? null : new Set();
  const selBar = h('div', { class: 'sel-bar', hidden: true });
  const paintSel = () => {
    selBar.hidden = !sel.size;
    selBar.replaceChildren(h('span', {}, `${sel.size} selected`), h('span', { class: 'muted' }, ' · press Enter to save to your computers'), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn small primary', onClick: act(() => sendToComputers(sel)) }, icon('download'), 'Save to computers'));
  };
  if (sel) state.selection = { ids: sel, send: () => sendToComputers(sel) };
  if (d.children.some(isPdf)) setTimeout(prefetchViewer, 800); // after the folder itself has loaded
  const body = h('div', { class: 'folder-body' },
    selBar,
    h('div', { class: 'toolbar' },
      d.can.edit
        ? [h('button', { type: 'button', class: 'btn primary', onClick: () => pickFiles(n) }, icon('upload'), 'Upload files'),
           // Phones cannot pick a folder; there the button would only open the file picker again.
           matchMedia('(pointer: coarse)').matches ? null : h('button', { type: 'button', class: 'btn', onClick: () => pickFiles(n, true) }, icon('folder'), 'Upload folder'),
           h('button', { type: 'button', class: 'btn', onClick: () => newFolder(n) }, icon('plus'), 'New folder')]
        : h('span', { class: 'muted' }, 'You can open and download files here.'),
      h('span', { class: 'grow' }),
      d.children.length ? h('button', { type: 'button', class: 'btn', onClick: act(() => downloadZip(n)) }, icon('download'), 'Download as ZIP') : null,
      h('button', { type: 'button', class: 'btn', onClick: act(() => accessDialog(n.id, title)) }, icon('people'), 'Who has access'),
      d.can.share ? h('button', { type: 'button', class: 'btn', onClick: act(() => linksDialog(n)) }, icon('link'), 'External links') : null),
    d.children.length ? fileTable(d.children, d, sel, paintSel) : empty('This folder is empty', d.can.edit ? 'Drop files or folders here, or use Upload files.' : 'Nothing has been added yet.'));
  if (d.can.edit) enableDrop(body, n);
  return h('div', { class: 'folder' },
    crumbsNav(d),
    h('div', { class: 'folder-head' },
      h('div', { class: 'tab' }, h('h1', {}, title)),
      stamp(d.area, n.level),
      n.restricted ? h('span', { class: 'badge' }, icon('lock'), 'Restricted') : null,
      d.quota ? quotaMeter(d.quota) : null),
    body);
}

function crumbsNav(d) {
  const parts = [...(d.context ? d.context.split(' / ').map(t => h('span', {}, t)) : []), ...d.crumbs.slice(0, -1).map(c => h('a', { href: `#/f/${c.id}` }, c.name))];
  return h('nav', { class: 'crumbs', 'aria-label': 'Location' }, parts.flatMap((p, i) => (i ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), p] : [p])));
}

function stamp(area, level) {
  if (area === 'confidential') return h('span', { class: 'stamp stamp-conf' }, `Confidential · ${LEVEL[level]}`);
  return h('span', { class: `stamp stamp-${LEVEL[level].toLowerCase()}` }, level === 1 ? 'Read only' : LEVEL[level]);
}

function quotaMeter(q) {
  const pct = Math.min(100, (q.used / q.total) * 100);
  const bar = h('i');
  bar.style.width = `${pct}%`;
  return h('div', { class: 'quota', title: `Storage space of "${q.name}"` }, h('span', { class: 'quota-bar' + (pct > 90 ? ' high' : '') }, bar), h('span', {}, `${fmtSize(q.used)} of ${fmtSize(q.total)}`));
}

function fileTable(items, d, sel, onSel) {
  const boxes = [];
  const tick = (it, box) => {
    if (box.checked) sel.add(it.id);
    else sel.delete(it.id);
    all.checked = sel.size === items.length;
    all.indeterminate = sel.size > 0 && sel.size < items.length;
    onSel();
  };
  // Select all covers rows not drawn yet too: they start ticked from sel.
  const all = sel && h('input', { type: 'checkbox', 'aria-label': 'Select all', onChange: () => {
    for (const it of items) all.checked ? sel.add(it.id) : sel.delete(it.id);
    for (const [, box] of boxes) box.checked = all.checked;
    onSel();
  } });
  const selCell = it => {
    if (!sel) return null;
    const box = h('input', { type: 'checkbox', checked: sel.has(it.id), 'aria-label': `Select ${it.name}`, onChange: () => tick(it, box) });
    boxes.push([it, box]);
    return h('td', { class: 'c-sel' }, box);
  };
  const row = it => h('tr', {},
    selCell(it),
    h('td', {}, it.dir
      ? h('a', { class: 'item', href: `#/f/${it.id}` }, icon('folder', 'ico ico-folder'), h('span', {}, it.name), it.restricted ? [icon('lock', 'ico ico-lock'), h('span', { class: 'sr' }, '(restricted)')] : null)
      : h('button', { type: 'button', class: 'item linkish', onClick: () => openFile(it) }, icon('file', 'ico ico-file'), h('span', {}, it.name))),
    h('td', { class: 'num mono' }, it.dir ? '' : fmtSize(it.size)),
    h('td', { class: 'c-date mono', title: fmtDateTime(it.updated_at) }, fmtDate(it.updated_at)),
    h('td', { class: 'c-by muted' }, it.updated_by || ''),
    h('td', { class: 'c-act' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Actions for ${it.name}`, 'aria-haspopup': 'menu', onClick: e => openMenu(e.currentTarget, itemActions(it, d)) }, icon('dots', 'ico ico-dots'))));
  // A big folder opens at once: the first rows are drawn now and the rest as you scroll towards them, so rows nobody
  // looks at are never drawn (5000 rows at once took about a second, mostly the browser laying out the table).
  const FIRST = 200, SLICE = 300;
  const tbody = h('tbody', {}, items.slice(0, FIRST).map(row));
  let next = FIRST;
  if (items.length > next) {
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      io.disconnect();
      tbody.append(...items.slice(next, (next += SLICE)).map(row));
      if (next < items.length) io.observe(tbody.lastElementChild);
    }, { rootMargin: '1500px 0px' });
    io.observe(tbody.lastElementChild);
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid files' },
    h('thead', {}, h('tr', {},
      sel ? h('th', { scope: 'col', class: 'c-sel' }, all) : null,
      h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col', class: 'num' }, 'Size'), h('th', { scope: 'col', class: 'c-date' }, 'Modified'),
      h('th', { scope: 'col', class: 'c-by' }, 'By'), h('th', { scope: 'col', class: 'c-act' }, h('span', { class: 'sr' }, 'Actions')))),
    tbody));
}

function itemActions(it, d) {
  const edit = d.can.edit && it.level >= 2 && !it.system;
  return [
    it.dir ? { label: 'Open', icon: 'folder', run: () => { location.hash = `#/f/${it.id}`; } } : null,
    isPdf(it) ? { label: it.level >= 2 ? 'Open (sign, comment, fill in)' : 'Open', icon: 'eye', run: () => openPdfViewer(it) } : null,
    canEditPdf(it) ? { label: 'Edit text', icon: 'pen', run: () => openPdfEditor(it) } : null,
    canEditPdf(it) && state.office ? { label: 'Edit as Word document', icon: 'file', run: () => openEditor(it) } : null,
    canEditOnline(it) ? { label: it.level >= 2 ? 'Edit in browser' : 'Open in browser', icon: 'pen', run: () => openEditor(it) } : null,
    !it.dir && !isPdf(it) && PREVIEWABLE.test(it.name) ? { label: 'Preview', icon: 'eye', run: () => preview(it) } : null,
    !it.dir ? { label: 'Download', icon: 'download', run: () => download(`/api/nodes/${it.id}/content`) } : { label: 'Download as ZIP', icon: 'download', run: () => downloadZip(it) },
    !it.dir ? { label: 'Versions', icon: 'history', run: () => versionsDialog(it) } : null,
    { label: 'Who has access', icon: 'people', run: () => accessDialog(it.id, it.name) },
    it.share ? { label: 'External links', icon: 'link', run: () => linksDialog(it) } : null,
    edit ? '-' : null,
    edit ? { label: 'Rename', icon: 'pen', run: () => renameDialog(it) } : null,
    edit ? { label: 'Move', icon: 'move', run: () => moveDialog(it, d.node.id) } : null,
    edit ? { label: 'Move to trash', icon: 'trash', danger: true, run: () => trashItem(it) } : null,
  ];
}

// PDFs open straight in the PDF editor for people who may edit them; with Read they keep the quick preview.
const canEditPdf = it => state.pdfEdit && !it.dir && /\.pdf$/i.test(it.name) && it.level >= 2;
const canEditOnline = it => state.office && !it.dir && EDITABLE.test(it.name);
const isPdf = it => !it.dir && /\.pdf$/i.test(it.name);
const openFile = it => (isPdf(it) ? openPdfViewer(it) : canEditOnline(it) ? openEditor(it) : PREVIEWABLE.test(it.name) ? preview(it) : download(`/api/nodes/${it.id}/content`));

// ---------------------------------------------------------------- PDF viewer (EmbedPDF)
// When a folder shows a PDF, the viewer (about 2 MB compressed) is fetched in the background, so the first click
// opens it from the browser's cache. The file names belong to the vendored version.
let viewerPrefetched = false;
function prefetchViewer() {
  if (viewerPrefetched) return;
  viewerPrefetched = true;
  for (const f of ['/viewer.html', '/viewer.js', '/viewer.css', 'embedpdf.js', 'embedpdf-cl9qiF45.js', 'worker-engine-BCCrxWYm.js', 'browser-BKLM0ThC-BCLQGPD6.js', 'pdfium.wasm'])
    document.head.append(h('link', { rel: 'prefetch', href: f.startsWith('/') ? f : `/vendor/embedpdf-2.15.1/${f}` }));
}

// Sharp zoom, thumbnails, search; with Edit also highlights, notes, drawing, stamps, signatures, forms and redaction.
// It runs on its own page in a frame (with its own CSP); Save there stores the finished PDF as a new version.
function openPdfViewer(it) {
  const edit = it.level >= 2;
  // Resolved here and passed on: Firefox gives a frame the color scheme its page declares, not the system's.
  const theme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const src = `/viewer.html#${new URLSearchParams({ id: it.id, v: it.updated_at, edit: edit ? '1' : '0', name: it.name, user: state.me?.name || '', theme })}`;
  const frame = h('iframe', { class: 'editor-frame', src, title: `PDF: ${it.name}`, allow: 'clipboard-read; clipboard-write; fullscreen' });
  let dirty = false;
  const saveBtn = h('button', { type: 'button', class: 'btn small primary', disabled: true, onClick: () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    frame.contentWindow.postMessage({ type: 'save' }, location.origin);
  } }, 'Save');
  const close = () => {
    removeEventListener('message', onMessage);
    removeEventListener('keydown', onKey);
    box.remove();
    if (location.hash.startsWith('#/f/')) route();
  };
  const leave = async () => {
    if (dirty && !(await confirmDialog('Leave without saving?', 'Your highlights, notes, signatures or other changes are not saved yet and will be lost.', 'Leave', true))) return false;
    close();
    return true;
  };
  const onMessage = e => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'dirty' && edit) {
      dirty = true;
      saveBtn.disabled = false;
    } else if (m.type === 'saved') {
      dirty = false;
      it.updated_at = m.version;
      saveBtn.textContent = 'Save';
      toast('Saved into the PDF.');
    } else if (m.type === 'error') {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = !dirty;
      toast(m.message, 'bad');
    }
  };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) leave(); };
  const box = h('div', { class: 'editor pdfviewer', role: 'dialog', 'aria-label': it.name },
    h('header', { class: 'editor-bar' },
      h('button', { type: 'button', class: 'btn small', 'aria-label': 'Back to files', onClick: () => leave() }, icon('back'), h('span', { class: 'lbl' }, 'Back to files')),
      h('strong', { class: 'editor-name' }, it.name),
      canEditPdf(it) ? h('button', { type: 'button', class: 'btn small', 'aria-label': 'Edit text', onClick: act(async () => { if (await leave()) openPdfEditor(it); }) }, icon('pen'), h('span', { class: 'lbl' }, 'Edit text')) : null,
      canEditPdf(it) && state.office ? h('button', { type: 'button', class: 'btn small', 'aria-label': 'Edit as Word', onClick: act(async () => { if (await leave()) openEditor(it); }) }, icon('file'), h('span', { class: 'lbl' }, 'Edit as Word')) : null,
      edit ? saveBtn : null,
      h('span', { class: 'muted editor-note' }, edit ? 'Highlight, comment, sign or fill in, then Save: it goes straight into this file.' : 'View only: you have Read access.')),
    frame);
  document.body.append(box);
  addEventListener('message', onMessage);
  addEventListener('keydown', onKey);
}

// ---------------------------------------------------------------- PDF editor
// Pages are shown exactly as they are (images rendered by the server) with every line of text clickable on top.
// Only the lines someone changes, erases or adds are written into the PDF; everything else stays as it was.
const PDF_FONTS = { sans: '"Liberation Sans", Arial, Helvetica, sans-serif', serif: '"Liberation Serif", "Times New Roman", Times, serif', mono: '"Liberation Mono", "Courier New", monospace' };
const measureCtx = document.createElement('canvas').getContext('2d');

async function openPdfEditor(it) {
  let d;
  toast('Opening the PDF…');
  try {
    d = await api('POST', `/api/nodes/${it.id}/pdf-edit`);
  } catch (e) {
    return toast(e.message, 'bad');
  }
  const scale = Math.min(2, Math.max(0.5, (innerWidth - 64) / Math.max(...d.pages.map(p => p.width))));
  const edits = new Map(); // key -> change sent to the server
  const items = new Map(); // key -> { el, page, base } for every line on screen
  const history = [];
  let tool = 'edit', added = 0, size = 11;
  const px = v => `${v * scale}px`;
  // The line's own font first (Calibri, Arial… are on most office computers), then a look-alike of the same width.
  const ALIAS = { Carlito: 'Calibri', Caladea: 'Cambria', LiberationSans: 'Arial', LiberationSerif: 'Times New Roman', LiberationMono: 'Courier New' };
  const fontOf = s => {
    const name = /^[\w .-]{1,60}$/.test(s.font || '') ? s.font : '';
    const own = name ? `"${name}", ${ALIAS[name] ? `"${ALIAS[name]}", ` : ''}` : '';
    return `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '400 '}${s.size * scale}px ${own}${PDF_FONTS[s.family] || PDF_FONTS.sans}`;
  };
  const styleText = (el, s) => {
    el.style.font = fontOf(s);
    el.style.color = `rgb(${s.color.map(c => Math.round(c * 255)).join(',')})`;
  };

  const saveBtn = h('button', { type: 'button', class: 'btn small primary', onClick: act(save) }, 'Save');
  const undoBtn = h('button', { type: 'button', class: 'btn small', onClick: undo }, 'Undo');
  const toolBtn = (name, label) => h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(tool === name), 'data-tool': name, onClick: () => setTool(name) }, label);
  const tools = h('div', { class: 'pdfed-tools', role: 'group', 'aria-label': 'Tool' }, toolBtn('edit', 'Edit text'), toolBtn('add', 'Add text'), toolBtn('erase', 'Erase'));
  const sizeSel = h('select', { class: 'pdfed-size', 'aria-label': 'Size of added text', onChange: e => { size = Number(e.target.value); } },
    [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map(n => h('option', { value: n, selected: n === size }, `${n} pt`)));
  const pagesEl = h('div', { class: 'pdfed-pages' });
  const box = h('div', { class: 'editor pdfed tool-edit', role: 'dialog', 'aria-label': `Editing ${it.name}` },
    h('header', { class: 'editor-bar' },
      h('button', { type: 'button', class: 'btn small', onClick: () => close() }, icon('back'), 'Back to files'),
      h('strong', { class: 'editor-name' }, it.name),
      tools, sizeSel, undoBtn, saveBtn,
      h('span', { class: 'muted editor-note' }, 'Pages stay exactly as they are; only what you change is rewritten.')),
    pagesEl);

  function setTool(name) {
    tool = name;
    box.className = `editor pdfed tool-${name}`;
    for (const b of tools.children) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  }
  function refresh() {
    saveBtn.textContent = edits.size ? `Save (${edits.size})` : 'Save';
    saveBtn.disabled = !edits.size;
    undoBtn.disabled = !history.length;
  }
  function paint(key) {
    const item = items.get(key);
    const e = edits.get(key);
    const s = item.base || e;
    item.el.className = 'pdfed-span' + (e?.type === 'erase' ? ' erased' : e ? (item.base ? ' changed' : ' added') : '');
    item.el.textContent = e && e.type !== 'erase' ? e.text : '';
    if (e && e.type !== 'erase') styleText(item.el, s);
    item.el.title = e?.type === 'erase' ? 'Erased' : (e?.text ?? s.text ?? '');
  }
  function set(key, value, record = true) {
    const prev = edits.get(key);
    if (record) history.push([key, prev?.type === 'add' && !prev.text.trim() ? undefined : prev]); // a just-placed empty box is not a state
    if (value) edits.set(key, value);
    else edits.delete(key);
    const item = items.get(key);
    if (!item.base && !value) { // an added line with no text is gone
      item.el.remove();
      items.delete(key);
    } else paint(key);
    refresh();
  }
  function undo() {
    const last = history.pop();
    if (!last) return;
    const [key, prev] = last;
    if (!items.has(key) && prev) makeAdded(key, prev); // bring back an added line that was removed
    set(key, prev, false);
  }
  // A text field over the line, in its font and size, growing with the text.
  function edit(key) {
    const item = items.get(key);
    const e = edits.get(key);
    const s = item.base || e;
    const [x0, y0, x1, y1] = item.base ? s.bbox : [s.origin[0], s.origin[1] - s.size * 0.8, s.origin[0], s.origin[1] + s.size * 0.25];
    const input = h('input', { class: 'pdfed-input', value: e && e.type !== 'erase' ? e.text : s.text || '', 'aria-label': 'Text', spellcheck: 'true' });
    styleText(input, s);
    // The field's border and padding sit outside the line, so its text starts exactly where the line starts;
    // it is always wider than the text, so nothing scrolls out of view while typing.
    input.style.left = `${x0 * scale - 4}px`;
    input.style.top = `${y0 * scale - 2}px`;
    input.style.height = `${Math.max(y1 - y0, s.size * 1.2) * scale + 4}px`;
    const fit = () => {
      measureCtx.font = fontOf(s);
      input.style.width = `${Math.max((x1 - x0) * scale + 8, measureCtx.measureText(input.value).width + 32, 48)}px`;
    };
    fit();
    input.addEventListener('input', fit);
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      input.remove();
      if (!keep) return;
      const v = input.value;
      if (item.base) {
        if (v === item.base.text) set(key, undefined);
        else if (!v.trim()) set(key, { type: 'erase', page: item.page, bbox: item.base.bbox });
        else set(key, { type: 'replace', page: item.page, bbox: s.bbox, origin: s.origin, text: v, size: s.size, color: s.color, family: s.family, bold: s.bold, italic: s.italic, font: s.font, pdfFont: s.pdfFont });
      } else set(key, v.trim() ? { ...e, text: v } : undefined);
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); if (!item.base && !e.text) set(key, undefined, false); }
    });
    input.addEventListener('blur', () => finish(true));
    item.el.parentNode.append(input);
    input.focus();
    input.select();
    input.scrollLeft = 0;
  }
  function makeAdded(key, e) {
    const el = h('div', { class: 'pdfed-span added' });
    el.style.left = px(e.origin[0]);
    el.style.top = px(e.origin[1] - e.size * 0.8);
    el.style.minHeight = px(e.size * 1.05);
    el.addEventListener('click', ev => { ev.stopPropagation(); if (tool === 'erase') set(key, undefined); else edit(key); });
    pagesEl.children[e.page].append(el);
    items.set(key, { el, page: e.page });
  }

  d.pages.forEach((p, pi) => {
    const pg = h('div', { class: 'pdfed-page' + (p.rotated ? ' rotated' : '') });
    pg.style.width = px(p.width);
    pg.style.height = px(p.height);
    pg.append(h('img', { src: `/api/nodes/${it.id}/pdf-page/${pi}?v=${d.version}`, alt: `Page ${pi + 1} of ${d.pages.length}`, loading: pi > 1 ? 'lazy' : null, draggable: 'false' }));
    p.spans.forEach((s, si) => {
      const key = `${pi}:${si}`;
      const el = h('div', { class: 'pdfed-span', title: s.text });
      el.style.left = px(s.bbox[0]);
      el.style.top = px(s.bbox[1]);
      el.style.minWidth = px(s.bbox[2] - s.bbox[0]);
      el.style.height = px(s.bbox[3] - s.bbox[1]);
      el.style.lineHeight = px(s.bbox[3] - s.bbox[1]);
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        if (tool === 'erase') set(key, edits.get(key)?.type === 'erase' ? undefined : { type: 'erase', page: pi, bbox: s.bbox });
        else edit(key);
      });
      pg.append(el);
      items.set(key, { el, page: pi, base: s });
    });
    // Add text: click anywhere on the page.
    pg.addEventListener('click', ev => {
      if (tool !== 'add' || p.rotated || ev.target.closest('.pdfed-input')) return;
      const r = pg.getBoundingClientRect();
      const x = (ev.clientX - r.left) / scale, y = (ev.clientY - r.top) / scale;
      const key = `a${++added}`;
      const e = { type: 'add', page: pi, origin: [x, y + size * 0.8], text: '', size, color: [0, 0, 0], family: 'sans', bold: false, italic: false };
      makeAdded(key, e);
      edits.set(key, e);
      edit(key);
    });
    pagesEl.append(pg);
  });

  async function save() {
    for (const [k, e] of edits) if (e.type === 'add' && !e.text.trim()) edits.delete(k);
    if (!edits.size) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api('POST', `/api/nodes/${it.id}/pdf-edit/save`, { version: d.version, edits: [...edits.values()] });
    } catch (e) {
      refresh();
      throw e;
    }
    toast('Saved into the PDF.');
    edits.clear();
    remove();
    openPdfEditor(it); // show the saved pages
  }
  function remove() {
    removeEventListener('keydown', onKey);
    box.remove();
  }
  async function close() {
    if (edits.size && !(await confirmDialog('Leave without saving?', `${edits.size} change${edits.size === 1 ? ' is' : 's are'} not saved yet and will be lost.`, 'Leave', true))) return;
    remove();
    if (location.hash.startsWith('#/f/')) route();
  }
  const onKey = ev => {
    if (document.querySelector('dialog[open]')) return;
    if (ev.key === 'Escape' && !ev.target.closest?.('input')) close();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.target.closest?.('input')) { ev.preventDefault(); undo(); }
  };
  addEventListener('keydown', onKey);
  document.body.append(box);
  refresh();
}

// Office files open full screen in Collabora Online, which runs on its own address; the file token is posted
// into its frame, never put in a URL. Saving happens inside the editor and lands as a new version.
async function openEditor(it) {
  let s;
  if (/\.pdf$/i.test(it.name)) toast('Turning the PDF into a Word document: two converters try and the closer result is kept. This takes up to 2 minutes the first time…');
  try {
    s = await api('POST', `/api/nodes/${it.id}/editor`);
  } catch (e) {
    return toast(e.message, 'bad');
  }
  const origin = new URL(s.url).origin;
  const frame = h('iframe', { name: `editor-${it.id}`, class: 'editor-frame', title: `Editor: ${it.name}`, allow: 'clipboard-read; clipboard-write; fullscreen' });
  const close = () => {
    removeEventListener('message', onMessage);
    removeEventListener('keydown', onKey);
    box.remove();
    if (location.hash.startsWith('#/f/')) route();
  };
  const onMessage = e => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    let m;
    try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (m?.MessageId === 'UI_Close') close();
  };
  const onKey = e => { if (e.key === 'Escape' && document.activeElement !== frame) close(); };
  const box = h('div', { class: 'editor', role: 'dialog', 'aria-label': `Editing ${it.name}` },
    h('header', { class: 'editor-bar' },
      h('button', { type: 'button', class: 'btn small', onClick: close }, icon('back'), 'Back to files'),
      h('strong', { class: 'editor-name' }, it.name),
      h('span', { class: 'muted editor-note' }, !s.edit ? 'View only: you have Read access.'
        : s.pdf ? 'Edited as a document; every save goes straight into this PDF.'
        : 'Changes are saved automatically. Older copies stay in Versions.')),
    frame);
  document.body.append(box);
  addEventListener('message', onMessage);
  addEventListener('keydown', onKey);
  const f = h('form', { method: 'post', action: s.url, target: frame.name },
    h('input', { type: 'hidden', name: 'access_token', value: s.token }),
    h('input', { type: 'hidden', name: 'access_token_ttl', value: String(s.ttl) }));
  document.body.append(f);
  f.submit();
  f.remove();
}

function preview(it, src = `/api/nodes/${it.id}/content`) {
  const inline = `${src}${src.includes('?') ? '&' : '?'}inline=1`;
  const body = /\.pdf$/i.test(it.name) ? h('iframe', { class: 'pv-frame', src: inline, title: it.name }) : h('img', { class: 'pv-img', src: inline, alt: it.name });
  dialog(it.name, body, [h('button', { type: 'button', class: 'btn', onClick: () => download(src) }, icon('download'), 'Download')], 'wide');
}

function newFolder(n) {
  formDialog('New folder', field('Name', h('input', { name: 'name', required: true, maxlength: 120 }), "Letters, digits, spaces and . _ - ( ) [ ] , + & '"), 'Create folder', async v => {
    await api('POST', `/api/nodes/${n.id}/folders`, { name: v.name.trim() });
    toast(`Folder "${v.name.trim()}" created.`);
    changed();
  });
}

function renameDialog(it) {
  formDialog(`Rename "${it.name}"`, field('New name', h('input', { name: 'name', value: it.name, required: true, maxlength: 120 })), 'Rename', async v => {
    await api('PATCH', `/api/nodes/${it.id}`, { name: v.name.trim() });
    toast('Renamed.');
    changed();
  });
}

async function trashItem(it) {
  await api('DELETE', `/api/nodes/${it.id}`);
  toast(`"${it.name}" moved to trash.`, '', { label: 'Undo', run: async () => { await api('POST', `/api/trash/${it.id}/restore`); changed(); } });
  changed();
}

function moveDialog(it, fromId) {
  const list = h('ul', { class: 'picker' });
  const where = h('p', { class: 'path' });
  const go = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Move here');
  let target = null;
  const d = dialog(`Move "${it.name}"`, [where, list], [h('button', { type: 'button', class: 'btn', onClick: () => d.close() }, 'Cancel'), go]);
  const row = (label, ico, run, note) => h('li', {}, h('button', { type: 'button', onClick: act(run) },
    icon(ico, ico === 'folder' ? 'ico ico-folder' : 'ico'), h('span', {}, label), note ? h('small', { class: 'muted' }, note) : null));
  function showSpaces() {
    target = null;
    go.disabled = true;
    where.replaceChildren(h('span', { class: 'muted' }, 'Choose where to move it.'));
    list.replaceChildren(...state.spaces.filter(s => s.level >= 2).map(s => row(spaceLabel(s), 'folder', () => open(s.id), AREA[s.area].label)));
  }
  async function open(id) {
    const f = await api('GET', `/api/nodes/${id}`);
    target = f.node;
    go.disabled = !f.can.edit || id === fromId;
    where.replaceChildren(h('span', { class: 'muted' }, 'Move into: '), h('strong', {}, f.crumbs.map(c => c.name).join(' / ')));
    list.replaceChildren(
      row(f.crumbs.length > 1 ? 'Up one level' : 'All my folders', 'back', () => (f.crumbs.length > 1 ? open(f.crumbs.at(-2).id) : showSpaces())),
      ...f.children.filter(c => c.dir && c.id !== it.id).map(c => row(c.name, 'folder', () => open(c.id))));
  }
  go.addEventListener('click', act(async () => {
    await api('PATCH', `/api/nodes/${it.id}`, { parent_id: target.id });
    d.close();
    toast(`Moved "${it.name}".`);
    changed();
  }));
  open(fromId).catch(e => toast(e.message, 'bad'));
}

async function versionsDialog(it) {
  const list = await api('GET', `/api/nodes/${it.id}/versions`);
  let d;
  const restore = v => act(async () => {
    await api('POST', `/api/versions/${v.id}/restore`);
    d.close();
    toast('Older version restored. The copy it replaced is kept as a version.');
    route();
  });
  d = dialog(`Versions of "${it.name}"`, [
    h('p', { class: 'muted' }, 'Uploading a file with the same name keeps the previous copy here. The last 20 copies are kept.'),
    list.length
      ? panel(table(['Saved', ['Size', 'num'], 'By', ['', 'c-btns']], list.map(v => [
          { v: fmtDateTime(v.created_at), cls: 'mono' }, { v: fmtSize(v.size), cls: 'mono' }, v.created_by || '',
          [h('button', { type: 'button', class: 'btn small', onClick: () => download(`/api/versions/${v.id}/content`) }, 'Download'),
           it.level >= 2 ? h('button', { type: 'button', class: 'btn small', onClick: restore(v) }, 'Restore') : null]])))
      : h('p', {}, 'No older versions yet.'),
  ], [], 'wide');
}

// ---------------------------------------------------------------- access and links
// Who has access: everyone who can open the item sees the list. Managers, IT and owners press Edit,
// add people with "+ Add person" (one or many at once) and remove them with ×.
async function accessDialog(nodeId, name) {
  const a = await api('GET', `/api/nodes/${nodeId}/access`);
  const dir = a.editable ? await api('GET', '/api/directory') : null;
  const what = a.dir ? 'folder' : 'file';
  let editing = false, adding = false, restricted = a.restricted;
  let entries = a.own.map(e => ({ ...e }));
  const who = e => h('div', { class: 'acl-who' }, h('span', {}, e.name), h('small', {}, e.type === 'group' ? (e.kind === 'everyone' ? 'all employees' : 'group') : e.login));
  const list = (rows, none) => (rows.length ? h('div', { class: 'acl-list' }, rows) : h('p', { class: 'muted' }, none));
  const btn = (label, cls, run, ico) => h('button', { type: 'button', class: `btn ${cls}`.trim(), onClick: run }, ico ? icon(ico) : null, label);
  // Manage grants, the Managers group and (in confidential and personal space) group grants stay as IT set them.
  const canEdit = e => e.level <= a.maxLevel && !(a.lockedGroups && e.type === 'group') && !(a.lockedManagers && e.kind === 'managers');
  const box = h('div', { class: 'acl' });
  const save = act(async () => {
    await api('PUT', `/api/nodes/${nodeId}/access`, { restricted, entries: entries.filter(canEdit).map(({ type, id, level }) => ({ type, id, level })) });
    d.close();
    toast('Access saved.');
    if (!state.me.admin) state.spaces = await api('GET', '/api/spaces');
    route();
  });
  const d = dialog(`Who has access: ${name}`, box, [h('span')]);
  const foot = d.querySelector('.dlg-foot');

  const ownRow = e => h('div', { class: 'acl-row' }, who(e), editing && canEdit(e)
    ? [levelSelect(e.level, a.maxLevel, v => { e.level = v; }, `Access for ${e.name}`),
       h('button', { type: 'button', class: 'icon-btn', title: 'Remove access', 'aria-label': `Remove access for ${e.name}`, onClick: () => { entries = entries.filter(x => x !== e); draw(); } }, icon('close'))]
    : h('span', { class: 'lvl' }, editing ? `${LEVEL[e.level]} · set by IT` : LEVEL[e.level]));

  function draw() {
    const inh = a.inherited.filter(e => !restricted || e.pass);
    box.replaceChildren(...[
      h('p', { class: 'muted path' }, a.path),
      editing && a.canRestrict
        ? h('label', { class: 'check restrict' },
            h('input', { type: 'checkbox', checked: restricted, onChange: e => { restricted = e.target.checked; draw(); } }),
            h('span', {}, h('strong', {}, 'Restrict this folder'), h('br'), h('span', { class: 'muted' }, 'Only people added below can open it. Department heads and Managers keep their access.')))
        : restricted ? h('p', { class: 'restrict' }, `This ${what} is restricted: only the people listed can open it.`) : null,
      a.confidential ? h('p', { class: 'callout' }, 'Confidential: people are added by name. External links are off.')
        : editing && a.personal ? h('p', { class: 'callout' }, `Only the people you add can open this ${what}. They find it under Shared with me.`) : null,
      h('section', { class: 'acl-section' }, h('h3', {}, 'From folders above'),
        list(inh.map(e => h('div', { class: 'acl-row' }, who(e), h('span', { class: 'acl-from muted', title: e.from }, e.from.split(' / ').at(-1)), h('span', { class: 'lvl' }, LEVEL[e.level]))),
          restricted ? `Nothing comes from above: only the people below can open this ${what}.` : 'Nothing comes from folders above.')),
      h('section', { class: 'acl-section' }, h('h3', {}, `Added to this ${what}`), list(entries.map(ownRow), `Nobody is added to this ${what} directly.`)),
      !editing ? null
        : adding ? picker(dir, a, entries, (picked, level) => { entries.push(...picked.map(o => ({ ...o, level }))); adding = false; draw(); }, () => { adding = false; draw(); })
        : btn(a.lockedGroups ? 'Add person' : 'Add person or group', 'add-person', () => { adding = true; draw(); }, 'plus'),
    ].filter(Boolean));
    foot.replaceChildren(...(editing
      ? [btn('Cancel', '', () => d.close()), btn('Save access', 'primary', save)]
      : [a.editable ? btn('Edit', 'primary', () => { editing = true; draw(); }, 'pen') : null, btn('Close', '', () => d.close())].filter(Boolean)));
  }
  draw();
}

function levelSelect(cur, max, onChange, label) {
  return h('select', { 'aria-label': label, onChange: e => onChange(Number(e.target.value)) },
    [1, 2, 3].filter(l => l <= max).map(l => h('option', { value: l, selected: l === cur }, LEVEL[l])));
}

// "+ Add person": tick one or many people (and groups where allowed), choose the access, add them all at once.
function picker(dir, a, entries, onAdd, onCancel) {
  const have = new Set(entries.map(e => `${e.type}:${e.id}`));
  const opts = [
    ...dir.users.map(u => ({ type: 'user', id: u.id, name: u.name, login: u.login })),
    ...dir.groups.filter(g => !a.lockedGroups && !(a.lockedManagers && g.kind === 'managers') && (!a.confidential || g.kind === 'managers'))
      .map(g => ({ type: 'group', id: g.id, name: g.name, kind: g.kind })),
  ].filter(o => !have.has(`${o.type}:${o.id}`));
  const chosen = new Set();
  const filter = h('input', { type: 'search', placeholder: a.lockedGroups ? 'Find a person' : 'Find a person or group', 'aria-label': 'Find a person' });
  const checks = h('div', { class: 'checklist' });
  const level = levelSelect(1, a.maxLevel, () => {}, 'Access for the people you add');
  const add = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => onAdd(opts.filter(o => chosen.has(o)), Number(level.value)) }, 'Add');
  const pick = (o, on) => {
    if (on) chosen.add(o);
    else chosen.delete(o);
    add.disabled = !chosen.size;
    add.textContent = chosen.size > 1 ? `Add ${chosen.size}` : 'Add';
  };
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = opts.filter(o => !q || o.name.toLowerCase().includes(q) || (o.login || '').toLowerCase().includes(q));
    checks.replaceChildren(...(shown.length
      ? shown.map(o => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: chosen.has(o), onChange: e => pick(o, e.target.checked) }),
          h('span', {}, o.name, ' ', h('small', { class: 'muted mono' }, o.type === 'group' ? 'group' : o.login))))
      : [h('p', { class: 'muted' }, opts.length ? 'Nobody matches.' : 'Everyone is already added.')]));
  };
  filter.addEventListener('input', paint);
  paint();
  queueMicrotask(() => filter.focus());
  return h('section', { class: 'acl-pick' }, h('h3', {}, 'Add people'), filter, checks,
    h('div', { class: 'acl-pick-foot' }, h('label', { class: 'acl-pick-lvl' }, h('span', { class: 'muted' }, 'Access'), level), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn', onClick: onCancel }, 'Cancel'), add));
}

async function linksDialog(it) {
  const box = h('div');
  async function load() {
    const links = await api('GET', `/api/nodes/${it.id}/links`);
    box.replaceChildren(links.length
      ? h('div', { class: 'acl-list' }, links.map(l => h('div', { class: 'acl-row' },
          h('div', { class: 'acl-who' }, h('code', { class: 'mono link-url' }, l.url), h('small', {}, `Works until ${fmtDateTime(l.expires_at)} · created by ${l.created_by}`)),
          h('button', { type: 'button', class: 'btn small', onClick: act(async () => { await copy(l.url); toast('Link copied.'); }) }, 'Copy'),
          h('button', { type: 'button', class: 'btn small danger', onClick: act(async () => { await api('DELETE', `/api/links/${l.id}`); toast('Link turned off.'); await load(); }) }, 'Turn off'))))
      : h('p', { class: 'muted' }, 'No active links.'));
  }
  const fresh = h('div');
  const create = form('stack', async (v, f) => {
    const r = await api('POST', `/api/nodes/${it.id}/links`, { days: Number(v.days) });
    f.reset();
    // The password is made by the server and shown only now; it goes to the recipient separately from the link.
    fresh.replaceChildren(h('div', { class: 'callout stack' },
      h('p', {}, h('strong', {}, 'New link'), h('br'), h('code', { class: 'mono link-url' }, r.url)),
      h('p', {}, h('strong', {}, 'Password'), h('br'), h('code', { class: 'mono secret' }, r.password)),
      h('p', { class: 'muted' }, 'Send the password separately from the link, for example by phone. It is shown only once.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onClick: act(async () => { await copy(r.url); toast('Link copied.'); }) }, 'Copy link'),
        h('button', { type: 'button', class: 'btn small', onClick: act(async () => { await copy(r.password); toast('Password copied.'); }) }, 'Copy password'))));
    await load();
  },
    field('Works for', h('select', { name: 'days' }, [1, 3, 7, 14, 30].map(n => h('option', { value: n, selected: n === 7 }, `${n} day${n > 1 ? 's' : ''}`))),
      'A strong password is made for each link. A link stops working after 30 days at most.'),
    errorLine(),
    h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, icon('link'), 'Create link')));
  dialog(`External links: ${it.name}`, [
    h('p', { class: 'muted' }, 'People outside the company can open this with the link and its password. They see only what is inside.'),
    box, h('h3', { class: 'sub' }, 'New link'), fresh, create]);
  await load();
}

// ---------------------------------------------------------------- uploads
// Resumable (tus): a file cut off by a lost connection, a closed lid or a reload continues from the last byte the
// server has. Several files go at once (small ones twice as many), big ones in parallel parts. Folders keep their
// structure, empty subfolders included. The tus client (85 KB) loads on the first upload.
const MB = 2 ** 20;
// Files from 4 MB go up in up to 6 parallel parts: one HTTP/2 stream from Chrome over a long-distance link moves
// only about 0.2 MB/s (measured 2026-11-19), several together fill the line. Smaller files go in one request and
// simply start again if cut off.
const RESUME_FROM = 4 * MB;
const partsFor = size => (size < RESUME_FROM ? 1 : Math.min(6, Math.ceil(size / (2 * MB))));
let tusLoading = null;
const loadTus = () => (tusLoading ??= new Promise((ok, no) => {
  document.head.append(h('script', { src: '/vendor/tus-4.3.1.min.js', onLoad: () => ok(window.tus), onError: () => {
    tusLoading = null;
    no(new Error('The uploader could not load. Check your connection and try again.'));
  } }));
}));
const parallel = () => {
  try {
    return Math.min(12, Math.max(1, Number(localStorage.getItem('uploadParallel')) || 6));
  } catch {
    return 6;
  }
};

// Counters are kept as jobs change state, so 20 000 files never mean a full scan per progress event.
const up = { jobs: [], next: 0, paused: false, n: { wait: 0, run: 0, pause: 0, done: 0, fail: 0, cancel: 0 }, total: 0, doneBytes: 0,
  live: new Set(), samples: [], rows: new Map(), panel: null, unfinished: [], checked: false, touched: new Set() };

function setState(j, s) {
  up.n[j.state]--;
  up.n[s]++;
  if (s === 'cancel') up.total -= j.size;
  if (s === 'done') up.doneBytes += j.size;
  if (s === 'run' || s === 'pause' || s === 'fail') up.live.add(j);
  else up.live.delete(j);
  if (s === 'wait') {
    up.next = Math.min(up.next, j.i);
    up.announced = false;
  }
  j.state = s;
}

function enqueue(items) {
  if (!up.n.wait && !up.n.run && !up.n.pause && !up.n.fail) clearUploads(); // a new batch after the last one finished
  for (const it of items) {
    up.jobs.push({ ...it, i: up.jobs.length, size: it.file.size, sent: 0, state: 'wait' });
    up.n.wait++;
    up.total += it.file.size;
  }
  up.announced = false;
  up.unfinished = [];
  up.paused = false;
  pump();
}

function clearUploads() {
  Object.assign(up, { jobs: [], next: 0, total: 0, doneBytes: 0, samples: [] });
  for (const k in up.n) up.n[k] = 0;
  up.live.clear();
  up.touched.clear();
}

function pump() {
  if (!up.paused) {
    const par = parallel();
    while (up.next < up.jobs.length && up.jobs[up.next].state !== 'wait') up.next++;
    for (let i = up.next; i < up.jobs.length; i++) {
      const j = up.jobs[i];
      if (j.state !== 'wait') continue;
      if (up.n.run >= (j.size < MB ? par * 2 : par)) break;
      startJob(j);
    }
  }
  paintUploads();
  if (!up.n.run && !up.n.wait && !up.n.pause && up.jobs.length && !up.announced) {
    up.announced = true;
    const here = Number(/^#\/f\/(\d+)/.exec(location.hash)?.[1]);
    if (up.touched.has(here)) route(); // the new files show without a reload
    if (up.n.fail) toast(`${up.n.fail} file${up.n.fail > 1 ? 's were' : ' was'} not uploaded. See Uploads for the reason.`, 'bad');
  }
}

async function startJob(j) {
  setState(j, 'run');
  try {
    if (!j.upload) {
      const tus = await loadTus();
      const meta = { folder: String(j.folder), name: j.name };
      j.upload = new tus.Upload(j.file, {
        endpoint: '/api/tus',
        chunkSize: 64 * MB,
        parallelUploads: partsFor(j.size),
        // A small file is one request. A larger one is created first, so its address is known (and remembered for
        // a reload) before the bytes start: a cut-off creating request could not be continued.
        uploadDataDuringCreation: j.size < RESUME_FROM,
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000],
        headers: { 'x-requested-with': 'fetch' },
        metadata: meta,
        metadataForPartialUploads: meta,
        storeFingerprintForResuming: j.size >= RESUME_FROM,
        removeFingerprintOnSuccess: true,
        fingerprint: () => Promise.resolve(`files:${j.folder}:${j.name}:${j.size}:${j.file.lastModified}`),
        onProgress: sent => {
          j.sent = sent;
          paintSoon();
        },
        onSuccess: () => {
          if (j.state !== 'run') return;
          j.sent = j.size;
          setState(j, 'done');
          up.touched.add(j.folder);
          pump();
        },
        onError: e => {
          failJob(j, e);
          pump();
        },
      });
      if (j.size >= RESUME_FROM) {
        const prev = await j.upload.findPreviousUploads();
        if (prev.length) j.upload.resumeFromPreviousUpload(prev[0]);
      }
    }
    if (j.state === 'run') j.upload.start(); // not if paused or cancelled while the uploader loaded
  } catch (e) {
    failJob(j, e);
    pump();
  }
}

function failJob(j, e) {
  if (j.state !== 'run') return; // stopped on purpose
  const res = e.originalResponse;
  const status = res?.getStatus?.() || 0;
  let msg = '';
  try {
    msg = JSON.parse(res.getBody()).error;
  } catch {}
  j.net = !status;
  j.error = msg || (status ? `Upload failed (${status}).` : navigator.onLine === false ? 'No connection. It continues when the connection is back.' : e.message);
  setState(j, 'fail');
  if (status === 401) {
    pauseUploads();
    api('GET', '/api/me').catch(() => {}); // shows the sign-in page; uploads continue after signing in and choosing the files again
  }
}

function pauseUploads() {
  up.paused = true;
  for (const j of [...up.live]) {
    if (j.state !== 'run') continue;
    setState(j, 'pause');
    j.upload?.abort();
  }
  paintUploads();
}

function resumeUploads() {
  up.paused = false;
  for (const j of [...up.live]) if (j.state === 'pause') setState(j, 'wait');
  pump();
}

function cancelJob(j) {
  if (j.state === 'done' || j.state === 'cancel') return;
  setState(j, 'cancel');
  j.upload?.abort(true).catch(() => {}); // true: the server drops what it already has
}

function cancelUploads() {
  for (const j of up.jobs) cancelJob(j);
  up.paused = false;
  pump();
}

function retryFailed(onlyNetwork = false) {
  for (const j of [...up.live]) {
    if (j.state !== 'fail' || (onlyNetwork && !j.net)) continue;
    j.error = '';
    setState(j, 'wait');
  }
  up.paused = false;
  pump();
}
addEventListener('online', () => retryFailed(true));
addEventListener('beforeunload', e => {
  if (up.n.run || up.n.wait) e.preventDefault(); // the browser asks "Leave site?"
});

const fmtEta = s => (s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
let paintTimer = null;
const paintSoon = () => (paintTimer ??= setTimeout(() => { paintTimer = null; paintUploads(); }, 250));

function uploadsPanel() {
  if (up.panel?.isConnected) return up.panel;
  const el = {};
  const btn = (label, onClick, cls = 'btn small') => h('button', { type: 'button', class: cls, onClick }, label);
  el.title = h('span', { class: 'up-title' });
  el.pause = btn('Pause', () => (up.paused ? resumeUploads() : pauseUploads()));
  el.cancel = btn('Cancel', () => cancelUploads());
  el.close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close uploads', onClick: () => {
    if (up.n.run || up.n.wait || up.n.pause) return;
    clearUploads();
    up.unfinished = [];
    up.panel.remove();
  } }, icon('close'));
  el.bar = h('progress', { max: 1, value: 0 });
  el.line = h('span', { class: 'up-line mono' });
  el.note = h('div', { class: 'up-note', hidden: true });
  el.list = h('ul', { 'aria-live': 'off' });
  el.retry = btn('Retry failed', () => retryFailed());
  el.par = h('select', { class: 'up-par', 'aria-label': 'Files uploaded at the same time', onChange: () => {
    try {
      localStorage.setItem('uploadParallel', el.par.value);
    } catch {}
    pump();
  } }, [1, 2, 3, 4, 6, 8, 10, 12].map(n => h('option', { value: n, selected: n === parallel() }, `${n} at a time`)));
  up.panel = h('section', { class: 'uploads', 'aria-label': 'Uploads' },
    h('header', {}, el.title, h('span', { class: 'grow' }), el.pause, el.cancel, el.close),
    h('div', { class: 'up-sum' }, el.bar, el.line),
    el.note, el.list,
    h('footer', {}, el.retry, h('span', { class: 'grow' }), el.par));
  up.panel.el = el;
  document.body.append(up.panel);
  return up.panel;
}

function paintUploads() {
  if (!up.jobs.length && !up.unfinished.length) return up.panel?.remove();
  const { el } = uploadsPanel();
  const n = up.n, all = up.jobs.length - n.cancel, busy = n.run + n.wait + n.pause;
  let sent = up.doneBytes;
  for (const j of up.live) sent += j.sent;
  const now = performance.now();
  up.samples.push([now, sent]);
  while (up.samples.length > 2 && now - up.samples[0][0] > 5000) up.samples.shift();
  const [t0, b0] = up.samples[0];
  const speed = now - t0 > 500 ? Math.max(0, ((sent - b0) / (now - t0)) * 1000) : 0;
  el.title.textContent = !up.jobs.length ? 'Unfinished uploads'
    : busy ? `${up.paused ? 'Paused' : 'Uploading'} · ${n.done} of ${all}`
    : `${n.done} uploaded${n.fail ? `, ${n.fail} failed` : ''}${n.cancel ? `, ${n.cancel} cancelled` : ''}`;
  el.pause.hidden = !busy;
  el.pause.textContent = up.paused ? 'Resume' : 'Pause';
  el.cancel.hidden = !busy && !n.fail;
  el.close.hidden = !!busy;
  el.bar.hidden = el.line.hidden = !up.jobs.length;
  el.bar.value = up.total ? sent / up.total : busy ? 0 : 1;
  el.line.textContent = `${fmtSize(sent)} of ${fmtSize(up.total)}` +
    (busy && !up.paused && speed ? ` · ${fmtSize(speed)}/s · ${fmtEta((up.total - sent) / speed)} left` : '');
  el.retry.hidden = !n.fail;
  el.retry.textContent = `Retry failed (${n.fail})`;
  // Unfinished uploads from before a reload: choosing the same files for the same folder continues them.
  el.note.hidden = !up.unfinished.length;
  if (up.unfinished.length) {
    const left = up.unfinished.reduce((s, u) => s + u.size - u.done, 0);
    el.note.replaceChildren(
      h('p', {}, `${up.unfinished.length} upload${up.unfinished.length > 1 ? 's' : ''} did not finish (${fmtSize(left)} left). Upload the same files or folder to the same place again: they continue where they stopped.`),
      h('ul', {}, up.unfinished.slice(0, 5).map(u => h('li', {}, h('a', { href: `#/f/${u.folder}` }, u.name), h('span', { class: 'muted mono' }, ` ${Math.floor((u.done / u.size) * 100) || 0}%`)))),
      h('button', { type: 'button', class: 'btn small', onClick: act(async () => {
        await api('DELETE', '/api/tus');
        up.unfinished = [];
        paintUploads();
      }) }, 'Discard them'));
  }
  // One row per file being sent, paused or failed; finished files only count.
  for (const [j, row] of up.rows) if (!up.live.has(j)) (row.remove(), up.rows.delete(j));
  for (const j of up.live) {
    let row = up.rows.get(j);
    if (!row) {
      row = h('li', {}, h('span', { class: 'up-name', title: j.path }, j.path), h('span', { class: 'up-state mono' }),
        h('button', { type: 'button', class: 'up-x', onClick: () => (j.state === 'fail' ? (j.error = '', setState(j, 'wait'), pump()) : (cancelJob(j), pump())) }),
        h('progress', { max: 1, value: 0 }));
      up.rows.set(j, row);
      el.list.append(row);
    }
    const [, state, x, bar] = row.children;
    state.textContent = j.state === 'fail' ? 'failed' : j.state === 'pause' ? 'paused' : `${Math.floor((j.sent / (j.size || 1)) * 100)}%`;
    state.className = `up-state mono${j.state === 'fail' ? ' bad' : ''}`;
    state.title = j.error || '';
    x.textContent = j.state === 'fail' ? 'Retry' : '×';
    x.setAttribute('aria-label', j.state === 'fail' ? `Retry ${j.name}` : `Cancel ${j.name}`);
    bar.value = j.size ? j.sent / j.size : 0;
    row.classList.toggle('failed', j.state === 'fail');
    if (j.state === 'fail' && !row.querySelector('.up-err')) row.append(h('span', { class: 'up-err' }, j.error));
  }
}

// One input per pick, put in the page: some browsers ignore clicks on inputs that are not.
function pickFiles(folder, dir = false) {
  const input = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: dir });
  input.addEventListener('change', () => {
    input.remove();
    act(() => uploadEntries(folder, [...input.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })), []))();
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

const readDir = dir => new Promise((ok, no) => {
  const reader = dir.createReader(), out = [];
  const more = () => reader.readEntries(batch => (batch.length ? (out.push(...batch), more()) : ok(out)), no); // gives 100 at a time
  more();
});
async function walkEntry(entry, prefix, files, dirs) {
  const p = prefix + entry.name;
  if (entry.isFile) files.push({ file: await new Promise((ok, no) => entry.file(ok, no)), path: p });
  else if (entry.isDirectory) {
    dirs.push(p);
    await Promise.all((await readDir(entry)).map(e => walkEntry(e, `${p}/`, files, dirs)));
  }
}

function enableDrop(el, folder) {
  el.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drop');
    // The dropped items can only be read during the event; their entries can be walked afterwards.
    const got = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => ({ entry: i.webkitGetAsEntry?.(), file: i.getAsFile() }));
    act(async () => {
      const files = [], dirs = [];
      await Promise.all(got.map(g => (g.entry ? walkEntry(g.entry, '', files, dirs) : g.file && files.push({ file: g.file, path: g.file.name }))));
      if (files.length || dirs.length) await uploadEntries(folder, files, dirs);
    })();
  });
}

// Creates the folders first (all of them, empty ones too, in a few requests), then queues the files into them.
async function uploadEntries(folder, files, dirs) {
  const want = new Set(dirs.map(p => p.split('/').map(cleanName).join('/')));
  let renamed = 0;
  const items = files.map(({ file, path }) => {
    const parts = path.split('/');
    const name = cleanName(parts.pop());
    const dir = parts.map(cleanName).join('/');
    if (dir) want.add(dir);
    if (name !== file.name) renamed++;
    return { file, name, dir, path: dir ? `${dir}/${name}` : name };
  });
  const ids = want.size ? await makeTree(folder.id, [...want]) : {};
  if (renamed) toast(`${renamed} file name${renamed > 1 ? 's were' : ' was'} adjusted: special characters became "_".`);
  if (want.size && location.hash === `#/f/${folder.id}`) route(); // the new folders show at once
  if (items.length) enqueue(items.map(it => ({ file: it.file, folder: it.dir ? ids[it.dir] : folder.id, name: it.name, path: it.path })));
}

async function makeTree(id, paths) {
  const inner = new Set();
  for (const p of paths) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) inner.add(p.slice(0, i));
  const ids = {};
  let batch = [], bytes = 0;
  const send = async () => {
    Object.assign(ids, (await api('POST', `/api/nodes/${id}/tree`, { paths: batch })).ids);
    batch = [];
    bytes = 0;
  };
  for (const p of paths.filter(p => !inner.has(p))) { // the deepest paths are enough: their parents come along
    const b = new Blob([p]).size + 4;
    if (batch.length && (bytes + b > 48000 || batch.length >= 1000)) await send(); // the server reads at most 64 KB
    batch.push(p);
    bytes += b;
  }
  if (batch.length) await send();
  return ids;
}

async function downloadZip(it) {
  const s = await api('GET', `/api/nodes/${it.id}/zip?check=1`);
  toast(`Downloading "${it.name}" as a ZIP: ${s.files} file${s.files === 1 ? '' : 's'}, ${fmtSize(s.bytes)}.`);
  download(`/api/nodes/${it.id}/zip`);
}

function cleanName(name) {
  let s = name.normalize('NFC').replace(NAME_BAD, '_').replace(/_{2,}/g, '_').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 120) {
    const ext = /\.[^.]{1,10}$/.exec(s)?.[0] || '';
    s = s.slice(0, 120 - ext.length).trim() + ext;
  }
  return s || 'file';
}


// ---------------------------------------------------------------- trash, search, activity, account
async function viewShared() {
  const items = await api('GET', '/api/shared');
  shell(page('Shared with me', 'Files and folders people gave you access to by name. If someone takes access back, the item disappears from here.',
    items.length
      ? panel(table(['Name', ['Where', 'c-loc'], 'Access', ['Modified', 'c-date']], items.map(it => [
          it.dir
            ? h('a', { class: 'item', href: `#/f/${it.id}` }, icon('folder', 'ico ico-folder'), h('span', {}, it.name))
            : h('button', { type: 'button', class: 'item linkish', onClick: () => openFile(it) }, icon('file', 'ico ico-file'), h('span', {}, it.name)),
          { v: it.location, cls: 'muted' },
          it.level === 1 ? 'Read only' : LEVEL[it.level],
          { v: fmtDate(it.updated_at), cls: 'mono', title: fmtDateTime(it.updated_at) },
        ])))
      : empty('Nothing is shared with you yet', 'When someone shares a file or folder with you, it appears here.')), 'shared');
}

async function viewTrash() {
  const items = await api('GET', '/api/trash');
  shell(page('Trash', 'Deleted files and folders stay here for 30 days, then they are removed for good. You see what was deleted in folders where you can edit.',
    items.length
      ? panel(table(['Name', ['Was in', 'c-loc'], ['Deleted', 'c-date'], ['By', 'c-by'], ['Removed for good', 'c-date'], ['', 'c-btns']], items.map(it => [
          h('span', { class: 'item' }, icon(it.dir ? 'folder' : 'file', it.dir ? 'ico ico-folder' : 'ico ico-file'), h('span', {}, it.name)),
          { v: it.location, cls: 'muted' },
          { v: fmtDate(it.deleted_at), cls: 'mono' }, it.deleted_by || '', { v: fmtDate(it.purge_at), cls: 'mono' },
          [h('button', { type: 'button', class: 'btn small', onClick: act(async () => {
            const r = await api('POST', `/api/trash/${it.id}/restore`);
            toast(r.name !== it.name ? `Restored as "${r.name}" because the name was taken.` : `Restored "${it.name}".`);
            changed();
          }) }, 'Restore'),
           h('button', { type: 'button', class: 'btn small danger', onClick: act(async () => {
            if (!(await confirmDialog(`Delete "${it.name}" forever?`, `${it.dir ? 'The folder and everything in it, with all old versions, are' : 'The file and all its old versions are'} erased now and cannot be restored from the trash. IT can still recover it from a nightly backup for 120 days.`, 'Delete forever', true))) return;
            await api('DELETE', `/api/trash/${it.id}`);
            toast(`"${it.name}" is deleted for good.`);
            changed();
          }) }, 'Delete forever')]])))
      : empty('Trash is empty', 'Files you delete appear here for 30 days.')), 'trash');
}

async function viewSearch(q) {
  const items = q.length >= 2 ? await api('GET', `/api/search?q=${encodeURIComponent(q)}`) : [];
  shell(page('Search', q.length >= 2 ? `Names containing "${q}", in folders you can open.` : 'Type at least 2 characters.',
    items.length
      ? panel(table(['Name', ['Location', 'c-loc'], ['Modified', 'c-date']], items.map(it => [
          it.dir
            ? h('a', { class: 'item', href: `#/f/${it.id}` }, icon('folder', 'ico ico-folder'), h('span', {}, it.name))
            : h('button', { type: 'button', class: 'item linkish', onClick: () => openFile(it) }, icon('file', 'ico ico-file'), h('span', {}, it.name)),
          it.location ? h('a', { class: 'muted', href: `#/f/${it.parent_id}` }, it.location) : '',
          { v: fmtDate(it.updated_at), cls: 'mono' }])))
      : q.length >= 2 ? empty('Nothing found', 'Search looks at file and folder names, not at the text inside files.') : null));
}

async function viewActivity() {
  const admin = state.me.admin;
  const cats = admin
    ? [['', 'Everything'], ['alerts', 'Alerts only'], ['auth', 'Sign-ins'], ['admin', 'Accounts and groups'], ['acl', 'Access changes']]
    : [['', 'Everything'], ['alerts', 'Alerts only'], ['file', 'Files'], ['acl', 'Access changes'], ['share', 'External links'], ['auth', 'Sign-ins'], ['admin', 'Accounts and groups']];
  let cat = '', before = '';
  const tbody = h('tbody');
  const more = h('button', { type: 'button', class: 'btn', hidden: true }, 'Show older');
  async function load(reset) {
    if (reset) {
      tbody.replaceChildren();
      before = '';
    }
    const { rows, next } = await api('GET', `/api/audit?cat=${cat}&before=${before}`);
    tbody.append(...rows.map(r => h('tr', { class: r.action.startsWith('ALERT') ? 'alert' : null },
      h('td', { class: 'mono' }, fmtDateTime(r.ts)),
      h('td', { class: 'nowrap' }, r.actor || h('span', { class: 'muted' }, r.cat === 'share' ? 'external visitor' : 'server')),
      h('td', { class: 'wrap' }, h('span', { class: 'tag' }, CAT[r.cat] || r.cat), ' ', r.action),
      h('td', { class: 'muted wrap' }, r.target || ''),
      h('td', { class: 'mono c-ip' }, r.ip || ''))));
    before = next ?? '';
    more.hidden = !next;
    if (!tbody.children.length) tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No events yet.')));
  }
  more.addEventListener('click', act(() => load(false)));
  shell(page('Activity log',
    admin
      ? 'Sign-ins, account and group changes, and access changes. Names inside department folders are hidden from IT; file activity is visible to Managers only.'
      : 'What happens in the storage: files, access changes, external links and sign-ins, for folders you can open. ALERT rows need a look: bulk downloads and sensitive IT actions. Entries cannot be edited or deleted.',
    h('div', { class: 'page-tools' }, h('select', { 'aria-label': 'Show', onChange: act(e => { cat = e.target.value; return load(true); }) }, cats.map(([v, l]) => h('option', { value: v }, l)))),
    panel(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Where'].map(t => h('th', { scope: 'col' }, t)), h('th', { scope: 'col', class: 'c-ip' }, 'IP'))), tbody),
      h('div', { class: 'more' }, more))), 'activity');
  await load(true);
}

async function viewAccount() {
  const me = state.me;
  const computers = me.admin ? null : await computersCard();
  shell(page('Account and security', `${me.name} · ${me.login}`,
    h('div', { class: 'cards' },
      card('Password', 'Changing it signs you out on your other devices.', passwordForm(null)),
      computers)), 'account');
}

// ---------------------------------------------------------------- auto-save to computers
const OS_NAME = { windows: 'Windows', macos: 'Mac', linux: 'Linux' };
function myOs() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|android/.test(navigator.userAgent.toLowerCase())) return null;
  return p.includes('win') ? 'windows' : p.includes('mac') ? 'macos' : p.includes('linux') || p.includes('x11') ? 'linux' : null;
}

async function computersCard() {
  const [devices, dl] = await Promise.all([api('GET', '/api/devices'), api('GET', '/api/agent/downloads')]);
  const os = myOs();
  const mine = os && dl[os];
  const others = Object.entries(dl).filter(([k, v]) => v && k !== os);
  const disconnect = d => act(async () => {
    if (!(await confirmDialog(`Disconnect "${d.name}"?`, 'Files sent to it that it has not saved yet are taken back, and it can no longer get files from here. Files it already saved stay on that computer.', 'Disconnect'))) return;
    await api('DELETE', `/api/devices/${d.id}`);
    toast(`"${d.name}" is disconnected.`);
    route();
  });
  return card('Your files on your computer', 'On Windows, Company Files appears in File Explorer like OneDrive: everything you can open here shows up, files download when you open them, and whatever you add, edit, rename or delete there comes back here (it then stays on the computer only as an icon, unless you choose "Always keep on this device"). On a Mac it appears in Finder the same way, once you switch it on in System Settings → File Providers (the app asks); until then your files are on the Company Files network drive in Finder. On Linux, My files is kept in sync as a folder. Select files and press Enter to save copies to your computers.',
    h('div', { class: 'stack' },
      h('div', { class: 'row' },
        mine
          ? h('a', { class: 'btn primary', href: mine.url, download: '' }, icon('download'), `Download for ${OS_NAME[os]}`, h('span', { class: 'muted' }, ` · ${fmtSize(mine.size)}`))
          : h('span', { class: 'muted' }, os ? `The app for ${OS_NAME[os]} is not available yet.` : 'The app works on Windows, Mac and Linux computers.'),
        os ? h('button', { type: 'button', class: 'btn', onClick: act(connectComputer) }, icon('plus'), 'Connect this computer') : null),
      others.length ? h('p', { class: 'muted' }, 'Also for ', others.flatMap(([k, v], i) => [i ? ', ' : '', h('a', { href: v.url, download: '' }, OS_NAME[k])]), '.') : null,
      devices.length
        ? table(['Computer', 'Status', ['Waiting', 'num'], ['', 'c-btns']], devices.map(d => [
            [h('strong', {}, d.name), h('br'), h('small', { class: 'muted' }, `${OS_NAME[d.os] || d.os} · connected ${fmtDate(d.created_at)}`)],
            d.online ? h('span', { class: 'tag good' }, 'online') : h('span', { class: 'muted' }, d.seen_at ? `offline · seen ${fmtDate(d.seen_at)}` : 'offline'),
            { v: d.pending ? `${d.pending} file${d.pending === 1 ? '' : 's'}` : '—', cls: 'num mono' },
            h('button', { type: 'button', class: 'btn small', onClick: disconnect(d) }, 'Disconnect'),
          ]))
        : h('p', { class: 'muted' }, 'No computer is connected yet.')));
}

// The site gets a one-time code and hands it to the app through a myfiles:// link; the app asks before it links.
async function connectComputer() {
  const p = await api('POST', '/api/devices/pair-code');
  const before = new Set((await api('GET', '/api/devices')).map(d => d.id));
  const d = dialog('Connect this computer', [
    h('p', {}, 'Your browser asks to open the Company Files app: allow it, then confirm in the app.'),
    h('p', {}, 'Nothing opened? Install the app first (Download button), or open it and enter this code:'),
    h('p', { class: 'callout secret' }, p.code),
    h('p', { class: 'muted' }, 'The code works once, for 10 minutes.'),
  ], [h('a', { class: 'btn primary', href: p.link }, 'Open the app'), h('button', { type: 'button', class: 'btn', onClick: () => d.close() }, 'Close')]);
  const t = setInterval(async () => {
    const list = await api('GET', '/api/devices').catch(() => []);
    const added = list.find(x => !before.has(x.id));
    if (!added) return;
    d.close();
    toast(`"${added.name}" is connected.`);
    route();
  }, 3000);
  d.addEventListener('close', () => clearInterval(t));
  location.href = p.link;
}

async function sendToComputers(ids) {
  const r = await api('POST', '/api/devices/send', { ids: [...ids] });
  const where = r.devices.length === 1 ? `"${r.devices[0]}"` : `${r.devices.length} computers`;
  toast(`${r.files} file${r.files === 1 ? '' : 's'} (${fmtSize(r.bytes)}) will be saved to ${where}.`, '', {
    label: 'Undo',
    run: async () => {
      const u = await api('DELETE', `/api/devices/batches/${r.batch}`);
      toast(u.removed ? 'Taken back.' : 'Already saved, nothing to take back.');
    },
  });
}

// ---------------------------------------------------------------- administration (IT)
async function viewPeople() {
  const [users, inv] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/invites')]);
  const invite = form('row', async (v, f) => {
    const r = await api('POST', '/api/admin/invites', { days: Number(v.days), max_uses: Number(v.max_uses), domain: v.domain.trim() });
    f.reset();
    showInvite(r.url);
  },
    field('Works for, days', h('input', { name: 'days', type: 'number', min: 1, max: 30, step: 1, value: 7, required: true })),
    field('People, up to', h('input', { name: 'max_uses', type: 'number', min: 1, max: 500, step: 1, value: 10, required: true })),
    field('Only emails at', h('input', { name: 'domain', maxlength: 100, autocapitalize: 'none', spellcheck: 'false', placeholder: 'algoritmi.kz (optional)' })),
    h('button', { type: 'submit', class: 'btn primary' }, 'Create link'),
    errorLine());
  const turnOff = i => act(async () => {
    if (!(await confirmDialog(`Turn off invite link #${i.id}?`, 'Nobody can sign up with it any more. Accounts already created stay.', 'Turn off', true))) return;
    await api('DELETE', `/api/admin/invites/${i.id}`);
    toast('Link turned off.');
    route();
  });
  const invites = card('Invite link', 'Send the link to new people: they sign up with their email and confirm it with a one-time code. New accounts see only their own folder until a Manager gives access.',
    inv.mail ? null : h('p', { class: 'callout' }, 'Email is not set up on the server yet, so people cannot finish signing up. Add the SMTP settings to the server .env.'),
    invite,
    inv.invites.length
      ? panel(table(['Link', 'Used', 'Only emails at', ['Expires', 'c-date'], ['Created by', 'c-by'], ['', 'c-btns']], inv.invites.map(i => [
          { v: `#${i.id}`, cls: 'mono' }, `${i.uses} of ${i.max_uses}`, i.domain ? `@${i.domain}` : 'any', { v: fmtDateTime(i.expires_at), cls: 'mono' }, i.created_by || '',
          h('button', { type: 'button', class: 'btn small danger', onClick: turnOff(i) }, 'Turn off')])))
      : null);
  const create = form('row', async (v, f) => {
    const r = await api('POST', '/api/admin/users', { login: v.login.trim(), name: v.name.trim(), email: v.email.trim(), role: v.role });
    f.reset();
    showPassword(v.login.trim(), r.password, true);
  },
    field('Full name', h('input', { name: 'name', required: true, maxlength: 80, autocomplete: 'off' })),
    field('Login', h('input', { name: 'login', required: true, maxlength: 40, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'a.serikova' })),
    field('Email (optional)', h('input', { name: 'email', type: 'email', maxlength: 254, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'a.serikova@company.kz', title: 'They can sign in with it, and nobody can make a second account with it through an invite link.' })),
    field('Role', h('select', { name: 'role' }, h('option', { value: 'employee' }, 'Employee'), h('option', { value: 'manager' }, 'Manager'), h('option', { value: 'admin' }, 'IT admin'))),
    h('button', { type: 'submit', class: 'btn primary' }, 'Create account'),
    errorLine());
  const patch = async (u, body, msg) => {
    await api('PATCH', `/api/admin/users/${u.id}`, body);
    toast(msg);
    route();
  };
  const actions = u => [
    u.disabled
      ? { label: 'Unblock', run: () => patch(u, { disabled: false }, `${u.name} is unblocked.`) }
      : u.id === state.me.id ? null : { label: 'Block', danger: true, run: async () => {
          if (await confirmDialog(`Block ${u.name}?`, 'They are signed out on every device at once and cannot sign in until unblocked. Their files stay where they are.', 'Block account', true))
            await patch(u, { disabled: true }, `${u.name} is blocked and signed out everywhere.`);
        } },
    u.is_admin ? null : u.manager
      ? { label: 'Remove Manager role', run: async () => {
          if (await confirmDialog(`Make ${u.name} an employee?`, 'They lose access to department and project folders they are not part of. Their own folders and groups stay.', 'Remove Manager role'))
            await patch(u, { role: 'employee' }, `${u.name} is now an employee.`);
        } }
      : { label: 'Give Manager role', run: async () => {
          if (await confirmDialog(`Make ${u.name} a Manager?`, 'Managers open and edit every department and project folder. Other Managers see this change in the activity log.', 'Give Manager role'))
            await patch(u, { role: 'manager' }, `${u.name} is now a Manager.`);
        } },
    u.is_admin ? null : u.flat_home
      ? { label: 'Show My files as a folder on computers', run: () => patch(u, { flat_home: false }, `On ${u.name}'s computers, My files is a folder again.`) }
      : { label: 'Put My files at the top on computers', run: async () => {
          if (await confirmDialog(`Put My files at the top on ${u.name}'s computers?`, 'In the Company Files folder on their computers there is no My files folder: what is in it sits at the top, next to the other folders, and what they put at the top goes into My files. Nothing is moved, and the website stays as it is. Their computers change over by themselves within a minute.', 'Put at the top'))
            await patch(u, { flat_home: true }, `On ${u.name}'s computers, My files is now at the top.`);
        } },
    { label: u.email ? 'Change email' : 'Set email', run: () => formDialog(`Email of ${u.name}`,
      field('Email', h('input', { name: 'email', type: 'email', value: u.email || '', maxlength: 254, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'name@company.kz' }),
        'They can sign in with it. One email can have only one account, so nobody can sign up again with it through an invite link. Leave empty to remove it.'),
      'Save', v => patch(u, { email: v.email.trim() }, v.email.trim() ? `Email of ${u.name} saved.` : `Email of ${u.name} removed.`)) },
    { label: 'Reset password', run: async () => {
      if (!(await confirmDialog(`Reset the password of ${u.name}?`, 'A new temporary password is created and their current sessions end.', 'Reset password'))) return;
      const r = await api('PATCH', `/api/admin/users/${u.id}`, { reset_password: true });
      showPassword(u.login, r.password);
    } },
    u.id === state.me.id ? null : '-',
    u.id === state.me.id ? null : { label: 'Delete account', danger: true, run: async () => {
      if (!(await confirmDialog(`Delete ${u.name} for good?`,
        `They are signed out everywhere and removed from all groups and folder access; their external links stop working. Their personal folder goes to the trash and is erased after 30 days. Files they put in shared folders stay. The login "${u.login}" becomes free. If they were a department head or project lead, give that role to someone else. This cannot be undone; to stop access only for a while, use Block instead.`,
        'Delete account', true))) return;
      await api('DELETE', `/api/admin/users/${u.id}`);
      toast(`${u.name} is deleted.`);
      route();
    } },
  ];
  shell(page('People', 'One account per employee. A new account gets a temporary password and a personal folder.',
    card('New account', 'Managers open every department and project folder. IT admin accounts manage people and folders but cannot open any files. Department heads and project leads are chosen on the Folders page.', create),
    invites,
    panel(table(['Name', 'Login', 'Role', ['Groups', 'c-groups'], ['Last active', 'c-date'], 'Status', ['', 'c-act']], users.map(u => [
      h('strong', {}, u.name),
      { v: u.email ? [u.login, h('br'), h('small', { class: 'muted' }, u.email)] : u.login, cls: 'mono' },
      u.is_admin ? h('span', { class: 'tag' }, 'IT admin') : u.manager ? h('span', { class: 'tag good' }, 'Manager') : h('span', { class: 'muted' }, 'Employee'),
      { v: u.groups || '', cls: 'muted' },
      { v: u.last_seen ? fmtDate(u.last_seen) : 'never', cls: 'mono' },
      [u.disabled ? h('span', { class: 'tag bad' }, 'blocked') : h('span', { class: 'muted' }, 'active'),
        u.flat_home ? [h('br'), h('small', { class: 'muted' }, 'My files at the top on computers')] : null],
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Actions for ${u.name}`, 'aria-haspopup': 'menu', onClick: e => openMenu(e.currentTarget, actions(u)) }, icon('dots', 'ico ico-dots'))])))), 'people');
}

function showInvite(url) {
  const d = dialog('Invite link', [
    h('p', {}, 'Send this link to the people who should sign up. Each of them confirms their email with a one-time code.'),
    h('p', { class: 'callout secret link-url' }, url),
    h('p', { class: 'muted' }, 'The link is shown only once. Anyone who has it can sign up until it expires or is used up, so send it only to the right people.'),
  ], [
    h('button', { type: 'button', class: 'btn', onClick: act(async () => { await copy(url); toast('Copied.'); }) }, 'Copy'),
    h('button', { type: 'button', class: 'btn primary', onClick: () => d.close() }, 'Done'),
  ]);
  d.addEventListener('close', () => route());
}

function showPassword(login, password, created = false) {
  const d = dialog(created ? 'Account created' : 'Password reset', [
    h('p', {}, 'Temporary password for ', h('strong', {}, login), ':'),
    h('p', { class: 'callout secret' }, password),
    h('p', { class: 'muted' }, 'Hand it over in person or by phone. At first sign-in they choose their own password. This password is not shown again.'),
  ], [
    h('button', { type: 'button', class: 'btn', onClick: act(async () => { await copy(password); toast('Copied.'); }) }, 'Copy'),
    h('button', { type: 'button', class: 'btn primary', onClick: () => d.close() }, 'Done'),
  ]);
  d.addEventListener('close', () => route());
}

async function viewGroups() {
  const [groups, dir] = await Promise.all([api('GET', '/api/admin/groups'), api('GET', '/api/directory')]);
  const KIND = { everyone: 'all employees', managers: 'see all folders', department: 'department', project: 'project team', team: 'group' };
  const create = form('row', async (v, f) => {
    await api('POST', '/api/admin/groups', { name: v.name.trim() });
    f.reset();
    toast('Group created.');
    route();
  }, field('Group name', h('input', { name: 'name', required: true, maxlength: 60 })), h('button', { type: 'submit', class: 'btn primary' }, 'Create group'), errorLine());
  shell(page('Groups', 'Access is given to groups. Department and project groups are created with their folders on the Folders page.',
    card('New group', 'For teams that cross departments, for example a tender committee.', create),
    panel(table(['Group', 'Type', 'Members', ['', 'c-btns']], groups.map(g => [
      h('strong', {}, g.name),
      { v: KIND[g.kind], cls: 'muted' },
      g.kind === 'everyone' ? h('span', { class: 'muted' }, 'Every employee account') : g.members.length ? h('div', { class: 'chips' }, g.members.map(m => h('span', { class: 'chip' }, m.name))) : h('span', { class: 'muted' }, 'No members'),
      g.kind === 'everyone' ? '' : h('button', { type: 'button', class: 'btn small', onClick: () => membersDialog(g, dir.users) }, 'Edit members')])))), 'groups');
}

function membersDialog(g, users) {
  const chosen = new Set(g.members.map(m => m.id));
  const filter = h('input', { type: 'search', placeholder: 'Filter by name or login', 'aria-label': 'Filter people' });
  const list = h('div', { class: 'checklist' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(...users.filter(u => !q || u.name.toLowerCase().includes(q) || u.login.includes(q)).map(u => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: chosen.has(u.id), onChange: e => (e.target.checked ? chosen.add(u.id) : chosen.delete(u.id)) }),
      h('span', {}, u.name, ' ', h('small', { class: 'muted mono' }, u.login)))));
  };
  filter.addEventListener('input', draw);
  draw();
  let d;
  d = dialog(`Members of ${g.name}`, [
    g.kind === 'managers' ? h('p', { class: 'callout' }, 'Managers can open and edit every department and project folder.') : null,
    filter, list,
  ], [
    h('button', { type: 'button', class: 'btn', onClick: () => d.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn primary', onClick: act(async () => {
      await api('PUT', `/api/admin/groups/${g.id}/members`, { user_ids: [...chosen] });
      d.close();
      toast('Members saved.');
      route();
    }) }, 'Save members'),
  ]);
}

async function viewStructure() {
  const [folders, dir] = await Promise.all([api('GET', '/api/admin/folders'), api('GET', '/api/directory')]);
  const person = (name, label) => field(label, h('select', { name, required: true }, h('option', { value: '' }, 'Choose a person'), dir.users.map(u => h('option', { value: u.id }, `${u.name} (${u.login})`))));
  const quota = () => field('Quota, GB', h('input', { name: 'quota_gb', type: 'number', min: 1, step: 1, placeholder: 'No limit' }));
  const nameField = example => field('Name', h('input', { name: 'name', required: true, maxlength: 120, placeholder: example }));
  const created = msg => { toast(msg); route(); };
  const dept = form('stack', async v => {
    await api('POST', '/api/admin/departments', { name: v.name.trim(), head_id: Number(v.head_id), quota_gb: v.quota_gb || null });
    created(`Department "${v.name.trim()}" created.`);
  }, nameField('Engineering'), person('head_id', 'Department head'), quota(), errorLine(), h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, 'Create department')));
  const proj = form('stack', async v => {
    await api('POST', '/api/admin/projects', { name: v.name.trim(), lead_id: Number(v.lead_id), quota_gb: v.quota_gb || null });
    created(`Project "${v.name.trim()}" created. Add its team on the Groups page.`);
  }, nameField('Almaty office fit-out'), person('lead_id', 'Project lead'), quota(), errorLine(), h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, 'Create project')));
  const conf = form('stack', async v => {
    await api('POST', '/api/admin/confidential', { name: v.name.trim(), managers: Number(v.managers), owner_id: v.owner_id ? Number(v.owner_id) : null });
    created(v.owner_id ? `Confidential folder "${v.name.trim()}" created. Its owner can now share it with people.` : `Confidential folder "${v.name.trim()}" created. Now open its access and add the people.`);
  }, nameField('Payroll'),
    field('Owner', h('select', { name: 'owner_id' }, h('option', { value: '' }, 'Nobody (IT adds people)'), dir.users.map(u => h('option', { value: u.id }, `${u.name} (${u.login})`))),
      'The owner shares the folder with named people and removes access, without IT.'),
    field('Managers group', h('select', { name: 'managers' }, h('option', { value: 0 }, 'No access'), h('option', { value: 1 }, 'Read'), h('option', { value: 2 }, 'Edit')), 'Management decides this.'),
    errorLine(), h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, 'Create folder')));

  const quotaDialog = f => formDialog(`Quota for ${f.name}`, field('Quota, GB', h('input', { name: 'quota_gb', type: 'number', min: 1, step: 1, value: f.quota ? Math.round(f.quota / 2 ** 30) : '', placeholder: 'No limit' }), 'Leave empty for no limit.'), 'Save quota', async v => {
    await api('PATCH', `/api/admin/folders/${f.id}`, { quota_gb: v.quota_gb || null });
    created('Quota saved.');
  });
  const archive = async f => {
    if (!(await confirmDialog(`Archive ${f.name}?`, 'The folder moves to 06 Archive. Everyone who had access keeps it as Read only, and its external links stop working.', 'Archive project'))) return;
    await api('POST', `/api/admin/folders/${f.id}/archive`);
    created(`${f.name} moved to the archive.`);
  };
  const row = (f, depth) => [
    h('span', { class: `item depth-${depth}` }, icon('folder', 'ico ico-folder'), h('span', {}, f.name)),
    { v: f.access, cls: 'muted wrap' },
    { v: f.quota ? `${fmtSize(f.used)} of ${fmtSize(f.quota)}` : f.used != null ? fmtSize(f.used) : '', cls: 'mono' },
    f.area === 'personal' ? '' : h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Actions for ${f.name}`, 'aria-haspopup': 'menu', onClick: e => openMenu(e.currentTarget, [
      { label: 'Access', icon: 'people', run: () => accessDialog(f.id, f.name) },
      f.parent_id != null ? { label: 'Set quota', run: () => quotaDialog(f) } : null,
      f.archivable ? { label: 'Archive project', run: () => archive(f) } : null,
    ]) }, icon('dots', 'ico ico-dots')),
  ];
  const roots = folders.filter(f => f.parent_id == null);
  shell(page('Folders and quotas', 'The top-level folders are fixed. Create department, project and confidential folders here; department heads organise everything inside them.',
    h('div', { class: 'cards' },
      card('New department', 'Creates the department folder, its archive folder and its group. The head gets Manage.', dept),
      card('New project', 'Creates the project folder and its team group. The lead gets Manage and can create external links.', proj),
      card('New confidential folder', 'Only people added by name can open it. External links are off. Its owner decides who else gets in.', conf)),
    panel(table(['Folder', ['Who has access', 'c-acc'], ['Space', 'num'], ['', 'c-act']], roots.flatMap(r => [row(r, 0), ...folders.filter(f => f.parent_id === r.id).map(f => row(f, 1))])))), 'structure');
}

// ---------------------------------------------------------------- public share page (external visitors)
// Sign-up page behind an invite link: name and email first, then the emailed code and a password.
async function renderJoin(token) {
  const base = `/api/join/${encodeURIComponent(token)}`;
  let info;
  try {
    info = await api('GET', base);
  } catch (e) {
    return gate(h('h1', { class: 'gate-title' }, 'This link does not work'), h('p', { class: 'gate-sub' }, e.message));
  }
  state.appName = info.appName;
  document.title = `Sign up · ${info.appName}`;
  const step1 = (name = '', email = '') => gate(
    h('h1', { class: 'gate-title' }, 'Create your account'),
    h('p', { class: 'gate-sub' }, info.domain ? `Use your @${info.domain} email. We send a confirmation code to it.` : 'We send a confirmation code to your email.'),
    form('stack', async v => {
      await api('POST', `${base}/code`, { name: v.name.trim(), email: v.email.trim() });
      step2(v.name.trim(), v.email.trim().toLowerCase());
    },
      field('Full name', h('input', { name: 'name', value: name, required: true, maxlength: 80, autocomplete: 'name', autofocus: true })),
      field('Work email', h('input', { name: 'email', type: 'email', value: email, required: true, maxlength: 254, autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', placeholder: `name@${info.domain || 'company.kz'}` })),
      errorLine(),
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Send code')),
    h('p', { class: 'gate-foot muted' }, 'Already have an account? ', h('a', { href: '/' }, 'Sign in')));
  const step2 = (name, email) => gate(
    h('h1', { class: 'gate-title' }, 'Check your email'),
    h('p', { class: 'gate-sub' }, 'We sent a 6-digit code to ', h('strong', {}, email), '. It works for 10 minutes. No email? Look in the spam folder.'),
    form('stack', async v => {
      if (v.password !== v.repeat) throw new Error('The two passwords do not match.');
      const r = await api('POST', `${base}/confirm`, { name, email, code: v.code, password: v.password });
      done(r.login, email);
    },
      field('Code from the email', h('input', { name: 'code', class: 'mono', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, autofocus: true })),
      field('Choose a password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 12, required: true }), 'At least 12 characters.'),
      field('Repeat the password', h('input', { name: 'repeat', type: 'password', autocomplete: 'new-password', required: true })),
      errorLine(),
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Create account')),
    h('p', { class: 'gate-foot muted' }, h('button', { type: 'button', class: 'linkish', onClick: () => step1(name, email) }, 'Wrong email, or no code after a few minutes? Go back')));
  const done = (login, email) => gate(
    h('h1', { class: 'gate-title' }, 'Your account is ready'),
    h('p', { class: 'gate-sub' }, 'Your login is ', h('strong', { class: 'mono' }, login), '. You can also sign in with ', h('strong', {}, email), '.'),
    h('p', { class: 'muted' }, 'At first you see only your own folder. A Manager gives you access to the folders you need.'),
    h('a', { class: 'btn primary wide', href: '/' }, 'Sign in'));
  step1();
}

async function renderShare(token) {
  const base = `/api/public/${encodeURIComponent(token)}`;
  let info;
  try {
    info = await api('GET', base);
  } catch (e) {
    state.appName = 'Shared files';
    return gate(h('h1', { class: 'gate-title' }, 'This link does not work'), h('p', { class: 'gate-sub' }, e.message));
  }
  state.appName = info.appName;
  document.title = `Shared files · ${info.appName}`;
  if (!info.unlocked)
    return gate(
      h('h1', { class: 'gate-title' }, 'Shared files'),
      h('p', { class: 'gate-sub' }, 'Enter the password you received together with this link.'),
      form('stack', async v => {
        await api('POST', `${base}/unlock`, { password: v.password });
        await renderShare(token);
      },
        field('Password', h('input', { name: 'password', type: 'password', required: true, autofocus: true, autocomplete: 'off' })),
        errorLine(),
        h('button', { type: 'submit', class: 'btn primary wide' }, 'Open')),
      h('p', { class: 'gate-foot muted' }, `This link works until ${fmtDateTime(info.expires_at)}.`));

  const show = async id => {
    const d = await api('GET', `${base}/items${id ? `?id=${id}` : ''}`);
    const files = d.node.dir ? d.children : [d.node];
    const open = it => (it.dir ? act(() => show(it.id)) : () => (PREVIEWABLE.test(it.name) ? preview(it, `${base}/content?id=${it.id}`) : download(`${base}/content?id=${it.id}`)));
    document.body.className = 'gate share';
    mount(h('div', { class: 'share-wrap' },
      h('nav', { class: 'crumbs', 'aria-label': 'Location' }, d.crumbs.slice(0, -1).flatMap((c, i) => [i ? h('span', { class: 'sep' }, '/') : null, h('button', { type: 'button', class: 'linkish', onClick: act(() => show(c.id)) }, c.name)])),
      h('div', { class: 'folder-head' }, h('div', { class: 'tab' }, folderGlyph(), h('h1', {}, d.node.name)), h('span', { class: 'stamp' }, 'Read only')),
      h('div', { class: 'folder-body' },
        h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, `Shared by ${info.appName}`), h('span', { class: 'grow' }), h('span', { class: 'muted mono' }, `until ${fmtDateTime(d.expires_at)}`)),
        files.length
          ? h('div', { class: 'table-wrap' }, table(['Name', ['Size', 'num'], ['Modified', 'c-date']], files.map(it => [
              h('button', { type: 'button', class: 'item linkish', onClick: open(it) }, icon(it.dir ? 'folder' : 'file', it.dir ? 'ico ico-folder' : 'ico ico-file'), h('span', {}, it.name)),
              { v: it.dir ? '' : fmtSize(it.size), cls: 'mono' },
              { v: fmtDate(it.updated_at), cls: 'mono' }])))
          : empty('This folder is empty')),
      h('p', { class: 'share-foot muted' }, 'Click a file to download it.')));
  };
  try {
    await show();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
