// Traffic Counter dashboard. Vanilla JS, no build step.

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const ORIGIN = location.origin;

// ---------- tiny DOM helper (never uses innerHTML with data) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------- api ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to clipboard`); }
  catch { toast('Select the text and copy it manually'); }
}

// ---------- formatting ----------
const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n || 0);
let regionNames, langNames;
try { regionNames = new Intl.DisplayNames(undefined, { type: 'region' }); langNames = new Intl.DisplayNames(undefined, { type: 'language' }); } catch { /* old browser */ }
const flag = (cc) => /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';
function countryName(cc) {
  if (!cc) return 'Unknown';
  let n = cc; try { n = regionNames?.of(cc) || cc; } catch { /* keep code */ }
  return `${flag(cc)} ${n}`;
}
function languageName(code) {
  if (!code) return 'Unknown';
  try { return langNames?.of(code) || code; } catch { return code; }
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}
function prettyDate(d, opts = { month: 'short', day: 'numeric' }) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['12m', '12 months'],
];
function presetRange(p, tz) {
  const t = todayIn(tz);
  switch (p) {
    case 'today': return [t, t];
    case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
    case '7d': return [addDays(t, -6), t];
    case 'month': return [t.slice(0, 8) + '01', t];
    case 'lastmonth': {
      const first = t.slice(0, 8) + '01';
      const last = addDays(first, -1);
      return [last.slice(0, 8) + '01', last];
    }
    case '12m': return [addDays(t, -364), t];
    default: return [addDays(t, -29), t];
  }
}

// ---------- theme ----------
function applyTheme() {
  let t = null;
  try { t = localStorage.getItem('tc_theme'); } catch { /* storage off */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme();

// ---------- routing ----------
let me = null;
let cleanup = [];
function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || a.hasAttribute('download') || a.getAttribute('href').startsWith('/api/')) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

function nav(items) {
  $nav.replaceChildren(...items);
}

function mount(...nodes) {
  for (const fn of cleanup) fn();
  cleanup = [];
  $app.replaceChildren(...nodes.filter(Boolean));
}

async function route() {
  const p = location.pathname;
  let m;
  try {
    if ((m = p.match(/^\/share\/([a-z0-9]+)$/))) return viewDashboard({ shareKey: m[1] });
    if (!me) me = await api('GET', '/api/me');
    if (me.setup) return viewSetup();
    if (!me.user) return viewLogin();
    nav([
      h('a', { href: '/', 'aria-current': p === '/' ? 'page' : null }, 'Sites'),
      h('a', { href: '/settings', 'aria-current': p === '/settings' ? 'page' : null }, 'Account'),
    ]);
    if (p === '/') return viewSites();
    if (p === '/settings') return viewAccount();
    if ((m = p.match(/^\/sites\/(\d+)\/settings$/))) return viewSiteSettings(Number(m[1]));
    if ((m = p.match(/^\/sites\/(\d+)$/))) return viewDashboard({ siteId: Number(m[1]) });
    mount(h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '/' }, 'Go to your sites')));
  } catch (err) {
    if (err.status === 401) { me = null; return route(); }
    mount(h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, err.message));
  }
}

// ---------- auth views ----------
function formHandler(fn) {
  return async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const err = form.querySelector('.error');
    if (err) err.textContent = '';
    btn.disabled = true;
    try { await fn(Object.fromEntries(new FormData(form)), form); }
    catch (x) { if (err) err.textContent = x.message; else toast(x.message); }
    finally { btn.disabled = false; }
  };
}

function viewSetup() {
  nav([]);
  document.title = 'Set up · Traffic Counter';
  mount(h('div', { class: 'auth' },
    h('h1', {}, 'Create your account'),
    h('p', { class: 'muted' }, 'This server has no account yet. The first account you create here owns every site on it.'),
    h('form', { onsubmit: formHandler(async (d) => { await api('POST', '/api/setup', d); me = null; go('/', true); }) },
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'username' })),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('input', { id: 'password', name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
        h('div', { class: 'hint' }, 'At least 8 characters.')),
      h('p', { class: 'error', role: 'alert' }),
      h('button', { class: 'primary', type: 'submit' }, 'Create account'))));
}

function viewLogin() {
  nav([]);
  document.title = 'Sign in · Traffic Counter';
  mount(h('div', { class: 'auth' },
    h('h1', {}, 'Sign in'),
    h('form', { onsubmit: formHandler(async (d) => { await api('POST', '/api/login', d); me = null; route(); }) },
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'username' })),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('input', { id: 'password', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      h('p', { class: 'error', role: 'alert' }),
      h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'muted', style: { marginTop: '2rem', fontSize: '.88rem' } }, 'Forgot your password? Run ', h('code', {}, 'traffic-counter reset-password <email> <new-password>'), ' on the server.')));
}

