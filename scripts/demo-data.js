#!/usr/bin/env node
// Fill a database with ~60 days of realistic fake traffic so you can try the dashboard.
//   DB_PATH=./data/demo.db node scripts/demo-data.js
// Then: DB_PATH=./data/demo.db npm start   (log in with demo@example.com / demo-password)
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { Ingestor } from '../src/ingest.js';
import { Auth } from '../src/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.DB_PATH || join(ROOT, 'data', 'demo.db'));
const auth = new Auth(db);
if (auth.needsSetup()) auth.createUser('demo@example.com', 'demo-password');

let site = db.prepare("SELECT * FROM sites WHERE key = 'demo000000'").get();
if (!site) {
  db.prepare("INSERT INTO sites (key, name, domains, timezone, public_stats, created_at) VALUES ('demo000000', 'fieldnotes.blog', 'fieldnotes.blog', 'America/Los_Angeles', 1, ?)").run(Date.now());
  site = db.prepare("SELECT * FROM sites WHERE key = 'demo000000'").get();
}

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => { let r = rnd() * arr.reduce((a, [, w]) => a + w, 0); for (const [v, w] of arr) { if ((r -= w) <= 0) return v; } return arr[0][0]; };

const PAGES = [['/', 30], ['/posts/self-hosting-on-a-raspberry-pi', 18], ['/posts/why-i-left-google-analytics', 14], ['/posts/sqlite-is-enough', 11],
  ['/about', 6], ['/posts/notes-on-css-grid', 6], ['/now', 4], ['/posts/a-year-of-plain-text', 4], ['/uses', 3], ['/archive', 3]];
const TITLES = { '/': 'Field Notes', '/about': 'About · Field Notes', '/now': 'Now · Field Notes', '/uses': 'Uses · Field Notes', '/archive': 'Archive · Field Notes' };
const REFS = [['', 45], ['https://www.google.com/', 22], ['https://news.ycombinator.com/item?id=41234567', 8], ['https://duckduckgo.com/', 6], ['https://www.reddit.com/r/selfhosted/comments/abc/', 5],
  ['https://bsky.app/profile/someone', 4], ['https://github.com/awesome-selfhosted', 3], ['https://lobste.rs/s/xyz', 3], ['https://t.co/abc', 2], ['https://chatgpt.com/', 2]];
const UAS = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 24],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 20],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 18],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 12],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 10],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 9],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68', 7],
];
const COUNTRIES = [['US', 34], ['DE', 11], ['GB', 9], ['CA', 6], ['FR', 5], ['NL', 5], ['IN', 5], ['BR', 4], ['AU', 3], ['JP', 3], ['SE', 2], ['PL', 2]];
const LANG = { US: 'en-US', DE: 'de', GB: 'en-GB', CA: 'en-CA', FR: 'fr', NL: 'nl', IN: 'en-IN', BR: 'pt-BR', AU: 'en-AU', JP: 'ja', SE: 'sv', PL: 'pl' };

const ing = new Ingestor(db, { countryHeader: 'cf-ipcountry' });
const DAYS = 60;
const start = Date.now() - DAYS * 86400000;
let n = 0;
db.exec('BEGIN');
for (let d = 0; d <= DAYS; d++) {
  const spike = d === 41 ? 5 : d === 42 ? 2.2 : 1;
  const weekday = new Date(start + d * 86400000).getUTCDay();
  const base = (60 + d * 1.4) * (weekday === 0 || weekday === 6 ? 0.7 : 1) * spike;
  const visitors = Math.round(base * (0.8 + rnd() * 0.4));
  for (let v = 0; v < visitors; v++) {
    const ua = pick(UAS);
    const cc = pick(COUNTRIES);
    const ip = `198.51.${d % 255}.${v % 255}.${Math.floor(v / 255)}`;
    let t = start + d * 86400000 + Math.floor(rnd() * 86400000);
    if (t > Date.now()) continue;
    const ref = d === 41 && rnd() < 0.6 ? 'https://news.ycombinator.com/item?id=41234567' : pick(REFS);
    const camp = rnd() < 0.05 ? '?utm_source=newsletter&utm_medium=email&utm_campaign=october-digest' : '';
    const views = 1 + Math.floor(rnd() * rnd() * 4);
    for (let i = 0; i < views; i++) {
      const p = pick(PAGES);
      const title = TITLES[p] || p.replace('/posts/', '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) + ' · Field Notes';
      ing.record({ s: site.key, p, t: title, r: i === 0 ? ref : '', q: i === 0 ? camp : '', w: ua.includes('Mobile') ? 390 : pick([[1440, 3], [1920, 4], [1280, 2], [2560, 1]]), l: LANG[cc] },
        { ip, ua, origin: 'https://fieldnotes.blog', headers: { 'cf-ipcountry': cc }, now: t });
      n++;
      if (rnd() < 0.04) ing.record({ s: site.key, p: pick([['newsletter-signup', 3], ['outbound: github.com', 2], ['copy-code', 2]]), e: 1 }, { ip, ua, origin: 'https://fieldnotes.blog', headers: {}, now: t + 5000 });
      t += 30000 + Math.floor(rnd() * 120000);
    }
  }
}
db.exec('COMMIT');
console.log(`Inserted ~${n} pageviews into "${site.name}" (key ${site.key}).`);
console.log('Log in with demo@example.com / demo-password');
