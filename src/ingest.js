// Turns a raw tracking request into a privacy-safe row in `hits`.
import { createHash, randomBytes } from 'node:crypto';
import { isBot, parseUA, screenBucket } from './ua.js';

const MAX = { path: 512, title: 300, ref: 200, refPath: 300, utm: 100 };

const FRIENDLY_REFS = [
  [/^(www\.)?google\.[a-z.]+$/, 'Google', true],
  [/^(www\.)?bing\.com$/, 'Bing', true],
  [/^(html\.|lite\.)?duckduckgo\.com$/, 'DuckDuckGo', true],
  [/^search\.yahoo\.com$|^[a-z]+\.search\.yahoo\.com$/, 'Yahoo', true],
  [/^(www\.)?ecosia\.org$/, 'Ecosia', true],
  [/^search\.brave\.com$/, 'Brave Search', true],
  [/^(www\.)?kagi\.com$/, 'Kagi', true],
  [/^(www\.)?(chatgpt\.com|chat\.openai\.com)$/, 'ChatGPT', true],
  [/^(www\.)?perplexity\.ai$/, 'Perplexity', true],
  [/^(www\.)?claude\.ai$/, 'Claude', true],
  [/^t\.co$|^(www\.|mobile\.)?(twitter|x)\.com$/, 'X (Twitter)', false],
  [/^(l\.|lm\.|m\.|www\.)?facebook\.com$/, 'Facebook', true],
  [/^(l\.)?instagram\.com$/, 'Instagram', true],
  [/^(www\.|old\.|out\.)?reddit\.com$/, 'Reddit', false],
  [/^news\.ycombinator\.com$/, 'Hacker News', false],
  [/^(www\.)?linkedin\.com$|^lnkd\.in$/, 'LinkedIn', true],
  [/^(www\.|m\.)?youtube\.com$|^youtu\.be$/, 'YouTube', true],
  [/^(www\.)?github\.com$/, 'GitHub', false],
  [/^(www\.)?pinterest\.[a-z.]+$/, 'Pinterest', true],
  [/^(www\.)?threads\.net$/, 'Threads', true],
  [/^bsky\.app$/, 'Bluesky', false],
];

function clip(s, n) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > n ? s.slice(0, n) : s;
}

export function normalizePath(p) {
  p = String(p ?? '');
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { /* keep */ }
  }
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/').replace(/\/index\.html?$/i, '/');
  try { p = decodeURI(p); } catch { /* keep encoded */ }
  return clip(p, MAX.path) || '/';
}