// ---------- sites list ----------
async function viewSites() {
  document.title = 'Sites · Traffic Counter';
  const sites = await api('GET', '/api/sites');
  const today = await Promise.all(sites.map((st) => api('GET', `/api/sites/${st.id}/stats?from=${addDays(todayIn(st.timezone), -6)}&to=${todayIn(st.timezone)}&limit=1`).catch(() => null)));

  const formBox = h('div');
  const showForm = () => {
    formBox.replaceChildren(siteForm({}, async (d) => {
      const st = await api('POST', '/api/sites', d);
      toast('Site added');
      go(`/sites/${st.id}/settings#tracking`);
    }, 'Add site', () => formBox.replaceChildren()));
    formBox.querySelector('input')?.focus();
  };

  mount(
    h('div', { class: 'sites-head' }, h('h1', {}, 'Your sites'), sites.length ? h('button', { class: 'primary', onclick: showForm }, 'Add a site') : null),
    formBox,
    sites.length
      ? h('div', { class: 'site-rows' }, sites.map((st, i) => h('div', { class: 'site-row' },
          h('div', {}, h('a', { class: 'name', href: `/sites/${st.id}` }, st.name), h('div', { class: 'muted' }, st.domains ? st.domains.split(',').join(', ') : 'Any domain')),
          h('div', { class: 'num hide-sm' }, fmt(today[i]?.totals.pageviews), h('small', {}, 'views, 7 days')),
          h('div', { class: 'num' }, fmt(today[i]?.totals.visitors), h('small', {}, 'visitors, 7 days')))))
      : h('div', { class: 'empty-state' },
          h('h2', {}, 'Add your first site'),
          h('p', { class: 'muted' }, 'You’ll get a one-line snippet to paste into your pages. Visits start showing up here within seconds.'),
          h('button', { class: 'primary', onclick: showForm }, 'Add a site')),
  );
  if (!sites.length) showForm();
}

const TIMEZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();
function tzSelect(value) {
  const sel = h('select', { id: 'timezone', name: 'timezone' }, ['UTC', ...TIMEZONES.filter((z) => z !== 'UTC')].map((z) => h('option', { value: z, selected: z === value }, z.replace(/_/g, ' '))));
  return sel;
}

function siteForm(site, onSave, label, onCancel) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return h('form', { class: 'panel', style: { marginBottom: '1.25rem' }, onsubmit: formHandler(onSave) },
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), h('input', { id: 'name', name: 'name', required: true, value: site.name || '', placeholder: 'My blog' })),
      h('div', { class: 'field' }, h('label', { for: 'domains' }, 'Domains'), h('input', { id: 'domains', name: 'domains', value: site.domains?.split(',').join(', ') || '', placeholder: 'example.com, *.example.com' }),
        h('div', { class: 'hint' }, 'Only count visits from these domains. Leave empty to accept any.')),
      h('div', { class: 'field' }, h('label', { for: 'timezone' }, 'Timezone'), tzSelect(site.timezone || browserTz),
        h('div', { class: 'hint' }, 'Days in charts start at midnight here.'))),
    h('p', { class: 'error', role: 'alert' }),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, label), onCancel ? h('button', { type: 'button', onclick: onCancel }, 'Cancel') : null));
}

