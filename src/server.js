// HTTP server: tracking endpoint, counter badges, dashboard + JSON API.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { openDb } from './db.js';
import { Ingestor } from './ingest.js';
import { Auth, COOKIE, parseCookies } from './auth.js';
import { getStats, breakdown, resolveRange, counterTotal, exportRows, DIMENSIONS, BREAKDOWNS } from './stats.js';
import { badgeSvg, formatCount } from './badge.js';
import { isValidTimezone, DATE_RE } from './time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Fixed-window rate limiter keyed by an arbitrary string (usually the IP).
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }
  hit(key, now = Date.now()) {
    let e = this.map.get(key);
    if (!e || now - e.start > this.windowMs) { e = { start: now, n: 0 }; this.map.set(key, e); }
    e.n++;
    if (this.map.size > 50000) this.sweep(now);
    return e.n <= this.limit;
  }
  sweep(now = Date.now()) { for (const [k, e] of this.map) if (now - e.start > this.windowMs) this.map.delete(k); }
}

function newSiteKey() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...randomBytes(10)].map((b) => abc[b % abc.length]).join('');
}

export function createApp(opts = {}) {
  const config = {
    dbPath: opts.dbPath ?? process.env.DB_PATH ?? join(ROOT, 'data', 'traffic.db'),
    trustProxy: opts.trustProxy ?? ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY).toLowerCase()),
    countryHeader: opts.countryHeader ?? process.env.COUNTRY_HEADER ?? '',
    secureCookies: opts.secureCookies ?? process.env.SECURE_COOKIES,
  };
  const db = opts.db ?? openDb(config.dbPath);
  const ingest = new Ingestor(db, { countryHeader: config.countryHeader });
  const auth = new Auth(db);
  const hitLimiter = new RateLimiter(120, 60000);
  const loginLimiter = new RateLimiter(10, 15 * 60000);

  const static_ = new Map();
  function staticFile(name) {
    if (static_.has(name) && !opts.dev) return static_.get(name);
    const file = join(PUBLIC, name);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return null;
    const body = readFileSync(file);
    const entry = { body, type: MIME[extname(file)] || 'application/octet-stream', etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"' };
    static_.set(name, entry);
    return entry;
  }

  const q = {
    sites: db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE'),
    site: db.prepare('SELECT * FROM sites WHERE id = ?'),
    siteByKey: db.prepare('SELECT * FROM sites WHERE key = ?'),
    insertSite: db.prepare('INSERT INTO sites (key, name, domains, timezone, created_at) VALUES (?, ?, ?, ?, ?)'),
    deleteSite: db.prepare('DELETE FROM sites WHERE id = ?'),
    deleteHits: db.prepare('DELETE FROM hits WHERE site_id = ?'),
    hitCount: db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM hits WHERE site_id = ?'),
  };

  // ---------- helpers ----------
  const clientIp = (req) => {
    if (config.trustProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf).trim();
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
      const xr = req.headers['x-real-ip'];
      if (xr) return String(xr).trim();
    }
    return req.socket.remoteAddress || '';
  };

  const isHttps = (req) => config.secureCookies !== undefined
    ? ['1', 'true', 'yes', true].includes(config.secureCookies)
    : req.socket.encrypted || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function send(res, status, body, headers = {}) {
    headers = { ...headers };
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers['Content-Type'] ??= 'application/json; charset=utf-8';
    }
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body ?? '');
  }

  async function readBody(req, max = 16 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new HttpError(413, 'body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  function currentUser(req) {
    return auth.userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
  }

  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'not logged in');
    return u;
  }

  // CSRF protection for state-changing requests: JSON body + same origin.
  function checkMutation(req) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) throw new HttpError(415, 'expected application/json');
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { throw new HttpError(403, 'bad origin'); }
      if (host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
    }
  }

  function sessionCookie(req, token, maxAge) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  function parseFilters(sp) {
    const f = {};
    for (const k of Object.keys(DIMENSIONS)) if (sp.has(k)) f[k] = sp.get(k);
    return f;
  }

  function dateParam(sp, name) {
    const v = sp.get(name);
    if (!v) return undefined;
    if (!DATE_RE.test(v)) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
    return v;
  }

  function publicSite(s) {
    const c = q.hitCount.get(s.id);
    return {
      id: s.id, key: s.key, name: s.name, domains: s.domains, timezone: s.timezone,
      public_stats: !!s.public_stats, public_counter: !!s.public_counter,
      retention_days: s.retention_days, ignore_paths: s.ignore_paths,
      created_at: s.created_at, hits: c.n, first_hit: c.first,
    };
  }

  function validateSite(body, existing = {}) {
    const s = { ...existing };
    if (body.name !== undefined) {
      s.name = String(body.name).trim().slice(0, 100);
      if (!s.name) throw new HttpError(400, 'name is required');
    }
    if (body.domains !== undefined) {
      s.domains = String(body.domains).split(/[\s,]+/).map((d) => d.trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).join(',');
    }
    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) throw new HttpError(400, 'unknown timezone');
      s.timezone = body.timezone;
    }
    if (body.public_stats !== undefined) s.public_stats = body.public_stats ? 1 : 0;
    if (body.public_counter !== undefined) s.public_counter = body.public_counter ? 1 : 0;
    if (body.retention_days !== undefined) {
      const n = Number(body.retention_days);
      if (!Number.isInteger(n) || n < 0 || n > 36500) throw new HttpError(400, 'retention_days must be 0–36500');
      s.retention_days = n;
    }
    if (body.ignore_paths !== undefined) {
      s.ignore_paths = String(body.ignore_paths).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 100).join('\n');
    }
    return s;
  }

  function statsResponse(site, sp) {
    return getStats(db, site, {
      from: dateParam(sp, 'from'), to: dateParam(sp, 'to'),
      filters: parseFilters(sp), limit: Number(sp.get('limit')) || 10,
    });
  }

  function breakdownResponse(site, dim, sp) {
    if (!BREAKDOWNS.includes(dim)) throw new HttpError(404, 'unknown breakdown');
    const range = resolveRange(site, dateParam(sp, 'from'), dateParam(sp, 'to'));
    return breakdown(db, site, range, parseFilters(sp), dim, { limit: sp.get('limit') || 50, offset: sp.get('offset') || 0 });
  }

  // ---------- tracking ----------
  function track(req, data) {
    const ip = clientIp(req);
    if (!hitLimiter.hit(ip)) return { ok: false, reason: 'rate limited' };
    return ingest.record(data, {
      ip,
      ua: String(req.headers['user-agent'] || ''),
      origin: req.headers.origin || req.headers.referer || '',
      acceptLanguage: req.headers['accept-language'],
      headers: req.headers,
    });
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };

  // ---------- routes ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const sp = url.searchParams;
    const method = req.method;
    let m;

    if (method === 'OPTIONS' && (path === '/api/hit' || path.startsWith('/counter/'))) return send(res, 204, null, CORS);

    // Tracking: beacon/fetch POST (text/plain JSON avoids CORS preflight) or pixel GET.
    if (path === '/api/hit' && method === 'POST') {
      let data;
      try { data = JSON.parse(await readBody(req, 8192)); } catch { return send(res, 400, null, CORS); }
      const r = track(req, data || {});
      return send(res, 204, null, { ...CORS, 'X-TC-Result': r.ok ? 'counted' : r.reason, 'Cache-Control': 'no-store' });
    }
    if ((path === '/api/hit.gif' || path === '/count') && method === 'GET') {
      const r = track(req, Object.fromEntries(sp));
      return send(res, 200, GIF, { ...CORS, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'X-TC-Result': r.ok ? 'counted' : r.reason });
    }

    // Visitor counter badges: /counter/<key>.svg  /counter/<key>.json
    if ((m = path.match(/^\/counter\/([a-z0-9]+)\.(svg|json)$/)) && method === 'GET') {
      const site = q.siteByKey.get(m[1]);
      if (!site || !site.public_counter) return send(res, 404, m[2] === 'json' ? { error: 'not found' } : 'not found', CORS);
      const p = sp.has('path') ? (sp.get('path') === '' ? '' : sp.get('path')) : '';
      const t = counterTotal(db, site, p);
      const metric = sp.get('metric') === 'visitors' ? 'visitors' : 'views';
      const headers = { ...CORS, 'Cache-Control': 'public, max-age=60' };
      if (m[2] === 'json') return send(res, 200, { path: p || null, views: t.views, visitors: t.visitors }, headers);
      const svg = badgeSvg({
        label: sp.has('label') ? sp.get('label') : (metric === 'visitors' ? 'visitors' : 'views'),
        value: formatCount(t[metric], sp.get('compact') === '1'),
        color: sp.get('color') || 'teal', labelColor: sp.get('labelColor') || '#555', style: sp.get('style') || 'flat',
      });
      return send(res, 200, svg, { ...headers, 'Content-Type': 'image/svg+xml; charset=utf-8' });
    }

    if (path === '/healthz') return send(res, 200, { ok: true, version: VERSION });

    // ---------- public share API ----------
    if ((m = path.match(/^\/api\/public\/([a-z0-9]+)\/(stats|breakdown\/(\w+)|live)$/)) && method === 'GET') {
      const site = q.siteByKey.get(m[1]);
      if (!site || !site.public_stats) throw new HttpError(404, 'not found');
      if (m[2] === 'stats') return send(res, 200, statsResponse(site, sp));
      if (m[2] === 'live') return send(res, 200, { online: ingest.liveCount(site.id) });
      return send(res, 200, breakdownResponse(site, m[3], sp));
    }

    // ---------- auth ----------
    if (path === '/api/me' && method === 'GET') {
      const u = currentUser(req);
      return send(res, 200, { setup: auth.needsSetup(), user: u, version: VERSION });
    }
    if (path === '/api/setup' && method === 'POST') {
      checkMutation(req);
      if (!auth.needsSetup()) throw new HttpError(403, 'already set up');
      const b = await readJson(req);
      const email = String(b.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'enter a valid email');
      if (String(b.password || '').length < 8) throw new HttpError(400, 'password must be at least 8 characters');
      const id = auth.createUser(email, b.password);
      const s = auth.createSession(id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }
    if (path === '/api/login' && method === 'POST') {
      checkMutation(req);
      if (!loginLimiter.hit(clientIp(req))) throw new HttpError(429, 'too many attempts, try again later');
      const b = await readJson(req);
      const s = auth.login(b.email, b.password);
      if (!s) throw new HttpError(401, 'wrong email or password');
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }
    if (path === '/api/logout' && method === 'POST') {
      checkMutation(req);
      auth.logout(parseCookies(req.headers.cookie)[COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (path === '/api/password' && method === 'POST') {
      checkMutation(req);
      const u = requireUser(req);
      const b = await readJson(req);
      if (String(b.next || '').length < 8) throw new HttpError(400, 'new password must be at least 8 characters');
      if (!auth.changePassword(u.id, String(b.current || ''), String(b.next))) throw new HttpError(400, 'current password is wrong');
      const s = auth.createSession(u.id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }

    // ---------- sites ----------
    if (path === '/api/sites' && method === 'GET') {
      requireUser(req);
      return send(res, 200, q.sites.all().map(publicSite));
    }
    if (path === '/api/sites' && method === 'POST') {
      checkMutation(req);
      requireUser(req);
      const s = validateSite(await readJson(req), { domains: '', timezone: 'UTC' });
      if (!s.name) throw new HttpError(400, 'name is required');
      const r = q.insertSite.run(newSiteKey(), s.name, s.domains, s.timezone, Date.now());
      return send(res, 201, publicSite(q.site.get(r.lastInsertRowid)));
    }
    if ((m = path.match(/^\/api\/sites\/(\d+)(?:\/(.*))?$/))) {
      const site = q.site.get(Number(m[1]));
      const sub = m[2] || '';
      if (method !== 'GET') checkMutation(req);
      requireUser(req);
      if (!site) throw new HttpError(404, 'site not found');

      if (sub === '' && method === 'PATCH') {
        const s = validateSite(await readJson(req), site);
        db.prepare(`UPDATE sites SET name=?, domains=?, timezone=?, public_stats=?, public_counter=?, retention_days=?, ignore_paths=? WHERE id=?`)
          .run(s.name, s.domains, s.timezone, s.public_stats, s.public_counter, s.retention_days, s.ignore_paths, site.id);
        return send(res, 200, publicSite(q.site.get(site.id)));
      }
      if (sub === '' && method === 'DELETE') {
        q.deleteHits.run(site.id);
        q.deleteSite.run(site.id);
        return send(res, 200, { ok: true });
      }
      if (sub === '' && method === 'GET') return send(res, 200, publicSite(site));
      if (sub === 'stats' && method === 'GET') return send(res, 200, statsResponse(site, sp));
      if (sub === 'live' && method === 'GET') return send(res, 200, { online: ingest.liveCount(site.id) });
      if ((m = sub.match(/^breakdown\/(\w+)$/)) && method === 'GET') return send(res, 200, breakdownResponse(site, m[1], sp));
      if (sub === 'export.csv' && method === 'GET') return exportCsv(res, site, sp);
      if (sub === 'reset' && method === 'POST') { q.deleteHits.run(site.id); return send(res, 200, { ok: true }); }
      throw new HttpError(404, 'not found');
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'not found');

    // ---------- static / app ----------
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    let name = path === '/' || path.startsWith('/share/') || path.startsWith('/sites/') || path === '/settings' ? 'index.html' : path.slice(1);
    if (name === 'tracker.js' || name === 'count.js') name = 't.js';
    if (name.includes('..')) throw new HttpError(404, 'not found');
    const f = staticFile(name);
    if (!f) throw new HttpError(404, 'not found');
    if (req.headers['if-none-match'] === f.etag) return send(res, 304, null);
    const headers = { 'Content-Type': f.type, ETag: f.etag };
    if (name === 't.js') Object.assign(headers, CORS, { 'Cache-Control': 'public, max-age=86400' });
    else if (name === 'index.html') Object.assign(headers, {
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    else headers['Cache-Control'] = 'public, max-age=3600';
    return send(res, 200, method === 'HEAD' ? null : f.body, headers);
  }

  function exportCsv(res, site, sp) {
    const range = resolveRange(site, dateParam(sp, 'from') || '1970-01-01', dateParam(sp, 'to'));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${site.key}-${range.from}-${range.to}.csv"`,
    });
    const cols = ['time', 'path', 'title', 'event', 'ref', 'ref_path', 'utm_source', 'utm_medium', 'utm_campaign',
      'browser', 'browser_ver', 'os', 'device', 'screen', 'country', 'language', 'new_visit', 'new_path'];
    const cell = (v) => {
      const s = String(v ?? '');
      // Neutralise spreadsheet formula injection.
      const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    res.write(cols.join(',') + '\n');
    for (const r of exportRows(db, site, range.fromMs, range.toMs)) {
      res.write([new Date(r.ts * 1000).toISOString(), r.path, r.title, r.event, r.ref, r.ref_path, r.utm_source, r.utm_medium,
        r.utm_campaign, r.browser, r.browser_ver, r.os, r.device, r.screen, r.country, r.language, r.new_visit, r.new_path].map(cell).join(',') + '\n');
    }
    res.end();
  }

  // ---------- background maintenance ----------
  function maintenance() {
    auth.purge();
    hitLimiter.sweep();
    loginLimiter.sweep();
    const now = Math.floor(Date.now() / 1000);
    for (const s of q.sites.all()) {
      if (s.retention_days > 0) db.prepare('DELETE FROM hits WHERE site_id = ? AND ts < ?').run(s.id, now - s.retention_days * 86400);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : err.message });
      else res.end();
    });
  });

  let timer;
  server.on('listening', () => { maintenance(); timer = setInterval(maintenance, 3600000); timer.unref(); });
  server.on('close', () => clearInterval(timer));

  return { server, db, ingest, auth, config };
}