// Returns { ref, refPath } or empty values for direct / internal traffic.
export function parseReferrer(raw, ownHost) {
  if (!raw) return { ref: '', refPath: '' };
  let u;
  try { u = new URL(raw); } catch { return { ref: clip(raw, MAX.ref), refPath: '' }; }
  if (u.protocol === 'android-app:') return { ref: clip(u.host, MAX.ref), refPath: '' };
  if (!/^https?:$/.test(u.protocol)) return { ref: '', refPath: '' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (ownHost && host === ownHost.toLowerCase().replace(/^www\./, '')) return { ref: '', refPath: '' };
  for (const [re, name, dropPath] of FRIENDLY_REFS) {
    if (re.test(u.hostname.toLowerCase())) {
      return { ref: name, refPath: dropPath ? '' : clip(u.pathname === '/' ? '' : u.pathname, MAX.refPath) };
    }
  }
  return { ref: clip(host, MAX.ref), refPath: clip(u.pathname === '/' ? '' : u.pathname, MAX.refPath) };
}

export function parseCampaign(query) {
  const out = { source: '', medium: '', campaign: '' };
  if (!query) return out;
  let sp;
  try { sp = new URLSearchParams(String(query).replace(/^\?/, '')); } catch { return out; }
  out.source = clip(sp.get('utm_source') || sp.get('ref') || sp.get('source') || '', MAX.utm);
  out.medium = clip(sp.get('utm_medium') || '', MAX.utm);
  out.campaign = clip(sp.get('utm_campaign') || sp.get('campaign') || '', MAX.utm);
  return out;
}

export function primaryLanguage(s) {
  const m = String(s || '').match(/^\s*([a-zA-Z]{2,3})/);
  return m ? m[1].toLowerCase() : '';
}

export function hostMatches(host, domains) {
  if (!domains) return true;
  host = (host || '').toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  return domains.split(',').map((d) => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean).some((d) => {
    if (d.startsWith('*.')) return host === d.slice(2) || host.endsWith(d.slice(1));
    return host === d;
  });
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export class Ingestor {
  constructor(db, { countryHeader = '' } = {}) {
    this.db = db;
    this.countryHeader = countryHeader.toLowerCase();
    this.saltCache = { day: '', salt: '' };
    // In-memory only: visitor hash -> last seen (ms), per site. Powers "online now".
    this.live = new Map();
    this.q = {
      site: db.prepare('SELECT * FROM sites WHERE key = ?'),
      getSalt: db.prepare('SELECT salt FROM salts WHERE day = ?'),
      putSalt: db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)'),
      seen: db.prepare('INSERT OR IGNORE INTO seen (day, site_id, visitor, path) VALUES (?, ?, ?, ?)'),
      insert: db.prepare(`INSERT INTO hits
        (site_id, ts, path, title, event, ref, ref_path, utm_source, utm_medium, utm_campaign,
         browser, browser_ver, os, device, screen, country, language, new_visit, new_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      purgeSalts: db.prepare('DELETE FROM salts WHERE day < ?'),
      purgeSeen: db.prepare('DELETE FROM seen WHERE day < ?'),
    };
  }

  salt(day) {
    if (this.saltCache.day === day) return this.saltCache.salt;
    let row = this.q.getSalt.get(day);
    if (!row) {
      this.q.putSalt.run(day, randomBytes(32).toString('hex'));
      row = this.q.getSalt.get(day);
      // A new day started: forget everything from previous days.
      this.q.purgeSalts.run(day);
      this.q.purgeSeen.run(day);
    }
    this.saltCache = { day, salt: row.salt };
    return row.salt;
  }

  liveCount(siteId, windowMs = 5 * 60000, now = Date.now()) {
    const live = this.live.get(siteId);
    if (!live) return 0;
    let n = 0;
    for (const [k, t] of live) {
      if (now - t > windowMs) live.delete(k); else n++;
    }
    return n;
  }

  /**
   * @param data  fields sent by the tracker
   * @param ctx   { ip, ua, origin, acceptLanguage, headers, now }
   * @returns {{ok: boolean, reason?: string}}
   */
  record(data, ctx) {
    const site = this.q.site.get(String(data.s || ''));
    if (!site) return { ok: false, reason: 'unknown site' };

    const ua = ctx.ua || '';
    if (Number(data.b) > 0 || isBot(ua)) return { ok: false, reason: 'bot' };

    // Prefetch / prerender requests are not real views.
    const purpose = (ctx.headers?.['sec-purpose'] || ctx.headers?.purpose || '').toLowerCase();
    if (purpose.includes('prefetch')) return { ok: false, reason: 'prefetch' };

    let originHost = '';
    try { originHost = ctx.origin ? new URL(ctx.origin).hostname : ''; } catch { /* ignore */ }
    if (site.domains && !hostMatches(originHost, site.domains)) return { ok: false, reason: 'domain not allowed' };

    const event = data.e === true || data.e === '1' || data.e === 1 || data.e === 'true' ? 1 : 0;
    const path = event ? clip(data.p, MAX.path) : normalizePath(data.p);
    if (!path) return { ok: false, reason: 'no path' };

    if (!event && site.ignore_paths) {
      for (const prefix of site.ignore_paths.split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (path.startsWith(prefix)) return { ok: false, reason: 'ignored path' };
      }
    }

    const now = ctx.now ?? Date.now();
    const day = utcDay(now);
    const visitor = createHash('sha256')
      .update(`${this.salt(day)}|${site.id}|${ctx.ip || ''}|${ua}`)
      .digest('base64url').slice(0, 22);

    let live = this.live.get(site.id);
    if (!live) this.live.set(site.id, (live = new Map()));
    live.set(visitor, now);

    const newVisit = this.q.seen.run(day, site.id, visitor, '').changes === 1 ? 1 : 0;
    const newPath = this.q.seen.run(day, site.id, visitor, (event ? 'e:' : 'p:') + path).changes === 1 ? 1 : 0;

    const camp = parseCampaign(data.q);
    let { ref, refPath } = parseReferrer(data.r, originHost);
    if (!ref && camp.source) ref = camp.source;

    const u = parseUA(ua);
    let os = u.os;
    let device = u.device;
    // iPadOS reports itself as macOS; the tracker sends touch support to fix that.
    if (os === 'macOS' && Number(data.tp) > 1) { os = 'iOS'; device = 'Tablet'; }

    const country = this.countryHeader
      ? clip(ctx.headers?.[this.countryHeader] || '', 2).toUpperCase().replace(/^(XX|T1)$/, '')
      : '';
    const language = primaryLanguage(data.l) || primaryLanguage(ctx.acceptLanguage);

    this.q.insert.run(
      site.id, Math.floor(now / 1000), path, clip(data.t, MAX.title), event,
      ref, refPath, camp.source, camp.medium, camp.campaign,
      u.browser, u.version, os, device, screenBucket(data.w), country, language,
      newVisit, newPath,
    );
    return { ok: true };
  }
}
