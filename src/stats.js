// Aggregate queries for the dashboard and API.
import { localMidnight, localDateStr, parts, addDays, daysBetween } from './time.js';

// Dimensions that can be filtered on / broken down by. Keys are API names.
export const DIMENSIONS = {
  path: 'path',
  ref: 'ref',
  campaign: 'utm_campaign',
  source: 'utm_source',
  medium: 'utm_medium',
  browser: 'browser',
  os: 'os',
  device: 'device',
  screen: 'screen',
  country: 'country',
  language: 'language',
};

const SLOT = 900; // 15 minute slots so half/quarter-hour timezones bucket correctly

function buildWhere(siteId, fromS, toS, filters) {
  const clauses = ['site_id = ?', 'ts >= ?', 'ts < ?'];
  const args = [siteId, fromS, toS];
  for (const [k, col] of Object.entries(DIMENSIONS)) {
    const v = filters?.[k];
    if (v === undefined || v === null) continue;
    clauses.push(`${col} = ?`);
    args.push(String(v));
  }
  return { sql: clauses.join(' AND '), args };
}

// When a path filter is active, "visitors" means unique visitors of that path.
function visitorCol(filters) {
  return filters?.path !== undefined ? 'new_path' : 'new_visit';
}

export function resolveRange(site, from, to) {
  const tz = site.timezone || 'UTC';
  const today = localDateStr(Date.now(), tz);
  to = to || today;
  from = from || addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  const fromMs = localMidnight(from, tz);
  const toMs = localMidnight(addDays(to, 1), tz);
  return { from, to, tz, fromMs, toMs, days: daysBetween(from, to) + 1 };
}

function totals(db, site, fromMs, toMs, filters) {
  const w = buildWhere(site.id, Math.floor(fromMs / 1000), Math.floor(toMs / 1000), filters);
  const vc = visitorCol(filters);
  const r = db.prepare(`SELECT
      COALESCE(SUM(event = 0), 0) AS pageviews,
      COALESCE(SUM(CASE WHEN ${vc === 'new_path' ? 'event = 0 AND new_path' : 'new_visit'} THEN 1 ELSE 0 END), 0) AS visitors,
      COALESCE(SUM(event = 1), 0) AS events
    FROM hits WHERE ${w.sql}`).get(...w.args);
  return { pageviews: r.pageviews, visitors: r.visitors, events: r.events };
}

function timeseries(db, site, range, filters) {
  const { fromMs, toMs, tz, days } = range;
  const w = buildWhere(site.id, Math.floor(fromMs / 1000), Math.floor(toMs / 1000), filters);
  const vc = visitorCol(filters);
  const rows = db.prepare(`SELECT ts / ${SLOT} AS slot,
      SUM(event = 0) AS views,
      SUM(CASE WHEN ${vc === 'new_path' ? 'event = 0 AND new_path' : 'new_visit'} THEN 1 ELSE 0 END) AS visitors
    FROM hits WHERE ${w.sql} GROUP BY slot`).all(...w.args);

  const unit = days <= 2 ? 'hour' : days <= 400 ? 'day' : 'month';
  const keyOf = (ms) => {
    if (unit === 'day') return localDateStr(ms, tz);
    const p = parts(ms, tz);
    const ym = `${p.y}-${String(p.m).padStart(2, '0')}`;
    if (unit === 'month') return ym;
    return `${ym}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:00`;
  };

  // Build the complete list of buckets so empty periods show as zero.
  const buckets = new Map();
  if (unit === 'hour') {
    for (let t = fromMs; t < toMs; t += 3600000) buckets.set(keyOf(t), { t: keyOf(t), views: 0, visitors: 0 });
  } else {
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const k = unit === 'day' ? d : d.slice(0, 7);
      if (!buckets.has(k)) buckets.set(k, { t: k, views: 0, visitors: 0 });
    }
  }
  for (const r of rows) {
    const b = buckets.get(keyOf(Number(r.slot) * SLOT * 1000));
    if (b) { b.views += r.views; b.visitors += r.visitors; }
  }
  return { unit, points: [...buckets.values()] };
}

