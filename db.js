'use strict';
// ===========================================================================
//  Database layer — MySQL/MariaDB (production) or SQLite (fallback/testing)
//
//  MySQL is used when DB_NAME is set (cPanel → MySQL® Databases):
//      DB_HOST=localhost  DB_PORT=3306  DB_NAME=…  DB_USER=…  DB_PASS=…
//  or on Railway when the MySQL service's MYSQL* variables / DATABASE_URL are present.
//  Otherwise SQLite built into Node 22.13+ is used, stored in DATA_DIR/truman.db.
//
//  All queries in the app are written in the SQL both engines understand:
//  "?" placeholders, no upserts, times stored as epoch milliseconds, JSON as text.
//  Only the table definitions differ, and those are generated below.
// ===========================================================================
const fs = require('fs');
const path = require('path');

let adapter = null;

// ---------------------------------------------------------------------------
// Adapters: each exposes all/get/run/exec/tx and `dialect`.
// ---------------------------------------------------------------------------
async function mysqlAdapter(cfg) {
  let mysql;
  try { mysql = require('mysql2/promise'); }
  catch (e) {
    throw new Error('DB_NAME is set but the mysql2 package is not installed. ' +
                    'In cPanel → Setup Node.js App, click "Run NPM Install", then restart.');
  }
  const pool = mysql.createPool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    connectionLimit: 5, waitForConnections: true, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true, dateStrings: true,
    timezone: 'Z', enableKeepAlive: true
  });
  const wrap = (q) => ({
    dialect: 'mysql',
    async all(sql, params = []) { const [rows] = await q.query(sql, norm(params)); return rows; },
    async get(sql, params = []) { const [rows] = await q.query(sql, norm(params)); return rows[0] || null; },
    async run(sql, params = []) {
      const [r] = await q.query(sql, norm(params));
      return { changes: r.affectedRows, insertId: Number(r.insertId) || null };
    },
    async exec(sql) { await q.query(sql); }
  });
  const base = wrap(pool);
  base.tx = async (fn) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(wrap(conn));
      await conn.commit();
      return out;
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    } finally { conn.release(); }
  };
  base.close = () => pool.end();
  await base.get('SELECT 1 AS ok');                 // fail fast with a clear error
  return base;
}

function sqliteAdapter(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    throw new Error('No database configured. Set DB_NAME / DB_USER / DB_PASS for MySQL ' +
                    '(recommended on cPanel), or use Node.js 22.13 or newer for the built-in SQLite.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');

  // One connection, so every call is serialised through a lock; a transaction
  // holds the lock until it commits, so nothing else can slip into it.
  let chain = Promise.resolve();
  const locked = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const direct = {
    dialect: 'sqlite',
    async all(sql, params = []) { return db.prepare(sql).all(...norm(params)).map(plain); },
    async get(sql, params = []) { const r = db.prepare(sql).get(...norm(params)); return r ? plain(r) : null; },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes), insertId: Number(r.lastInsertRowid) || null };
    },
    async exec(sql) { db.exec(sql); }
  };
  const base = {
    dialect: 'sqlite',
    all: (s, p) => locked(() => direct.all(s, p)),
    get: (s, p) => locked(() => direct.get(s, p)),
    run: (s, p) => locked(() => direct.run(s, p)),
    exec: (s) => locked(() => direct.exec(s)),
    tx: (fn) => locked(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const out = await fn(direct); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    }),
    close: () => db.close()
  };
  return base;
}

