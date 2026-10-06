'use strict';
// ===========================================================================
//  Shop backend: catalogue, pricing, checkout, Paymob, order lifecycle, stock
// ===========================================================================
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const { json, readJson, readBody, clientIp, limiter, clip, isEmail, int } = require('./util');

// ---- Paymob configuration (environment variables) --------------------------
const PAYMOB = {
  base:        process.env.PAYMOB_BASE_URL   || 'https://accept.paymob.com',
  secretKey:   process.env.PAYMOB_SECRET_KEY || '',
  publicKey:   process.env.PAYMOB_PUBLIC_KEY || '',
  hmacSecret:  process.env.PAYMOB_HMAC_SECRET || '',
  integrationIds: (process.env.PAYMOB_INTEGRATION_IDS || '')
                    .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean),
  siteUrl:     (process.env.SITE_URL || '').replace(/\/+$/, '')
};
const PAYMOB_READY = !!(PAYMOB.secretKey && PAYMOB.publicKey && PAYMOB.integrationIds.length);

// ---- Order statuses ---------------------------------------------------------
const STATUS = {
  pending:          'Created',
  awaiting_payment: 'Awaiting payment',
  payment_failed:   'Payment failed',
  expired:          'Expired (not paid)',
  paid:             'Paid',
  processing:       'Preparing',
  shipped:          'Shipped',
  delivered:        'Delivered',
  cancelled:        'Cancelled',
  refunded:         'Refunded'
};
const UNPAID = new Set(['pending', 'awaiting_payment', 'payment_failed', 'expired']);
const FULFILMENT = new Set(['paid', 'processing', 'shipped', 'delivered']);
const isPaidState = s => FULFILMENT.has(s);

// ---- Catalogue ------------------------------------------------------------
let catalogCache = null, catalogAt = 0;
function invalidateCatalog() { catalogCache = null; }

async function shippingSettings(q = db) {
  const get = async k => { const r = await q.get('SELECT v FROM settings WHERE k = ?', [k]); return r ? JSON.parse(r.v) : null; };
  return { flat_rate_cents: (await get('shipping_flat_cents')) || 0, free_over_cents: await get('shipping_free_over_cents'),
           currency: (await get('currency')) || 'EGP', max_qty: (await get('checkout_max_qty')) || 20 };
}

function publicProduct(p) {
  let specs = [];
  try { specs = JSON.parse(p.specs || '[]'); } catch (e) {}
  return {
    sku: p.sku, category: p.category, in_stock: true, price_cents: p.price_cents,
    name_en: p.name_en, name_ar: p.name_ar || p.name_en, desc_en: p.desc_en || '', desc_ar: p.desc_ar || '',
    image: p.image || 'assets/logo.png', specs,
    ...(p.stock_qty != null && p.stock_qty <= (p.low_stock_at || 0) ? { low_stock: true } : {})
  };
}
const available = p => p.active && (p.stock_qty == null || p.stock_qty > 0);

async function getCatalog() {
  if (catalogCache && Date.now() - catalogAt < 5000) return catalogCache;
  const rows = await db.all('SELECT * FROM products ORDER BY sort_order, sku');
  const ship = await shippingSettings();
  catalogCache = {
    currency: ship.currency,
    shipping: { flat_rate_cents: ship.flat_rate_cents, free_over_cents: ship.free_over_cents },
    payments_live: PAYMOB_READY,
    products: rows.filter(available).map(publicProduct)
  };
  catalogAt = Date.now();
  return catalogCache;
}

