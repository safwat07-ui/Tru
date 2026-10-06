'use strict';
// Small shared helpers: HTTP responses, body parsing, escaping, rate limits.

const MAX_BODY = 1e6;

function send(res, code, type, body, extraHeaders) {
  res.writeHead(code, Object.assign({ 'Content-Type': type }, extraHeaders || {}));
  res.end(body);
}
function json(res, code, obj, extraHeaders) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj),
       Object.assign({ 'Cache-Control': 'no-store' }, extraHeaders || {}));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body_too_large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const egp = c => (Number(c || 0) / 100).toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EGP';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
}

// In-memory sliding-window limiter. Per process — good enough as a spam brake.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) { const f = arr.filter(t => t > cutoff); f.length ? hits.set(k, f) : hits.delete(k); }
  }, Math.max(windowMs, 60e3)).unref();
  return function hit(key) {
    const now = Date.now(), recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now); hits.set(key, recent); return true;
  };
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

module.exports = { send, json, readBody, readJson, esc, egp, clientIp, limiter, clip, isEmail, int };
