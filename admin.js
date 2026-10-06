'use strict';
// ===========================================================================
//  Admin API  (/api/admin/...)
//  Every route checks the signed-in user's permissions on the server; the
//  dashboard only hides buttons for convenience.
// ===========================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const shop = require('./shop');
const mail = require('./mail');
const { json, send, readJson, clientIp, limiter, clip, isEmail, int } = require('./util');

let ROOT = process.cwd();
const loginIpLimit = limiter(20, 15 * 60e3);
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3;

const httpErr = (status, message, code) => Object.assign(new Error(message), { status, code });
function need(ctx, perm) { if (!auth.can(ctx.user, perm)) throw httpErr(403, 'You do not have permission to do that.'); }
function needAny(ctx, perms) { if (!perms.some(p => auth.can(ctx.user, p))) throw httpErr(403, 'You do not have permission to do that.'); }
const actorOf = ctx => ctx.user.email;

// ---- Cairo-time helpers (reports and filters use Egyptian dates) ------------------
const TZ = 'Africa/Cairo';
const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
                                               hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function tzOffset(t) {
  const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}
function cairoStartOf(dateStr) {               // 'YYYY-MM-DD' -> epoch ms of 00:00 Cairo time
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return guess - tzOffset(guess - tzOffset(guess));
}
const cairoDate = t => { const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const cairoDateTime = t => { if (!t) return ''; const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`; };

// ---- Shapes sent to the dashboard -------------------------------------------------
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, perms: auth.permsOf(u),
           active: !!u.active, totp_enabled: !!u.totp_enabled, must_change_pw: !!u.must_change_pw,
           last_login_at: u.last_login_at, created_at: u.created_at,
           locked: !!(u.locked_until && u.locked_until > Date.now()) };
}
function orderSummary(o) {
  return { ref: o.ref, status: o.status, status_label: shop.STATUS[o.status] || o.status, created_at: o.created_at,
           paid_at: o.paid_at, total_cents: o.total_cents, refunded_cents: o.refunded_cents, currency: o.currency,
           name: `${o.first_name || ''} ${o.last_name || ''}`.trim(), phone: o.phone, email: o.email, city: o.city,
           demo: !!o.demo, amount_mismatch: !!o.amount_mismatch, items_count: o.items_count };
}

// Statuses this user may move this order to
function allowedMoves(ctx, o) {
  return Object.keys(shop.STATUS).filter(to => {
    const perm = shop.permissionFor(o.status, to);
    if (!perm || !auth.can(ctx.user, perm)) return false;
    if (to === 'refunded' && !o.paid_at) return false;
    return true;
  });
}

// ---- Order filters (shared by list and export) ----------------------------------
const STATUS_GROUPS = {
  action: ['paid', 'processing'], open: ['paid', 'processing', 'shipped'],
  unpaid: ['pending', 'awaiting_payment', 'payment_failed', 'expired'], closed: ['delivered', 'cancelled', 'refunded']
};
function orderWhere(params) {
  const where = [], vals = [];
  const st = clip(params.get('status'), 40);
  if (st && STATUS_GROUPS[st]) { where.push(`status IN (${STATUS_GROUPS[st].map(() => '?').join(',')})`); vals.push(...STATUS_GROUPS[st]); }
  else if (st && shop.STATUS[st]) { where.push('status = ?'); vals.push(st); }
  const q = clip(params.get('q'), 100);
  if (q) {
    // '!' as the LIKE escape character works the same in MySQL and SQLite
    const like = `%${q.replace(/[!%_]/g, m => '!' + m)}%`;
    where.push("(ref LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!' OR first_name LIKE ? ESCAPE '!' OR last_name LIKE ? ESCAPE '!' OR paymob_txn_id = ?)");
    vals.push(like, like, like, like, like, q);
  }
  const from = cairoStartOf(params.get('from')), to = cairoStartOf(params.get('to'));
  if (from != null) { where.push('created_at >= ?'); vals.push(from); }
  if (to != null) { where.push('created_at < ?'); vals.push(to + 86400e3); }
  if (params.get('demo') === '0') where.push('demo = 0');
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

// =================================================================================
//  Route table
// =================================================================================
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), opts, fn });
const PUBLIC = { public: true }, NONE = {};

// ---- Login / logout ----------------------------------------------------------------
route('POST', '/api/admin/login', PUBLIC, async (req, res) => {
  const ip = clientIp(req);
  if (!loginIpLimit(ip)) throw httpErr(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  const b = await readJson(req, 10e3);
  const email = clip(b.email, 200).toLowerCase(), pw = String(b.password || '');
  const u = email ? await db.get('SELECT * FROM users WHERE email = ?', [email]) : null;
  const generic = httpErr(401, 'Email or password is incorrect.');
  if (!u || !u.active) { await auth.verifyPassword(pw, 'scrypt$16384$8$1$AAAA$AAAA'); throw generic; }
  if (u.locked_until && u.locked_until > Date.now()) {
    throw httpErr(423, `This account is locked after too many wrong passwords. Try again in ${Math.ceil((u.locked_until - Date.now()) / 60e3)} minutes.`);
  }
  if (!(await auth.verifyPassword(pw, u.pass_hash))) {
    const fails = (u.failed_logins || 0) + 1;
    await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      [fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? Date.now() + LOCK_MS : null, u.id]);
    await auth.audit(req, u, 'login.failed', u.email, fails >= LOCK_AFTER ? 'account locked for 15 minutes' : `attempt ${fails}`);
    throw generic;
  }
  await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
  const token = await auth.createSession(req, u, !u.totp_enabled);
  if (!u.totp_enabled) {
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), u.id]);
    await auth.audit(req, u, 'login', u.email);
  }
  json(res, 200, { ok: true, need_totp: !!u.totp_enabled }, { 'Set-Cookie': auth.cookieHeader(req, token, 7 * 86400) });
});

const totpFails = new Map();
route('POST', '/api/admin/login/totp', { allowPartial: true }, async (req, res, ctx) => {
  const b = await readJson(req, 2e3);
  const u = ctx.user;
  const step = auth.checkTotp(u.totp_secret, b.code, u.totp_last);
  if (step == null) {
    const n = (totpFails.get(ctx.sid) || 0) + 1; totpFails.set(ctx.sid, n);
    await auth.audit(req, u, 'login.totp_failed', u.email, `attempt ${n}`);
    if (n >= 5) { totpFails.delete(ctx.sid); await auth.destroySession(ctx.sid); throw httpErr(401, 'Too many wrong codes. Sign in again.', 'signin'); }
    throw httpErr(401, 'That code is not right. Check the time on your phone and try the newest code.');
  }
  totpFails.delete(ctx.sid);
  await db.run('UPDATE users SET totp_last = ?, last_login_at = ? WHERE id = ?', [step, Date.now(), u.id]);
  await db.run('UPDATE sessions SET mfa_ok = 1 WHERE id = ?', [ctx.sid]);
  await auth.audit(req, u, 'login', u.email, 'with authenticator code');
  json(res, 200, { ok: true });
});

route('POST', '/api/admin/logout', { allowPartial: true, allowPwChange: true }, async (req, res, ctx) => {
  await auth.destroySession(ctx.sid);
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(req, '', 0) });
});

// ---- My account ----------------------------------------------------------------------
route('GET', '/api/admin/me', { allowPwChange: true }, async (req, res, ctx) => {
  const ship = await shop.shippingSettings();
  json(res, 200, {
    ok: true, user: publicUser(ctx.user),
    permissions: auth.PERMISSIONS, presets: auth.PRESETS,
    statuses: shop.STATUS,
    system: { payments_live: shop.PAYMOB_READY, mail: mail.describe().ready, db: db.dialect, currency: ship.currency,
              storage_warning: shop.storageWarning ? shop.storageWarning() : null }
  });
});

route('POST', '/api/admin/me/password', { allowPwChange: true }, async (req, res, ctx) => {
  const b = await readJson(req, 5e3);
  if (!(await auth.verifyPassword(String(b.current || ''), ctx.user.pass_hash))) throw httpErr(400, 'Your current password is not right.');
  const problem = auth.passwordProblem(b.password, ctx.user.email);
  if (problem) throw httpErr(400, problem);
  if (await auth.verifyPassword(String(b.password), ctx.user.pass_hash)) throw httpErr(400, 'Choose a password different from the current one.');
  await db.run('UPDATE users SET pass_hash = ?, must_change_pw = 0 WHERE id = ?', [await auth.hashPassword(String(b.password)), ctx.user.id]);
  await auth.destroyUserSessions(ctx.user.id, ctx.sid);
  await auth.audit(req, ctx.user, 'password.changed', ctx.user.email);
  json(res, 200, { ok: true });
});

route('POST', '/api/admin/me/totp/setup', NONE, async (req, res, ctx) => {
  if (ctx.user.totp_enabled) throw httpErr(409, 'Two-step sign-in is already on.');
  const secret = auth.newTotpSecret();
  await db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, ctx.user.id]);
  json(res, 200, { ok: true, secret, otpauth: auth.otpauthUrl(secret, ctx.user.email) });
});
route('POST', '/api/admin/me/totp/enable', NONE, async (req, res, ctx) => {
  const b = await readJson(req, 2e3);
  const u = await db.get('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  const step = auth.checkTotp(u.totp_secret, b.code, null);
  if (step == null) throw httpErr(400, 'That code is not right. Enter the 6-digit code your app shows now.');
  await db.run('UPDATE users SET totp_enabled = 1, totp_last = ? WHERE id = ?', [step, u.id]);
  await db.run('UPDATE sessions SET mfa_ok = 1 WHERE id = ?', [ctx.sid]);
  await auth.audit(req, u, 'totp.enabled', u.email);
  json(res, 200, { ok: true });
});
route('POST', '/api/admin/me/totp/disable', NONE, async (req, res, ctx) => {
  const b = await readJson(req, 5e3);
  if (!(await auth.verifyPassword(String(b.password || ''), ctx.user.pass_hash))) throw httpErr(400, 'Your password is not right.');
  await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last = NULL WHERE id = ?', [ctx.user.id]);
  await auth.audit(req, ctx.user, 'totp.disabled', ctx.user.email);
  json(res, 200, { ok: true });
});

// ---- Overview ----------------------------------------------------------------------------
async function salesBetween(from, to, includeDemo) {
  const rows = await db.all(`SELECT paid_at, total_cents, refunded_cents FROM orders
     WHERE paid_at IS NOT NULL AND paid_at >= ? AND paid_at < ? ${includeDemo ? '' : 'AND demo = 0'}`, [from, to]);
  return { orders: rows.length, revenue_cents: rows.reduce((s, r) => s + r.total_cents - r.refunded_cents, 0), rows };
}

route('GET', '/api/admin/overview', NONE, async (req, res, ctx) => {
  const out = { ok: true, demo_mode: !shop.PAYMOB_READY };
  const includeDemo = !shop.PAYMOB_READY;
  const todayStart = cairoStartOf(cairoDate(Date.now()));
  if (auth.can(ctx.user, 'orders.view')) {
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    out.status_counts = Object.fromEntries(counts.map(r => [r.status, r.n]));
    out.recent = (await db.all(`SELECT o.*, (SELECT SUM(qty) FROM order_items i WHERE i.order_id = o.id) AS items_count
       FROM orders o WHERE status IN ('paid','processing') ORDER BY paid_at LIMIT 8`)).map(orderSummary);
  }
  if (auth.can(ctx.user, 'reports.view')) {
    const now = Date.now();
    const t = await salesBetween(todayStart, now + 1, includeDemo);
    const w = await salesBetween(todayStart - 6 * 86400e3, now + 1, includeDemo);
    const m = await salesBetween(todayStart - 29 * 86400e3, now + 1, includeDemo);
    const byDay = {};
    for (let i = 29; i >= 0; i--) byDay[cairoDate(todayStart - i * 86400e3 + 3600e3 * 12)] = 0;
    for (const r of m.rows) { const d = cairoDate(r.paid_at); if (d in byDay) byDay[d] += r.total_cents - r.refunded_cents; }
    out.sales = { today: { orders: t.orders, revenue_cents: t.revenue_cents }, week: { orders: w.orders, revenue_cents: w.revenue_cents },
                  month: { orders: m.orders, revenue_cents: m.revenue_cents }, by_day: Object.entries(byDay).map(([d, c]) => ({ d, c })) };
  }
  if (auth.can(ctx.user, 'stock.edit') || auth.can(ctx.user, 'products.edit')) {
    out.low_stock = await db.all('SELECT sku, name_en, stock_qty, low_stock_at, active FROM products WHERE stock_qty IS NOT NULL AND stock_qty <= low_stock_at AND active = 1 ORDER BY stock_qty, sku LIMIT 20');
  }
  if (auth.can(ctx.user, 'enquiries.view')) {
    out.new_enquiries = (await db.get("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'")).n;
  }
  json(res, 200, out);
});

// ---- Orders ----------------------------------------------------------------------------------
route('GET', '/api/admin/orders', NONE, async (req, res, ctx, url) => {
  need(ctx, 'orders.view');
  const { sql, vals } = orderWhere(url.searchParams);
  const page = Math.max(1, int(url.searchParams.get('page'), 1)), per = 50;
  const total = (await db.get(`SELECT COUNT(*) AS n FROM orders ${sql}`, vals)).n;
  const rows = await db.all(`SELECT o.*, (SELECT SUM(qty) FROM order_items i WHERE i.order_id = o.id) AS items_count
     FROM orders o ${sql} ORDER BY created_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, vals);
  json(res, 200, { ok: true, total, page, per, orders: rows.map(orderSummary) });
});