// ---- Server-side pricing: the browser never decides the total --------------
async function priceCart(items, q = db) {
  const ship = await shippingSettings(q);
  const lines = [], problems = [];
  let subtotal = 0;
  const merged = new Map();
  for (const raw of (Array.isArray(items) ? items : []).slice(0, 50)) {
    const sku = clip(raw && raw.sku, 64);
    let qty = int(raw && raw.qty, 1);
    if (qty < 1) qty = 1;
    merged.set(sku, Math.min((merged.get(sku) || 0) + qty, ship.max_qty));
  }
  for (const [sku, qty] of merged) {
    const p = await q.get('SELECT * FROM products WHERE sku = ?', [sku]);
    if (!p || !p.active) { problems.push({ sku, error: 'unavailable' }); continue; }
    if (p.stock_qty != null && p.stock_qty < qty) {
      problems.push({ sku, error: 'out_of_stock', available: Math.max(0, p.stock_qty) });
      continue;
    }
    const lineTotal = p.price_cents * qty;
    subtotal += lineTotal;
    lines.push({ sku: p.sku, name: p.name_en, name_ar: p.name_ar || p.name_en, qty,
                 unit_price_cents: p.price_cents, line_total_cents: lineTotal });
  }
  const shipping = !lines.length ? 0
    : (ship.free_over_cents != null && subtotal >= ship.free_over_cents) ? 0 : (ship.flat_rate_cents || 0);
  return { lines, problems, subtotal_cents: subtotal, shipping_cents: shipping,
           total_cents: subtotal + shipping, currency: ship.currency };
}

// ---- Orders: loading and shaping --------------------------------------------
async function loadOrder(refOrId, q = db, withEvents = false) {
  const o = typeof refOrId === 'number'
    ? await q.get('SELECT * FROM orders WHERE id = ?', [refOrId])
    : await q.get('SELECT * FROM orders WHERE ref = ?', [String(refOrId)]);
  if (!o) return null;
  o.items = await q.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [o.id]);
  if (withEvents) o.events = await q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY at, id', [o.id]);
  return o;
}
// The shape the email templates expect
function mailShape(o) {
  return {
    ref: o.ref, lang: o.lang, demo: !!o.demo, currency: o.currency,
    shipping_cents: o.shipping_cents, total_cents: o.total_cents, subtotal_cents: o.subtotal_cents,
    paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null, amount_mismatch: !!o.amount_mismatch,
    courier: o.courier, tracking_no: o.tracking_no,
    billing: { first_name: o.first_name, last_name: o.last_name, email: o.email, phone: o.phone, street: o.street, city: o.city },
    lines: o.items.map(i => ({ sku: i.sku, name: i.name_en, name_ar: i.name_ar, qty: i.qty,
                               unit_price_cents: i.unit_price_cents, line_total_cents: i.line_total_cents })),
    paymob: { method: o.pay_method, card_last4: o.card_last4, transaction_id: o.paymob_txn_id }
  };
}

async function addEvent(q, orderId, actor, type, fromStatus, toStatus, message) {
  await q.run('INSERT INTO order_events (order_id, at, actor, type, from_status, to_status, message) VALUES (?,?,?,?,?,?,?)',
    [orderId, Date.now(), actor || 'system', type, fromStatus || null, toStatus || null, message == null ? null : String(message).slice(0, 4000)]);
}

// ---- Stock -------------------------------------------------------------------
// direction -1 takes items out of stock (a sale), +1 puts them back.
async function moveStock(q, order, direction, actor, reason) {
  const notes = [];
  // Flip the flag first, conditionally: if another request already did it, do nothing.
  const want = direction < 0 ? 1 : 0;
  const g = await q.run('UPDATE orders SET stock_applied = ? WHERE id = ? AND stock_applied = ?', [want, order.id, 1 - want]);
  if (!g.changes) return notes;
  for (const it of order.items) {
    const p = await q.get('SELECT sku, stock_qty FROM products WHERE sku = ?', [it.sku]);
    if (!p || p.stock_qty == null) continue;                 // stock not tracked for this product
    const delta = direction * it.qty;
    await q.run('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE sku = ?', [delta, Date.now(), it.sku]);
    const after = p.stock_qty + delta;
    await q.run('INSERT INTO stock_moves (at, sku, delta, qty_after, reason, order_ref, actor) VALUES (?,?,?,?,?,?,?)',
      [Date.now(), it.sku, delta, after, reason, order.ref, actor]);
    if (after < 0) notes.push(`${it.sku} is oversold — stock is now ${after}`);
  }
  invalidateCatalog();
  return notes;
}

