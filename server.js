'use strict';
// ===========================================================================
//  TRUMAN ELECTRONICS — website, shop and admin dashboard
//
//  RUN LOCALLY        node server.js     (Node 18+; Node 22.13+ for the built-in
//                     SQLite database), then open http://localhost:3000
//                     Admin dashboard:  http://localhost:3000/admin
//
//  DEPLOY ON CPANEL   See README.md. In short: Setup Node.js App, application
//                     root = this folder (OUTSIDE public_html), startup file =
//                     server.js, "Run NPM Install", add environment variables.
//
//  CODE LAYOUT        lib/db.js      database (MySQL or SQLite), tables, imports
//                     lib/shop.js    catalogue, checkout, Paymob, order lifecycle
//                     lib/admin.js   admin API (permissions checked here)
//                     lib/auth.js    passwords, sessions, two-step sign-in
//                     lib/mail.js    order and status emails (SMTP or API)
//                     admin/         the dashboard pages
//
//  WHAT IS PUBLIC     Only the site pages, assets/ and the dashboard's own
//                     page files. Source code, data/ and config never are.
// ===========================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const db = require('./lib/db');
const auth = require('./lib/auth');
const shop = require('./lib/shop');
const admin = require('./lib/admin');
const mail = require('./lib/mail');
const { send, json } = require('./lib/util');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// On Railway, attach a Volume and its mount path is used automatically.
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'));
admin.setRoot(ROOT);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};
const ADMIN_HEADERS = {
  ...BASE_HEADERS,
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                             "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

// ---- What visitors are allowed to download ----------------------------------
const PUBLIC_FILES = new Set([
  'index.html', 'range.html', 'shop.html', 'payment-result.html', '404.html',
  'robots.txt', 'sitemap.xml', 'Truman-Catalogue.pdf', 'favicon.ico'
]);
const ASSET_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.ico', '.js', '.css', '.woff', '.woff2', '.pdf']);
// Images may also sit next to the pages (the older repo layout); scripts there may not,
// apart from the translations file.
const ROOT_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.ico', '.pdf']);
function isPublicFile(rel) {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.split('/').some(seg => seg.startsWith('.'))) return false;
  if (PUBLIC_FILES.has(rel) || rel === 'i18n.js') return true;
  if (!rel.includes('/')) return ROOT_EXT.has(path.extname(rel).toLowerCase());
  return rel.startsWith('assets/') && ASSET_EXT.has(path.extname(rel).toLowerCase());
}

function notFound(req, res) {
  fs.readFile(path.join(ROOT, '404.html'), (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'Not found', BASE_HEADERS);
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...BASE_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
// Works with both layouts: "logo.png" falls back to "assets/logo.png" and vice versa.
function altPath(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('assets/') && rel.split('/').length === 2) return path.join(ROOT, rel.slice(7));
  if (!rel.includes('/') && ROOT_EXT.has(path.extname(rel).toLowerCase()) || rel === 'i18n.js') return path.join(ROOT, 'assets', rel);
  return null;
}
function serveFile(req, res, file, headers = BASE_HEADERS, tried) {
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, data) => {
    if (err) { const alt = !tried && altPath(file); return alt ? serveFile(req, res, alt, headers, true) : notFound(req, res); }
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', ...headers };
    if (ext !== '.html' && !h['Cache-Control']) h['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---- Database start-up (the public pages keep working while it retries) -------
let dbReady = false, dbError = null;
async function startDb() {
  try {
    await db.init({ root: ROOT, dataDir: DATA_DIR });
    await auth.bootstrapOwner();
    dbReady = true; dbError = null;
    if (storageWarning()) console.warn('[db] WARNING: ' + storageWarning());
    shop.startHousekeeping();
  } catch (e) {
    dbError = e.message;
    console.error('[db] NOT AVAILABLE:', e.message, '— retrying in 30 s');
    setTimeout(startDb, 30e3).unref();
  }
}
// Railway's disk is wiped on every deploy: SQLite there needs a Volume.
function storageWarning() {
  if (db.dialect !== 'sqlite' || !process.env.RAILWAY_ENVIRONMENT) return null;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR) return null;
  return 'Orders and accounts are on a temporary disk and will be lost on the next deploy. Add a MySQL database (or a Volume) in Railway.';
}
shop.storageWarning = storageWarning;
const unavailable = res => json(res, 503, { ok: false, error: 'The shop is temporarily unavailable. Please try again shortly or call 19903.' });

// ---- Requests -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;

    if (route.startsWith('/api/')) {
      if (!dbReady) return unavailable(res);
      if (route.startsWith('/api/admin/')) return admin.handle(req, res, url);
      if (req.method === 'POST') {
        if (route === '/api/checkout')       return shop.handleCheckout(req, res);
        if (route === '/api/paymob/webhook') return shop.handleWebhook(req, res);
        if (route === '/api/contact')        return shop.handleContact(req, res);
        return send(res, 405, 'text/plain', 'Method Not Allowed');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method Not Allowed');
      if (route === '/api/catalog')        return json(res, 200, await shop.getCatalog());
      if (route === '/api/order')          return shop.handleOrderStatus(req, res, url);
      if (route === '/api/paymob/webhook') return shop.handleWebhook(req, res);
      if (route === '/api/health')         return json(res, 200, { ok: true, db: db.dialect });
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method Not Allowed');

    // product photos uploaded in the dashboard live in the database
    const media = /^\/media\/([A-Za-z0-9._-]{1,120})$/.exec(route);
    if (media) {
      if (!dbReady) return notFound(req, res);
      const img = await db.get('SELECT mime, data FROM images WHERE name = ?', [media[1]]);
      if (!img) return notFound(req, res);
      res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', ...BASE_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : img.data);
    }

    // the catalogue is now generated from the database
    if (route === '/catalog.json') return dbReady ? json(res, 200, await shop.getCatalog()) : unavailable(res);

    // admin dashboard pages
    if (route === '/admin' || route === '/admin/') return serveFile(req, res, path.join(ROOT, 'admin', 'index.html'), ADMIN_HEADERS);
    if (route === '/admin/app.js' || route === '/admin/app.css' || route === '/admin/qrcode.js') return serveFile(req, res, path.join(ROOT, route), ADMIN_HEADERS);

    if (route === '/payment-result') return serveFile(req, res, path.join(ROOT, 'payment-result.html'));
    if (route === '/shop')           return serveFile(req, res, path.join(ROOT, 'shop.html'));

    let p;
    try { p = decodeURIComponent(route); } catch (e) { return notFound(req, res); }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (!isPublicFile(rel)) return notFound(req, res);
    return serveFile(req, res, file);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) send(res, 500, 'text/plain', 'Server error');
  }
});

startDb().then(() => {
  server.listen(PORT, () => {
    const m = mail.describe();
    console.log(`Truman Electronics site running on port ${PORT}`);
    console.log(shop.PAYMOB_READY
      ? `[paymob] LIVE mode — ${shop.PAYMOB.integrationIds.length} integration id(s)${shop.PAYMOB.siteUrl ? '' : ' — WARNING: SITE_URL is not set'}`
      : '[paymob] DEMO mode — set PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET, PAYMOB_INTEGRATION_IDS to go live');
    console.log(m.ready ? `[mail]   via ${m.transport}${m.host ? ' ' + m.host : ''} from ${m.from} -> ${m.notify.join(', ') || '(ORDER_NOTIFY_TO not set!)'}`
                        : '[mail]   not configured — order emails are printed to this log instead');
  });
});

module.exports = server;