route('GET', '/api/admin/orders/([A-Za-z0-9-]{4,40})', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'orders.view');
  const o = await shop.loadOrder(m[1], db, true);
  if (!o) throw httpErr(404, 'Order not found.');
  json(res, 200, { ok: true, order: { ...o, error: undefined, status_label: shop.STATUS[o.status] },
                   moves: allowedMoves(ctx, o), can_simulate: !!o.demo && !shop.PAYMOB_READY && shop.UNPAID.has(o.status) && ctx.user.role === 'owner' });
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/status', NONE, async (req, res, ctx, url, m) => {
  needAny(ctx, ['orders.update', 'orders.cancel']);
  const b = await readJson(req, 10e3);
  const to = clip(b.status, 24);
  if (!shop.STATUS[to]) throw httpErr(400, 'Unknown status.');
  if (b.restock && !auth.can(ctx.user, 'orders.cancel')) throw httpErr(403, 'You do not have permission to return items to stock.');
  const out = await shop.changeStatus(m[1], to, {
    actor: actorOf(ctx), courier: b.courier, tracking_no: b.tracking_no, note: b.note, notify: b.notify !== false,
    restock: !!b.restock, refund_cents: b.refund_cents == null || b.refund_cents === '' ? null : int(b.refund_cents),
    allowed: perm => auth.can(ctx.user, perm)
  });
  await auth.audit(req, ctx.user, 'order.status', m[1], { to, partial: !!out.partial, restock: !!b.restock });
  json(res, 200, { ok: true, ...out });
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/note', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'orders.update');
  const b = await readJson(req, 10e3);
  const text = clip(b.text, 2000);
  if (!text) throw httpErr(400, 'Write a note first.');
  const o = await db.get('SELECT id FROM orders WHERE ref = ?', [m[1]]);
  if (!o) throw httpErr(404, 'Order not found.');
  await shop.addEvent(db, o.id, actorOf(ctx), 'note', null, null, text);
  json(res, 200, { ok: true });
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/details', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'orders.update');
  const b = await readJson(req, 10e3);
  const o = await db.get('SELECT * FROM orders WHERE ref = ?', [m[1]]);
  if (!o) throw httpErr(404, 'Order not found.');
  const fields = { phone: 40, street: 500, city: 120, courier: 80, tracking_no: 120 };
  const changes = [];
  for (const [f, n] of Object.entries(fields)) {
    if (b[f] === undefined) continue;
    const v = clip(b[f], n) || null;
    if (v !== o[f]) { await db.run(`UPDATE orders SET ${f} = ?, updated_at = ? WHERE id = ?`, [v, Date.now(), o.id]); changes.push(`${f}: "${o[f] || ''}" → "${v || ''}"`); }
  }
  if (changes.length) {
    await shop.addEvent(db, o.id, actorOf(ctx), 'edit', null, null, 'Details changed — ' + changes.join('; '));
    await auth.audit(req, ctx.user, 'order.details', m[1], changes.join('; '));
  }
  json(res, 200, { ok: true, changed: changes.length });
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/restock', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'orders.cancel');
  const out = await shop.returnToStock(m[1], actorOf(ctx));
  await auth.audit(req, ctx.user, 'order.restock', m[1]);
  json(res, 200, out);
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/resend', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'orders.update');
  const o = await shop.loadOrder(m[1]);
  if (!o) throw httpErr(404, 'Order not found.');
  if (!o.paid_at) throw httpErr(409, 'Only paid orders have a confirmation email.');
  const sent = await mail.resendConfirmation(shop.mailShape(o));
  await shop.addEvent(db, o.id, actorOf(ctx), 'email', null, null, sent ? 'Order confirmation re-sent to customer' : 'Confirmation could not be sent (email not configured or failed)');
  json(res, 200, { ok: true, sent });
});

