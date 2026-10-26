#!/usr/bin/env node
// Traffic Counter command line.
//
//   traffic-counter [serve]                       start the server (default)
//   traffic-counter add-user <email> <password>   create a login
//   traffic-counter reset-password <email> <pw>   set a new password
//   traffic-counter sites                         list sites and their keys
//   traffic-counter import-goatcounter <site-key> <export.csv[.gz]>

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an "experimental" warning on every start; it is stable enough for us.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));

const { openDb } = await import('../src/db.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || join(ROOT, 'data', 'traffic.db');
const [cmd = 'serve', ...args] = process.argv.slice(2);

function die(msg) { console.error(msg); process.exit(1); }

switch (cmd) {
  case 'serve': {
    const { createApp } = await import('../src/server.js');
    const port = Number(process.env.PORT) || 8080;
    const host = process.env.HOST || '0.0.0.0';
    const { server, db } = createApp({ dbPath });
    server.listen(port, host, () => {
      console.log(`Traffic Counter listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      console.log(`Database: ${dbPath}`);
    });
    const stop = () => { server.close(); db.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    break;
  }
  case 'add-user': {
    const [email, pw] = args;
    if (!email || !pw || pw.length < 8) die('usage: add-user <email> <password (8+ chars)>');
    const { Auth } = await import('../src/auth.js');
    new Auth(openDb(dbPath)).createUser(email, pw);
    console.log(`Created user ${email}`);
    break;
  }
  case 'reset-password': {
    const [email, pw] = args;
    if (!email || !pw || pw.length < 8) die('usage: reset-password <email> <new password (8+ chars)>');
    const { hashPassword } = await import('../src/auth.js');
    const db = openDb(dbPath);
    const r = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(pw), email);
    if (!r.changes) die(`No user ${email}`);
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(email);
    console.log(`Password updated for ${email}`);
    break;
  }
  case 'sites': {
    const db = openDb(dbPath);
    for (const s of db.prepare('SELECT key, name, domains FROM sites ORDER BY name').all()) {
      console.log(`${s.key}\t${s.name}\t${s.domains || '(any domain)'}`);
    }
    break;
  }
  case 'import-goatcounter': {
    const [key, file] = args;
    if (!key || !file) die('usage: import-goatcounter <site-key> <goatcounter-export.csv[.gz]>');
    const db = openDb(dbPath);
    const site = db.prepare('SELECT * FROM sites WHERE key = ?').get(key);
    if (!site) die(`No site with key ${key} (run "sites" to list them)`);
    const { importGoatCounter } = await import('../src/import.js');
    const r = importGoatCounter(db, site, file);
    console.log(`Imported ${r.imported} hits into "${site.name}" (${r.skipped} skipped)`);
    break;
  }
  case '-h': case '--help': case 'help':
    console.log(`Traffic Counter

Usage:
  traffic-counter [serve]                         start the server
  traffic-counter add-user <email> <password>     create a login
  traffic-counter reset-password <email> <pw>     set a new password
  traffic-counter sites                           list sites and keys
  traffic-counter import-goatcounter <key> <csv>  import a GoatCounter export

Environment: PORT, HOST, DB_PATH, TRUST_PROXY, COUNTRY_HEADER, SECURE_COOKIES`);
    break;
  default:
    die(`Unknown command "${cmd}". Run with --help.`);
}
