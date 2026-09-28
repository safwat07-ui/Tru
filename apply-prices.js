#!/usr/bin/env node
/*
 * apply-prices.js — put your real prices into catalog.json
 *
 *   1. Open prices.csv in Excel.
 *   2. Edit the price_egp column (and in_stock: yes / no).
 *   3. Save it as CSV — same file name, same columns.
 *   4. Run:   node apply-prices.js
 *
 * It rewrites catalog.json in place and tells you exactly what changed.
 * Nothing else in catalog.json is touched. A backup is written first.
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CSV = path.join(DIR, 'prices.csv');
const CAT = path.join(DIR, 'catalog.json');

if (!fs.existsSync(CSV)) { console.error('prices.csv not found next to this script.'); process.exit(1); }

// minimal CSV reader: handles quoted fields and doubled quotes
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const head = rows.shift().map(h => h.trim().toLowerCase());
const iSku = head.indexOf('sku');
const iPrice = head.indexOf('price_egp');
const iStock = head.indexOf('in_stock');
const iName = head.indexOf('name_en');
if (iSku < 0 || iPrice < 0) {
  console.error('prices.csv must have at least the columns: sku, price_egp');
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CAT, 'utf8'));
const bySku = new Map(catalog.products.map(p => [p.sku, p]));

const changes = [], warnings = [];
const drifted = [];
for (const r of rows) {
  const sku = (r[iSku] || '').trim();
  if (!sku) continue;
  const p = bySku.get(sku);
  if (!p) { warnings.push(`unknown SKU in CSV, skipped: ${sku}`); continue; }

  // Safety net: if the name column no longer matches, the row's columns have
  // shifted (usually a quote broken by hand-editing) and the price in this row
  // may belong to a different product. Refuse rather than mis-price it.
  if (iName >= 0 && (r[iName] || '').trim() && (r[iName] || '').trim() !== p.name_en) {
    drifted.push(`${sku}: CSV says "${(r[iName]||'').trim()}", catalogue says "${p.name_en}"`);
    continue;
  }

  const raw = (r[iPrice] || '').trim().replace(/[, ]/g, '').replace(/^(EGP|LE)/i, '');
  const egp = Number(raw);
  if (raw !== '' && Number.isFinite(egp) && egp >= 0) {
    const cents = Math.round(egp * 100);
    if (cents !== p.price_cents) {
      changes.push(`${sku}: ${(p.price_cents/100).toFixed(2)} -> ${(cents/100).toFixed(2)} EGP`);
      p.price_cents = cents;
    }
  } else if (raw !== '') {
    warnings.push(`${sku}: could not read price "${r[iPrice]}", left unchanged`);
  }

  if (iStock >= 0) {
    const s = (r[iStock] || '').trim().toLowerCase();
    if (s) {
      const inStock = !['no', 'n', 'false', '0', 'out'].includes(s);
      if (inStock !== (p.in_stock !== false)) {
        changes.push(`${sku}: ${inStock ? 'back in stock' : 'hidden from shop'}`);
        p.in_stock = inStock;
      }
    }
  }
}

if (drifted.length) {
  console.error(`\nStopped: ${drifted.length} row(s) in prices.csv don't line up with the catalogue.\n`);
  drifted.forEach(d => console.error('  ! ' + d));
  console.error('\nThe columns have shifted, so the prices in those rows may belong to the\n' +
                'wrong products. Nothing was changed. Re-export prices.csv from Excel\n' +
                '(or delete the name_en column) and run this again.');
  process.exit(1);
}

const zero = catalog.products.filter(p => !p.price_cents);
if (zero.length) warnings.push(`${zero.length} product(s) priced at 0 — they will sell for nothing: ${zero.map(p=>p.sku).join(', ')}`);

if (!changes.length) {
  console.log('No changes — catalog.json already matches prices.csv.');
} else {
  fs.copyFileSync(CAT, CAT + '.bak');
  fs.writeFileSync(CAT, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Updated ${changes.length} item(s) in catalog.json (backup: catalog.json.bak)\n`);
  changes.forEach(c => console.log('  ' + c));
}
if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach(w => console.log('  ! ' + w));
}
console.log('\nRestart the site for the new prices to take effect.');