route('POST', '/api/admin/orders/([A-Za-z0-9-]{4,40})/simulate-payment', NONE, async (req, res, ctx, url, m) => {
  if (ctx.user.role !== 'owner') throw httpErr(403, 'Only the owner can simulate payments.');
  const out = await shop.simulatePayment(m[1], actorOf(ctx));
  await auth.audit(req, ctx.user, 'order.simulate_payment', m[1]);
  json(res, 200, out);
});

// Excel-friendly CSV (UTF-8 with BOM so Arabic opens correctly)
route('GET', '/api/admin/export/orders.csv', NONE, async (req, res, ctx, url) => {
  need(ctx, 'orders.export');
  const { sql, vals } = orderWhere(url.searchParams);
  const rows = await db.all(`SELECT * FROM orders ${sql} ORDER BY created_at DESC LIMIT 20000`, vals);
  const ids = rows.map(r => r.id);
  const items = {};
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const it of await db.all(`SELECT order_id, sku, qty FROM order_items WHERE order_id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
      (items[it.order_id] = items[it.order_id] || []).push(`${it.sku} x${it.qty}`);
    }
  }
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const money = c => (Number(c || 0) / 100).toFixed(2);
  const head = ['Order', 'Created (Cairo)', 'Status', 'Paid (Cairo)', 'First name', 'Last name', 'Email', 'Phone', 'City', 'Address',
                'Items', 'Subtotal', 'Shipping', 'Total', 'Refunded', 'Currency', 'Payment method', 'Card', 'Paymob transaction', 'Courier', 'Tracking', 'Demo'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.ref, cairoDateTime(r.created_at), shop.STATUS[r.status] || r.status, cairoDateTime(r.paid_at), r.first_name, r.last_name,
      r.email, r.phone, r.city, r.street, (items[r.id] || []).join('; '), money(r.subtotal_cents), money(r.shipping_cents),
      money(r.total_cents), money(r.refunded_cents), r.currency, r.pay_method, r.card_last4, r.paymob_txn_id, r.courier, r.tracking_no,
      r.demo ? 'yes' : ''].map(cell).join(','));
  }
  await auth.audit(req, ctx.user, 'orders.export', null, `${rows.length} rows`);
  send(res, 200, 'text/csv; charset=utf-8', '﻿' + lines.join('\r\n'), {
    'Content-Disposition': `attachment; filename="truman-orders-${cairoDate(Date.now())}.csv"`, 'Cache-Control': 'no-store' });
});

// ---- Products & stock --------------------------------------------------------------------
route('GET', '/api/admin/products', NONE, async (req, res, ctx) => {
  needAny(ctx, ['products.edit', 'stock.edit']);
  const rows = await db.all('SELECT * FROM products ORDER BY sort_order, sku');
  const sold = await db.all(`SELECT i.sku, SUM(i.qty) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.paid_at IS NOT NULL AND o.paid_at >= ? AND o.status NOT IN ('cancelled','refunded') GROUP BY i.sku`, [Date.now() - 30 * 86400e3]);
  const soldMap = Object.fromEntries(sold.map(s => [s.sku, s.n]));
  json(res, 200, { ok: true, products: rows.map(p => ({ ...p, specs: safeJson(p.specs, []), sold_30d: soldMap[p.sku] || 0 })),
                   categories: [...new Set(rows.map(r => r.category).filter(Boolean))].sort() });
});
const safeJson = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
// Product text is shown on the public site, so markup characters are never stored.
const txt = (v, n) => clip(v, n).replace(/[<>]/g, '');
const catSlug = v => clip(v, 64).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
route('POST', '/api/admin/products', NONE, async (req, res, ctx) => {
  need(ctx, 'products.edit');
  const b = await readJson(req, 50e3);
  const sku = clip(b.sku, 64);
  if (!SKU_RE.test(sku)) throw httpErr(400, 'SKU must be 2–64 letters, numbers, dots, dashes or underscores.');
  if (await db.get('SELECT sku FROM products WHERE sku = ?', [sku])) throw httpErr(409, 'A product with that SKU already exists.');
  const name = txt(b.name_en, 255);
  if (!name) throw httpErr(400, 'Give the product an English name.');
  const price = int(b.price_cents, -1);
  if (price < 0 || price > 1e10) throw httpErr(400, 'Enter a valid price.');
  const maxSort = (await db.get('SELECT MAX(sort_order) AS m FROM products')).m || 0;
  const now = Date.now();
  await db.run(`INSERT INTO products (sku, name_en, name_ar, category, price_cents, image, desc_en, desc_ar, specs, active,
                stock_qty, low_stock_at, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [sku, name, txt(b.name_ar, 255) || name, catSlug(b.category), price, 'assets/logo.png', txt(b.desc_en, 4000),
     txt(b.desc_ar, 4000), JSON.stringify(cleanSpecs(b.specs)), 0, null, 3, maxSort + 1, now, now]);
  shop.invalidateCatalog();
  await auth.audit(req, ctx.user, 'product.created', sku, { price_cents: price });
  json(res, 200, { ok: true, sku });
});
const cleanSpecs = s => (Array.isArray(s) ? s : String(s || '').split(/\r?\n|,/)).map(x => txt(x, 60)).filter(Boolean).slice(0, 12);

route('PUT', '/api/admin/products/([A-Za-z0-9._-]{2,64})', NONE, async (req, res, ctx, url, m) => {
  needAny(ctx, ['products.edit', 'stock.edit']);
  const p = await db.get('SELECT * FROM products WHERE sku = ?', [m[1]]);
  if (!p) throw httpErr(404, 'Product not found.');
  const b = await readJson(req, 50e3);
  const sets = [], vals = [], changes = {};
  const set = (col, v) => { if (v !== undefined && v !== p[col]) { sets.push(`${col} = ?`); vals.push(v); changes[col] = [p[col], v]; } };
  if (auth.can(ctx.user, 'products.edit')) {
    if (b.name_en !== undefined) { const v = txt(b.name_en, 255); if (!v) throw httpErr(400, 'The English name cannot be empty.'); set('name_en', v); }
    if (b.name_ar !== undefined) set('name_ar', txt(b.name_ar, 255));
    if (b.category !== undefined) set('category', catSlug(b.category));
    if (b.desc_en !== undefined) set('desc_en', txt(b.desc_en, 4000));
    if (b.desc_ar !== undefined) set('desc_ar', txt(b.desc_ar, 4000));
    if (b.specs !== undefined) set('specs', JSON.stringify(cleanSpecs(b.specs)));
    if (b.sort_order !== undefined) set('sort_order', int(b.sort_order, p.sort_order));
    if (b.active !== undefined) set('active', b.active ? 1 : 0);
    if (b.price_cents !== undefined) {
      const v = int(b.price_cents, -1);
      if (v < 0 || v > 1e10) throw httpErr(400, 'Enter a valid price.');
      set('price_cents', v);
    }
  } else if (['name_en', 'name_ar', 'category', 'desc_en', 'desc_ar', 'specs', 'price_cents', 'active', 'sort_order'].some(k => b[k] !== undefined)) {
    throw httpErr(403, 'You can only change stock settings.');
  }
  if (b.low_stock_at !== undefined) { need(ctx, 'stock.edit'); set('low_stock_at', Math.max(0, int(b.low_stock_at, 3))); }
  if (b.track_stock !== undefined) {
    need(ctx, 'stock.edit');
    if (!b.track_stock && p.stock_qty != null) set('stock_qty', null);
    if (b.track_stock && p.stock_qty == null) set('stock_qty', 0);
  }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now());
    await db.run(`UPDATE products SET ${sets.join(', ')} WHERE sku = ?`, [...vals, p.sku]);
    shop.invalidateCatalog();
    await auth.audit(req, ctx.user, 'product.updated', p.sku, changes);
  }
  json(res, 200, { ok: true, changed: Object.keys(changes) });
});