export function breakdown(db, site, range, filters, dim, { limit = 10, offset = 0 } = {}) {
  const w = buildWhere(site.id, Math.floor(range.fromMs / 1000), Math.floor(range.toMs / 1000), filters);
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);

  let col, extra = '', where = w.sql + ' AND event = 0', vc = visitorCol(filters);
  switch (dim) {
    case 'pages':
      col = 'path'; extra = ', MAX(title) AS title'; vc = 'new_path'; break;
    case 'events':
      col = 'path'; extra = ', MAX(title) AS title'; vc = 'new_path'; where = w.sql + ' AND event = 1'; break;
    case 'refs':
      // Drill into the referrer's paths when filtering on a referrer.
      col = filters?.ref !== undefined ? 'ref_path' : 'ref';
      where += filters?.ref !== undefined ? '' : " AND ref != ''";
      break;
    case 'campaigns': col = 'utm_campaign'; where += " AND utm_campaign != ''"; break;
    case 'browsers': col = filters?.browser !== undefined ? 'browser_ver' : 'browser'; break;
    case 'systems': col = 'os'; break;
    case 'devices': col = 'device'; break;
    case 'screens': col = 'screen'; break;
    case 'countries': col = 'country'; break;
    case 'languages': col = 'language'; break;
    default: throw new Error('unknown breakdown');
  }
  const vexpr = vc === 'new_path' ? 'SUM(new_path)' : 'SUM(new_visit)';
  const countExpr = dim === 'events' ? 'COUNT(*)' : 'COUNT(*)';
  const rows = db.prepare(`SELECT ${col} AS name, ${countExpr} AS views, ${vexpr} AS visitors ${extra}
      FROM hits WHERE ${where}
      GROUP BY ${col} ORDER BY visitors DESC, views DESC, name ASC LIMIT ? OFFSET ?`)
    .all(...w.args, lim + 1, off);
  const more = rows.length > lim;
  return { rows: rows.slice(0, lim).map((r) => ({ ...r })), more };
}

export const BREAKDOWNS = ['pages', 'refs', 'campaigns', 'events', 'browsers', 'systems', 'devices', 'screens', 'countries', 'languages'];

export function getStats(db, site, { from, to, filters = {}, limit = 10 } = {}) {
  const range = resolveRange(site, from, to);
  const len = range.toMs - range.fromMs;
  const cur = totals(db, site, range.fromMs, range.toMs, filters);
  const prev = totals(db, site, range.fromMs - len, range.fromMs, filters);
  const out = {
    site: { key: site.key, name: site.name, timezone: range.tz },
    range: { from: range.from, to: range.to, days: range.days },
    filters,
    totals: cur,
    previous: prev,
    series: timeseries(db, site, range, filters),
  };
  for (const b of BREAKDOWNS) out[b] = breakdown(db, site, range, filters, b, { limit });
  return out;
}

// Lifetime totals for a single path (or the whole site), used by counter badges.
export function counterTotal(db, site, path) {
  if (path === undefined || path === null || path === '') {
    const r = db.prepare('SELECT COALESCE(SUM(event = 0), 0) AS views, COALESCE(SUM(new_visit), 0) AS visitors FROM hits WHERE site_id = ?').get(site.id);
    return { views: r.views, visitors: r.visitors };
  }
  const r = db.prepare('SELECT COUNT(*) AS views, COALESCE(SUM(new_path), 0) AS visitors FROM hits WHERE site_id = ? AND path = ? AND event = 0').get(site.id, path);
  return { views: r.views, visitors: r.visitors };
}

export function exportRows(db, site, fromMs, toMs) {
  return db.prepare(`SELECT ts, path, title, event, ref, ref_path, utm_source, utm_medium, utm_campaign,
      browser, browser_ver, os, device, screen, country, language, new_visit, new_path
    FROM hits WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY ts`).iterate(site.id, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
}
