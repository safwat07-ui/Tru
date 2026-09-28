// ---------------------------------------------------------------------------
// Truman Electronics — static server + shop + Paymob payments
// Zero npm dependencies. Node 18+ (uses built-in fetch + crypto).
//
// SECURITY MODEL
//   * Prices are read from catalog.json on the server. Anything the browser
//     sends about price/total is ignored and recomputed.
//   * An order is only marked PAID by the HMAC-verified Paymob webhook.
//     The browser redirect is treated as a hint for the UI, never as proof.
// ---------------------------------------------------------------------------
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ---- Paymob configuration (set these as environment variables) -------------
const PAYMOB = {
  base:        process.env.PAYMOB_BASE_URL   || 'https://accept.paymob.com',
  secretKey:   process.env.PAYMOB_SECRET_KEY || '',   // "Authorization: Token <secret>"
  publicKey:   process.env.PAYMOB_PUBLIC_KEY || '',   // used in the checkout URL
  hmacSecret:  process.env.PAYMOB_HMAC_SECRET || '',  // verifies the webhook
  // Comma-separated integration IDs from the Paymob dashboard (card, wallet, kiosk…)
  integrationIds: (process.env.PAYMOB_INTEGRATION_IDS || '')
                    .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean),
  siteUrl:     process.env.SITE_URL || ''             // e.g. https://truman.up.railway.app
};
const PAYMOB_READY = !!(PAYMOB.secretKey && PAYMOB.publicKey && PAYMOB.integrationIds.length);

// ---- Catalogue (source of truth for pricing) -------------------------------
let CATALOG = { products: [], currency: 'EGP', shipping: { flat_rate_cents: 0, free_over_cents: null } };
function loadCatalog() {
  try {
    CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
    console.log(`[catalog] ${CATALOG.products.length} products loaded`);
  } catch (e) { console.error('[catalog] failed to load:', e.message); }
}
loadCatalog();
const bySku = sku => CATALOG.products.find(p => p.sku === sku);

// ---- Order store (flat JSON file; swap for a DB when volume justifies it) ---
const ORDERS_FILE = path.join(ROOT, 'orders.json');
let ORDERS = {};
try { ORDERS = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch (e) { ORDERS = {}; }
let saveTimer = null;
function saveOrders() {                 // debounced so a burst of webhooks isn't N writes
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(ORDERS_FILE, JSON.stringify(ORDERS, null, 2), err => {
      if (err) console.error('[orders] save failed:', err.message);
    });
  }, 200);
}