route('POST', '/api/admin/products/([A-Za-z0-9._-]{2,64})/stock', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'stock.edit');
  const b = await readJson(req, 5e3);
  const out = await db.tx(async q => {
    const p = await q.get('SELECT sku, stock_qty FROM products WHERE sku = ?', [m[1]]);
    if (!p) throw httpErr(404, 'Product not found.');
    const current = p.stock_qty == null ? 0 : p.stock_qty;
    const qty = int(b.qty, NaN);
    if (!Number.isFinite(qty) || Math.abs(qty) > 1e6) throw httpErr(400, 'Enter a whole number.');
    const after = b.mode === 'set' ? qty : current + qty;
    if (after < 0 && b.mode === 'set') throw httpErr(400, 'Stock cannot be set below zero.');
    const delta = after - current;
    await q.run('UPDATE products SET stock_qty = ?, updated_at = ? WHERE sku = ?', [after, Date.now(), p.sku]);
    await q.run('INSERT INTO stock_moves (at, sku, delta, qty_after, reason, actor, note) VALUES (?,?,?,?,?,?,?)',
      [Date.now(), p.sku, delta, after, b.mode === 'set' ? 'count' : 'manual', actorOf(ctx), clip(b.note, 255) || null]);
    return { sku: p.sku, before: p.stock_qty, after, delta };
  });
  shop.invalidateCatalog();
  await auth.audit(req, ctx.user, 'stock.adjusted', m[1], out);
  json(res, 200, { ok: true, ...out });
});