// ---- Status changes (shared by the webhook and the admin dashboard) ----------
// Who may move an order where. Returns the permission needed, or null if not allowed.
function permissionFor(from, to) {
  if (from === to) return null;
  if (to === 'cancelled') return UNPAID.has(from) ? 'orders.update' : isPaidState(from) ? 'orders.cancel' : null;
  if (to === 'refunded') return (isPaidState(from) || from === 'cancelled') ? 'orders.cancel' : null;
  if (FULFILMENT.has(to) && FULFILMENT.has(from)) return 'orders.update';
  return null;
}

async function changeStatus(ref, to, opts = {}) {
  const { actor = 'system', courier, tracking_no, note, notify = true, restock = false, refund_cents } = opts;
  let emailOrder = null, warnings = [];
  const result = await db.tx(async q => {
    const o = await loadOrder(ref, q);
    if (!o) throw Object.assign(new Error('not_found'), { status: 404 });
    const from = o.status;
    const perm = permissionFor(from, to);
    if (!perm) throw Object.assign(new Error(`An order that is "${STATUS[from] || from}" cannot be changed to "${STATUS[to] || to}".`), { status: 409 });
    if (opts.allowed && !opts.allowed(perm)) throw Object.assign(new Error('You do not have permission for this change.'), { status: 403 });
    if (to === 'refunded' && !o.paid_at) throw Object.assign(new Error('This order was never paid, so there is nothing to refund.'), { status: 409 });
    const now = Date.now();
    const sets = ['updated_at = ?'], vals = [now];
    if (courier !== undefined) { sets.push('courier = ?'); vals.push(clip(courier, 80) || null); }
    if (tracking_no !== undefined) { sets.push('tracking_no = ?'); vals.push(clip(tracking_no, 120) || null); }

    let msg = note ? clip(note, 2000) : '';
    if (to === 'refunded') {
      const amount = refund_cents == null ? o.total_cents - o.refunded_cents : Math.max(0, int(refund_cents));
      const newTotal = Math.min(o.total_cents, o.refunded_cents + amount);
      sets.push('refunded_cents = ?'); vals.push(newTotal);
      msg = `Refund recorded: ${(amount / 100).toFixed(2)} ${o.currency}` + (msg ? ` — ${msg}` : '');
      if (newTotal < o.total_cents) {                     // partial refund: status stays
        await q.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, [...vals, o.id]);
        await addEvent(q, o.id, actor, 'refund', from, from, msg + ' (partial)');
        return { ref: o.ref, status: from, partial: true };
      }
    }
    sets.push('status = ?'); vals.push(to);
    const upd = await q.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND status = ?`, [...vals, o.id, from]);
    if (!upd.changes) throw Object.assign(new Error('Someone else just changed this order. Reload and try again.'), { status: 409 });
    const extra = [];
    if (courier) extra.push(`courier ${clip(courier, 80)}`);
    if (tracking_no) extra.push(`tracking ${clip(tracking_no, 120)}`);
    await addEvent(q, o.id, actor, 'status', from, to, [msg, extra.join(', ')].filter(Boolean).join(' — ') || null);

    if (restock && o.stock_applied && (to === 'cancelled' || to === 'refunded')) {
      warnings = warnings.concat(await moveStock(q, o, +1, actor, to === 'cancelled' ? 'cancel' : 'refund'));
      await addEvent(q, o.id, actor, 'stock', null, null, 'Items returned to stock');
    }
    if (notify && ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(to) && !(to === 'cancelled' && UNPAID.has(from))) {
      emailOrder = await loadOrder(o.id, q);
    }
    return { ref: o.ref, status: to };
  });

  if (emailOrder) {
    const sent = await mail.notifyStatus(mailShape(emailOrder), result.status);
    await addEvent(db, emailOrder.id, 'system', 'email', null, null,
      sent ? `Customer emailed: ${STATUS[result.status]}` : 'Customer email not sent (email not configured or failed)');
    result.emailed = sent;
  }
  result.warnings = warnings;
  return result;
}

async function returnToStock(ref, actor) {
  return db.tx(async q => {
    const o = await loadOrder(ref, q);
    if (!o) throw Object.assign(new Error('not_found'), { status: 404 });
    if (!o.stock_applied) throw Object.assign(new Error('Stock was not taken for this order, so there is nothing to return.'), { status: 409 });
    const before = await q.get('SELECT stock_applied FROM orders WHERE id = ?', [o.id]);
    const w = await moveStock(q, o, +1, actor, 'return');
    const after = await q.get('SELECT stock_applied FROM orders WHERE id = ?', [o.id]);
    if (before.stock_applied === after.stock_applied) throw Object.assign(new Error('Stock was already returned.'), { status: 409 });
    await addEvent(q, o.id, actor, 'stock', null, null, 'Items returned to stock');
    return { ok: true, warnings: w };
  });
}

// Marks an order paid exactly once, takes stock, and returns the order for emailing.
async function markPaid(q, o, info, actor) {
  const now = Date.now();
  const upd = await q.run(`UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ?, paymob_txn_id = ?, paid_amount_cents = ?,
               card_last4 = ?, pay_method = ?, amount_mismatch = ? WHERE id = ? AND status = ?`,
    [now, now, info.txn_id != null ? String(info.txn_id) : null, info.amount_cents, info.card_last4 || null,
     info.method || null, info.amount_cents != null && Number(info.amount_cents) !== Number(o.total_cents) ? 1 : 0, o.id, o.status]);
  if (!upd.changes) return null;                  // a simultaneous callback got there first
  let msg = info.message || 'Payment confirmed';
  if (o.status === 'cancelled' || o.status === 'expired') msg += ` — NOTE: the order was ${o.status} before this payment arrived. Check it.`;
  await addEvent(q, o.id, actor, 'payment', o.status, 'paid', msg);
  const warn = await moveStock(q, o, -1, actor, 'sale');
  for (const w of warn) await addEvent(q, o.id, 'system', 'stock', null, null, w);
  if (info.amount_cents != null && Number(info.amount_cents) !== Number(o.total_cents)) {
    await addEvent(q, o.id, 'system', 'warning', null, null,
      `AMOUNT MISMATCH: charged ${info.amount_cents}, expected ${o.total_cents}. Check before shipping.`);
  }
  return loadOrder(o.id, q);
}

// ---- Paymob API ----------------------------------------------------------------
async function createIntention(order) {
  const body = {
    amount: order.total_cents, currency: order.currency || 'EGP',
    payment_methods: PAYMOB.integrationIds,
    items: order.lines.map(l => ({ name: l.name.slice(0, 50), amount: l.unit_price_cents, quantity: l.qty, description: l.sku })),
    billing_data: {
      first_name: order.billing.first_name, last_name: order.billing.last_name,
      email: order.billing.email, phone_number: order.billing.phone,
      street: order.billing.street || 'NA', building: 'NA', floor: 'NA', apartment: 'NA',
      city: order.billing.city || 'Cairo', state: 'NA', country: 'EG', postal_code: 'NA'
    },
    special_reference: order.ref,
    notification_url: PAYMOB.siteUrl ? `${PAYMOB.siteUrl}/api/paymob/webhook` : undefined,
    redirection_url:  PAYMOB.siteUrl ? `${PAYMOB.siteUrl}/payment-result` : undefined
  };
  if (order.shipping_cents > 0) body.items.push({ name: 'Shipping', amount: order.shipping_cents, quantity: 1, description: 'DELIVERY' });

  const r = await fetch(`${PAYMOB.base}/v1/intention/`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${PAYMOB.secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    const err = new Error('paymob_intention_failed');
    err.status = r.status; err.detail = data && Object.keys(data).length ? data : text.slice(0, 500);
    throw err;
  }
  return data;
}

// HMAC-SHA512 over these fields, in this exact order (defined by Paymob).
const HMAC_FIELDS = [
  'amount_cents','created_at','currency','error_occured','has_parent_transaction',
  'id','integration_id','is_3d_secure','is_auth','is_capture','is_refunded',
  'is_standalone_payment','is_voided','order.id','owner','pending',
  'source_data.pan','source_data.sub_type','source_data.type','success'
];
const dig = (obj, dotted) => dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
function verifyHmac(obj, received) {
  if (!PAYMOB.hmacSecret || !received) return false;
  const concatenated = HMAC_FIELDS.map(f => {
    const v = dig(obj, f);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return v == null ? '' : String(v);
  }).join('');
  const expected = crypto.createHmac('sha512', PAYMOB.hmacSecret).update(concatenated).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(received));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Routes: checkout -----------------------------------------------------------
const checkoutLimit = limiter(8, 10 * 60e3);
const orderRef = () => 'TRM-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

async function handleCheckout(req, res) {
  if (!checkoutLimit(clientIp(req))) return json(res, 429, { ok: false, error: 'too_many_attempts' });
  let payload;
  try { payload = await readJson(req, 100e3); } catch (e) { return json(res, 400, { ok: false, error: 'bad_json' }); }

  const b = payload.billing || {};
  const billing = {
    first_name: clip(b.first_name, 120), last_name: clip(b.last_name, 120), email: clip(b.email, 200).toLowerCase(),
    phone: clip(b.phone, 40), street: clip(b.street, 500), city: clip(b.city, 120)
  };
  if (!billing.first_name || !billing.last_name || !isEmail(billing.email) ||
      !/^(\+?20)?0?1[0-9]{9}$/.test(billing.phone.replace(/[\s-]/g, ''))) {
    return json(res, 422, { ok: false, error: 'invalid_billing' });
  }

  const priced = await priceCart(payload.items);
  if (priced.problems.length) return json(res, 409, { ok: false, error: 'stock_changed', problems: priced.problems });
  if (!priced.lines.length) return json(res, 422, { ok: false, error: 'empty_cart' });

  const order = { ref: orderRef(), lang: payload.lang === 'ar' ? 'ar' : 'en', billing, ...priced, demo: !PAYMOB_READY };
  const now = Date.now();
  const orderId = await db.tx(async q => {
    const r = await q.run(`INSERT INTO orders (ref, status, lang, currency, created_at, updated_at, subtotal_cents,
        shipping_cents, total_cents, first_name, last_name, email, phone, street, city, demo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [order.ref, 'pending', order.lang, order.currency, now, now, order.subtotal_cents, order.shipping_cents,
       order.total_cents, billing.first_name, billing.last_name, billing.email, billing.phone, billing.street,
       billing.city, order.demo ? 1 : 0]);
    for (const l of order.lines) {
      await q.run(`INSERT INTO order_items (order_id, sku, name_en, name_ar, qty, unit_price_cents, line_total_cents)
                   VALUES (?,?,?,?,?,?,?)`, [r.insertId, l.sku, l.name, l.name_ar, l.qty, l.unit_price_cents, l.line_total_cents]);
    }
    await addEvent(q, r.insertId, 'customer', 'created', null, 'pending', `Order placed from ${clientIp(req)}`);
    return r.insertId;
  });

  if (!PAYMOB_READY) {
    await db.run("UPDATE orders SET status = 'awaiting_payment' WHERE id = ?", [orderId]);
    await addEvent(db, orderId, 'system', 'status', 'pending', 'awaiting_payment', 'Demo mode — no payment taken');
    console.log(`[order] ${order.ref} created (DEMO MODE) total=${order.total_cents}`);
    return json(res, 200, { ok: true, demo: true, order_ref: order.ref, total_cents: order.total_cents,
                            checkout_url: `/payment-result?demo=1&order=${encodeURIComponent(order.ref)}` });
  }

  try {
    const intention = await createIntention(order);
    await db.run(`UPDATE orders SET status = 'awaiting_payment', paymob_intention_id = ?, paymob_order_id = ?, updated_at = ? WHERE id = ?`,
      [String(intention.id || ''), intention.intention_order_id != null ? String(intention.intention_order_id) : null, Date.now(), orderId]);
    await addEvent(db, orderId, 'system', 'status', 'pending', 'awaiting_payment', 'Sent to Paymob checkout');
    const url = `${PAYMOB.base}/unifiedcheckout/?publicKey=${encodeURIComponent(PAYMOB.publicKey)}` +
                `&clientSecret=${encodeURIComponent(intention.client_secret)}`;
    return json(res, 200, { ok: true, order_ref: order.ref, total_cents: order.total_cents, checkout_url: url });
  } catch (err) {
    const detail = err.detail || err.message;
    await db.run(`UPDATE orders SET status = 'payment_failed', error = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(detail).slice(0, 2000), Date.now(), orderId]);
    await addEvent(db, orderId, 'system', 'status', 'pending', 'payment_failed', 'Could not start Paymob checkout');
    console.error(`[order] ${order.ref} intention failed:`, err.status || '', detail);
    return json(res, 502, { ok: false, error: 'gateway_error' });
  }
}

// ---- Routes: Paymob webhook ----------------------------------------------------
async function handleWebhook(req, res) {
  const raw = await readBody(req).catch(() => '');
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false }); }
  const url = new URL(req.url, 'http://x');
  const obj = body.obj || {};
  if (!verifyHmac(obj, url.searchParams.get('hmac') || body.hmac)) {
    console.warn('[webhook] REJECTED — HMAC mismatch');
    return json(res, 401, { ok: false, error: 'bad_hmac' });
  }
  try {
    const out = await applyPaymobTransaction(obj, body);
    return json(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[webhook] failed:', e);
    return json(res, 500, { ok: false });           // Paymob retries on non-200
  }
}

async function findOrderForTxn(q, obj, body) {
  const ref = (obj.order && (obj.order.merchant_order_id || obj.order.special_reference)) || body.special_reference;
  let o = ref ? await loadOrder(String(ref), q) : null;
  if (!o && obj.order && obj.order.id != null) {
    const row = await q.get('SELECT id FROM orders WHERE paymob_order_id = ?', [String(obj.order.id)]);
    if (row) o = await loadOrder(row.id, q);
  }
  return o;
}

async function applyPaymobTransaction(obj, body = {}) {
  let paidOrder = null;
  const out = await db.tx(async q => {
    const o = await findOrderForTxn(q, obj, body);
    if (!o) { console.warn('[webhook] verified but no matching order', obj.order && obj.order.id); return { matched: false }; }

    const success = obj.success === true && obj.pending === false;
    const isRefundish = obj.is_refunded === true || obj.is_voided === true || obj.is_refund === true || obj.is_void === true;
    const txn = obj.id != null ? String(obj.id) : '';

    if (isRefundish && success) {
      const marker = `[txn ${txn}]`;
      const seen = await q.get("SELECT id FROM order_events WHERE order_id = ? AND type = 'refund' AND message LIKE ?", [o.id, `%${marker}%`]);
      const amount = obj.is_voided === true || obj.is_void === true ? o.total_cents
                   : int(obj.refunded_amount_cents, 0) || int(obj.amount_cents, 0);
      const newRefunded = Math.min(o.total_cents, Math.max(o.refunded_cents, amount));
      if (!seen) {
        await addEvent(q, o.id, 'paymob', 'refund', null, null,
          `Paymob ${obj.is_voided || obj.is_void ? 'void' : 'refund'} of ${(amount / 100).toFixed(2)} ${o.currency} ${marker}. Decide whether to return the items to stock.`);
      }
      await q.run('UPDATE orders SET refunded_cents = ?, updated_at = ? WHERE id = ?', [newRefunded, Date.now(), o.id]);
      if (newRefunded >= o.total_cents && o.status !== 'refunded' && (isPaidState(o.status) || o.status === 'cancelled')) {
        const rf = await q.run("UPDATE orders SET status = 'refunded' WHERE id = ? AND status = ?", [o.id, o.status]);
        if (rf.changes) await addEvent(q, o.id, 'paymob', 'status', o.status, 'refunded', 'Fully refunded in Paymob');
      }
      return { matched: true, refund: true };
    }

    if (success) {
      if (!UNPAID.has(o.status) && o.status !== 'cancelled') return { matched: true, idempotent: true };
      paidOrder = await markPaid(q, o, {
        txn_id: obj.id, amount_cents: obj.amount_cents, card_last4: obj.source_data && obj.source_data.pan,
        method: obj.source_data && (obj.source_data.sub_type || obj.source_data.type), message: `Paymob transaction ${txn}`
      }, 'paymob');
      return paidOrder ? { matched: true, status: 'paid' } : { matched: true, idempotent: true };
    }

    if (UNPAID.has(o.status)) {
      const reason = (obj.data && (obj.data.message || obj.data['txn_response_code'])) || 'declined';
      const f = await q.run("UPDATE orders SET status = 'payment_failed', updated_at = ? WHERE id = ? AND status = ?", [Date.now(), o.id, o.status]);
      if (!f.changes) return { matched: true, ignored: true };
      await addEvent(q, o.id, 'paymob', 'payment', o.status, 'payment_failed', `Payment attempt failed (${String(reason).slice(0, 200)}) — txn ${txn}`);
      return { matched: true, status: 'payment_failed' };
    }
    return { matched: true, ignored: true };
  });
  if (paidOrder) {
    console.log(`[webhook] ${paidOrder.ref} -> paid`);
    mail.notifyPaidOrder(mailShape(paidOrder), false);
  }
  return out;
}

// Demo mode only: lets the owner walk an order through "paid" without Paymob.
async function simulatePayment(ref, actor) {
  if (PAYMOB_READY) throw Object.assign(new Error('Live payments are on, so payments cannot be simulated.'), { status: 409 });
  let paid = null;
  await db.tx(async q => {
    const o = await loadOrder(ref, q);
    if (!o) throw Object.assign(new Error('not_found'), { status: 404 });
    if (!o.demo || !UNPAID.has(o.status)) throw Object.assign(new Error('Only unpaid demo orders can be marked paid.'), { status: 409 });
    paid = await markPaid(q, o, { txn_id: 'DEMO', amount_cents: o.total_cents, method: 'demo', message: 'Simulated payment (demo mode)' }, actor);
    if (!paid) throw Object.assign(new Error('The order changed meanwhile. Reload and try again.'), { status: 409 });
  });
  mail.notifyPaidOrder(mailShape(paid), true);
  return { ok: true };
}

// ---- Routes: order status for the payment-result page ----------------------------
async function handleOrderStatus(req, res, url) {
  const ref = clip(url.searchParams.get('ref'), 40);
  const o = ref ? await loadOrder(ref) : null;
  if (!o) return json(res, 404, { ok: false, error: 'not_found' });
  return json(res, 200, {
    ok: true, ref: o.ref, status: o.status, paid: isPaidState(o.status) || o.status === 'refunded',
    total_cents: o.total_cents, currency: o.currency, demo: !!o.demo,
    lines: o.items.map(i => ({ sku: i.sku, name: i.name_en, name_ar: i.name_ar, qty: i.qty, line_total_cents: i.line_total_cents }))
  });
}

// ---- Routes: contact form ------------------------------------------------------------
const CONTACT_TO = (process.env.CONTACT_NOTIFY_TO || process.env.ORDER_NOTIFY_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const contactLimit = limiter(5, 10 * 60e3);

async function handleContact(req, res) {
  const raw = await readBody(req, 50e3).catch(() => '');
  let d = {};
  try {
    d = (req.headers['content-type'] || '').includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
  } catch (e) { return json(res, 400, { ok: false, error: 'bad body' }); }
  if (clip(d.website, 10)) return json(res, 200, { ok: true });          // honeypot
  const ip = clientIp(req);
  if (!contactLimit(ip)) return json(res, 429, { ok: false, error: 'too many' });

  const name = clip(d.name, 120), email = clip(d.email, 200), message = clip(d.message, 5000), topic = clip(d.topic || 'General', 80);
  if (!name || !message || !isEmail(email)) return json(res, 422, { ok: false, error: 'invalid fields' });

  const r = await db.run('INSERT INTO enquiries (created_at, name, email, topic, message, status, ip) VALUES (?,?,?,?,?,?,?)',
    [Date.now(), name, email, topic, message, 'new', ip]);

  let delivered = false;
  const text = `New website enquiry — ${topic}\nFrom: ${name} <${email}>\n\n${message}\n\nReceived ${new Date().toISOString()}`;
  if (mail.MAIL_READY && CONTACT_TO.length) {
    const h = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    delivered = await mail.sendMailRetrying({
      to: CONTACT_TO, replyTo: `${name} <${email}>`, subject: `Website enquiry — ${topic} — ${name}`, text,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#12242f;max-width:560px">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#c9832a">${h(topic)}</p>
        <p style="margin:0 0 14px"><strong>${h(name)}</strong> &lt;<a href="mailto:${h(email)}">${h(email)}</a>&gt;</p>
        <p style="white-space:pre-wrap;margin:0 0 16px;line-height:1.55">${h(message)}</p>
        <p style="margin:0;font-size:12px;color:#68767f">Reply to this email to answer ${h(name)} directly. It is also in the admin dashboard under Enquiries.</p></div>`
    }, `contact from ${email}`);
  }
  if (!delivered && process.env.CONTACT_WEBHOOK_URL) {
    try {
      const w = await fetch(process.env.CONTACT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, name, email, topic, message }), signal: AbortSignal.timeout(10000) });
      delivered = w.ok;
    } catch (err) { console.error('[contact] webhook failed:', err && err.message); }
  }
  if (delivered) await db.run('UPDATE enquiries SET delivered = 1 WHERE id = ?', [r.insertId]);
  console.log(`[contact] enquiry #${r.insertId} saved${delivered ? ' and delivered' : ''}`);
  return json(res, 200, { ok: true, delivered });
}

