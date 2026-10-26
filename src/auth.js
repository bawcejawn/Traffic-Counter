// Password hashing (scrypt) and cookie sessions.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_DAYS = 30;
export const COOKIE = 'tc_session';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, n, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(key, got);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export class Auth {
  constructor(db) {
    this.db = db;
    this.q = {
      count: db.prepare('SELECT COUNT(*) AS n FROM users'),
      byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      byId: db.prepare('SELECT id, email, created_at FROM users WHERE id = ?'),
      insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
      setPw: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
      insertSess: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
      sess: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'),
      delSess: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      delUserSess: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    };
  }

  needsSetup() { return this.q.count.get().n === 0; }

  createUser(email, password) {
    const r = this.q.insertUser.run(String(email).trim(), hashPassword(password), Date.now());
    return Number(r.lastInsertRowid);
  }

  login(email, password) {
    const u = this.q.byEmail.get(String(email || '').trim());
    // Always run a hash to keep timing similar for unknown emails.
    if (!u) { verifyPassword(String(password || ''), hashPassword('x')); return null; }
    if (!verifyPassword(String(password || ''), u.password_hash)) return null;
    return this.createSession(u.id);
  }

  createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    this.q.insertSess.run(sha(token), userId, Date.now() + SESSION_DAYS * 86400000);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  userFromToken(token) {
    if (!token) return null;
    const s = this.q.sess.get(sha(token));
    if (!s || s.expires_at < Date.now()) return null;
    return this.q.byId.get(s.user_id) || null;
  }

  logout(token) { if (token) this.q.delSess.run(sha(token)); }

  changePassword(userId, current, next) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !verifyPassword(current, u.password_hash)) return false;
    this.q.setPw.run(hashPassword(next), userId);
    this.q.delUserSess.run(userId);
    return true;
  }

  purge() { this.q.purge.run(Date.now()); }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