// ---- Helpers ---------------------------------------------------------------
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon',
  '.json':'application/json; charset=utf-8', '.xml':'application/xml; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.pdf':'application/pdf',
  '.woff2':'font/woff2', '.woff':'font/woff'
};
function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function json(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > limit) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function orderRef() {
  return 'TRM-' + Date.now().toString(36).toUpperCase() +
         '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ---- Server-side pricing: the browser never decides the total --------------
function priceCart(items) {
  const lines = [];
  let subtotal = 0;
  for (const raw of (items || [])) {
    const product = bySku(String(raw.sku || ''));
    if (!product || product.in_stock === false) continue;      // unknown SKU: drop it
    let qty = parseInt(raw.qty, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 20) qty = 20;                                     // sane per-line cap
    const lineTotal = product.price_cents * qty;                // price from catalogue ONLY
    subtotal += lineTotal;
    lines.push({
      sku: product.sku, name: product.name_en, qty,
      unit_price_cents: product.price_cents, line_total_cents: lineTotal
    });
  }
  const ship = CATALOG.shipping || {};
  const freeOver = ship.free_over_cents;
  const shipping = (lines.length === 0) ? 0
                 : (freeOver != null && subtotal >= freeOver) ? 0
                 : (ship.flat_rate_cents || 0);
  return { lines, subtotal_cents: subtotal, shipping_cents: shipping, total_cents: subtotal + shipping };
}

// ---- Paymob: create intention ---------------------------------------------
async function createIntention(order, billing) {
  const body = {
    amount: order.total_cents,                 // piastres
    currency: CATALOG.currency || 'EGP',
    payment_methods: PAYMOB.integrationIds,
    items: order.lines.map(l => ({
      name: l.name, amount: l.unit_price_cents, quantity: l.qty, description: l.sku
    })),
    billing_data: {
      first_name: billing.first_name, last_name: billing.last_name,
      email: billing.email, phone_number: billing.phone,
      street: billing.street || 'NA', building: 'NA', floor: 'NA', apartment: 'NA',
      city: billing.city || 'Cairo', state: billing.state || 'NA',
      country: 'EG', postal_code: 'NA'
    },
    special_reference: order.ref,              // our reference, echoed back to us
    notification_url: PAYMOB.siteUrl ? `${PAYMOB.siteUrl}/api/paymob/webhook` : undefined,
    redirection_url:  PAYMOB.siteUrl ? `${PAYMOB.siteUrl}/payment-result`     : undefined
  };
  // shipping shows as its own line so the Paymob total matches ours exactly
  if (order.shipping_cents > 0) {
    body.items.push({ name: 'Shipping', amount: order.shipping_cents, quantity: 1, description: 'DELIVERY' });
  }

  const r = await fetch(`${PAYMOB.base}/v1/intention/`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${PAYMOB.secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
  if (!r.ok) {
    const err = new Error('paymob_intention_failed');
    err.status = r.status; err.detail = data && Object.keys(data).length ? data : text.slice(0, 500);
    throw err;
  }
  return data;                                  // { client_secret, id, intention_order_id, ... }
}

// ---- Paymob: verify webhook HMAC ------------------------------------------
// HMAC-SHA512 over these 20 fields, in this exact order, concatenated with no
// separator. Order is defined by Paymob and must not be "tidied up".
const HMAC_FIELDS = [
  'amount_cents','created_at','currency','error_occured','has_parent_transaction',
  'id','integration_id','is_3d_secure','is_auth','is_capture','is_refunded',
  'is_standalone_payment','is_voided','order.id','owner','pending',
  'source_data.pan','source_data.sub_type','source_data.type','success'
];
function dig(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
function verifyHmac(obj, received) {
  if (!PAYMOB.hmacSecret || !received) return false;
  const concatenated = HMAC_FIELDS.map(f => {
    const v = dig(obj, f);
    if (typeof v === 'boolean') return v ? 'true' : 'false';   // must be lowercase
    return v == null ? '' : String(v);
  }).join('');
  const expected = crypto.createHmac('sha512', PAYMOB.hmacSecret).update(concatenated).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(received), 'utf8');
  if (a.length !== b.length) return false;                     // timingSafeEqual throws otherwise
  return crypto.timingSafeEqual(a, b);
}

// ---- Routes ----------------------------------------------------------------
async function handleCheckout(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req) || '{}'); }
  catch (e) { return json(res, 400, { ok: false, error: 'bad_json' }); }

  const b = payload.billing || {};
  const first_name = String(b.first_name || '').trim();
  const last_name  = String(b.last_name  || '').trim();
  const email      = String(b.email      || '').trim();
  const phone      = String(b.phone      || '').trim();

  if (!first_name || !last_name ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      !/^(\+?20)?0?1[0-9]{9}$/.test(phone.replace(/[\s-]/g, ''))) {
    return json(res, 422, { ok: false, error: 'invalid_billing' });
  }

  const priced = priceCart(payload.items);
  if (!priced.lines.length) return json(res, 422, { ok: false, error: 'empty_cart' });

  const order = {
    ref: orderRef(),
    status: 'pending',
    created_at: new Date().toISOString(),
    ...priced,
    currency: CATALOG.currency || 'EGP',
    billing: { first_name, last_name, email, phone,
               street: String(b.street || '').trim(), city: String(b.city || '').trim() },
    paymob: {}
  };
  ORDERS[order.ref] = order; saveOrders();

  // No live keys yet → return a demo checkout so the whole flow stays testable.
  if (!PAYMOB_READY) {
    order.status = 'awaiting_payment';
    order.demo = true;
    saveOrders();
    console.log(`[order] ${order.ref} created (DEMO MODE — no Paymob keys configured) total=${order.total_cents}`);
    return json(res, 200, {
      ok: true, demo: true, order_ref: order.ref,
      total_cents: order.total_cents,
      checkout_url: `/payment-result?demo=1&order=${encodeURIComponent(order.ref)}`
    });
  }

  try {
    const intention = await createIntention(order, order.billing);
    order.paymob = {
      intention_id: intention.id,
      order_id: intention.intention_order_id,
      client_secret: intention.client_secret
    };
    order.status = 'awaiting_payment';
    saveOrders();
    const url = `${PAYMOB.base}/unifiedcheckout/?publicKey=${encodeURIComponent(PAYMOB.publicKey)}` +
                `&clientSecret=${encodeURIComponent(intention.client_secret)}`;
    console.log(`[order] ${order.ref} intention created total=${order.total_cents}`);
    return json(res, 200, { ok: true, order_ref: order.ref, total_cents: order.total_cents, checkout_url: url });
  } catch (err) {
    order.status = 'failed';
    order.error = err.detail || err.message;
    saveOrders();
    console.error(`[order] ${order.ref} intention failed:`, err.status || '', err.detail || err.message);
    return json(res, 502, { ok: false, error: 'gateway_error' });
  }
}