// ---------- dashboard ----------
async function viewDashboard({ siteId, shareKey }) {
  const isShare = !!shareKey;
  const base = isShare ? `/api/public/${shareKey}` : `/api/sites/${siteId}`;
  let sites = [];
  let site;
  if (isShare) {
    nav([]);
  } else {
    sites = await api('GET', '/api/sites');
    site = sites.find((x) => x.id === siteId);
    if (!site) return mount(h('h1', {}, 'Site not found'), h('p', {}, h('a', { href: '/' }, 'Back to your sites')));
  }

  const sp = new URLSearchParams(location.search);
  const state = { preset: sp.get('range') || (sp.get('from') ? 'custom' : '30d'), from: sp.get('from'), to: sp.get('to'), filters: {} };
  for (const k of ['path', 'ref', 'campaign', 'browser', 'os', 'device', 'screen', 'country', 'language']) if (sp.has(k)) state.filters[k] = sp.get(k);

  const $title = h('div', { class: 'title' });
  const $ranges = h('div', { class: 'ranges', role: 'group', 'aria-label': 'Date range' });
  const $filters = h('div', { class: 'filters' });
  const $meters = h('div', { class: 'meters' });
  const $chart = h('section', { class: 'panel chart-panel', 'aria-label': 'Traffic over time' });
  const $lists = h('div', { class: 'grid2' });
  const $live = h('div', { class: 'live', title: 'Visitors active in the last 5 minutes' }, h('i'), h('span', {}, ' '));

  mount(h('div', { class: 'dash-head' }, $title, $ranges), $filters, $meters, $chart, $lists,
    isShare ? h('p', { class: 'share-note' }, 'Shared with Traffic Counter. No cookies, no personal data.') : null);

  let tz = site?.timezone || 'UTC';

  function query(extra = {}) {
    const q = new URLSearchParams();
    if (state.from) q.set('from', state.from);
    if (state.to) q.set('to', state.to);
    for (const [k, v] of Object.entries(state.filters)) q.set(k, v);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q;
  }

  function syncUrl() {
    const q = new URLSearchParams();
    if (state.preset !== 'custom') { if (state.preset !== '30d') q.set('range', state.preset); }
    else { q.set('from', state.from); q.set('to', state.to); }
    for (const [k, v] of Object.entries(state.filters)) q.set(k, v);
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  function setPreset(p) {
    state.preset = p;
    if (p !== 'custom') [state.from, state.to] = presetRange(p, tz);
    load();
  }

  function addFilter(k, v) { state.filters[k] = v; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function removeFilter(k) { delete state.filters[k]; load(); }

  function renderRanges() {
    const from = h('input', { type: 'date', value: state.from, 'aria-label': 'From date', max: state.to });
    const to = h('input', { type: 'date', value: state.to, 'aria-label': 'To date', min: state.from });
    const onDate = () => { if (from.value && to.value) { state.preset = 'custom'; state.from = from.value; state.to = to.value; load(); } };
    from.addEventListener('change', onDate);
    to.addEventListener('change', onDate);
    $ranges.replaceChildren(...PRESETS.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(state.preset === k), onclick: () => setPreset(k) }, label)), from, to);
  }

  const FILTER_LABELS = { path: 'Page', ref: 'Referrer', campaign: 'Campaign', browser: 'Browser', os: 'System', device: 'Device', screen: 'Screen', country: 'Country', language: 'Language' };
  function renderFilters() {
    const entries = Object.entries(state.filters);
    $filters.hidden = !entries.length;
    $filters.replaceChildren(...entries.map(([k, v]) => h('span', { class: 'chip' }, h('b', {}, FILTER_LABELS[k]),
      k === 'country' ? countryName(v) : k === 'language' ? languageName(v) : (v || '(none)'),
      h('button', { type: 'button', 'aria-label': `Remove ${FILTER_LABELS[k]} filter`, onclick: () => removeFilter(k) }, '×'))));
  }

  function renderTitle(name) {
    if (isShare) { $title.replaceChildren(h('h1', {}, name), $live); return; }
    const sel = h('select', { class: 'site-switch', 'aria-label': 'Switch site', onchange: (e) => go(`/sites/${e.target.value}${location.search}`) },
      sites.map((x) => h('option', { value: x.id, selected: x.id === siteId }, x.name)));
    $title.replaceChildren(h('h1', {}, sites.length > 1 ? sel : name),
      h('div', { class: 'row' }, $live, h('a', { href: `/sites/${siteId}/settings`, style: { fontSize: '.9rem', marginTop: '.25rem' } }, 'Settings & tracking code')));
  }

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    syncUrl();
    renderRanges();
    renderFilters();
    $app.setAttribute('aria-busy', 'true');
    try {
      const data = await api('GET', `${base}/stats?${query()}`);
      if (seq !== loadSeq) return;
      tz = data.site.timezone;
      document.title = `${data.site.name} · Traffic Counter`;
      renderTitle(data.site.name);
      renderMeters(data);
      renderChart(data);
      renderLists(data);
    } catch (err) {
      if (err.status === 404 && isShare) return mount(h('h1', {}, 'This dashboard isn’t shared'), h('p', { class: 'muted' }, 'The owner hasn’t made these stats public, or the link is wrong.'));
      toast(err.message);
    } finally { $app.removeAttribute('aria-busy'); }
  }

  function meter(label, value, prev) {
    let delta;
    if (!prev && !value) delta = h('div', { class: 'delta' }, 'No data in this period yet');
    else if (!prev) delta = h('div', { class: 'delta' }, 'Nothing in the previous period to compare');
    else {
      const pct = Math.round(((value - prev) / prev) * 100);
      delta = h('div', { class: 'delta' }, h('span', { class: pct > 0 ? 'up' : pct < 0 ? 'down' : '' }, `${pct > 0 ? '▲' : pct < 0 ? '▼' : '±'} ${Math.abs(pct)}%`), ` vs previous ${prettyRangeLen()}`);
    }
    return h('section', { class: 'meter' }, h('h2', {}, label), odometer(value), delta);
  }

  function prettyRangeLen() {
    if (state.preset === 'today' || state.preset === 'yesterday') return 'day';
    const days = Math.round((Date.parse(state.to) - Date.parse(state.from)) / 86400000) + 1;
    return `${days} days`;
  }

  function renderMeters(d) {
    $meters.replaceChildren(
      meter(state.filters.path !== undefined ? 'Visitors to this page' : 'Visitors', d.totals.visitors, d.previous.visitors),
      meter('Pageviews', d.totals.pageviews, d.previous.pageviews),
      meter('Events', d.totals.events, d.previous.events));
  }

  function renderChart(d) {
    const pts = d.series.points;
    const W = 1000, H = 240, padL = 44, padB = 26, padT = 10;
    const max = Math.max(1, ...pts.map((p) => Math.max(p.views, p.visitors)));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const cw = (W - padL) / pts.length;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Pageviews and visitors per ${d.series.unit}` });

    for (let v = 0; v <= top; v += step) {
      svg.append(s('line', { class: 'grid', x1: padL, x2: W, y1: y(v), y2: y(v), 'vector-effect': 'non-scaling-stroke' }));
    }
    const bars = pts.map((p, i) => {
      const bw = Math.max(1, cw * 0.72);
      const r = s('rect', { class: 'bar', x: padL + i * cw + (cw - bw) / 2, y: y(p.views), width: bw, height: Math.max(0, y(0) - y(p.views)) });
      svg.append(r);
      return r;
    });
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${(padL + i * cw + cw / 2).toFixed(1)},${y(p.visitors).toFixed(1)}`).join('');
    svg.append(s('path', { class: 'vline', d: line, 'vector-effect': 'non-scaling-stroke' }));

    // Axis labels live in an HTML overlay so text doesn't stretch with the SVG.
    const labels = h('div', { 'aria-hidden': 'true' });
    for (let v = 0; v <= top; v += step) {
      labels.append(h('span', { class: 'axis-y', style: { position: 'absolute', left: 0, top: `calc(${(y(v) / H) * 100}% - .6em)`, fontSize: '11px', color: 'var(--muted)' } }, compact(v)));
    }
    const every = Math.max(1, Math.ceil(pts.length / 7));
    pts.forEach((p, i) => {
      if (i % every) return;
      labels.append(h('span', { style: { position: 'absolute', bottom: 0, left: `${((padL + i * cw + cw / 2) / W) * 100}%`, transform: 'translateX(-50%)', fontSize: '11px', color: 'var(--muted)', whiteSpace: 'nowrap' } }, axisLabel(p.t, d.series.unit)));
    });

    const tip = h('div', { class: 'tip' });
    const box = h('div', { class: 'chart' }, svg, labels, tip);
    let hot = null;
    box.addEventListener('pointermove', (e) => {
      const rect = box.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.min(pts.length - 1, Math.max(0, Math.floor((x - padL) / cw)));
      if (hot !== null) bars[hot].classList.remove('hot');
      hot = i; bars[i].classList.add('hot');
      const p = pts[i];
      tip.replaceChildren(h('div', {}, h('b', {}, tipLabel(p.t, d.series.unit))), h('div', {}, `${fmt(p.visitors)} visitors · ${fmt(p.views)} views`));
      tip.style.left = `${((padL + i * cw + cw / 2) / W) * rect.width}px`;
      tip.style.top = `${(y(Math.max(p.views, p.visitors)) / H) * rect.height}px`;
      tip.classList.add('show');
    });
    box.addEventListener('pointerleave', () => { tip.classList.remove('show'); if (hot !== null) bars[hot].classList.remove('hot'); hot = null; });

    $chart.replaceChildren(
      h('div', { class: 'chart-head' }, h('h2', {}, rangeTitle()),
        h('div', { class: 'legend' }, h('span', { class: 'lv' }, h('i'), 'Pageviews'), h('span', { class: 'lu' }, h('i'), 'Visitors'))),
      box);
  }

  function rangeTitle() {
    if (state.from === state.to) return prettyDate(state.from, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const sameYear = state.from.slice(0, 4) === state.to.slice(0, 4);
    return `${prettyDate(state.from, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })} – ${prettyDate(state.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  const LISTS = [
    ['pages', 'Pages', 'path', true],
    ['refs', 'Referrers', 'ref'],
    ['campaigns', 'Campaigns', 'campaign'],
    ['events', 'Events', null],
    ['countries', 'Countries', 'country'],
    ['browsers', 'Browsers', 'browser'],
    ['systems', 'Systems', 'os'],
    ['devices', 'Devices', 'device'],
    ['screens', 'Screen sizes', 'screen'],
    ['languages', 'Languages', 'language'],
  ];

  function rowName(dim, r) {
    if (dim === 'countries') return countryName(r.name);
    if (dim === 'languages') return languageName(r.name);
    if (dim === 'refs' && state.filters.ref !== undefined) return r.name || '(home page)';
    if (dim === 'browsers' && state.filters.browser !== undefined) return r.name ? `${state.filters.browser} ${r.name}` : 'Unknown version';
    return r.name || 'Unknown';
  }

  function renderLists(d) {
    $lists.replaceChildren(...LISTS.map(([dim, title, filterKey, wide]) => {
      // Hide lists that would just repeat the active filter.
      if (filterKey && state.filters[filterKey] !== undefined && !['refs', 'browsers'].includes(dim)) return null;
      const block = d[dim];
      const max = Math.max(1, ...block.rows.map((r) => r.visitors || r.views));
      const tbody = h('tbody');
      const addRows = (rows) => {
        for (const r of rows) {
          const label = rowName(dim, r);
          const canFilter = filterKey && !(dim === 'refs' && state.filters.ref !== undefined) && !(dim === 'browsers' && state.filters.browser !== undefined);
          const bar = h('span', { class: 'bar' });
          bar.style.width = `${((r.visitors || r.views) / max) * 100}%`;
          const nameEl = canFilter
            ? h('button', { type: 'button', title: `Show only ${label}`, onclick: () => addFilter(filterKey, r.name) }, label, r.title && dim === 'pages' ? h('span', { class: 'sub' }, r.title) : null)
            : h('button', { type: 'button', disabled: true, style: { cursor: 'default', opacity: 1 }, title: r.title || label }, label, r.title && dim === 'events' ? h('span', { class: 'sub' }, r.title) : null);
          tbody.append(h('tr', {}, h('td', { class: 'name' }, bar, nameEl), h('td', { class: 'n' }, fmt(r.visitors)), h('td', { class: 'n' }, fmt(r.views))));
        }
      };
      addRows(block.rows);
      let offset = block.rows.length;
      const more = block.more ? h('button', { type: 'button', class: 'more', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const next = await api('GET', `${base}/breakdown/${dim}?${query({ offset, limit: 25 })}`);
          addRows(next.rows); offset += next.rows.length;
          if (!next.more) e.target.remove(); else e.target.disabled = false;
        } catch (x) { toast(x.message); e.target.disabled = false; }
      } }, 'Show more') : null;
      const heading = dim === 'refs' && state.filters.ref !== undefined ? `Pages on ${state.filters.ref}` : dim === 'browsers' && state.filters.browser !== undefined ? `${state.filters.browser} versions` : title;
      return h('section', { class: `panel list${wide ? ' wide' : ''}` },
        h('h2', {}, heading),
        block.rows.length
          ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, h('span', { class: 'visually-hidden' }, 'Name')), h('th', { class: 'n' }, dim === 'events' ? 'Unique' : 'Visitors'), h('th', { class: 'n' }, dim === 'events' ? 'Total' : 'Views'))), tbody)
          : h('p', { class: 'empty' }, emptyText(dim)),
        more);
    }));
  }

  function emptyText(dim) {
    return {
      refs: 'No referrers yet. Direct visits and visits from your own site aren’t listed here.',
      campaigns: 'No campaigns yet. Add ?utm_campaign=name to links you share.',
      events: 'No events yet. Add data-tc-event="name" to a button or link to count clicks.',
      countries: 'No country data. Set COUNTRY_HEADER if you run behind Cloudflare or another proxy that adds one.',
    }[dim] || 'Nothing here for this period.';
  }

  async function pollLive() {
    try {
      const { online } = await api('GET', `${base}/live`);
      $live.classList.toggle('on', online > 0);
      $live.lastChild.textContent = online === 1 ? '1 visitor online' : `${fmt(online)} visitors online`;
    } catch { /* ignore */ }
  }

  if (state.preset !== 'custom') [state.from, state.to] = presetRange(state.preset, tz);
  await load();
  pollLive();
  const iv = setInterval(() => { if (document.visibilityState === 'visible') { pollLive(); if (state.to >= todayIn(tz)) load(); } }, 60000);
  cleanup.push(() => clearInterval(iv));
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return Math.max(1, m * mag);
  return 10 * mag;
}
function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'k';
  return String(n);
}
function axisLabel(t, unit) {
  if (unit === 'hour') return t.slice(11, 13) + ':00';
  if (unit === 'month') return prettyDate(t + '-01', { month: 'short', year: '2-digit' });
  return prettyDate(t);
}
function tipLabel(t, unit) {
  if (unit === 'hour') return `${prettyDate(t.slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' })}, ${t.slice(11, 16)}`;
  if (unit === 'month') return prettyDate(t + '-01', { month: 'long', year: 'numeric' });
  return prettyDate(t, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Mechanical-counter rendering of a number: at least six wheels, unused ones dimmed.
function odometer(n) {
  const digits = String(Math.max(0, Math.floor(n || 0)));
  const padded = digits.padStart(Math.max(6, digits.length), '0');
  const lead = padded.length - digits.length;
  const out = h('div', { class: 'odo', role: 'img', 'aria-label': fmt(n) });
  [...padded].forEach((c, i) => {
    const fromEnd = padded.length - i;
    out.append(h('span', { class: i < lead ? 'lead' : null }, c));
    if (fromEnd > 1 && fromEnd % 3 === 1) out.append(h('span', { class: 'sep' }, ','));
  });
  return out;
}

// ---------- site settings ----------
async function viewSiteSettings(id) {
  let site = await api('GET', `/api/sites/${id}`);
  document.title = `${site.name} settings · Traffic Counter`;

  const snippet = () => `<script async src="${ORIGIN}/t.js" data-site="${site.key}"></script>`;
  const noscript = () => `<noscript><img src="${ORIGIN}/api/hit.gif?s=${site.key}&p=YOUR-PAGE-PATH" alt="" width="1" height="1"></noscript>`;
  const codeBlock = (text, label = 'Copy') => h('div', { class: 'code' }, h('pre', {}, h('code', {}, text)), h('button', { type: 'button', onclick: () => copy(text, 'Copied') }, label));

  async function save(patch, msg = 'Saved') {
    site = await api('PATCH', `/api/sites/${id}`, patch);
    toast(msg);
    return site;
  }

  // Badge builder
  const badgeState = { path: '', metric: 'views', label: 'views', color: 'teal', compact: false };
  const badgeImg = h('img', { alt: 'Counter badge preview', height: 20 });
  const badgeCode = h('div');
  function badgeUrl() {
    const q = new URLSearchParams();
    if (badgeState.path) q.set('path', badgeState.path);
    if (badgeState.metric !== 'views') q.set('metric', badgeState.metric);
    if (badgeState.label !== badgeState.metric) q.set('label', badgeState.label);
    if (badgeState.color !== 'teal') q.set('color', badgeState.color);
    if (badgeState.compact) q.set('compact', '1');
    const qs = q.toString();
    return `${ORIGIN}/counter/${site.key}.svg${qs ? '?' + qs : ''}`;
  }
  function renderBadge() {
    const url = badgeUrl();
    badgeImg.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    badgeCode.replaceChildren(
      h('h3', {}, 'HTML'), codeBlock(`<img src="${url}" alt="${badgeState.label} counter">`),
      h('h3', {}, 'Markdown'), codeBlock(`![${badgeState.label}](${url})`));
  }
  const bInput = (key, { tag = 'input', kids = [], ...attrs }) =>
    h(tag, { ...attrs, oninput: (e) => { badgeState[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderBadge(); } }, kids);

  const sections = [
    ['tracking', 'Tracking code', [
      h('p', {}, 'Paste this just before ', h('code', {}, '</head>'), ' on every page you want to count. It’s about 2 KB compressed, sets no cookies and loads without blocking your page.'),
      codeBlock(snippet(), 'Copy snippet'),
      h('details', {}, h('summary', {}, 'Count button clicks and other events'),
        h('p', { style: { marginTop: '.75rem' } }, 'Add an attribute to any element. Clicks show up under Events.'),
        codeBlock('<button data-tc-event="signup">Sign up</button>'),
        h('p', {}, 'Or call it from your own code:'),
        codeBlock("window.tc.event('newsletter-subscribed')")),
      h('details', {}, h('summary', {}, 'Options'),
        h('p', { style: { marginTop: '.75rem' } }, 'Add these attributes to the script tag:'),
        h('ul', {},
          h('li', {}, h('code', {}, 'data-outbound'), ' counts clicks on links to other sites as events.'),
          h('li', {}, h('code', {}, 'data-respect-dnt'), ' skips visitors who send Do Not Track or Global Privacy Control.'),
          h('li', {}, h('code', {}, 'data-hash'), ' counts #section changes as separate pages (for hash-routed apps).'),
          h('li', {}, h('code', {}, 'data-manual'), ' turns off automatic counting; call ', h('code', {}, 'tc.pageview()'), ' yourself.'),
          h('li', {}, h('code', {}, 'data-allow-local'), ' counts visits on localhost while you test.'),
          h('li', {}, h('code', {}, 'data-no-spa'), ' stops counting pushState navigations.'))),
      h('details', {}, h('summary', {}, 'No JavaScript? Use an image'),
        h('p', { style: { marginTop: '.75rem' } }, 'Works in emails and pages without scripts. Replace the path on each page.'),
        codeBlock(noscript())),
      h('details', {}, h('summary', {}, 'Stop counting your own visits'),
        h('p', { style: { marginTop: '.75rem' } }, 'Open any page of your site with ', h('code', {}, '#tc-ignore'), ' at the end of the address, for example ', h('code', {}, `https://${site.domains.split(',')[0] || 'example.com'}/#tc-ignore`), '. Do it again to start counting again. It applies to that one browser.')),
    ]],
    ['counter', 'Visit counter badge', [
      h('p', {}, 'Show a live view count on your page. Leave the path empty for the whole site.'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 'bpath' }, 'Page path'), bInput('path', { id: 'bpath', placeholder: '/blog/my-post' })),
        h('div', { class: 'field' }, h('label', { for: 'bmetric' }, 'Count'), bInput('metric', { tag: 'select', id: 'bmetric', kids: [h('option', { value: 'views' }, 'Pageviews'), h('option', { value: 'visitors' }, 'Visitors')] })),
        h('div', { class: 'field' }, h('label', { for: 'blabel' }, 'Label'), bInput('label', { id: 'blabel', value: 'views' })),
        h('div', { class: 'field' }, h('label', { for: 'bcolor' }, 'Color'), bInput('color', { tag: 'select', id: 'bcolor', kids: ['teal', 'green', 'blue', 'purple', 'orange', 'red', 'gray', 'black'].map((c) => h('option', { value: c }, c)) }))),
      h('label', { class: 'check' }, bInput('compact', { type: 'checkbox' }), 'Short numbers (12.3k instead of 12,345)'),
      h('div', { class: 'badge-preview' }, badgeImg, h('span', { class: 'muted' }, 'Updates about once a minute.')),
      badgeCode,
      h('p', { class: 'muted' }, 'JSON for your own design: ', h('code', {}, `${ORIGIN}/counter/${site.key}.json?path=/`)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: site.public_counter, onchange: (e) => save({ public_counter: e.target.checked }, e.target.checked ? 'Counter badges turned on' : 'Counter badges turned off') }),
        'Allow counter badges for this site. Turning this off makes the badge and JSON links return “not found”.'),
    ]],
    ['sharing', 'Public dashboard', [
      h('p', {}, 'Let anyone with the link see this site’s dashboard, read-only. Nothing in it identifies a visitor.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: site.public_stats, onchange: async (e) => { await save({ public_stats: e.target.checked }, e.target.checked ? 'Dashboard is public' : 'Dashboard is private'); shareBox.hidden = !site.public_stats; } }),
        'Make the dashboard public'),
    ]],
    ['data', 'Data', [
      h('form', { onsubmit: formHandler((d) => save({ retention_days: Number(d.retention_days), ignore_paths: d.ignore_paths })) },
        h('div', { class: 'field' }, h('label', { for: 'retention' }, 'Keep data for'),
          h('select', { id: 'retention', name: 'retention_days' }, [[0, 'Forever'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1825, '5 years']]
            .map(([v, l]) => h('option', { value: v, selected: Number(site.retention_days) === v }, l))),
          h('div', { class: 'hint' }, 'Older visits are deleted automatically every hour.')),
        h('div', { class: 'field' }, h('label', { for: 'ignore' }, 'Don’t count these paths'), h('textarea', { id: 'ignore', name: 'ignore_paths', placeholder: '/admin\n/preview' }, site.ignore_paths),
          h('div', { class: 'hint' }, 'One per line. Any page whose path starts with one of these is skipped.')),
        h('p', { class: 'error', role: 'alert' }),
        h('button', { class: 'primary', type: 'submit' }, 'Save data settings')),
      h('h3', { style: { marginTop: '1.5rem' } }, 'Export'),
      h('p', { class: 'muted' }, `${fmt(site.hits)} recorded hits${site.first_hit ? ` since ${new Date(site.first_hit * 1000).toLocaleDateString()}` : ''}.`),
      h('a', { class: 'btn', href: `/api/sites/${id}/export.csv`, download: '' }, 'Download CSV'),
      h('h3', { style: { marginTop: '1.5rem' } }, 'Import from GoatCounter'),
      h('p', { class: 'muted' }, 'Export your data from GoatCounter (Settings → Export), copy the file to the server and run:'),
      codeBlock(`traffic-counter import-goatcounter ${site.key} goatcounter-export.csv.gz`),
    ]],
    ['details', 'Site details', [
      siteForm(site, async (d) => { await save(d); document.title = `${site.name} settings · Traffic Counter`; heading.textContent = site.name; }, 'Save details'),
      h('p', { class: 'muted' }, 'Site key: ', h('code', {}, site.key)),
    ]],
    ['danger', 'Delete', [
      h('div', { class: 'danger-zone' },
        h('p', {}, 'Clear all recorded visits but keep the site and its tracking code.'),
        h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm(`Delete all ${fmt(site.hits)} hits for ${site.name}? This can’t be undone.`)) return;
          await api('POST', `/api/sites/${id}/reset`, {}); toast('All visits deleted');
        } }, 'Delete all visits'),
        h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '1.25rem 0' } }),
        h('p', {}, 'Remove the site and all of its data. The tracking code stops working.'),
        h('button', { type: 'button', class: 'danger solid', onclick: async () => {
          const typed = prompt(`Type the site name (${site.name}) to delete it.`);
          if (typed !== site.name) { if (typed !== null) toast('The name didn’t match, nothing was deleted'); return; }
          await api('DELETE', `/api/sites/${id}`, {}); toast('Site deleted'); go('/');
        } }, 'Delete site')),
    ]],
  ];

  const shareUrl = `${ORIGIN}/share/${site.key}`;
  const shareBox = h('div', { hidden: !site.public_stats }, codeBlock(shareUrl, 'Copy link'), h('p', {}, h('a', { href: `/share/${site.key}` }, 'Open the public dashboard')));
  sections[2][2].push(shareBox);

  const heading = h('span', {}, site.name);
  mount(
    h('div', { class: 'sites-head' }, h('h1', {}, heading), h('a', { class: 'btn', href: `/sites/${id}` }, 'View dashboard')),
    h('div', { class: 'settings' },
      h('nav', { 'aria-label': 'Settings sections' }, sections.map(([k, t]) => h('a', { href: `#${k}`, onclick: (e) => { e.preventDefault(); document.getElementById(k).scrollIntoView({ behavior: 'smooth' }); history.replaceState(null, '', `#${k}`); } }, t))),
      h('div', {}, sections.map(([k, t, body]) => h('section', { id: k }, h('h2', {}, t), body)))));
  renderBadge();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// ---------- account ----------