route('GET', '/api/admin/products/([A-Za-z0-9._-]{2,64})/moves', NONE, async (req, res, ctx, url, m) => {
  needAny(ctx, ['stock.edit', 'products.edit']);
  json(res, 200, { ok: true, moves: await db.all('SELECT * FROM stock_moves WHERE sku = ? ORDER BY at DESC, id DESC LIMIT 100', [m[1]]) });
});

route('POST', '/api/admin/products/([A-Za-z0-9._-]{2,64})/image', { bodyLimit: 4e6 }, async (req, res, ctx, url, m) => {
  need(ctx, 'products.edit');
  const p = await db.get('SELECT sku, image FROM products WHERE sku = ?', [m[1]]);
  if (!p) throw httpErr(404, 'Product not found.');
  const b = await readJson(req, 4e6);
  const mm = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
  if (!mm) throw httpErr(400, 'Upload a JPG, PNG or WebP image.');
  const buf = Buffer.from(mm[2], 'base64');
  if (buf.length > 2.5e6) throw httpErr(400, 'That image is too large (2.5 MB max).');
  const sig = buf.subarray(0, 12);
  const real = sig.subarray(0, 4).toString('latin1') === 'RIFF' && sig.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp'
             : sig[0] === 0xFF && sig[1] === 0xD8 ? 'jpg' : sig.readUInt32BE(0) === 0x89504E47 ? 'png' : null;
  if (!real) throw httpErr(400, 'That file is not a valid image.');
  // Stored in the database, so photos survive redeploys (Railway) and are included in DB backups.
  const name = `${p.sku.replace(/[^A-Za-z0-9._-]/g, '')}-${crypto.randomBytes(4).toString('hex')}.${real}`;
  await db.run('INSERT INTO images (name, mime, data, created_at) VALUES (?,?,?,?)',
    [name, real === 'jpg' ? 'image/jpeg' : 'image/' + real, buf, Date.now()]);
  const rel = `media/${name}`;
  await db.run('UPDATE products SET image = ?, updated_at = ? WHERE sku = ?', [rel, Date.now(), p.sku]);
  shop.invalidateCatalog();
  await auth.audit(req, ctx.user, 'product.image', p.sku, { from: p.image, to: rel });
  json(res, 200, { ok: true, image: rel });
});