function norm(params) {
  return params.map(v => v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
}
function plain(row) {                       // node:sqlite rows have a null prototype
  const o = {};
  for (const k in row) {
    const v = row[k];
    o[k] = typeof v === 'bigint' ? Number(v) : (v instanceof Uint8Array && !Buffer.isBuffer(v)) ? Buffer.from(v) : v;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Schema — one neutral definition, rendered per engine.
//   id      auto-increment primary key
//   s(n)    short string (indexable)   t  long text   i  integer   b  big integer
// ---------------------------------------------------------------------------
const TABLES = [
  { name: 'settings', cols: [['k', 's64', 'PRIMARY KEY'], ['v', 't']] },

  { name: 'products', cols: [
      ['sku', 's64', 'PRIMARY KEY'], ['name_en', 's255'], ['name_ar', 's255'], ['category', 's64'],
      ['price_cents', 'i', 'NOT NULL DEFAULT 0'], ['image', 's255'], ['desc_en', 't'], ['desc_ar', 't'],
      ['specs', 't'], ['active', 'i', 'NOT NULL DEFAULT 1'], ['stock_qty', 'i'],
      ['low_stock_at', 'i', 'NOT NULL DEFAULT 3'], ['sort_order', 'i', 'NOT NULL DEFAULT 0'],
      ['created_at', 'b'], ['updated_at', 'b']],
    indexes: [['idx_products_cat', 'category']] },

  { name: 'orders', cols: [
      ['id', 'id'], ['ref', 's40', 'NOT NULL'], ['status', 's24', 'NOT NULL'], ['lang', 's4'], ['currency', 's8'],
      ['created_at', 'b', 'NOT NULL'], ['updated_at', 'b'], ['paid_at', 'b'],
      ['subtotal_cents', 'i', 'NOT NULL DEFAULT 0'], ['shipping_cents', 'i', 'NOT NULL DEFAULT 0'],
      ['total_cents', 'i', 'NOT NULL DEFAULT 0'],
      ['first_name', 's120'], ['last_name', 's120'], ['email', 's200'], ['phone', 's40'],
      ['street', 's500'], ['city', 's120'],
      ['paymob_intention_id', 's80'], ['paymob_order_id', 's80'], ['paymob_txn_id', 's80'],
      ['pay_method', 's40'], ['card_last4', 's12'], ['paid_amount_cents', 'i'],
      ['amount_mismatch', 'i', 'NOT NULL DEFAULT 0'], ['refunded_cents', 'i', 'NOT NULL DEFAULT 0'],
      ['demo', 'i', 'NOT NULL DEFAULT 0'], ['stock_applied', 'i', 'NOT NULL DEFAULT 0'],
      ['courier', 's80'], ['tracking_no', 's120'], ['error', 't']],
    unique: [['uq_orders_ref', 'ref']],
    indexes: [['idx_orders_status', 'status, created_at'], ['idx_orders_created', 'created_at'],
              ['idx_orders_pmorder', 'paymob_order_id'], ['idx_orders_email', 'email'], ['idx_orders_phone', 'phone']] },

  { name: 'order_items', cols: [
      ['id', 'id'], ['order_id', 'b', 'NOT NULL'], ['sku', 's64'], ['name_en', 's255'], ['name_ar', 's255'],
      ['qty', 'i', 'NOT NULL'], ['unit_price_cents', 'i', 'NOT NULL'], ['line_total_cents', 'i', 'NOT NULL']],
    indexes: [['idx_items_order', 'order_id'], ['idx_items_sku', 'sku']] },

  { name: 'order_events', cols: [
      ['id', 'id'], ['order_id', 'b', 'NOT NULL'], ['at', 'b', 'NOT NULL'], ['actor', 's200'],
      ['type', 's32'], ['from_status', 's24'], ['to_status', 's24'], ['message', 't']],
    indexes: [['idx_events_order', 'order_id']] },

  { name: 'users', cols: [
      ['id', 'id'], ['email', 's200', 'NOT NULL'], ['name', 's120'], ['role', 's16', 'NOT NULL'],
      ['perms', 't'], ['pass_hash', 's255'], ['must_change_pw', 'i', 'NOT NULL DEFAULT 0'],
      ['totp_secret', 's64'], ['totp_enabled', 'i', 'NOT NULL DEFAULT 0'], ['totp_last', 'b'],
      ['active', 'i', 'NOT NULL DEFAULT 1'], ['failed_logins', 'i', 'NOT NULL DEFAULT 0'],
      ['locked_until', 'b'], ['last_login_at', 'b'], ['created_at', 'b']],
    unique: [['uq_users_email', 'email']] },

  { name: 'sessions', cols: [
      ['id', 's64', 'PRIMARY KEY'], ['user_id', 'b', 'NOT NULL'], ['created_at', 'b'], ['expires_at', 'b'],
      ['last_seen', 'b'], ['ip', 's64'], ['ua', 's255'], ['mfa_ok', 'i', 'NOT NULL DEFAULT 0']],
    indexes: [['idx_sessions_user', 'user_id']] },

  { name: 'enquiries', cols: [
      ['id', 'id'], ['created_at', 'b', 'NOT NULL'], ['name', 's120'], ['email', 's200'], ['topic', 's80'],
      ['message', 't'], ['status', 's16', "NOT NULL DEFAULT 'new'"], ['handled_by', 's200'],
      ['handled_at', 'b'], ['delivered', 'i', 'NOT NULL DEFAULT 0'], ['ip', 's64']],
    indexes: [['idx_enq_status', 'status, created_at']] },

  { name: 'stock_moves', cols: [
      ['id', 'id'], ['at', 'b', 'NOT NULL'], ['sku', 's64', 'NOT NULL'], ['delta', 'i', 'NOT NULL'],
      ['qty_after', 'i'], ['reason', 's40'], ['order_ref', 's40'], ['actor', 's200'], ['note', 's255']],
    indexes: [['idx_moves_sku', 'sku, at']] },

  { name: 'images', cols: [
      ['name', 's120', 'PRIMARY KEY'], ['mime', 's40', 'NOT NULL'], ['data', 'blob', 'NOT NULL'], ['created_at', 'b']] },

  { name: 'audit_log', cols: [
      ['id', 'id'], ['at', 'b', 'NOT NULL'], ['user_id', 'b'], ['user_email', 's200'], ['action', 's64'],
      ['target', 's120'], ['detail', 't'], ['ip', 's64']],
    indexes: [['idx_audit_at', 'at']] }
];

function colType(t, dialect) {
  const my = dialect === 'mysql';
  if (t === 'id') return my ? 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  if (t === 't')  return my ? 'MEDIUMTEXT' : 'TEXT';
  if (t === 'blob') return my ? 'MEDIUMBLOB' : 'BLOB';
  if (t === 'i')  return my ? 'INT' : 'INTEGER';
  if (t === 'b')  return my ? 'BIGINT' : 'INTEGER';
  if (t[0] === 's') return my ? `VARCHAR(${t.slice(1)})` : 'TEXT';
  throw new Error('bad type ' + t);
}

function createStatements(dialect) {
  const out = [];
  for (const tb of TABLES) {
    const lines = tb.cols.map(([n, t, extra]) => `  ${n} ${colType(t, dialect)}${extra ? ' ' + extra : ''}`);
    if (dialect === 'mysql') {
      for (const [n, c] of tb.unique || []) lines.push(`  UNIQUE KEY ${n} (${c})`);
      for (const [n, c] of tb.indexes || []) lines.push(`  KEY ${n} (${c})`);
      out.push(`CREATE TABLE IF NOT EXISTS ${tb.name} (\n${lines.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    } else {
      out.push(`CREATE TABLE IF NOT EXISTS ${tb.name} (\n${lines.join(',\n')}\n)`);
      for (const [n, c] of tb.unique || []) out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${n} ON ${tb.name} (${c})`);
      for (const [n, c] of tb.indexes || []) out.push(`CREATE INDEX IF NOT EXISTS ${n} ON ${tb.name} (${c})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings helpers (key/value, JSON-encoded)
// ---------------------------------------------------------------------------
async function getSetting(k, dflt = null) {
  const r = await adapter.get('SELECT v FROM settings WHERE k = ?', [k]);
  if (!r) return dflt;
  try { return JSON.parse(r.v); } catch (e) { return dflt; }
}
async function setSetting(k, v, q = adapter) {
  const val = JSON.stringify(v);
  const r = await q.run('UPDATE settings SET v = ? WHERE k = ?', [val, k]);
  if (!r.changes) {
    const exists = await q.get('SELECT k FROM settings WHERE k = ?', [k]);   // MySQL reports 0 changes when unchanged
    if (!exists) await q.run('INSERT INTO settings (k, v) VALUES (?, ?)', [k, val]);
  }
}

// ---------------------------------------------------------------------------
// First-run imports: catalog.json → products, old data/orders.json → orders
// ---------------------------------------------------------------------------
async function seed(root, dataDir) {
  const now = Date.now();
  const nProducts = (await adapter.get('SELECT COUNT(*) AS n FROM products')).n;
  const catFile = path.join(root, 'catalog.json');
  if (!nProducts && fs.existsSync(catFile)) {
    const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
    await adapter.tx(async q => {
      let i = 0;
      for (const p of cat.products || []) {
        await q.run(`INSERT INTO products (sku, name_en, name_ar, category, price_cents, image, desc_en, desc_ar,
                       specs, active, stock_qty, low_stock_at, sort_order, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.sku, p.name_en, p.name_ar || p.name_en, p.category, p.price_cents | 0, p.image || '',
           p.desc_en || '', p.desc_ar || '', JSON.stringify(p.specs || []), p.in_stock === false ? 0 : 1,
           null, 3, i++, now, now]);
      }
      if (cat.shipping) {
        await setSetting('shipping_flat_cents', cat.shipping.flat_rate_cents | 0, q);
        await setSetting('shipping_free_over_cents', cat.shipping.free_over_cents == null ? null : cat.shipping.free_over_cents | 0, q);
      }
      await setSetting('currency', cat.currency || 'EGP', q);
    });
    console.log(`[db] imported ${(cat.products || []).length} products from catalog.json`);
  }

  if (!(await getSetting('legacy_orders_imported', false))) {
    const legacy = [path.join(dataDir, 'orders.json'), path.join(root, 'orders.json')].find(f => fs.existsSync(f));
    let n = 0;
    if (legacy) {
      let old = {};
      try { old = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch (e) { console.error('[db] could not read', legacy, e.message); }
      await adapter.tx(async q => {
        for (const o of Object.values(old)) {
          if (!o || !o.ref) continue;
          if (await q.get('SELECT id FROM orders WHERE ref = ?', [o.ref])) continue;
          const b = o.billing || {}, pm = o.paymob || {};
          const t = Date.parse(o.created_at) || now;
          const status = o.status === 'pending' ? 'awaiting_payment' : (o.status || 'awaiting_payment');
          const r = await q.run(`INSERT INTO orders (ref, status, lang, currency, created_at, updated_at, paid_at,
              subtotal_cents, shipping_cents, total_cents, first_name, last_name, email, phone, street, city,
              paymob_intention_id, paymob_order_id, paymob_txn_id, pay_method, card_last4, paid_amount_cents,
              amount_mismatch, demo, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [o.ref, status, o.lang || 'en', o.currency || 'EGP', t, t, o.paid_at ? Date.parse(o.paid_at) : null,
             o.subtotal_cents | 0, o.shipping_cents | 0, o.total_cents | 0, b.first_name, b.last_name, b.email, b.phone,
             b.street, b.city, pm.intention_id != null ? String(pm.intention_id) : null,
             pm.order_id != null ? String(pm.order_id) : null, pm.transaction_id != null ? String(pm.transaction_id) : null,
             pm.method, pm.card_last4, pm.amount_cents, o.amount_mismatch ? 1 : 0, o.demo ? 1 : 0,
             o.error ? JSON.stringify(o.error).slice(0, 2000) : null]);
          for (const l of o.lines || []) {
            await q.run(`INSERT INTO order_items (order_id, sku, name_en, name_ar, qty, unit_price_cents, line_total_cents)
                         VALUES (?,?,?,?,?,?,?)`, [r.insertId, l.sku, l.name, l.name_ar || l.name, l.qty, l.unit_price_cents, l.line_total_cents]);
          }
          await q.run('INSERT INTO order_events (order_id, at, actor, type, to_status, message) VALUES (?,?,?,?,?,?)',
            [r.insertId, now, 'system', 'import', status, 'Imported from the old orders.json file']);
          n++;
        }
        await setSetting('legacy_orders_imported', true, q);
      });
      try { fs.renameSync(legacy, legacy + '.imported'); } catch (e) {}
      console.log(`[db] imported ${n} order(s) from ${legacy}`);
    } else {
      await setSetting('legacy_orders_imported', true);
    }
  }

  // sensible defaults for settings the admin can change
  const defaults = { shipping_flat_cents: 15000, shipping_free_over_cents: null, currency: 'EGP',
                     unpaid_expiry_hours: 24, checkout_max_qty: 20 };
  for (const [k, v] of Object.entries(defaults)) {
    if ((await adapter.get('SELECT k FROM settings WHERE k = ?', [k])) == null) await setSetting(k, v);
  }
}

// MySQL settings from cPanel-style DB_* variables, Railway's MYSQL* variables,
// or a single URL (DATABASE_URL / MYSQL_URL = mysql://user:pass@host:port/db).
function mysqlConfig(env) {
  const url = env.DATABASE_URL || env.MYSQL_URL || env.MYSQL_PUBLIC_URL;
  if (!env.DB_NAME && url && /^mysql:\/\//i.test(url)) {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port || '3306', 10), user: decodeURIComponent(u.username),
             password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  }
  const database = env.DB_NAME || env.MYSQLDATABASE || env.MYSQL_DATABASE;
  if (!database) return null;
  return { host: env.DB_HOST || env.MYSQLHOST || 'localhost', port: parseInt(env.DB_PORT || env.MYSQLPORT || '3306', 10),
           user: env.DB_USER || env.MYSQLUSER || 'root', password: env.DB_PASS || env.DB_PASSWORD || env.MYSQLPASSWORD || env.MYSQL_ROOT_PASSWORD || '',
           database };
}

// ---------------------------------------------------------------------------
async function init({ root, dataDir }) {
  const env = process.env;
  const my = mysqlConfig(env);
  if (my) {
    adapter = await mysqlAdapter(my);
    console.log(`[db] MySQL ${my.user}@${my.host}:${my.port}/${my.database}`);
  } else {
    const file = env.SQLITE_FILE || path.join(dataDir, 'truman.db');
    adapter = sqliteAdapter(file);
    console.log(`[db] SQLite ${file}${env.NODE_ENV === 'production' ? '  (set DB_NAME to use MySQL)' : ''}`);
  }
  for (const sql of createStatements(adapter.dialect)) await adapter.exec(sql);
  await seed(root, dataDir);
  return adapter;
}

const db = {
  init, getSetting, setSetting, TABLES, createStatements,
  get dialect() { return adapter && adapter.dialect; },
  all: (s, p) => adapter.all(s, p),
  get: (s, p) => adapter.get(s, p),
  run: (s, p) => adapter.run(s, p),
  tx: (fn) => adapter.tx(fn),
  close: () => adapter && adapter.close()
};
module.exports = db;