// ---- Housekeeping: expire unpaid orders, clear old sessions --------------------------
async function housekeeping() {
  try {
    const hours = (await db.getSetting('unpaid_expiry_hours', 24)) || 24;
    const cutoff = Date.now() - hours * 3600e3;
    const stale = await db.all("SELECT id, status FROM orders WHERE status IN ('pending','awaiting_payment','payment_failed') AND created_at < ? LIMIT 500", [cutoff]);
    for (const o of stale) {
      const r = await db.run("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = ?", [Date.now(), o.id, o.status]);
      if (r.changes) await addEvent(db, o.id, 'system', 'status', o.status, 'expired', `Not paid within ${hours} hours`);
    }
    if (stale.length) console.log(`[orders] ${stale.length} unpaid order(s) marked expired`);
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  } catch (e) { console.error('[housekeeping]', e.message); }
}
function startHousekeeping() {
  setTimeout(housekeeping, 5000).unref();
  setInterval(housekeeping, 10 * 60e3).unref();
}

module.exports = {
  PAYMOB, PAYMOB_READY, STATUS, UNPAID, FULFILMENT, isPaidState,
  getCatalog, invalidateCatalog, priceCart, loadOrder, mailShape, addEvent, moveStock,
  permissionFor, changeStatus, returnToStock, simulatePayment, applyPaymobTransaction, verifyHmac, HMAC_FIELDS,
  handleCheckout, handleWebhook, handleOrderStatus, handleContact, housekeeping, startHousekeeping, shippingSettings
};