// ---- Enquiries --------------------------------------------------------------------------------
route('GET', '/api/admin/enquiries', NONE, async (req, res, ctx, url) => {
  need(ctx, 'enquiries.view');
  const st = url.searchParams.get('status');
  const where = st === 'new' || st === 'handled' ? 'WHERE status = ?' : '';
  const rows = await db.all(`SELECT * FROM enquiries ${where} ORDER BY created_at DESC LIMIT 200`, where ? [st] : []);
  json(res, 200, { ok: true, enquiries: rows });
});
route('POST', '/api/admin/enquiries/(\\d+)', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'enquiries.view');
  const b = await readJson(req, 2e3);
  const st = b.status === 'handled' ? 'handled' : 'new';
  await db.run('UPDATE enquiries SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?',
    [st, st === 'handled' ? actorOf(ctx) : null, st === 'handled' ? Date.now() : null, int(m[1])]);
  json(res, 200, { ok: true });
});

// ---- Reports ---------------------------------------------------------------------------------
route('GET', '/api/admin/reports', NONE, async (req, res, ctx, url) => {
  need(ctx, 'reports.view');
  const to = cairoStartOf(url.searchParams.get('to')) ?? cairoStartOf(cairoDate(Date.now()));
  const from = cairoStartOf(url.searchParams.get('from')) ?? to - 29 * 86400e3;
  const end = to + 86400e3;
  const demo = shop.PAYMOB_READY ? 'AND o.demo = 0' : '';
  const paid = await db.all(`SELECT o.id, o.paid_at, o.total_cents, o.refunded_cents, o.shipping_cents, o.pay_method, o.city, o.status
     FROM orders o WHERE o.paid_at IS NOT NULL AND o.paid_at >= ? AND o.paid_at < ? ${demo}`, [from, end]);
  const byDay = {};
  for (let t = from; t < end; t += 86400e3) byDay[cairoDate(t + 12 * 3600e3)] = { orders: 0, cents: 0 };
  const byMethod = {}, byCity = {};
  let gross = 0, refunds = 0, shipping = 0;
  for (const r of paid) {
    const d = byDay[cairoDate(r.paid_at)]; if (d) { d.orders++; d.cents += r.total_cents - r.refunded_cents; }
    gross += r.total_cents; refunds += r.refunded_cents; shipping += r.shipping_cents;
    const mth = r.pay_method || 'unknown'; byMethod[mth] = (byMethod[mth] || 0) + 1;
    const c = (r.city || 'Unknown').trim() || 'Unknown'; byCity[c] = (byCity[c] || 0) + 1;
  }
  const top = await db.all(`SELECT i.sku, MAX(i.name_en) AS name, SUM(i.qty) AS qty, SUM(i.line_total_cents) AS cents
     FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.paid_at IS NOT NULL AND o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'refunded' ${demo}
     GROUP BY i.sku ORDER BY cents DESC LIMIT 15`, [from, end]);
  const created = (await db.get(`SELECT COUNT(*) AS n FROM orders o WHERE created_at >= ? AND created_at < ? ${demo}`, [from, end])).n;
  json(res, 200, { ok: true, from: cairoDate(from), to: cairoDate(to), demo_included: !shop.PAYMOB_READY,
    totals: { orders: paid.length, gross_cents: gross, refunds_cents: refunds, net_cents: gross - refunds, shipping_cents: shipping,
              average_cents: paid.length ? Math.round((gross - refunds) / paid.length) : 0, checkouts_started: created,
              conversion: created ? paid.length / created : 0 },
    by_day: Object.entries(byDay).map(([d, v]) => ({ d, ...v })),
    by_method: Object.entries(byMethod).sort((a, b) => b[1] - a[1]),
    by_city: Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 12), top_products: top });
});

