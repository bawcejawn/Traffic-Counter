// Import a GoatCounter CSV export (v2 format) into a site.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseReferrer, normalizePath, primaryLanguage } from './ingest.js';
import { screenBucket } from './ua.js';
import { tx } from './db.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const OS_MAP = [[/^mac|os x/i, 'macOS'], [/^ios|iphone|ipad/i, 'iOS'], [/^android/i, 'Android'], [/^windows/i, 'Windows'],
  [/^chrome ?os/i, 'ChromeOS'], [/linux|ubuntu|fedora|debian/i, 'Linux']];

export function importGoatCounter(db, site, file) {
  let buf = readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const rows = parseCsv(buf.toString('utf8'));
  const header = rows.shift() || [];
  if (!/^\d*path$/i.test(header[0] || '')) throw new Error('This does not look like a GoatCounter CSV export (first column should be "2Path").');
  const idx = Object.fromEntries(header.map((h, i) => [h.replace(/^\d+/, '').toLowerCase(), i]));
  const col = (r, name) => r[idx[name]] ?? '';

  const ins = db.prepare(`INSERT INTO hits (site_id, ts, path, title, event, ref, ref_path, utm_source, browser, browser_ver,
    os, device, screen, country, language, new_visit, new_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let imported = 0, skipped = 0;
  tx(db, () => {
    for (const r of rows) {
      if (r.length < 5) { skipped++; continue; }
      if (Number(col(r, 'bot')) > 0) { skipped++; continue; }
      const ts = Date.parse(col(r, 'date'));
      if (!Number.isFinite(ts)) { skipped++; continue; }
      const event = /^(true|1)$/i.test(col(r, 'event')) ? 1 : 0;
      const path = event ? col(r, 'path').slice(0, 512) : normalizePath(col(r, 'path'));

      const [bName, bVer = ''] = (col(r, 'browser') || '').split(/\s+(?=\d)/);
      const sys = col(r, 'system') || '';
      let os = 'Other';
      for (const [re, name] of OS_MAP) if (re.test(sys)) { os = name; break; }

      const width = Number((col(r, 'screen size') || '').split(',')[0]) || 0;
      const device = width && width < 576 ? 'Mobile' : width && width < 992 ? 'Tablet' : 'Desktop';

      let ref = '', refPath = '', source = '';
      const rawRef = col(r, 'referrer');
      const scheme = col(r, 'referrer scheme');
      if (rawRef) {
        if (scheme === 'c' || scheme === 'g' || scheme === 'o') { ref = rawRef.slice(0, 200); if (scheme === 'c') source = ref; }
        else ({ ref, refPath } = parseReferrer(/^https?:/.test(rawRef) ? rawRef : 'https://' + rawRef, ''));
      }
      const first = /^(true|1)$/i.test(col(r, 'firstvisit')) ? 1 : 0;

      ins.run(site.id, Math.floor(ts / 1000), path, col(r, 'title').slice(0, 300), event, ref, refPath, source,
        bName || 'Other', (bVer.match(/^\d+/) || [''])[0], os, device, screenBucket(width),
        (col(r, 'location') || '').slice(0, 2).toUpperCase(), primaryLanguage(''), first, first);
      imported++;
    }
  });
  return { imported, skipped };
}