function viewAccount() {
  document.title = 'Account · Traffic Counter';
  let theme = 'system';
  try { theme = localStorage.getItem('tc_theme') || 'system'; } catch { /* ignore */ }
  mount(
    h('div', { class: 'sites-head' }, h('h1', {}, 'Account')),
    h('div', { style: { maxWidth: '520px' } },
      h('section', { class: 'panel', style: { marginBottom: '1rem' } },
        h('h2', { style: { marginBottom: '.5rem' } }, 'Signed in'),
        h('p', {}, me.user.email),
        h('button', { type: 'button', onclick: async () => { await api('POST', '/api/logout', {}); me = null; go('/'); } }, 'Sign out')),
      h('section', { class: 'panel', style: { marginBottom: '1rem' } },
        h('h2', { style: { marginBottom: '.75rem' } }, 'Appearance'),
        h('div', { class: 'field' }, h('label', { for: 'theme' }, 'Theme'),
          h('select', { id: 'theme', onchange: (e) => { try { if (e.target.value === 'system') localStorage.removeItem('tc_theme'); else localStorage.setItem('tc_theme', e.target.value); } catch { /* ignore */ } applyTheme(); } },
            [['system', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: theme === v }, l))))),
      h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '.75rem' } }, 'Change password'),
        h('form', { onsubmit: formHandler(async (d, form) => { await api('POST', '/api/password', d); form.reset(); toast('Password changed. Other sessions were signed out.'); }) },
          h('div', { class: 'field' }, h('label', { for: 'current' }, 'Current password'), h('input', { id: 'current', name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
          h('div', { class: 'field' }, h('label', { for: 'next' }, 'New password'), h('input', { id: 'next', name: 'next', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
          h('p', { class: 'error', role: 'alert' }),
          h('button', { class: 'primary', type: 'submit' }, 'Change password'))),
      h('p', { class: 'muted', style: { marginTop: '1.5rem', fontSize: '.85rem' } }, `Traffic Counter ${me.version}`)));
}

route();