// ---- Staff (owner only) -------------------------------------------------------------------
route('GET', '/api/admin/users', NONE, async (req, res, ctx) => {
  need(ctx, 'users.manage');
  json(res, 200, { ok: true, users: (await db.all('SELECT * FROM users ORDER BY role DESC, created_at')).map(publicUser) });
});
const cleanPerms = list => [...new Set((Array.isArray(list) ? list : []).filter(p => auth.PERM_KEYS.has(p)))];

route('POST', '/api/admin/users', NONE, async (req, res, ctx) => {
  need(ctx, 'users.manage');
  const b = await readJson(req, 10e3);
  const email = clip(b.email, 200).toLowerCase();
  if (!isEmail(email)) throw httpErr(400, 'Enter a valid email address.');
  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw httpErr(409, 'Someone with that email already has an account.');
  const perms = cleanPerms(b.perms);
  const temp = auth.randomPassword();
  await db.run(`INSERT INTO users (email, name, role, perms, pass_hash, must_change_pw, active, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [email, clip(b.name, 120) || email.split('@')[0], 'staff', JSON.stringify(perms), await auth.hashPassword(temp), 1, 1, Date.now()]);
  await auth.audit(req, ctx.user, 'user.created', email, { perms });
  json(res, 200, { ok: true, temp_password: temp });
});

route('PUT', '/api/admin/users/(\\d+)', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'users.manage');
  const u = await db.get('SELECT * FROM users WHERE id = ?', [int(m[1])]);
  if (!u) throw httpErr(404, 'User not found.');
  const b = await readJson(req, 10e3);
  if (u.role === 'owner' && (b.active === false || b.perms !== undefined)) throw httpErr(400, 'The owner account always has full access and cannot be disabled.');
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(clip(b.name, 120)); }
  if (b.perms !== undefined) { sets.push('perms = ?'); vals.push(JSON.stringify(cleanPerms(b.perms))); }
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (b.unlock) { sets.push('locked_until = NULL, failed_logins = 0'); }
  if (sets.length) await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, u.id]);
  if (b.active === false || b.perms !== undefined) await auth.destroyUserSessions(u.id);   // takes effect immediately
  await auth.audit(req, ctx.user, 'user.updated', u.email, b);
  json(res, 200, { ok: true });
});

route('POST', '/api/admin/users/(\\d+)/reset-password', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'users.manage');
  const u = await db.get('SELECT * FROM users WHERE id = ?', [int(m[1])]);
  if (!u) throw httpErr(404, 'User not found.');
  if (u.id === ctx.user.id) throw httpErr(400, 'Change your own password under My account.');
  const temp = auth.randomPassword();
  await db.run('UPDATE users SET pass_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', [await auth.hashPassword(temp), u.id]);
  await auth.destroyUserSessions(u.id);
  await auth.audit(req, ctx.user, 'user.password_reset', u.email);
  json(res, 200, { ok: true, temp_password: temp });
});

route('POST', '/api/admin/users/(\\d+)/reset-2fa', NONE, async (req, res, ctx, url, m) => {
  need(ctx, 'users.manage');
  const u = await db.get('SELECT * FROM users WHERE id = ?', [int(m[1])]);
  if (!u) throw httpErr(404, 'User not found.');
  await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last = NULL WHERE id = ?', [u.id]);
  await auth.destroyUserSessions(u.id);
  await auth.audit(req, ctx.user, 'user.2fa_reset', u.email);
  json(res, 200, { ok: true });
});

route('GET', '/api/admin/audit', NONE, async (req, res, ctx, url) => {
  need(ctx, 'audit.view');
  const page = Math.max(1, int(url.searchParams.get('page'), 1));
  const rows = await db.all(`SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT 100 OFFSET ${(page - 1) * 100}`);
  json(res, 200, { ok: true, page, entries: rows });
});

// ---- Settings ---------------------------------------------------------------------------------
const SETTING_KEYS = {
  shipping_flat_cents: v => Math.max(0, int(v, 0)),
  shipping_free_over_cents: v => (v === null || v === '' ? null : Math.max(0, int(v, 0))),
  unpaid_expiry_hours: v => Math.min(24 * 14, Math.max(1, int(v, 24))),
  checkout_max_qty: v => Math.min(500, Math.max(1, int(v, 20)))
};
route('GET', '/api/admin/settings', NONE, async (req, res, ctx) => {
  need(ctx, 'settings.edit');
  const out = {};
  for (const k of Object.keys(SETTING_KEYS)) out[k] = await db.getSetting(k, null);
  const m = mail.describe();
  json(res, 200, { ok: true, settings: out, system: {
    db: db.dialect, payments_live: shop.PAYMOB_READY, paymob_integrations: shop.PAYMOB.integrationIds.length,
    site_url: shop.PAYMOB.siteUrl || '(SITE_URL not set)', mail_ready: m.ready, mail_transport: m.transport, mail_host: m.host,
    mail_from: m.from, order_notify_to: m.notify, node: process.version } });
});
route('PUT', '/api/admin/settings', NONE, async (req, res, ctx) => {
  need(ctx, 'settings.edit');
  const b = await readJson(req, 5e3);
  const changed = {};
  for (const [k, fn] of Object.entries(SETTING_KEYS)) {
    if (b[k] === undefined) continue;
    const v = fn(b[k]);
    await db.setSetting(k, v); changed[k] = v;
  }
  shop.invalidateCatalog();
  await auth.audit(req, ctx.user, 'settings.updated', null, changed);
  json(res, 200, { ok: true, settings: changed });
});

route('POST', '/api/admin/test-email', NONE, async (req, res, ctx) => {
  need(ctx, 'settings.edit');
  const m = mail.describe();
  if (!m.ready) throw httpErr(409, 'Email is not set up yet. Add the SMTP settings in cPanel and restart the app.');
  try {
    await mail.sendMail({ to: [ctx.user.email], subject: 'Truman admin — test email',
      text: 'This is a test from your Truman admin dashboard. Email sending works.',
      html: '<p style="font-family:Arial,sans-serif">This is a test from your Truman admin dashboard. <strong>Email sending works.</strong></p>' });
  } catch (e) { throw httpErr(502, 'Sending failed: ' + e.message); }
  json(res, 200, { ok: true, to: ctx.user.email });
});

// =================================================================================
//  Dispatcher
// =================================================================================
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

async function handle(req, res, url) {
  const r = routes.find(rt => rt.method === req.method && rt.re.test(url.pathname));
  if (!r) return json(res, 404, { ok: false, error: 'Not found.' });
  const m = r.re.exec(url.pathname);
  try {
    if (req.method !== 'GET') {
      // CSRF: the dashboard always sends this header; other sites cannot without our permission.
      if (req.headers['x-admin'] !== '1' || !sameOrigin(req)) throw httpErr(403, 'Request blocked.');
    }
    let ctx = null;
    if (!r.opts.public) {
      ctx = await auth.sessionFrom(req);
      if (!ctx) throw httpErr(401, 'Please sign in.', 'signin');
      const partial = ctx.user.totp_enabled && !ctx.session.mfa_ok;
      if (partial && !r.opts.allowPartial) throw httpErr(401, 'Enter your authenticator code to finish signing in.', 'totp');
      if (!partial && r.opts.allowPartial && /login\/totp$/.test(url.pathname)) throw httpErr(409, 'Already signed in.');
      if (ctx.user.must_change_pw && !r.opts.allowPwChange && !r.opts.allowPartial) throw httpErr(428, 'Choose a new password to continue.', 'password');
    }
    await r.fn(req, res, ctx, url, m);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[admin]', req.method, url.pathname, e);
    if (!res.headersSent) json(res, status, { ok: false, error: status >= 500 ? 'Something went wrong on the server.' : e.message, code: e.code });
  }
}

module.exports = { handle, setRoot: r => { ROOT = r; }, cairoStartOf, cairoDate };
