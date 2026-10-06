'use strict';
// ===========================================================================
//  Admin authentication: passwords, sessions, two-step login, permissions
// ===========================================================================
const crypto = require('crypto');
const db = require('./db');

// ---- Permissions -----------------------------------------------------------
// The owner has everything. Staff get only what is ticked for them.
const PERMISSIONS = [
  ['orders.view',    'See orders and customer details'],
  ['orders.update',  'Update order status, courier and tracking, add notes'],
  ['orders.cancel',  'Cancel orders, record refunds, return items to stock'],
  ['orders.export',  'Export orders to Excel (CSV)'],
  ['products.edit',  'Edit products and prices, add products and photos'],
  ['stock.edit',     'Adjust stock levels'],
  ['enquiries.view', 'Read and handle contact-form enquiries'],
  ['reports.view',   'See sales figures and reports'],
  ['settings.edit',  'Change delivery fees and shop settings']
];
const PERM_KEYS = new Set(PERMISSIONS.map(p => p[0]));
const PRESETS = {
  sales:     ['orders.view', 'orders.update', 'enquiries.view'],
  warehouse: ['orders.view', 'orders.update', 'stock.edit'],
  accounts:  ['orders.view', 'orders.cancel', 'orders.export', 'reports.view'],
  manager:   PERMISSIONS.map(p => p[0])
};

function permsOf(user) {
  if (!user) return [];
  if (user.role === 'owner') return [...PERM_KEYS, 'users.manage', 'audit.view'];
  try { return (JSON.parse(user.perms || '[]') || []).filter(p => PERM_KEYS.has(p)); } catch (e) { return []; }
}
const can = (user, perm) => permsOf(user).includes(perm);

// ---- Passwords (scrypt, built into Node) -----------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, N, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, 'base64');
    crypto.scrypt(String(pw), Buffer.from(salt, 'base64'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: 128 * +N * +r * 2 }, (err, key) => {
        if (err) return resolve(false);
        resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
  });
}
function passwordProblem(pw, email) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (email && [String(email).toLowerCase(), String(email).split('@')[0].toLowerCase()].includes(pw.toLowerCase())) return 'Do not use your email as the password.';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password\d*|qwerty\w*)$/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}
function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4, 9) + '-' + out.slice(9, 14);
}

// ---- TOTP (authenticator app codes, RFC 6238) ------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString();
  return code.padStart(6, '0');
}
// Returns the matching time-step counter, or null. Allows ±1 step of clock drift.
function checkTotp(secret, code, lastUsed) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !secret) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now, now - 1, now + 1]) {
    if (lastUsed != null && c <= lastUsed) continue;       // no replaying a code already used
    const a = Buffer.from(totpAt(secret, c)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return c;
  }
  return null;
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
const otpauthUrl = (secret, email) =>
  `otpauth://totp/${encodeURIComponent('Truman Admin:' + email)}?secret=${secret}&issuer=${encodeURIComponent('Truman Admin')}&digits=6&period=30`;

// ---- Sessions --------------------------------------------------------------
const COOKIE = 'tr_admin';
const IDLE_MS = 12 * 3600e3;            // signed out after 12 hours without activity
const ABSOLUTE_MS = 7 * 24 * 3600e3;    // and after 7 days regardless
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  return req.socket.encrypted || /^https/i.test(String(req.headers['x-forwarded-proto'] || '')) ||
         /^https:/i.test(process.env.SITE_URL || '');
}
function cookieHeader(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

async function createSession(req, user, mfaOk) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen, ip, ua, mfa_ok)
                VALUES (?,?,?,?,?,?,?,?)`,
    [sha(token), user.id, now, now + IDLE_MS, now, clientIpOf(req), String(req.headers['user-agent'] || '').slice(0, 255), mfaOk ? 1 : 0]);
  return token;
}
function clientIpOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64); }

// Resolves the signed-in user for a request, or null. Slides the idle timeout.
async function sessionFrom(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const sid = sha(token);
  const s = await db.get('SELECT * FROM sessions WHERE id = ?', [sid]);
  const now = Date.now();
  if (!s || s.expires_at < now || s.created_at + ABSOLUTE_MS < now) {
    if (s) await db.run('DELETE FROM sessions WHERE id = ?', [sid]);
    return null;
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [s.user_id]);
  if (!user || !user.active) return null;
  if (now - s.last_seen > 60e3) {
    await db.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', [now, now + IDLE_MS, sid]);
  }
  return { session: s, user, sid };
}
async function destroySession(sid) { await db.run('DELETE FROM sessions WHERE id = ?', [sid]); }
async function destroyUserSessions(userId, exceptSid) {
  if (exceptSid) await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, exceptSid]);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

// ---- Audit trail -----------------------------------------------------------
async function audit(req, user, action, target, detail) {
  try {
    await db.run('INSERT INTO audit_log (at, user_id, user_email, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)',
      [Date.now(), user ? user.id : null, user ? user.email : null, action, target == null ? null : String(target).slice(0, 120),
       detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 4000), req ? clientIpOf(req) : null]);
  } catch (e) { console.error('[audit] write failed:', e.message); }
}

const nameFromEmail = e => { const n = e.split('@')[0].split(/[._-]/)[0]; return n.charAt(0).toUpperCase() + n.slice(1); };

// ---- First owner -----------------------------------------------------------
// The very first account comes from ADMIN_EMAIL + ADMIN_PASSWORD, so nobody can
// claim the dashboard by visiting it first. ADMIN_PASSWORD_RESET=yes resets the
// owner's password (and two-step login) to ADMIN_PASSWORD on the next start.
async function bootstrapOwner() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  const owners = await db.all("SELECT * FROM users WHERE role = 'owner'");
  if (!owners.length) {
    if (!email || !pw) {
      console.warn('[admin] no owner account yet — set ADMIN_EMAIL and ADMIN_PASSWORD, then restart, to create it');
      return;
    }
    await db.run(`INSERT INTO users (email, name, role, perms, pass_hash, must_change_pw, active, created_at)
                  VALUES (?,?,?,?,?,?,?,?)`, [email, process.env.ADMIN_NAME || nameFromEmail(email), 'owner', '[]', await hashPassword(pw), 1, 1, Date.now()]);
    await audit(null, null, 'owner.created', email, 'from ADMIN_EMAIL / ADMIN_PASSWORD');
    console.log(`[admin] owner account created for ${email} — sign in at /admin and choose a new password`);
    return;
  }
  if (/^(1|yes|true)$/i.test(process.env.ADMIN_PASSWORD_RESET || '') && pw) {
    const target = owners.find(o => o.email === email) || owners[0];
    await db.run(`UPDATE users SET pass_hash = ?, must_change_pw = 1, totp_enabled = 0, totp_secret = NULL,
                  failed_logins = 0, locked_until = NULL, active = 1 WHERE id = ?`, [await hashPassword(pw), target.id]);
    await destroyUserSessions(target.id);
    await audit(null, null, 'owner.password_reset', target.email, 'via ADMIN_PASSWORD_RESET');
    console.warn(`[admin] owner password for ${target.email} was reset from ADMIN_PASSWORD. ` +
                 'Remove ADMIN_PASSWORD_RESET now, or it will reset again on every restart.');
  }
}

module.exports = {
  PERMISSIONS, PRESETS, PERM_KEYS, permsOf, can,
  hashPassword, verifyPassword, passwordProblem, randomPassword,
  newTotpSecret, otpauthUrl, checkTotp, totpAt,
  COOKIE, cookieHeader, createSession, sessionFrom, destroySession, destroyUserSessions,
  audit, bootstrapOwner, clientIpOf
};
