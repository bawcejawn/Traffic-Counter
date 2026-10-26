import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { importGoatCounter } from '../src/import.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let app, base, cookie = '', site;

async function req(method, path, { body, headers = {}, raw = false } = {}) {
  const h = { cookie, ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return res;
  if (process.env.DBG) console.error(method, path, res.status, [...res.headers].filter(([k]) => k.startsWith('content') || k.startsWith('x-tc')));
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
}

function hit(data, headers = {}) {
  return req('POST', '/api/hit', { body: JSON.stringify({ s: site.key, ...data }), headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: 'https://example.com', ...headers } });
}

before(async () => {
  app = createApp({ db: openDb(':memory:'), trustProxy: true, countryHeader: 'cf-ipcountry' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

test('setup flow and auth', async () => {
  let r = await req('GET', '/api/me');
  assert.equal(r.data.setup, true);
  r = await req('POST', '/api/setup', { body: { email: 'me@example.com', password: 'short' } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/setup', { body: { email: 'me@example.com', password: 'correct horse' } });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/me');
  assert.equal(r.data.user.email, 'me@example.com');
  // second setup refused
  r = await req('POST', '/api/setup', { body: { email: 'x@example.com', password: 'another one' } });
  assert.equal(r.status, 403);
});

test('csrf: form posts and cross-origin requests are refused', async () => {
  let r = await req('POST', '/api/sites', { body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  r = await req('POST', '/api/sites', { body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('create site', async () => {
  const r = await req('POST', '/api/sites', { body: { name: 'Example', domains: 'https://example.com/, blog.example.com', timezone: 'America/New_York' } });
  assert.equal(r.status, 201);
  site = r.data;
  assert.equal(site.domains, 'example.com,blog.example.com');
  assert.match(site.key, /^[a-z0-9]{10}$/);
});

test('tracking and stats', async () => {
  const ip1 = { 'x-forwarded-for': '203.0.113.1', 'cf-ipcountry': 'US' };
  const ip2 = { 'x-forwarded-for': '203.0.113.2', 'cf-ipcountry': 'DE' };
  let r = await hit({ p: '/', t: 'Home', r: 'https://www.google.com/', w: 1440, l: 'en-US' }, ip1);
  assert.equal(r.headers.get('x-tc-result'), 'counted');
  await hit({ p: '/', t: 'Home', w: 1440 }, ip1);             // repeat view, same visitor
  await hit({ p: '/about', t: 'About', w: 1440 }, ip1);        // new path, same visitor
  await hit({ p: '/', t: 'Home', r: 'https://news.ycombinator.com/item?id=9', q: '?utm_campaign=launch', w: 390, l: 'de' }, ip2);
  await hit({ p: 'signup', e: 1, t: 'Sign up' }, ip2);

  // rejected hits
  r = await hit({ p: '/' }, { ...ip1, 'user-agent': 'Googlebot/2.1' });
  assert.equal(r.headers.get('x-tc-result'), 'bot');
  r = await hit({ p: '/' }, { ...ip1, origin: 'https://evil.com' });
  assert.equal(r.headers.get('x-tc-result'), 'domain not allowed');
  r = await hit({ p: '/', b: 153 }, ip1);
  assert.equal(r.headers.get('x-tc-result'), 'bot');
  r = await hit({ p: '/' }, { ...ip1, 'sec-purpose': 'prefetch' });
  assert.equal(r.headers.get('x-tc-result'), 'prefetch');
  r = await req('POST', '/api/hit', { body: JSON.stringify({ s: 'nope', p: '/' }), headers: { 'content-type': 'text/plain', 'user-agent': UA } });
  assert.equal(r.headers.get('x-tc-result'), 'unknown site');

  const s = (await req('GET', `/api/sites/${site.id}/stats`)).data;
  assert.equal(s.totals.pageviews, 4);
  assert.equal(s.totals.visitors, 2);
  assert.equal(s.totals.events, 1);
  assert.deepEqual(s.pages.rows.map((x) => [x.name, x.views, x.visitors]), [['/', 3, 2], ['/about', 1, 1]]);
  assert.deepEqual(s.refs.rows.map((x) => x.name).sort(), ['Google', 'Hacker News']);
  assert.equal(s.campaigns.rows[0].name, 'launch');
  assert.equal(s.events.rows[0].name, 'signup');
  assert.deepEqual(s.countries.rows.map((x) => x.name).sort(), ['DE', 'US']);
  assert.equal(s.browsers.rows[0].name, 'Chrome');
  assert.equal(s.series.unit, 'day');
  assert.equal(s.series.points.length, 30);
  assert.equal(s.series.points.at(-1).views, 4);

  // filters
  const f = (await req('GET', `/api/sites/${site.id}/stats?path=%2Fabout`)).data;
  assert.equal(f.totals.pageviews, 1);
  assert.equal(f.totals.visitors, 1);
  const g = (await req('GET', `/api/sites/${site.id}/stats?country=DE`)).data;
  assert.equal(g.totals.pageviews, 1);
  const rf = (await req('GET', `/api/sites/${site.id}/stats?ref=Hacker%20News`)).data;
  assert.equal(rf.refs.rows[0].name, '/item');

  // today range is hourly
  const today = (await req('GET', `/api/sites/${site.id}/stats?from=${s.range.to}&to=${s.range.to}`)).data;
  assert.equal(today.series.unit, 'hour');
  assert.equal(today.series.points.reduce((a, p) => a + p.views, 0), 4);

  // live
  assert.equal((await req('GET', `/api/sites/${site.id}/live`)).data.online, 2);
});

test('no personal data is stored', async () => {
  const cols = app.db.prepare('PRAGMA table_info(hits)').all().map((c) => c.name);
  for (const bad of ['ip', 'user_agent', 'ua', 'visitor', 'session']) assert.ok(!cols.includes(bad), `hits has ${bad}`);
  const row = JSON.stringify(app.db.prepare('SELECT * FROM hits').all());
  assert.ok(!row.includes('203.0.113'));
  assert.ok(!row.includes('Mozilla'));
});

test('pixel endpoint', async () => {
  const r = await req('GET', `/api/hit.gif?s=${site.key}&p=/pixel`, { headers: { 'user-agent': UA, referer: 'https://example.com/pixel', 'x-forwarded-for': '203.0.113.9' }, raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.equal(r.headers.get('x-tc-result'), 'counted');
});

test('counter badge and json', async () => {
  let r = await req('GET', `/counter/${site.key}.json?path=/`);
  assert.deepEqual(r.data, { path: '/', views: 3, visitors: 2 });
  r = await req('GET', `/counter/${site.key}.svg?label=hits`);
  assert.match(r.data, /<svg/);
  assert.match(r.data, />hits</);
  await req('PATCH', `/api/sites/${site.id}`, { body: { public_counter: false } });
  r = await req('GET', `/counter/${site.key}.json`);
  assert.equal(r.status, 404);
});

test('public dashboard', async () => {
  let r = await req('GET', `/api/public/${site.key}/stats`, { headers: { cookie: '' } });
  assert.equal(r.status, 404);
  await req('PATCH', `/api/sites/${site.id}`, { body: { public_stats: true } });
  const saved = cookie; cookie = '';
  r = await req('GET', `/api/public/${site.key}/stats`);
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.pageviews, 5);
  r = await req('GET', `/api/sites/${site.id}/stats`);
  assert.equal(r.status, 401);
  cookie = saved;
});

test('ignore paths', async () => {
  await req('PATCH', `/api/sites/${site.id}`, { body: { ignore_paths: '/admin\n/preview' } });
  const r = await hit({ p: '/admin/users' }, { 'x-forwarded-for': '203.0.113.50' });
  assert.equal(r.headers.get('x-tc-result'), 'ignored path');
});

test('csv export', async () => {
  const r = await req('GET', `/api/sites/${site.id}/export.csv`);
  assert.equal(r.status, 200);
  const lines = r.data.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'time');
  assert.equal(lines.length, 7);
});

test('goatcounter import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'));
  const file = join(dir, 'gc.csv');
  writeFileSync(file, [
    '2Path,Title,Event,UserAgent,Browser,System,Session,Bot,Referrer,Referrer scheme,Screen size,Location,FirstVisit,Date',
    '/old,Old post,false,,Firefox 120,Windows 10,1,0,news.ycombinator.com/item,h,"1920,1080,1",NL,true,2024-03-01T10:00:00Z',
    '/old,Old post,false,,Chrome 121,macOS 14,2,0,,,"390,844,3",US-CA,false,2024-03-01T11:00:00Z',
    '/bot,,false,,,,3,4,,,,,true,2024-03-01T12:00:00Z',
  ].join('\n'));
  const s = app.db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
  const r = importGoatCounter(app.db, s, file);
  assert.deepEqual(r, { imported: 2, skipped: 1 });
  const st = (await req('GET', `/api/sites/${site.id}/stats?from=2024-03-01&to=2024-03-01`)).data;
  assert.equal(st.totals.pageviews, 2);
  assert.equal(st.refs.rows[0].name, 'Hacker News');
  assert.deepEqual(st.countries.rows.map((x) => x.name).sort(), ['NL', 'US']);
});

test('dashboard is served with security headers', async () => {
  const r = await req('GET', '/sites/1', { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  const t = await req('GET', '/t.js', { raw: true });
  assert.equal(t.headers.get('access-control-allow-origin'), '*');
  const body = await t.text();
  assert.ok(body.length < 6000, `tracker is ${body.length} bytes`);
});

test('delete site removes its data', async () => {
  const r = await req('DELETE', `/api/sites/${site.id}`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM hits').get().n, 0);
});