async function handleWebhook(req, res) {
  const raw = await readBody(req).catch(() => '');
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false }); }

  const url = new URL(req.url, 'http://x');
  const hmacParam = url.searchParams.get('hmac') || body.hmac;
  const obj = body.obj || {};

  if (!verifyHmac(obj, hmacParam)) {
    console.warn('[webhook] REJECTED — HMAC mismatch');
    return json(res, 401, { ok: false, error: 'bad_hmac' });     // never trust an unsigned callback
  }

  // Correlate: our reference travels as special_reference / merchant_order_id.
  const ref = obj.order?.merchant_order_id || obj.order?.special_reference ||
              body.special_reference || null;
  const order = ref ? ORDERS[ref] : Object.values(ORDERS)
                  .find(o => o.paymob && String(o.paymob.order_id) === String(obj.order?.id));

  if (!order) { console.warn('[webhook] verified but no matching order; ref=', ref); return json(res, 200, { ok: true }); }

  if (order.status === 'paid') return json(res, 200, { ok: true, idempotent: true });   // replay-safe

  const success = obj.success === true && obj.pending === false;
  order.status = success ? 'paid' : 'payment_failed';
  order.paid_at = success ? new Date().toISOString() : undefined;
  order.paymob.transaction_id = obj.id;
  order.paymob.amount_cents  = obj.amount_cents;
  order.paymob.card_last4    = obj.source_data?.pan;
  order.paymob.method        = obj.source_data?.type;
  saveOrders();

  // A mismatch here means the captured amount differs from what we priced.
  if (success && Number(obj.amount_cents) !== Number(order.total_cents)) {
    order.amount_mismatch = true; saveOrders();
    console.error(`[webhook] AMOUNT MISMATCH on ${order.ref}: charged ${obj.amount_cents}, expected ${order.total_cents}`);
  }
  console.log(`[webhook] ${order.ref} -> ${order.status}`);
  return json(res, 200, { ok: true });
}

function handleOrderStatus(req, res, url) {
  const ref = url.searchParams.get('ref');
  const order = ref && ORDERS[ref];
  if (!order) return json(res, 404, { ok: false, error: 'not_found' });
  return json(res, 200, {                       // only non-sensitive fields
    ok: true, ref: order.ref, status: order.status,
    total_cents: order.total_cents, currency: order.currency,
    lines: order.lines, demo: !!order.demo
  });
}

// ---- HTTP entry ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;

    if (req.method === 'POST') {
      if (route === '/api/checkout')       return handleCheckout(req, res);
      if (route === '/api/paymob/webhook') return handleWebhook(req, res);
      if (route === '/api/contact')        return handleContact(req, res);
      return send(res, 405, 'text/plain', 'Method Not Allowed');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(res, 405, 'text/plain', 'Method Not Allowed');

    if (route === '/api/catalog') {
      return json(res, 200, {
        currency: CATALOG.currency, shipping: CATALOG.shipping,
        payments_live: PAYMOB_READY,
        products: CATALOG.products.filter(p => p.in_stock !== false)
      });
    }
    if (route === '/api/order')          return handleOrderStatus(req, res, url);
    if (route === '/api/paymob/webhook') return handleWebhook(req, res);   // GET response callback
    if (route === '/payment-result')     return serveFile(res, path.join(ROOT, 'payment-result.html'), req);
    if (route === '/shop')               return serveFile(res, path.join(ROOT, 'shop.html'), req);

    // static files
    let p = decodeURIComponent(route);
    if (p === '/') p = '/index.html';
    const safe = path.normalize(path.join(ROOT, p));
    if (!safe.startsWith(ROOT)) return send(res, 403, 'text/plain', 'Forbidden');
    if (path.basename(safe) === 'orders.json') return send(res, 403, 'text/plain', 'Forbidden');
    return serveFile(res, safe, req);
  } catch (e) {
    console.error('[server]', e);
    send(res, 500, 'text/plain', 'Server error');
  }
});

function serveFile(res, file, req) {
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, '404.html'), (e2, nf) => {
        if (e2) return send(res, 404, 'text/plain', 'Not found');
        send(res, 404, 'text/html; charset=utf-8', nf);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext !== '.html') headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(req && req.method === 'HEAD' ? undefined : data);
  });
}

// ---- Contact form (unchanged behaviour) ------------------------------------
async function handleContact(req, res) {
  const raw = await readBody(req).catch(() => '');
  let d = {};
  try {
    d = (req.headers['content-type'] || '').includes('application/json')
      ? JSON.parse(raw || '{}')
      : Object.fromEntries(new URLSearchParams(raw));
  } catch (e) { return json(res, 400, { ok: false, error: 'bad body' }); }

  const name = (d.name || '').trim(), email = (d.email || '').trim(),
        message = (d.message || '').trim(), topic = (d.topic || 'General').trim();
  if (!name || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json(res, 422, { ok: false, error: 'invalid fields' });

  const payload = { name, email, topic, message, at: new Date().toISOString() };
  try {
    if (process.env.CONTACT_WEBHOOK_URL) {
      await fetch(process.env.CONTACT_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `New Truman enquiry — ${topic}\nFrom: ${name} <${email}>\n\n${message}`, ...payload })
      });
    } else { console.log('[contact] (no delivery configured)', JSON.stringify(payload)); }
    return json(res, 200, { ok: true });
  } catch (err) {
    console.error('[contact] delivery failed:', err && err.message);
    return json(res, 502, { ok: false, error: 'delivery failed' });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Truman Electronics site running on port ${PORT}`);
  console.log(PAYMOB_READY
    ? `[paymob] LIVE mode — ${PAYMOB.integrationIds.length} integration id(s), base ${PAYMOB.base}`
    : `[paymob] DEMO mode — set PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_INTEGRATION_IDS to go live`);
});
