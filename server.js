'use strict';
/* Coffee ERP / Order Management — single-file production build.
 * Consolidated from the modular sources. Business logic unchanged.
 * Generated: 2026-09-22 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();


/* ---------------- db.js ---------------- */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'erp.db');
let dbConn = null;

function open() {
  if (dbConn) return dbConn;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  dbConn = new sqlite3.Database(DB_PATH);
  dbConn.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  return dbConn;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function initializeDatabase() {
  open();
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff', created_at TEXT DEFAULT (datetime('now'))
    )`,
    // Customer/Ledger master: ONE entity, permanent ledger_id preserved from workbook (CUS...).
    `CREATE TABLE IF NOT EXISTS customers(
      ledger_id TEXT PRIMARY KEY,
      ledger_name TEXT NOT NULL, ledger_name_norm TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      emp_name TEXT, address TEXT, route TEXT, route_day TEXT,
      payment_type TEXT NOT NULL DEFAULT 'Credit',
      mobile TEXT, mobile_norm TEXT, city TEXT, area TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cust_name_norm ON customers(ledger_name_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_cust_mobile ON customers(mobile_norm)`,
    // Product Summary: canonical source. name_norm unique blocks typo-duplicates;
    // size guard lives in match.js so 500 vs 1000 never merge.
    `CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_id TEXT UNIQUE, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE,
      uom TEXT NOT NULL DEFAULT 'KG', status TEXT NOT NULL DEFAULT 'Active',
      std_price REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`,
    // Approved blends: customer-specific (ledger_id, product_id).
    `CREATE TABLE IF NOT EXISTS approvals(
      ledger_id TEXT NOT NULL REFERENCES customers(ledger_id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ledger_id, product_id)
    )`,
    // Customer-specific negotiated pricing.
    `CREATE TABLE IF NOT EXISTS customer_prices(
      ledger_id TEXT NOT NULL REFERENCES customers(ledger_id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ledger_id, product_id)
    )`,
    // Orders: single table for the whole lifecycle; stage is DERIVED.
    // order_id permanent (workbook ORD... preserved; new ones ORDYYYYMMDD####).
    `CREATE TABLE IF NOT EXISTS orders(
      order_id TEXT PRIMARY KEY,
      order_date TEXT NOT NULL,
      ledger_id TEXT NOT NULL REFERENCES customers(ledger_id),
      product_id INTEGER REFERENCES products(id),
      blend_snapshot TEXT NOT NULL,
      qty REAL NOT NULL CHECK(qty > 0),
      uom TEXT NOT NULL CHECK(uom IN ('KG','LTR','PAC')),
      route TEXT, route_day TEXT, billing_date TEXT NOT NULL, remarks TEXT,
      payment_type TEXT NOT NULL, payment_status TEXT NOT NULL,
      billing_status TEXT NOT NULL DEFAULT 'Pending',
      billed_at TEXT, billed_by TEXT,
      delivered_on TEXT, delivery_status TEXT NOT NULL DEFAULT 'Pending',
      unit_price REAL DEFAULT 0, total REAL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_ledger ON orders(ledger_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_billing ON orders(billing_status, billing_date)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders(delivery_status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id)`,
    `CREATE TABLE IF NOT EXISTS holidays(
      date TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')), username TEXT, action TEXT NOT NULL,
      entity TEXT, record_id TEXT, old_value TEXT, new_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS error_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')), username TEXT, api_endpoint TEXT,
      action TEXT, http_status INTEGER, message TEXT, details TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
    `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
    // Billing-email incremental tracking: which order lines were already emailed, per day.
    `CREATE TABLE IF NOT EXISTS emailed_lines(order_id TEXT NOT NULL, emailed_date TEXT NOT NULL, emailed_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (order_id, emailed_date))`,
  ];
  for (const s of stmts) await run(s);
  // Migration: billing_date was NOT NULL; it is optional now (blank stays in Tracker).
  const cols = await all(`PRAGMA table_info(orders)`);
  const bd = cols.find((c) => c.name === 'billing_date');
  if (bd && bd.notnull === 1) {
    await run(`CREATE TABLE orders_new(
      order_id TEXT PRIMARY KEY, order_date TEXT NOT NULL, ledger_id TEXT NOT NULL REFERENCES customers(ledger_id),
      product_id INTEGER REFERENCES products(id), blend_snapshot TEXT NOT NULL, qty REAL NOT NULL CHECK(qty > 0),
      uom TEXT NOT NULL CHECK(uom IN ('KG','LTR','PAC')), route TEXT, route_day TEXT, billing_date TEXT, remarks TEXT,
      payment_type TEXT NOT NULL, payment_status TEXT NOT NULL, billing_status TEXT NOT NULL DEFAULT 'Pending',
      billed_at TEXT, billed_by TEXT, delivered_on TEXT, delivery_status TEXT NOT NULL DEFAULT 'Pending',
      unit_price REAL DEFAULT 0, total REAL DEFAULT 0, idempotency_key TEXT UNIQUE,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    await run(`INSERT INTO orders_new SELECT * FROM orders`);
    await run(`DROP TABLE orders`);
    await run(`ALTER TABLE orders_new RENAME TO orders`);
    await run(`CREATE INDEX IF NOT EXISTS idx_orders_ledger ON orders(ledger_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_orders_billing ON orders(billing_status, billing_date)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders(delivery_status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id)`);
  }
}

const DEFAULT_SETTINGS = {
  company_name: 'Coffee ERP',
  company_logo: '',
  billing_email_enabled: 'yes',
  billing_email_recipients: '',
  billing_email_subject: "Today's Billing — ({date})",
  eod_email_enabled: 'yes',
  eod_email_recipients: '',
  eod_email_subject: 'EOD Report — ({date})',
  smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '',
  reminders_enabled: 'yes',
  reminder_weekly_days: '2', reminder_fortnight_days: '5', reminder_monthly_days: '6',
};

async function getSettings() {
  const rows = await all(`SELECT k, v FROM settings`);
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.k] = r.v;
  return out;
}

async function saveSettings(pairs) {
  for (const [k, v] of Object.entries(pairs)) {
    if (k === 'company_logo' && String(v || '').length > 350000) throw new Error('Logo is too large (max ~250KB).');
    await run(`INSERT INTO settings(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, String(v == null ? '' : v)]);
  }
}

async function audit({ username, action, entity, record_id, old_value, new_value }) {
  const j = (v) => (v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
  await run(
    `INSERT INTO audit_log(username, action, entity, record_id, old_value, new_value) VALUES(?,?,?,?,?,?)`,
    [username || null, action, entity || null, record_id || null, j(old_value), j(new_value)]
  );
}
async function logError({ username, api_endpoint, action, http_status, message, details }) {
  const j = (v) => (v === undefined || v === null ? null : (typeof v === 'string' ? v.slice(0, 4000) : JSON.stringify(v).slice(0, 4000)));
  await run(
    `INSERT INTO error_log(username, api_endpoint, action, http_status, message, details) VALUES(?,?,?,?,?,?)`,
    [username || null, api_endpoint || null, action || null, http_status || null, message || null, j(details)]
  );
}

// Module facade (replaces require('./db') used by the original sources).
const db = { open, run, get, all, initializeDatabase, audit, logError, DB_PATH, DEFAULT_SETTINGS, getSettings, saveSettings };

/* ---------------- utils/match.js ---------------- */
// Normalization + fuzzy matching shared by backend routes.
// Customer/Product duplicate protection: exact normalized -> permanent ID ->
// structured-field -> fuzzy (token/levenshtein). Never auto-merge ambiguous.
function normalizeName(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .replace(/[''`'']/g, '')          // drop apostrophes (Cafe' Mondo == Cafe Mondo)
    .replace(/[‐‑‒–—―−]/g, ' ')       // unicode dashes -> space
    .replace(/&/g, ' and ')           // & vs "and"
    .replace(/[-_/.]/g, ' ')          // hyphen/underscore/slash/dot -> space
    .replace(/[^a-z0-9\s]/g, ' ')     // any other punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeId(s) {
  if (s === null || s === undefined) return '';
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizePhone(s) {
  if (s === null || s === undefined) return '';
  let d = String(s).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

// Extract the "size token" (trailing number, e.g. -500 / 1000 / 10x10) so that
// 500 vs 1000 products never merge even when names are otherwise identical.
// Trailing unit letters (200g == 200, 1000ml == 1000) are NOT a size difference.
function sizeToken(s) {
  let t = String(s || '').toLowerCase().replace(/\s+/g, '');
  t = t.replace(/(kilograms?|kilogrammes?|grams?|millilitres?|milliliters?|litres?|liters?|packets?|pieces?|pcs|nos?|kg|ml|ltr|g|l)$/, '');
  const m = t.match(/(\d+\s*x\s*\d+|\d+)\s*$/);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Guard: different size tokens => genuinely different products, cap similarity.
  if (sizeToken(na) !== sizeToken(nb)) return 0.4;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

// Flexible date parser for bulk uploads: Excel serials, ISO, DD-MM-YYYY,
// DD/MM/YYYY, YYYY/MM/DD, DD-Mon-YYYY ("15-Sep-2026"). Returns YYYY-MM-DD or null.
const MON3 = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function parseFlexDate(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000) + 12 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  // Excel serial, as number or numeric string from CSV.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Math.round((n - 25569) * 86400 * 1000) + 12 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    // Indian convention: DD-MM-YYYY. dd > 12 confirms DD-MM (keep);
    // mm > 12 with dd <= 12 means it was MM-DD (swap).
    let dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
    if (parseInt(dd, 10) <= 12 && parseInt(mm, 10) > 12) { const t = dd; dd = mm; mm = t; }
    if (parseInt(mm, 10) < 1 || parseInt(mm, 10) > 12 || parseInt(dd, 10) < 1 || parseInt(dd, 10) > 31) return null;
    return `${y}-${mm}-${dd}`;
  }
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{2,4})/);
  if (m && MON3[m[2].slice(0, 3).toLowerCase()]) {
    let y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    return `${y}-${MON3[m[2].slice(0, 3).toLowerCase()]}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3,9})[\s\-]+(\d{1,2}),?[\s\-]+(\d{2,4})/);
  if (m && MON3[m[1].slice(0, 3).toLowerCase()]) {
    let y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    return `${y}-${MON3[m[1].slice(0, 3).toLowerCase()]}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

// Closest-match resolution over master candidates.
// Returns {status, match, score}:
//   'exact'     — normalized equality (score 1)
//   'matched'   — strong (score>=STRONG) and unambiguous (gap>=GAP to runner-up)
//   'ambiguous' — two+ candidates similarly close; do NOT guess
//   'review'    — best in gray zone [GRAY,STRONG); possible but unsafe
//   'none'      — nothing close enough
// Size-token guard (via similarity) keeps genuinely different products apart.
const MATCH_STRONG = 0.85, MATCH_GRAY = 0.6, MATCH_GAP = 0.05;
// Filler words that may be dropped/added without changing identity
// ("Iruve Bake Brew" == "Iruve Bake & Brew").
const FILLER_TOKENS = new Set(['and', 'the', 'of', 'a', 'an']);
function subsetScore(na, nb) {
  const ta = na.split(' '), tb = nb.split(' ');
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  if (!small.every((t) => bigSet.has(t))) return 0;
  const extra = big.filter((t) => !small.includes(t));
  if (extra.length && extra.every((t) => FILLER_TOKENS.has(t))) return 0.9;
  return 0;
}
function bestMatch(input, candidates, getName) {
  const norm = normalizeName(input);
  if (!norm) return { status: 'none', match: null, score: 0 };
  const get = getName || ((c) => (typeof c === 'string' ? c : c.name));
  let exact = null;
  const scored = [];
  for (const c of candidates) {
    const nm = get(c);
    if (normalizeName(nm) === norm) { exact = c; break; }
    const nn = normalizeName(nm);
    const s = Math.max(similarity(norm, nn), subsetScore(norm, nn));
    scored.push({ c, name: nm, score: s });
  }
  if (exact) return { status: 'exact', match: exact, score: 1 };
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < MATCH_GRAY) return { status: 'none', match: null, score: top ? top.score : 0 };
  const second = scored[1];
  if (top.score >= MATCH_STRONG && (!second || second.score < MATCH_GRAY || top.score - second.score >= MATCH_GAP)) {
    return { status: 'matched', match: top.c, score: +top.score.toFixed(2) };
  }
  if (top.score >= MATCH_STRONG) {
    return { status: 'ambiguous', match: null, score: +top.score.toFixed(2), candidates: scored.slice(0, 3).map((s) => s.name) };
  }
  return { status: 'review', match: null, score: +top.score.toFixed(2), candidates: scored.slice(0, 3).map((s) => s.name) };
}

/* ---------------- utils/workflow.js ---------------- */
// Exact workbook workflow, enforced server-side. Stage is DERIVED from row state:
//   Order Tracker   = billing_status Pending AND NOT eligible for today's billing
//   Today's Billing = billing_status Pending AND billing_date <= today AND payment OK
//   Pending Delivery= billing_status Billed AND delivery_status != Delivered
//   Delivered Orders= delivery_status Delivered
// Advance: payment_status must be 'Payment Received'. Credit: 'Credit'.
const UOMS = ['KG', 'LTR', 'PAC'];

function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function paymentOK(order) {
  if (order.payment_type === 'Credit') return order.payment_status === 'Credit';
  return order.payment_status === 'Payment Received'; // Advance
}

function isEligibleToday(order, today = todayISO()) {
  if (order.billing_status !== 'Pending') return false;
  if (!order.billing_date) return false; // blank stays in Order Tracker — never auto-set
  if (order.billing_date > today) return false; // future billing date stays in tracker
  return paymentOK(order);
}

function stageOf(order, today = todayISO()) {
  if (order.delivery_status === 'Delivered') return 'delivered';
  if (order.billing_status === 'Billed') return 'pending_delivery';
  if (isEligibleToday(order, today)) return 'todays_billing';
  return 'tracker';
}

// Why is this tracker order still waiting? Shown in Order Tracker UI.
function waitingReason(order, today = todayISO()) {
  if (order.billing_status !== 'Pending') return '';
  if (!order.billing_date) return 'Billing Date not set';
  if (order.billing_date > today) return `Billing date ${order.billing_date} is in the future`;
  if (!paymentOK(order)) {
    if (order.payment_type === 'Advance') return 'Advance payment not received';
    return `Payment status must be Credit`;
  }
  return 'Ready for billing';
}

function validateOrderInput(b) {
  const errs = [];
  if (!b.ledger_id) errs.push('Customer/Ledger is required');
  if (!b.blend && !b.product_id) errs.push('Blend is required');
  const q = Number(b.qty);
  if (b.qty === undefined || b.qty === '' || !Number.isFinite(q)) errs.push('Quantity must be numeric');
  else if (q <= 0) errs.push('Quantity must be greater than zero');
  if (!UOMS.includes(b.uom)) errs.push('UOM must be one of KG, LTR, PAC');
  // Billing Date is OPTIONAL: blank stays in Order Tracker; never auto-set.
  if (b.billing_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.billing_date)) errs.push('Billing Date is invalid (YYYY-MM-DD)');
  if (b.payment_status && !['Credit', 'Payment Received', 'Pending'].includes(b.payment_status)) errs.push('Invalid Payment Status');
  return errs;
}

/* ---------------- utils/duplicates.js ---------------- */
// Central duplicate engine: Ledger + Order Date + Quantity + Blend.
// Normalized: ledger by permanent ID, date as ISO value, qty numeric,
// blend by canonical product ID. Used by manual entry, edit, and all bulk.

function dupKey(ledger_id, order_date, qty, product_id) {
  return `${ledger_id}|${order_date || ''}|${Number(qty)}|${product_id}`;
}

// Find an existing order with the same business identity.
// exclude_order_id: the order being edited (never flags itself).
async function findOrderDuplicate({ ledger_id, order_date, qty, product_id, exclude_order_id }) {
  if (!ledger_id || !order_date || !product_id || !Number.isFinite(Number(qty))) return null;
  const rows = await db.all(
    `SELECT order_id, ledger_id, order_date, qty, product_id, blend_snapshot FROM orders
     WHERE ledger_id=? AND order_date=? AND product_id=?`,
    [ledger_id, order_date, product_id]);
  const want = Number(qty);
  for (const r of rows) {
    if (exclude_order_id && r.order_id === exclude_order_id) continue;
    if (Number(r.qty) === want) return r;
  }
  return null;
}

function dupMessage(dup) {
  return `Duplicate — Already exists as ${dup.order_id} (same Ledger, Order Date, Quantity and Blend).`;
}

/* ---------------- utils/resolve.js ---------------- */
// Shared closest-match resolvers for ledgers + blends.
// Same logic for bulk upload and manual entry (§12 consistency).
// Ledger: exact ID -> exact name -> fuzzy (strong+unambiguous) -> nhu (create-candidate) / review / none.
// Blend: exact -> fuzzy (strong+unambiguous) -> review/ambiguous/none (never auto-created).


async function resolveLedger(input, lists) {
  // input: {ledger_id?, ledger_name?} -> {status, customer?, score?, candidates?, createName?}
  const id = (input.ledger_id || '').trim();
  if (id) {
    const byId = lists
      ? lists.customers.find((c) => c.ledger_id === id) || null
      : await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [id]);
    if (byId) return { status: 'exact', customer: byId, score: 1 };
  }
  const name = (input.ledger_name || '').trim();
  if (!name) return { status: 'none', customer: null, score: 0 };
  const norm = normalizeName(name);
  const all = lists ? lists.customers : await db.all(`SELECT * FROM customers LIMIT 2000`);
  const exact = all.find((c) => (c.ledger_name_norm || normalizeName(c.ledger_name)) === norm);
  if (exact) return { status: 'exact', customer: exact, score: 1 };
  const r = bestMatch(name, all, (c) => c.ledger_name);
  if (r.status === 'exact') return { status: 'exact', customer: r.match, score: 1 };
  if (r.status === 'matched') return { status: 'matched', customer: r.match, score: r.score };
  if (r.status === 'ambiguous') {
    return { status: 'ambiguous', customer: null, score: r.score, candidates: r.candidates,
      message: `Manual review required — "${name}" is similarly close to: ${r.candidates.join('; ')}.` };
  }
  if (r.status === 'review') {
    return { status: 'review', customer: null, score: r.score, candidates: r.candidates,
      message: `Possible match for "${name}": ${r.candidates.join('; ')}. Manual review required — not auto-mapped, not created.` };
  }
  return { status: 'none', customer: null, score: 0, createName: name };
}

async function resolveBlend(input, lists) {
  // input: blend text -> {status, product?, score?, ...}. Never creates products.
  const text = (input || '').trim();
  if (!text) return { status: 'none', product: null, score: 0, message: 'Blend Name is required.' };
  const norm = normalizeName(text);
  const all = lists ? lists.products : await db.all(`SELECT * FROM products LIMIT 2000`);
  const exact = all.find((p) => (p.name_norm || normalizeName(p.name)) === norm);
  if (exact) return { status: 'exact', product: exact, score: 1 };
  const r = bestMatch(text, all, (p) => p.name);
  if (r.status === 'exact') return { status: 'exact', product: r.match, score: 1 };
  if (r.status === 'matched') return { status: 'matched', product: r.match, score: r.score };
  if (r.status === 'ambiguous') {
    return { status: 'ambiguous', product: null, score: r.score, candidates: r.candidates,
      message: `Manual review required — "${text}" is similarly close to: ${r.candidates.join('; ')}.` };
  }
  if (r.status === 'review') {
    return { status: 'review', product: null, score: r.score, candidates: r.candidates,
      message: `"${text}" is close to ${r.candidates.join('; ')} but not reliable. Correct it or add the product first.` };
  }
  return { status: 'none', product: null, score: 0, message: `No reliable match found for blend "${text}". Correct it or add the product first.` };
}

/* ---------------- middleware/auth.js ---------------- */
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'coffee-erp-dev-secret-change-me');
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable must be set in production.');
const JWT_TTL = process.env.JWT_TTL || '12h';

async function ensureAdmin() {
  const row = await db.get(`SELECT * FROM users WHERE username='admin'`);
  if (!row) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.run(`INSERT INTO users(username, password_hash, role) VALUES('admin', ?, 'admin')`, [hash]);
  }
  const staff = await db.get(`SELECT * FROM users WHERE username='staff'`);
  if (!staff) {
    const hash = bcrypt.hashSync('staff123', 10);
    await db.run(`INSERT INTO users(username, password_hash, role) VALUES('staff', ?, 'staff')`, [hash]);
  }
}

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, data: [], message: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, data: [], message: 'Session expired. Please log in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, data: [], message: 'You do not have permission for this action.' });
    }
    next();
  };
}

/* ---------------- services/mailer.js ---------------- */
// Email scheduler: Billing 10:00 AM (incremental), EOD 6:00 PM (no Sun/holidays).
// Runs inside the server process; checks once a minute, sends once per day.



function subject(fill, date) {
  return String(fill || '').replace('{date}', date).replace('(date)', date);
}

function splitRecips(s) {
  return String(s || '').split(',').map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
}

function transporter(s) {
  if (!s.smtp_host) return null;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: parseInt(s.smtp_port, 10) || 587,
    secure: parseInt(s.smtp_port, 10) === 465,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
  });
}

async function billingLines(today) {
  const rows = await db.all(
    `SELECT o.*, c.ledger_name FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id`);
  return rows.filter((o) => stageOf(o, today) === 'todays_billing');
}

function formatBilling(s, lines, today) {
  const out = [`${s.company_name} — Today's Billing (${today})`, ''];
  for (const l of lines) {
    out.push([l.order_id, l.order_date, l.ledger_name, l.blend_snapshot, l.qty, l.uom,
      l.route, l.route_day, l.billing_date, l.payment_status, l.billing_status, l.remarks || ''].join(' | '));
  }
  out.push('', `${lines.length} order line(s).`);
  return out.join('\n');
}

async function runBillingEmail(today) {
  const s = await db.getSettings();
  if (String(s.billing_email_enabled).toLowerCase() === 'no') return { sent: 0, reason: 'disabled' };
  const to = splitRecips(s.billing_email_recipients);
  if (!to.length) return { sent: 0, reason: 'no recipients' };
  const t = transporter(s);
  if (!t) return { sent: 0, reason: 'no SMTP configured' };
  const lines = await billingLines(today);
  const emailed = await db.all(`SELECT order_id FROM emailed_lines WHERE emailed_date=?`, [today]);
  const seen = new Set(emailed.map((r) => r.order_id));
  const fresh = lines.filter((l) => !seen.has(l.order_id));
  if (!fresh.length) return { sent: 0, reason: 'nothing new' };
  try {
    await t.sendMail({ from: s.smtp_user || 'coffee-erp', to: to.join(','), subject: subject(s.billing_email_subject, today) || `Today's Billing — (${today})`, text: formatBilling(s, fresh, today) });
  } catch (e) {
    await db.logError({ username: 'scheduler', api_endpoint: 'billing-email', action: 'send', http_status: 500, message: e.message });
    return { sent: 0, reason: 'send failed: ' + e.message };
  }
  for (const l of fresh) {
    await db.run(`INSERT OR IGNORE INTO emailed_lines(order_id, emailed_date) VALUES(?,?)`, [l.order_id, today]);
  }
  await db.audit({ username: 'scheduler', action: 'BILLING_EMAIL_SENT', entity: 'orders', record_id: `${fresh.length} line(s)` });
  return { sent: fresh.length };
}

async function runEodEmail(today) {
  const s = await db.getSettings();
  if (String(s.eod_email_enabled).toLowerCase() === 'no') return { sent: 0, reason: 'disabled' };
  const d = new Date(today + 'T12:00:00');
  if (d.getDay() === 0) {
    await db.audit({ username: 'scheduler', action: 'EOD_EMAIL_SKIPPED', entity: 'orders', record_id: 'Sunday' });
    return { sent: 0, reason: 'Sunday — skipped, no catch-up' };
  }
  const h = await db.get(`SELECT name FROM holidays WHERE date=?`, [today]);
  if (h) {
    await db.audit({ username: 'scheduler', action: 'EOD_EMAIL_SKIPPED', entity: 'orders', record_id: h.name });
    return { sent: 0, reason: `${h.name} — skipped, no catch-up` };
  }
  const to = splitRecips(s.eod_email_recipients);
  if (!to.length) return { sent: 0, reason: 'no recipients' };
  const t = transporter(s);
  if (!t) return { sent: 0, reason: 'no SMTP configured' };
  const orders = await db.all(`SELECT * FROM orders`);
  let billed = 0, billedQty = 0, delivered = 0, deliveredQty = 0, pending = 0;
  for (const o of orders) {
    const st = stageOf(o, today);
    if (st === 'pending_delivery') pending++;
    if (o.billing_status === 'Billed' && (o.order_date === today || o.billing_date === today)) { billed++; billedQty += Number(o.qty); }
    if (o.delivered_on === today) { delivered++; deliveredQty += Number(o.qty); }
  }
  const body = [`${s.company_name} — End of Day Report (${today})`, '',
    `Billed today: ${billed} line(s), ${billedQty} qty`,
    `Delivered today: ${delivered} line(s), ${deliveredQty} qty`,
    `Pending delivery: ${pending} line(s)`].join('\n');
  try {
    await t.sendMail({ from: s.smtp_user || 'coffee-erp', to: to.join(','), subject: subject(s.eod_email_subject, today) || `EOD Report — (${today})`, text: body });
  } catch (e) {
    await db.logError({ username: 'scheduler', api_endpoint: 'eod-email', action: 'send', http_status: 500, message: e.message });
    return { sent: 0, reason: 'send failed: ' + e.message };
  }
  await db.audit({ username: 'scheduler', action: 'EOD_EMAIL_SENT', entity: 'orders', record_id: today });
  return { sent: 1 };
}

const lastRun = { billing: '', eod: '' };

function checkSchedules() {
  (async () => {
    try {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = todayISO();
      // Window-based (not exact-minute): survives restarts and slow ticks.
      // Each job still runs at most once per day.
      if (hm >= '10:00' && lastRun.billing !== today) {
        lastRun.billing = today;
        await runBillingEmail(today);
      }
      if (hm >= '18:00' && lastRun.eod !== today) {
        lastRun.eod = today;
        await runEodEmail(today);
      }
    } catch (e) {
      try { await db.logError({ username: 'scheduler', api_endpoint: 'scheduler', action: 'tick', http_status: 500, message: e.message }); } catch {}
    }
  })();
}

async function schedulerStatus() {
  const rows = await db.all(
    `SELECT ts, action, record_id FROM audit_log WHERE action LIKE '%EMAIL%' ORDER BY id DESC LIMIT 10`);
  return { now: new Date().toISOString(), lastRuns: lastRun, recent: rows };
}

async function sendTestEmail(kind) {
  const s = await db.getSettings();
  const t = transporter(s);
  if (!t) {
    const host = (s.smtp_host || '').trim();
    if (!host) throw new Error('SMTP Host is empty. Enter your provider host (e.g. smtp.gmail.com) in Settings.');
    if (/.+@.+\..+/.test(host)) throw new Error(`SMTP Host "${host}" looks like an email address. Enter the server host, e.g. smtp.gmail.com — not an email ID.`);
  }
  const key = kind === 'eod' ? 'eod_email_recipients' : 'billing_email_recipients';
  const to = splitRecips(s[key]);
  if (!to.length) throw new Error('No recipients configured for this email in Settings.');
  const info = await t.sendMail({
    from: s.smtp_user || 'coffee-erp',
    to: to.join(','),
    subject: `[TEST] ${subject(kind === 'eod' ? s.eod_email_subject : s.billing_email_subject, todayISO())}`,
    text: `Test email from ${s.company_name} Coffee ERP (${kind}). If you received this, scheduled emails will work.`,
  });
  await db.audit({ username: 'admin', action: 'TEST_EMAIL_SENT', entity: 'settings', record_id: `${kind} → ${to.join(',')}` });
  return { sent: 1, messageId: info.messageId };
}

function startScheduler() {
  setInterval(checkSchedules, 60 * 1000);
}

/* ---------------- routes/_guard.js ---------------- */
const adminOnly = [authenticate, requireRole('admin')];
const staffOnly = [authenticate, requireRole('admin', 'staff')];

/* ---------------- routes/auth.routes.js ---------------- */
const authRouter = express.Router();

authRouter.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await db.get(`SELECT * FROM users WHERE username=?`, [String(username || '').trim()]);
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      await db.logError({ username: username || '', api_endpoint: '/api/auth/login', action: 'login', http_status: 401, message: 'Invalid login attempt' });
      return res.status(401).json({ success: false, data: [], message: 'Invalid username or password' });
    }
    const token = sign(user);
    res.json({ success: true, data: [{ token, username: user.username, role: user.role }], message: 'Logged in' });
  } catch (e) { next(e); }
});

authRouter.post('/users', adminOnly, async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, data: [], message: 'Username and password required' });
    const hash = bcrypt.hashSync(String(password), 10);
    await db.run(`INSERT INTO users(username, password_hash, role) VALUES(?,?,?)`,
      [String(username).trim(), hash, role === 'admin' ? 'admin' : 'staff']);
    await db.audit({ username: req.user.username, action: 'USER_CREATED', entity: 'users', record_id: username });
    res.json({ success: true, data: [], message: 'User created' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ success: false, data: [], message: 'Username already exists' });
    next(e);
  }
});

authRouter.get('/users', adminOnly, async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT id, username, role, created_at FROM users ORDER BY username`);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

/* ---------------- routes/customer.routes.js ---------------- */
const customerRouter = express.Router();

// List with server-side search + pagination (never dump whole DB to browser).
customerRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const off = (page - 1) * limit;
    const where = [];
    const params = [];
    if (q) {
      where.push(`(ledger_name LIKE ? OR ledger_id LIKE ? OR mobile LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (req.query.status) { where.push(`status=?`); params.push(req.query.status); }
    if (req.query.payment_type) { where.push(`payment_type=?`); params.push(req.query.payment_type); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await db.get(`SELECT COUNT(*) c FROM customers ${w}`, params)).c;
    const rows = await db.all(`SELECT * FROM customers ${w} ORDER BY ledger_name LIMIT ? OFFSET ?`, [...params, limit, off]);
    // attach approved blend names
    for (const r of rows) {
      r.approved_blends = (await db.all(
        `SELECT p.id, p.name FROM approvals a JOIN products p ON p.id=a.product_id WHERE a.ledger_id=? ORDER BY p.name`, [r.ledger_id]
      )).map(x => x.name);
    }
    res.json({ success: true, data: rows, total, page, message: '' });
  } catch (e) { next(e); }
});

// Approved blends for one customer (order form dropdown source).
customerRouter.get('/:id/blends', staffOnly, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT p.id, p.name, p.uom, COALESCE(cp.price, p.std_price, 0) price
       FROM approvals a JOIN products p ON p.id=a.product_id
       LEFT JOIN customer_prices cp ON cp.ledger_id=a.ledger_id AND cp.product_id=a.product_id
       WHERE a.ledger_id=? ORDER BY p.name`, [req.params.id]);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

// Duplicate check: exact normalized -> ID -> phone -> fuzzy. Returns candidates for user decision.
customerRouter.post('/check-duplicate', staffOnly, async (req, res, next) => {
  try {
    const { ledger_name, mobile, ledger_id } = req.body || {};
    const norm = normalizeName(ledger_name || '');
    const matches = [];
    if (ledger_id) {
      const byId = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [ledger_id]);
      if (byId) matches.push({ level: 'permanent_id', customer: byId });
    }
    if (norm) {
      const exact = await db.all(`SELECT * FROM customers WHERE ledger_name_norm=?`, [norm]);
      for (const c of exact) if (!matches.find(m => m.customer.ledger_id === c.ledger_id)) matches.push({ level: 'exact_normalized', customer: c });
    }
    const ph = normalizePhone(mobile || '');
    if (ph) {
      const byPh = await db.all(`SELECT * FROM customers WHERE mobile_norm=? AND mobile_norm!=''`, [ph]);
      for (const c of byPh) if (!matches.find(m => m.customer.ledger_id === c.ledger_id)) matches.push({ level: 'phone_match', customer: c });
    }
    // fuzzy over names (bounded scan; 91-row master is tiny, paginated fallback for larger)
    if (norm && matches.length === 0) {
      const allC = await db.all(`SELECT * FROM customers LIMIT 2000`);
      for (const c of allC) {
        const s = similarity(norm, c.ledger_name_norm);
        if (s >= 0.82) matches.push({ level: 'fuzzy', score: +s.toFixed(2), customer: c });
      }
      matches.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    res.json({ success: true, data: matches.slice(0, 10), message: '' });
  } catch (e) { next(e); }
});


customerRouter.post('/', staffOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.ledger_name || !String(b.ledger_name).trim()) return res.status(400).json({ success: false, data: [], message: 'Customer/Ledger Name is required' });
    if (b.payment_type && !['Advance', 'Credit'].includes(b.payment_type)) return res.status(400).json({ success: false, data: [], message: 'Payment Type must be Advance or Credit' });
    const norm = normalizeName(b.ledger_name);
    const dup = await db.get(`SELECT ledger_id FROM customers WHERE ledger_name_norm=?`, [norm]);
    if (dup) return res.status(409).json({ success: false, data: [dup], message: `Possible duplicate of ${dup.ledger_id}. Editing the existing customer keeps the same ID.` });
    const id = await sharedNextLedgerId(); // shared helper (import section, hoisted)
    const now = new Date().toISOString();
    await db.run(`INSERT INTO customers(ledger_id, ledger_name, ledger_name_norm, status, emp_name, address, route, route_day, payment_type, mobile, mobile_norm, city, area, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, String(b.ledger_name).trim(), norm, b.status || 'Active', b.emp_name || null, b.address || null, b.route || null, b.route_day || null,
       b.payment_type || 'Credit', b.mobile || null, normalizePhone(b.mobile || ''), b.city || null, b.area || null, now]);
    await db.audit({ username: req.user.username, action: 'CUSTOMER_CREATED', entity: 'customers', record_id: id, new_value: b });
    res.json({ success: true, data: [{ ledger_id: id }], message: 'Customer created with permanent ID ' + id });
  } catch (e) { next(e); }
});

// Edit NEVER creates a new customer: ledger_id in path is immutable.
customerRouter.put('/:id', staffOnly, async (req, res, next) => {
  try {
    const old = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [req.params.id]);
    if (!old) return res.status(404).json({ success: false, data: [], message: 'Customer not found' });
    const b = req.body || {};
    if (b.ledger_id && b.ledger_id !== req.params.id) return res.status(400).json({ success: false, data: [], message: 'Customer/Ledger ID is permanent and cannot change' });
    if (b.payment_type && !['Advance', 'Credit'].includes(b.payment_type)) return res.status(400).json({ success: false, data: [], message: 'Payment Type must be Advance or Credit' });
    const name = b.ledger_name !== undefined ? String(b.ledger_name).trim() : old.ledger_name;
    if (!name) return res.status(400).json({ success: false, data: [], message: 'Customer/Ledger Name is required' });
    const norm = normalizeName(name);
    const clash = await db.get(`SELECT ledger_id FROM customers WHERE ledger_name_norm=? AND ledger_id!=?`, [norm, req.params.id]);
    if (clash) return res.status(409).json({ success: false, data: [clash], message: `That name matches existing customer ${clash.ledger_id}. Merge instead of duplicating.` });
    await db.run(`UPDATE customers SET ledger_name=?, ledger_name_norm=?, status=?, emp_name=?, address=?, route=?, route_day=?, payment_type=?, mobile=?, mobile_norm=?, city=?, area=?, updated_at=? WHERE ledger_id=?`,
      [name, norm, b.status || old.status, b.emp_name !== undefined ? b.emp_name : old.emp_name, b.address !== undefined ? b.address : old.address,
       b.route !== undefined ? b.route : old.route, b.route_day !== undefined ? b.route_day : old.route_day,
       b.payment_type || old.payment_type, b.mobile !== undefined ? b.mobile : old.mobile,
       b.mobile !== undefined ? normalizePhone(b.mobile || '') : old.mobile_norm,
       b.city !== undefined ? b.city : old.city, b.area !== undefined ? b.area : old.area, new Date().toISOString(), req.params.id]);
    await db.audit({ username: req.user.username, action: 'CUSTOMER_EDITED', entity: 'customers', record_id: req.params.id, old_value: old, new_value: b });
    res.json({ success: true, data: [], message: 'Customer updated (same permanent ID)' });
  } catch (e) { next(e); }
});

// Replace approval set for a customer.
customerRouter.put('/:id/approvals', staffOnly, async (req, res, next) => {
  try {
    const cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [req.params.id]);
    if (!cust) return res.status(404).json({ success: false, data: [], message: 'Customer not found' });
    const ids = Array.isArray(req.body.product_ids) ? req.body.product_ids : [];
    for (const pid of ids) {
      const p = await db.get(`SELECT id FROM products WHERE id=?`, [pid]);
      if (!p) return res.status(400).json({ success: false, data: [], message: `Unknown product id ${pid}` });
    }
    await db.run(`DELETE FROM approvals WHERE ledger_id=?`, [req.params.id]);
    for (const pid of ids) await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [req.params.id, pid]);
    await db.audit({ username: req.user.username, action: 'APPROVALS_CHANGED', entity: 'approvals', record_id: req.params.id, new_value: ids });
    res.json({ success: true, data: [], message: 'Approved blends updated' });
  } catch (e) { next(e); }
});

// Customer-specific pricing upsert.
customerRouter.put('/:id/prices', staffOnly, async (req, res, next) => {
  try {
    const cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [req.params.id]);
    if (!cust) return res.status(404).json({ success: false, data: [], message: 'Customer not found' });
    const prices = req.body.prices || {};
    for (const [pid, price] of Object.entries(prices)) {
      const p = Number(price);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ success: false, data: [], message: `Invalid price for product ${pid}` });
      await db.run(`INSERT INTO customer_prices(ledger_id, product_id, price) VALUES(?,?,?)
        ON CONFLICT(ledger_id, product_id) DO UPDATE SET price=excluded.price, updated_at=datetime('now')`, [req.params.id, Number(pid), p]);
    }
    await db.audit({ username: req.user.username, action: 'PRICING_CHANGED', entity: 'customer_prices', record_id: req.params.id, new_value: prices });
    res.json({ success: true, data: [], message: 'Pricing updated' });
  } catch (e) { next(e); }
});

customerRouter.get('/:id/prices', staffOnly, async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT product_id, price FROM customer_prices WHERE ledger_id=?`, [req.params.id]);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

// DELETE — admin only. Blocked while orders reference the customer.
customerRouter.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    const cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [req.params.id]);
    if (!cust) return res.status(404).json({ success: false, data: [], message: 'Customer not found' });
    const used = await db.get(`SELECT COUNT(*) c FROM orders WHERE ledger_id=?`, [req.params.id]);
    if (used.c > 0) {
      return res.status(400).json({ success: false, data: [], message: `Cannot delete: ${used.c} order(s) reference this customer.` });
    }
    await db.run(`DELETE FROM approvals WHERE ledger_id=?`, [req.params.id]);
    await db.run(`DELETE FROM customer_prices WHERE ledger_id=?`, [req.params.id]);
    await db.run(`DELETE FROM customers WHERE ledger_id=?`, [req.params.id]);
    await db.audit({ username: req.user.username, action: 'CUSTOMER_DELETED', entity: 'customers', record_id: req.params.id, old_value: cust });
    res.json({ success: true, data: [], message: `Customer ${req.params.id} deleted by admin` });
  } catch (e) { next(e); }
});

/* ---------------- routes/product.routes.js ---------------- */
const productRouter = express.Router();

productRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const off = (page - 1) * limit;
    const masters = await db.all(`SELECT * FROM products ORDER BY name`);
    // Order stats per blend, fuzzy-resolved to the canonical master product
    // so spelling variants never create duplicate summary entries.
    const lines = await db.all(`SELECT blend_snapshot, COUNT(*) n, COALESCE(SUM(qty),0) q FROM orders GROUP BY blend_snapshot`);
    const byNorm = new Map();
    for (const p of masters) byNorm.set(p.name_norm, p);
    const stats = new Map(); // productId -> {orders, qty}
    const extra = new Map(); // normName -> {name, orders, qty} for blends with no master row
    for (const l of lines) {
      const raw = (l.blend_snapshot || '').trim();
      if (!raw) continue;
      const norm = normalizeName(raw);
      const direct = byNorm.get(norm);
      if (direct) {
        const s = stats.get(direct.id) || { orders: 0, qty: 0 };
        s.orders += l.n; s.qty += Number(l.q);
        stats.set(direct.id, s);
        continue;
      }
      const r = bestMatch(raw, masters, (p) => p.name);
      if (r.status === 'matched' || r.status === 'exact') {
        const s = stats.get(r.match.id) || { orders: 0, qty: 0 };
        s.orders += l.n; s.qty += Number(l.q);
        stats.set(r.match.id, s);
        continue;
      }
      const e = extra.get(norm) || { name: raw, orders: 0, qty: 0 };
      e.orders += l.n; e.qty += Number(l.q);
      if (raw.length < e.name.length) e.name = raw;
      extra.set(norm, e);
    }
    let rows = masters.map((p) => ({
      ...p,
      total_orders: (stats.get(p.id) || {}).orders || 0,
      total_qty: (stats.get(p.id) || {}).qty || 0,
      source: 'master',
    }));
    for (const e of extra.values()) {
      rows.push({
        id: null, sku_id: null, name: e.name, name_norm: null, uom: '', status: 'In orders only',
        std_price: 0, total_orders: e.orders, total_qty: e.qty, source: 'orders',
      });
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (q) {
      const nq = q.toLowerCase();
      rows = rows.filter((p) => (p.name + ' ' + (p.sku_id || '')).toLowerCase().includes(nq));
    }
    const total = rows.length;
    res.json({ success: true, data: rows.slice(off, off + limit), total, page, message: '' });
  } catch (e) { next(e); }
});

// Match a typed blend name to the canonical product (typo-tolerant, size-safe).
productRouter.post('/match', staffOnly, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '');
    const norm = normalizeName(name);
    if (!norm) return res.json({ success: true, data: [], message: '' });
    const exact = await db.get(`SELECT * FROM products WHERE name_norm=?`, [norm]);
    if (exact) return res.json({ success: true, data: [{ ...exact, score: 1, level: 'exact' }], message: '' });
    const allP = await db.all(`SELECT * FROM products WHERE status='Active' LIMIT 2000`);
    const scored = [];
    for (const p of allP) {
      const s = similarity(norm, p.name_norm);
      if (s >= 0.72) scored.push({ ...p, score: +s.toFixed(2), level: 'fuzzy' });
    }
    scored.sort((a, b) => b.score - a.score);
    res.json({ success: true, data: scored.slice(0, 8), message: '' });
  } catch (e) { next(e); }
});

productRouter.post('/', staffOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ success: false, data: [], message: 'Product/Blend name is required' });
    if (b.uom && !['KG', 'LTR', 'PAC'].includes(b.uom)) return res.status(400).json({ success: false, data: [], message: 'UOM must be KG, LTR or PAC' });
    const norm = normalizeName(b.name);
    const dup = await db.get(`SELECT * FROM products WHERE name_norm=?`, [norm]);
    if (dup) return res.status(409).json({ success: false, data: [dup], message: `Matches canonical product "${dup.name}". Use it instead of creating a duplicate.` });
    // fuzzy warning (not a block): surface near-matches so the user decides
    const allP = await db.all(`SELECT * FROM products LIMIT 2000`);
    const near = allP.filter(p => similarity(norm, p.name_norm) >= 0.82).slice(0, 5);
    // Product ID is system-generated, unique and permanent — never typed in.
    let maxSku = 0;
    const skuRows = await db.all(`SELECT sku_id FROM products`);
    for (const r of skuRows) {
      const m = /^SKU(\d+)$/.exec(r.sku_id || '');
      if (m) maxSku = Math.max(maxSku, parseInt(m[1], 10));
    }
    const sku_id = 'SKU' + (maxSku + 1);
    const r = await db.run(`INSERT INTO products(sku_id, name, name_norm, uom, status, std_price) VALUES(?,?,?,?,?,?)`,
      [sku_id, String(b.name).trim(), norm, b.uom || 'KG', b.status || 'Active', Number(b.std_price || 0)]);
    await db.audit({ username: req.user.username, action: 'PRODUCT_CREATED', entity: 'products', record_id: String(r.lastID), new_value: b });
    res.json({ success: true, data: [{ id: r.lastID, near_matches: near.map(p => p.name) }], message: 'Product created' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ success: false, data: [], message: 'A matching canonical product already exists' });
    next(e);
  }
});

productRouter.put('/:id', staffOnly, async (req, res, next) => {
  try {
    const old = await db.get(`SELECT * FROM products WHERE id=?`, [req.params.id]);
    if (!old) return res.status(404).json({ success: false, data: [], message: 'Product not found' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : old.name;
    if (!name) return res.status(400).json({ success: false, data: [], message: 'Product name is required' });
    if (b.uom && !['KG', 'LTR', 'PAC'].includes(b.uom)) return res.status(400).json({ success: false, data: [], message: 'UOM must be KG, LTR or PAC' });
    const norm = normalizeName(name);
    const clash = await db.get(`SELECT id FROM products WHERE name_norm=? AND id!=?`, [norm, req.params.id]);
    if (clash) return res.status(409).json({ success: false, data: [], message: 'That name matches another canonical product' });
    await db.run(`UPDATE products SET name=?, name_norm=?, uom=?, status=?, std_price=?, updated_at=datetime('now') WHERE id=?`,
      [name, norm, b.uom || old.uom, b.status || old.status, b.std_price !== undefined ? Number(b.std_price) : old.std_price, req.params.id]);
    await db.audit({ username: req.user.username, action: 'PRODUCT_EDITED', entity: 'products', record_id: req.params.id, old_value: old, new_value: b });
    res.json({ success: true, data: [], message: 'Product updated' });
  } catch (e) { next(e); }
});

/* ---------------- routes/order.routes.js ---------------- */
const orderRouter = express.Router();

function enrich(rows, today) {
  return rows.map(o => ({ ...o, stage: stageOf(o, today), waiting_reason: waitingReason(o, today) }));
}

// Resolve blend text -> canonical product id (exact, else closest reliable match).
// Returns {id} or {error}. Never invents products.
async function resolveProduct(blendText) {
  const r = await resolveBlend(blendText);
  if (r.status === 'exact' || r.status === 'matched') return { id: r.product.id };
  return { error: r.message || `No reliable match found for blend "${blendText}".` };
}

async function priceFor(ledger_id, product_id) {
  if (!product_id) return { unit: 0 };
  const cp = await db.get(`SELECT price FROM customer_prices WHERE ledger_id=? AND product_id=?`, [ledger_id, product_id]);
  if (cp) return { unit: Number(cp.price), source: 'customer' };
  const p = await db.get(`SELECT std_price FROM products WHERE id=?`, [product_id]);
  return { unit: Number((p && p.std_price) || 0), source: 'standard' };
}

async function nextOrderId(txGet) {
  const today = todayISO().replace(/-/g, '');
  const row = await txGet(`SELECT order_id FROM orders WHERE order_id LIKE 'ORD${today}%' ORDER BY order_id DESC LIMIT 1`);
  let seq = 1;
  if (row) seq = parseInt(row.order_id.slice(-4), 10) + 1;
  return `ORD${today}${String(seq).padStart(4, '0')}`;
}

// List by workflow stage with server-side filters + pagination.
orderRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const today = todayISO();
    const { stage, q, ledger_id, product_id, from, to, page, limit } = req.query;
    const pg = Math.max(1, parseInt(page || '1', 10));
    const lim = Math.min(5000, Math.max(1, parseInt(limit || '50', 10)));
    const where = [];
    const params = [];
    if (ledger_id) { where.push('o.ledger_id=?'); params.push(ledger_id); }
    if (product_id) { where.push('o.product_id=?'); params.push(product_id); }
    if (from) { where.push('o.billing_date>=?'); params.push(from); }
    if (to) { where.push('o.billing_date<=?'); params.push(to); }
    if (q) { where.push('(o.order_id LIKE ? OR c.ledger_name LIKE ? OR o.blend_snapshot LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    let rows = await db.all(
      `SELECT o.*, c.ledger_name, c.payment_type AS cust_payment_type
       FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id ${w}
       ORDER BY o.billing_date, o.created_at LIMIT 2000`, params);
    let data = enrich(rows, today);
    if (stage) data = data.filter(o => o.stage === stage);
    // Delivered Orders: newest on top, oldest at bottom.
    if (stage === 'delivered') {
      data.sort((a, b) => {
        const k = (o) => `${o.billing_date || ''}|${o.delivered_on || ''}|${o.order_id}`;
        return k(b).localeCompare(k(a));
      });
    }
    const total = data.length;
    data = data.slice((pg - 1) * lim, pg * lim);
    res.json({ success: true, data, total, page: pg, today, message: '' });
  } catch (e) { next(e); }
});

orderRouter.get('/:id', staffOnly, async (req, res, next) => {
  try {
    const o = await db.get(`SELECT o.*, c.ledger_name FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id WHERE o.order_id=?`, [req.params.id]);
    if (!o) return res.status(404).json({ success: false, data: [], message: 'Order not found' });
    const today = todayISO();
    res.json({ success: true, data: [{ ...o, stage: stageOf(o, today), waiting_reason: waitingReason(o, today) }], message: '' });
  } catch (e) { next(e); }
});

// CREATE — every new order starts in Order Tracker. Idempotent via idempotency_key.
orderRouter.post('/', staffOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const errs = validateOrderInput(b);
    if (errs.length) return res.status(400).json({ success: false, data: [], message: errs.join('; ') });
    const cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [b.ledger_id]);
    if (!cust) return res.status(400).json({ success: false, data: [], message: 'Unknown Customer/Ledger' });
    const blendText = String(b.blend || '').trim();
    const resolved = b.product_id ? { id: b.product_id } : await resolveProduct(blendText);
    if (!resolved.id) return res.status(400).json({ success: false, data: [], message: resolved.error });
    const product_id = resolved.id;
    // Approved-blend enforcement (backend authority).
    const ap = await db.get(`SELECT 1 FROM approvals WHERE ledger_id=? AND product_id=?`, [b.ledger_id, product_id]);
    if (!ap) return res.status(400).json({ success: false, data: [], message: 'Blend is not approved for this Customer/Ledger' });
    const prod = await db.get(`SELECT * FROM products WHERE id=?`, [product_id]);
    if (b.uom && prod.uom && b.uom !== prod.uom && ['KG', 'LTR', 'PAC'].includes(prod.uom)) {
      // UOM must be valid; product UOM is advisory. Keep strict KG/LTR/PAC only.
    }
    // Payment status defaults from customer type.
    let payment_status = b.payment_status;
    if (!payment_status) payment_status = cust.payment_type === 'Advance' ? 'Pending' : 'Credit';
    if (cust.payment_type === 'Credit' && payment_status !== 'Credit')
      return res.status(400).json({ success: false, data: [], message: 'Credit customers use Payment Status = Credit' });
    if (cust.payment_type === 'Advance' && !['Pending', 'Payment Received'].includes(payment_status))
      return res.status(400).json({ success: false, data: [], message: 'Advance customers use Pending or Payment Received' });
    const idem = b.idempotency_key || crypto.randomUUID();
    const existing = await db.get(`SELECT order_id FROM orders WHERE idempotency_key=?`, [idem]);
    if (existing) return res.json({ success: true, data: [existing], message: 'Duplicate submission ignored (same order)', duplicate: true });
    const pr = await priceFor(b.ledger_id, product_id);
    const qty = Number(b.qty);
    const order_date = b.order_date || todayISO();
    // System-wide duplicate rule: Ledger + Order Date + Quantity + Blend.
    const dup = await findOrderDuplicate({
      ledger_id: b.ledger_id, order_date, qty, product_id,
    });
    if (dup) return res.status(409).json({ success: false, data: [dup], message: dupMessage(dup) });
    const order_id = await nextOrderId(db.get);
    await db.run(`INSERT INTO orders(order_id, order_date, ledger_id, product_id, blend_snapshot, qty, uom, route, route_day,
      billing_date, remarks, payment_type, payment_status, billing_status, delivery_status, unit_price, total, idempotency_key, created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Pending', ?,?,?,?)`,
       [order_id, order_date, b.ledger_id, product_id, prod.name, qty, b.uom, b.route || cust.route, b.route_day || cust.route_day,
        b.billing_date || null, b.remarks || null, cust.payment_type, payment_status, 'Pending', pr.unit, pr.unit * qty, idem, req.user.username]);
    await db.audit({ username: req.user.username, action: 'ORDER_CREATED', entity: 'orders', record_id: order_id, new_value: b });
    res.json({ success: true, data: [{ order_id }], message: `Order ${order_id} created in Order Tracker` });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ success: false, data: [], message: 'Duplicate order submission blocked' });
    next(e);
  }
});

// EDIT — updates the same order_id, revalidates everything incl. blend approval + price.
orderRouter.put('/:id', staffOnly, async (req, res, next) => {
  try {
    const old = await db.get(`SELECT * FROM orders WHERE order_id=?`, [req.params.id]);
    if (!old) return res.status(404).json({ success: false, data: [], message: 'Order not found' });
    if (old.billing_status === 'Billed' || old.delivery_status === 'Delivered')
      return res.status(400).json({ success: false, data: [], message: 'Billed/Delivered orders cannot be edited' });
    const b = req.body || {};
    const ledger_id = b.ledger_id || old.ledger_id;
    const cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [ledger_id]);
    if (!cust) return res.status(400).json({ success: false, data: [], message: 'Unknown Customer/Ledger' });
    const blendText = b.blend !== undefined ? String(b.blend).trim() : old.blend_snapshot;
    let product_id = b.product_id || old.product_id;
    if (b.product_id === undefined && b.blend !== undefined) {
      const resolved = await resolveProduct(blendText);
      if (!resolved.id) return res.status(400).json({ success: false, data: [], message: resolved.error });
      product_id = resolved.id;
    }
    const ap = await db.get(`SELECT 1 FROM approvals WHERE ledger_id=? AND product_id=?`, [ledger_id, product_id]);
    if (!ap) return res.status(400).json({ success: false, data: [], message: 'Blend is not approved for this Customer/Ledger' });
    const merged = {
      qty: b.qty !== undefined ? b.qty : old.qty,
      uom: b.uom || old.uom,
      billing_date: b.billing_date !== undefined ? (b.billing_date || null) : old.billing_date,
      payment_status: b.payment_status || old.payment_status,
    };
    const errs = validateOrderInput({ ledger_id, blend: blendText || 'x', ...merged });
    if (errs.length) return res.status(400).json({ success: false, data: [], message: errs.join('; ') });
    // Edit-into-duplicate: same identity as ANOTHER order is rejected (self excluded).
    const editDup = await findOrderDuplicate({
      ledger_id, order_date: old.order_date, qty: Number(merged.qty), product_id,
      exclude_order_id: req.params.id,
    });
    if (editDup) return res.status(409).json({ success: false, data: [editDup], message: dupMessage(editDup) });
    if (cust.payment_type === 'Credit') merged.payment_status = 'Credit';
    const pr = await priceFor(ledger_id, product_id);
    const prod = await db.get(`SELECT name FROM products WHERE id=?`, [product_id]);
    await db.run(`UPDATE orders SET ledger_id=?, product_id=?, blend_snapshot=?, qty=?, uom=?, route=?, route_day=?,
      billing_date=?, remarks=?, payment_type=?, payment_status=?, unit_price=?, total=?, updated_at=datetime('now') WHERE order_id=?`,
      [ledger_id, product_id, prod ? prod.name : blendText, Number(merged.qty), merged.uom,
       b.route !== undefined ? b.route : old.route, b.route_day !== undefined ? b.route_day : old.route_day,
       merged.billing_date, b.remarks !== undefined ? b.remarks : old.remarks,
       cust.payment_type, merged.payment_status, pr.unit, pr.unit * Number(merged.qty), req.params.id]);
    await db.audit({ username: req.user.username, action: 'ORDER_EDITED', entity: 'orders', record_id: req.params.id, old_value: old, new_value: b });
    res.json({ success: true, data: [], message: 'Order updated (same Order ID)' });
  } catch (e) { next(e); }
});

// Payment status change (Advance: user marks Payment Received once money arrives).
orderRouter.post('/:id/payment', staffOnly, async (req, res, next) => {
  try {
    const o = await db.get(`SELECT * FROM orders WHERE order_id=?`, [req.params.id]);
    if (!o) return res.status(404).json({ success: false, data: [], message: 'Order not found' });
    const { payment_status } = req.body || {};
    if (o.payment_type === 'Credit') return res.status(400).json({ success: false, data: [], message: 'Credit orders stay at Payment Status = Credit' });
    if (!['Pending', 'Payment Received'].includes(payment_status)) return res.status(400).json({ success: false, data: [], message: 'Invalid Payment Status' });
    await db.run(`UPDATE orders SET payment_status=?, updated_at=datetime('now') WHERE order_id=?`, [payment_status, req.params.id]);
    await db.audit({ username: req.user.username, action: 'PAYMENT_STATUS_CHANGED', entity: 'orders', record_id: req.params.id, old_value: o.payment_status, new_value: payment_status });
    res.json({ success: true, data: [], message: `Payment status → ${payment_status}` });
  } catch (e) { next(e); }
});

// BILL — atomic, revalidates eligibility server-side. Concurrent double-bill: only one wins.
orderRouter.post('/:id/bill', staffOnly, async (req, res, next) => {
  try {
    const today = todayISO();
    await db.run('BEGIN IMMEDIATE');
    try {
      const o = await db.get(`SELECT * FROM orders WHERE order_id=?`, [req.params.id]);
      if (!o) { await db.run('ROLLBACK'); return res.status(404).json({ success: false, data: [], message: 'Order not found' }); }
      if (o.billing_status === 'Billed') { await db.run('ROLLBACK'); return res.status(409).json({ success: false, data: [], message: 'Order is already billed — duplicate billing blocked' }); }
      if (o.delivery_status === 'Delivered') { await db.run('ROLLBACK'); return res.status(409).json({ success: false, data: [], message: 'Delivered orders cannot be billed again' }); }
      if (!o.billing_date) { await db.run('ROLLBACK'); return res.status(400).json({ success: false, data: [], message: 'Billing Date is not set' }); }
      if (o.billing_date > today) { await db.run('ROLLBACK'); return res.status(400).json({ success: false, data: [], message: `Billing date ${o.billing_date} is in the future` }); }
      if (o.payment_type === 'Advance' && o.payment_status !== 'Payment Received') {
        await db.run('ROLLBACK');
        return res.status(400).json({ success: false, data: [], message: 'Advance payment not received — order cannot be billed' });
      }
      if (o.payment_type === 'Credit' && o.payment_status !== 'Credit') {
        await db.run('ROLLBACK');
        return res.status(400).json({ success: false, data: [], message: 'Credit order must have Payment Status = Credit' });
      }
      const r = await db.run(`UPDATE orders SET billing_status='Billed', billed_at=datetime('now'), billed_by=?, updated_at=datetime('now')
        WHERE order_id=? AND billing_status='Pending'`, [req.user.username, req.params.id]);
      if (r.changes !== 1) { await db.run('ROLLBACK'); return res.status(409).json({ success: false, data: [], message: 'Order was billed by someone else just now' }); }
      await db.run('COMMIT');
    } catch (e) {
      try { await db.run('ROLLBACK'); } catch {}
      throw e;
    }
    await db.audit({ username: req.user.username, action: 'ORDER_BILLED', entity: 'orders', record_id: req.params.id });
    res.json({ success: true, data: [], message: 'Billed — moved to Pending Delivery' });
  } catch (e) { next(e); }
});

// DELIVER — billed + not delivered -> record date + Delivered.
orderRouter.post('/:id/deliver', staffOnly, async (req, res, next) => {
  try {
    const o = await db.get(`SELECT * FROM orders WHERE order_id=?`, [req.params.id]);
    if (!o) return res.status(404).json({ success: false, data: [], message: 'Order not found' });
    if (o.billing_status !== 'Billed') return res.status(400).json({ success: false, data: [], message: 'Only billed orders can be delivered' });
    if (o.delivery_status === 'Delivered') return res.status(409).json({ success: false, data: [], message: 'Order is already delivered — duplicate delivery blocked' });
    const { delivered_on, delivery_status } = req.body || {};
    if (delivery_status !== 'Delivered') return res.status(400).json({ success: false, data: [], message: 'Delivery Status must be Delivered' });
    if (!delivered_on || !/^\d{4}-\d{2}-\d{2}$/.test(delivered_on)) return res.status(400).json({ success: false, data: [], message: 'Delivered On date is required (YYYY-MM-DD)' });
    await db.run(`UPDATE orders SET delivered_on=?, delivery_status='Delivered', updated_at=datetime('now') WHERE order_id=? AND delivery_status!='Delivered'`, [delivered_on, req.params.id]);
    await db.audit({ username: req.user.username, action: 'ORDER_DELIVERED', entity: 'orders', record_id: req.params.id, new_value: delivered_on });
    res.json({ success: true, data: [], message: 'Delivered — moved to Delivered Orders' });
  } catch (e) { next(e); }
});

// Safe bulk upload: validate -> normalize -> duplicate check -> preview -> confirm import.
orderRouter.post('/bulk/preview', staffOnly, async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, data: [], message: 'No rows supplied' });
    const today = todayISO();
    const preview = [];
    const seenKeys = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const item = { row: i + 1, input: r, status: 'new', issues: [] };
      let cust = r.ledger_id ? await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [r.ledger_id])
        : await db.get(`SELECT * FROM customers WHERE ledger_name_norm=?`, [normalizeName(r.ledger_name || '')]);
      if (!cust && !r.ledger_id && (r.ledger_name || '').trim()) {
        // Closest-match fallback (same engine as delivered bulk).
        const led = await resolveLedger({ ledger_name: r.ledger_name });
        if (led.status === 'matched') {
          cust = led.customer;
          item.matched = [{ field: 'Ledger Name', uploaded: r.ledger_name.trim(), matched_to: cust.ledger_name, status: 'Closest Match', score: led.score }];
          item.issues.push(`Ledger Closest Match: "${r.ledger_name.trim()}" → "${cust.ledger_name}".`);
        } else if (led.status === 'ambiguous' || led.status === 'review') {
          item.status = 'invalid'; item.issues.push(led.message); preview.push(item); continue;
        }
      }
      if (!cust) { item.status = 'invalid'; item.issues.push('Unknown Customer/Ledger — no reliable match found. Correct it or add the customer first.'); }
      else {
        item.ledger_id = cust.ledger_id;
        const resolved = await resolveProduct(r.blend || '');
        if (!resolved.id) { item.status = 'invalid'; item.issues.push(resolved.error); }
        else {
          const pid = resolved.id;
          const ap = await db.get(`SELECT 1 FROM approvals WHERE ledger_id=? AND product_id=?`, [cust.ledger_id, pid]);
          if (!ap) { item.status = 'invalid'; item.issues.push('Blend not approved for customer'); }
          else item.product_id = pid;
        }
        if (cust.payment_type === 'Advance' && (r.payment_status || 'Pending') !== 'Payment Received') item.issues.push('Advance: awaiting Payment Received (will stay in Tracker)');
      }
      const q = Number(r.qty);
      if (!Number.isFinite(q) || q <= 0) { item.status = 'invalid'; item.issues.push('Quantity must be > 0'); }
      if (!UOMS.includes(r.uom)) { item.status = 'invalid'; item.issues.push('UOM must be KG/LTR/PAC'); }
      if (r.billing_date) {
        const iso = parseFlexDate(r.billing_date);
        if (!iso) { item.status = 'invalid'; item.issues.push(`Billing Date "${r.billing_date}" not recognized.`); }
        else r.billing_date = iso;
      }
      if (r.order_date) {
        const iso = parseFlexDate(r.order_date);
        if (!iso) { item.status = 'invalid'; item.issues.push(`Order Date "${r.order_date}" not recognized.`); }
        else r.order_date = iso;
      }
      if (item.status === 'invalid') { preview.push(item); continue; }
      // Duplicate engine: in-file repeats + existing system records.
      const od = r.order_date || todayISO();
      const fkey = item.ledger_id && item.product_id ? dupKey(item.ledger_id, od, Number(r.qty), item.product_id) : null;
      if (fkey && seenKeys.has(fkey)) {
        item.status = 'duplicate';
        item.issues.push('Duplicate — Repeated in uploaded file. Only the first occurrence will be saved.');
      } else {
        if (fkey) seenKeys.add(fkey);
        if (item.ledger_id && item.product_id) {
          const hit = await findOrderDuplicate({ ledger_id: item.ledger_id, order_date: od, qty: Number(r.qty), product_id: item.product_id });
          if (hit) { item.status = 'duplicate'; item.issues.push(dupMessage(hit) + ' Will not be saved.'); }
        }
      }
      if (item.status === 'new' && item.issues.length) item.status = 'valid_with_warnings';
      preview.push(item);
    }
    res.json({ success: true, data: preview, today, message: '' });
  } catch (e) { next(e); }
});

orderRouter.post('/bulk/confirm', staffOnly, async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    let created = 0, rejected = 0, duplicates = 0;
    const seenSave = new Set();
    const report = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        let cust = r.ledger_id ? await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [r.ledger_id])
          : await db.get(`SELECT * FROM customers WHERE ledger_name_norm=?`, [normalizeName(r.ledger_name || '')]);
        if (!cust && !r.ledger_id && (r.ledger_name || '').trim()) {
          const led = await resolveLedger({ ledger_name: r.ledger_name });
          if (led.status === 'matched') cust = led.customer;
          else if (led.status === 'ambiguous' || led.status === 'review') throw new Error(led.message);
        }
        if (!cust) throw new Error('Unknown Customer/Ledger — no reliable match found.');
        const resolved = await resolveProduct(r.blend || '');
        if (!resolved.id) throw new Error(resolved.error);
        const pid = resolved.id;
        const ap = await db.get(`SELECT 1 FROM approvals WHERE ledger_id=? AND product_id=?`, [cust.ledger_id, pid]);
        if (!ap) throw new Error('Blend not approved for customer');
        const q = Number(r.qty);
        if (!Number.isFinite(q) || q <= 0) throw new Error('Bad quantity');
        if (!UOMS.includes(r.uom)) throw new Error('Bad UOM');
        const od = (r.order_date && parseFlexDate(r.order_date)) || todayISO();
        // Save-time duplicate re-check (latest data): in-file + system-wide.
        const fkey = dupKey(cust.ledger_id, od, q, pid);
        if (seenSave.has(fkey)) { duplicates++; report.push({ row: i + 1, status: 'duplicate', reason: 'Duplicate — Repeated in uploaded file.' }); continue; }
        seenSave.add(fkey);
        const hit = await findOrderDuplicate({ ledger_id: cust.ledger_id, order_date: od, qty: q, product_id: pid });
        if (hit) { duplicates++; report.push({ row: i + 1, status: 'duplicate', reason: dupMessage(hit) }); continue; }
        const pr = await priceFor(cust.ledger_id, pid);
        const prod = await db.get(`SELECT name FROM products WHERE id=?`, [pid]);
        const order_id = await nextOrderId(db.get);
        const idem = `bulk:${fkey}:${i}`;
        const dup = await db.get(`SELECT order_id FROM orders WHERE idempotency_key=?`, [idem]);
        if (dup) { duplicates++; report.push({ row: i + 1, status: 'duplicate', order_id: dup.order_id }); continue; }
        await db.run(`INSERT INTO orders(order_id, order_date, ledger_id, product_id, blend_snapshot, qty, uom, route, route_day, billing_date, remarks,
          payment_type, payment_status, billing_status, delivery_status, unit_price, total, idempotency_key, created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [order_id, od, cust.ledger_id, pid, prod.name, q, r.uom,
           // Missing Route / Route Day auto-filled from the customer master.
           r.route || cust.route, r.route_day || cust.route_day,
           r.billing_date || null, r.remarks || null,
           cust.payment_type,
           cust.payment_type === 'Credit' ? 'Credit' : (r.payment_status || 'Pending'),
           'Pending', 'Pending',
           pr.unit, pr.unit * q, idem, req.user.username]);
        created++;
        report.push({ row: i + 1, status: 'created', order_id });
      } catch (err) {
        rejected++;
        report.push({ row: i + 1, status: 'rejected', reason: err.message });
      }
    }
    await db.audit({ username: req.user.username, action: 'BULK_IMPORT', entity: 'orders', record_id: `${created} created, ${duplicates} duplicates, ${rejected} rejected`, new_value: { created, duplicates, rejected } });
    res.json({ success: true, data: report, message: `Upload Complete — Total: ${rows.length}, New: ${created}, Duplicates: ${duplicates}, Invalid: ${rejected}, Saved: ${created}` });
  } catch (e) { next(e); }
});

// BULK DELETE — admin only (used by Delivered select + select-all).
orderRouter.post('/bulk-delete', adminOnly, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids : [];
    if (!ids.length) return res.status(400).json({ success: false, data: [], message: 'No orders selected.' });
    if (ids.length > 500) return res.status(400).json({ success: false, data: [], message: 'Select at most 500 orders at once.' });
    const ph = ids.map(() => '?').join(',');
    const r = await db.run(`DELETE FROM orders WHERE order_id IN (${ph})`, ids);
    await db.audit({ username: req.user.username, action: 'ORDERS_BULK_DELETED', entity: 'orders', record_id: `${r.changes} order(s)` });
    res.json({ success: true, data: [{ deleted: r.changes }], message: `${r.changes} order(s) deleted by admin` });
  } catch (e) { next(e); }
});

// DELETE — admin only, enforced server-side. Covers every stage incl. Delivered.
orderRouter.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    const o = await db.get(`SELECT * FROM orders WHERE order_id=?`, [req.params.id]);
    if (!o) return res.status(404).json({ success: false, data: [], message: 'Order not found' });
    await db.run(`DELETE FROM orders WHERE order_id=?`, [req.params.id]);
    await db.audit({ username: req.user.username, action: 'ORDER_DELETED', entity: 'orders', record_id: req.params.id, old_value: o });
    res.json({ success: true, data: [], message: `Order ${req.params.id} deleted by admin` });
  } catch (e) { next(e); }
});

/* ---------------- routes/report.routes.js ---------------- */
const reportRouter = express.Router();

// Operational dashboard: exactly the 5 required KPIs + side-by-side Top 10s.
reportRouter.get('/dashboard', staffOnly, async (req, res, next) => {
  try {
    if (dashCache.payload && Date.now() - dashCache.at < DASH_TTL_MS) return res.json(dashCache.payload);
    const today = todayISO();
    const month = today.slice(0, 7);
    const orders = await db.all(`SELECT * FROM orders`);
    let mtdOrders = 0, mtdQty = 0, todayBilling = 0, pendingDelivery = 0, todayQty = 0;
    const qtyByBlend = {}, qtyByCust = {};
    for (const o of orders) {
      const s = stageOf(o, today);
      const q = Number(o.qty);
      qtyByBlend[o.blend_snapshot] = (qtyByBlend[o.blend_snapshot] || 0) + q;
      qtyByCust[o.ledger_id] = (qtyByCust[o.ledger_id] || 0) + q;
      if ((o.order_date || '').startsWith(month)) { mtdOrders++; mtdQty += q; }
      if (s === 'todays_billing') todayBilling++;
      if (s === 'pending_delivery') pendingDelivery++;
      if (o.billing_date === today) todayQty += q;
    }
    const custNames = {};
    for (const c of await db.all(`SELECT ledger_id, ledger_name FROM customers`)) custNames[c.ledger_id] = c.ledger_name;
    const top = (m, kl) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, qty]) => ({ [kl]: kl === 'ledger_name' ? (custNames[k] || k) : k, qty }));
    dashCache.at = Date.now();
    dashCache.payload = {
      success: true, today,
      data: [{
        mtd_orders: mtdOrders, mtd_qty: mtdQty, today_billing_total: todayBilling,
        pending_delivery_total: pendingDelivery, today_qty_total: todayQty,
        top_customers: top(qtyByCust, 'ledger_name'), top_blends: top(qtyByBlend, 'blend'),
      }],
      message: '',
    };
    res.json(dashCache.payload);
  } catch (e) { next(e); }
});

// MTD report: month totals + per-ledger breakdown (by Order Date, all stages).
reportRouter.get('/mtd', staffOnly, async (req, res, next) => {
  try {
    const m = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : todayISO().slice(0, 7);
    const rows = await db.all(
      `SELECT o.order_id, o.order_date, o.ledger_id, c.ledger_name, o.qty
       FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id
       WHERE substr(o.order_date,1,7)=? ORDER BY o.order_date, o.order_id`, [m]);
    const byLedger = new Map();
    let totalQty = 0;
    for (const r of rows) {
      const q = Number(r.qty) || 0;
      totalQty += q;
      if (!byLedger.has(r.ledger_id)) {
        byLedger.set(r.ledger_id, { ledger_id: r.ledger_id, ledger_name: r.ledger_name, orders: 0, qty: 0 });
      }
      const e = byLedger.get(r.ledger_id);
      e.orders += 1;
      e.qty = +(e.qty + q).toFixed(2);
    }
    const ledgerWise = [...byLedger.values()].sort((a, b) => b.qty - a.qty);
    res.json({
      success: true, month: m,
      data: [{ month: m, total_orders: rows.length, total_qty: +totalQty.toFixed(2), ledger_wise: ledgerWise }],
      total: ledgerWise.length, message: '',
    });
  } catch (e) { next(e); }
});

// UI diagnostics intake: the frontend posts render/network exceptions here.
// Stored in error_log like any server error; never throws, always JSON.
reportRouter.post('/diagnose', staffOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n || 2000);
    const source = cut(b.source || 'ui', 120) || 'ui';
    const message = cut(b.message || 'unspecified UI issue', 2000);
    const context = { url: cut(b.url || '', 500), context: cut(typeof b.context === 'string' ? b.context : JSON.stringify(b.context || {}), 4000) };
    try {
      await db.logError({
        username: (req.user && req.user.username) || null,
        api_endpoint: '/api/reports/diagnose', action: 'UI_DIAGNOSTIC:' + source,
        http_status: null, message, details: context,
      });
    } catch (logErr) { return next(logErr); }
    res.json({ success: true, data: [{ logged: true }], message: 'Diagnostic logged' });
  } catch (e) { next(e); }
});

// Period labels: '2026-08' -> 'Aug-26'; FY quarter (y=FY start year) -> 'Q1 26-27'.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return ym;
  return `${MON[parseInt(m[2], 10) - 1]}-${m[1].slice(2)}`;
}
function fmtQ(y, q) {
  return `Q${q} ${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}
function prevMonthOf(m) {
  const d = new Date(m + '-01T12:00:00');
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// MoM: selected month vs selected comparison month (default: previous month).
reportRouter.get('/mom', staffOnly, async (req, res, next) => {
  try {
    const m = req.query.month || todayISO().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ success: false, data: [], message: 'Pick a month (YYYY-MM).' });
    let pm = req.query.cmp;
    if (!pm || !/^\d{4}-\d{2}$/.test(pm)) pm = prevMonthOf(m);
    const agg = async (prefix) => {
      const rows = await db.all(`SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM orders WHERE substr(order_date,1,7)=?`, [prefix]);
      return { orders: rows[0].n, qty: rows[0].q };
    };
    const cur = await agg(m), prv = await agg(pm);
    const vOrd = cur.orders - prv.orders, vQty = +(cur.qty - prv.qty).toFixed(2);
    res.json({ success: true, data: [{ label: m, prev_label: pm,
      p1_label: fmtMonth(pm), p2_label: fmtMonth(m), display: `${fmtMonth(pm)} - ${fmtMonth(m)}`,
      orders: cur.orders, prev_orders: prv.orders,
      variance_orders: vOrd, variance_orders_pct: prv.orders ? +((vOrd / prv.orders) * 100).toFixed(1) : null,
      qty: cur.qty, prev_qty: prv.qty, variance_qty: vQty,
      variance_qty_pct: prv.qty ? +((vQty / prv.qty) * 100).toFixed(1) : null }], message: '' });
  } catch (e) { next(e); }
});

// Ledger-wise MoM table: per-ledger variance qty/orders + percentages.
reportRouter.get('/mom-ledger', staffOnly, async (req, res, next) => {
  try {
    const m = req.query.month || todayISO().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ success: false, data: [], message: 'Pick a month (YYYY-MM).' });
    let pm = req.query.cmp;
    if (!pm || !/^\d{4}-\d{2}$/.test(pm)) pm = prevMonthOf(m);
    const rows = await db.all(
      `SELECT c.ledger_id, c.ledger_name,
        SUM(CASE WHEN substr(o.order_date,1,7)=? THEN 1 ELSE 0 END) orders,
        SUM(CASE WHEN substr(o.order_date,1,7)=? THEN 1 ELSE 0 END) prev_orders,
        COALESCE(SUM(CASE WHEN substr(o.order_date,1,7)=? THEN o.qty ELSE 0 END),0) qty,
        COALESCE(SUM(CASE WHEN substr(o.order_date,1,7)=? THEN o.qty ELSE 0 END),0) prev_qty
       FROM customers c LEFT JOIN orders o ON o.ledger_id=c.ledger_id
         AND (substr(o.order_date,1,7)=? OR substr(o.order_date,1,7)=?)
       GROUP BY c.ledger_id, c.ledger_name HAVING orders > 0 OR prev_orders > 0
       ORDER BY qty DESC LIMIT 500`, [m, pm, m, pm, m, pm]);
    const data = rows.map((r) => {
      const vO = r.orders - r.prev_orders, vQ = +(r.qty - r.prev_qty).toFixed(2);
      return { ...r, variance_orders: vO, variance_orders_pct: r.prev_orders ? +((vO / r.prev_orders) * 100).toFixed(1) : null,
        variance_qty: vQ, variance_qty_pct: r.prev_qty ? +((vQ / r.prev_qty) * 100).toFixed(1) : null };
    });
    res.json({ success: true, p1_label: fmtMonth(pm), p2_label: fmtMonth(m),
      display: `${fmtMonth(pm)} - ${fmtMonth(m)}`, data, message: '' });
  } catch (e) { next(e); }
});

// QoQ: FY Apr–Mar quarters, both sides user-selectable.
function qMonths(yy, qq) {
  const map = { 1: ['04', '05', '06'], 2: ['07', '08', '09'], 3: ['10', '11', '12'], 4: ['01', '02', '03'] };
  const year = qq === 4 ? yy + 1 : yy;
  return map[qq].map((mm) => `${year}-${mm}`);
}
reportRouter.get('/qoq', staffOnly, async (req, res, next) => {
  try {
    const y = parseInt(req.query.year, 10), q = parseInt(req.query.quarter, 10);
    if (!(q >= 1 && q <= 4) || !Number.isFinite(y)) return res.status(400).json({ success: false, data: [], message: 'Pick a year and quarter (Q1–Q4).' });
    const cy = req.query.cmp_year ? parseInt(req.query.cmp_year, 10) : (q === 1 ? y - 1 : y);
    const cq = req.query.cmp_quarter ? parseInt(req.query.cmp_quarter, 10) : (q === 1 ? 4 : q - 1);
    if (!(cq >= 1 && cq <= 4) || !Number.isFinite(cy)) return res.status(400).json({ success: false, data: [], message: 'Pick a valid comparison quarter.' });
    const aggQ = async (yy, qq) => {
      const months = qMonths(yy, qq);
      const ph = months.map(() => '?').join(',');
      const rows = await db.all(`SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM orders WHERE substr(order_date,1,7) IN (${ph})`, months);
      return { orders: rows[0].n, qty: rows[0].q };
    };
    const cur = await aggQ(y, q), prv = await aggQ(cy, cq);
    const vOrd = cur.orders - prv.orders, vQty = +(cur.qty - prv.qty).toFixed(2);
    res.json({
      success: true,
      data: [{ label: `Q${q} FY${y}`, prev_label: `Q${cq} FY${cy}`,
        p1_label: fmtQ(cy, cq), p2_label: fmtQ(y, q), display: `${fmtQ(cy, cq)} - ${fmtQ(y, q)}`,
        orders: cur.orders, prev_orders: prv.orders,
        variance_orders: vOrd, variance_orders_pct: prv.orders ? +((vOrd / prv.orders) * 100).toFixed(1) : null,
        qty: cur.qty, prev_qty: prv.qty, variance_qty: vQty,
        variance_qty_pct: prv.qty ? +((vQty / prv.qty) * 100).toFixed(1) : null }],
      message: '',
    });
  } catch (e) { next(e); }
});

// Ledger-wise QoQ table (Indian FY quarters Apr–Mar).
reportRouter.get('/qoq-ledger', staffOnly, async (req, res, next) => {
  try {
    const y = parseInt(req.query.year, 10), q = parseInt(req.query.quarter, 10);
    if (!(q >= 1 && q <= 4) || !Number.isFinite(y)) return res.status(400).json({ success: false, data: [], message: 'Pick a year and quarter (Q1–Q4).' });
    const cy = req.query.cmp_year ? parseInt(req.query.cmp_year, 10) : (q === 1 ? y - 1 : y);
    const cq = req.query.cmp_quarter ? parseInt(req.query.cmp_quarter, 10) : (q === 1 ? 4 : q - 1);
    if (!(cq >= 1 && cq <= 4) || !Number.isFinite(cy)) return res.status(400).json({ success: false, data: [], message: 'Pick a valid comparison quarter.' });
    const inA = qMonths(y, q).map(() => '?').join(',');
    const inB = qMonths(cy, cq).map(() => '?').join(',');
    const rows = await db.all(
      `SELECT c.ledger_id, c.ledger_name,
        SUM(CASE WHEN substr(o.order_date,1,7) IN (${inA}) THEN 1 ELSE 0 END) orders,
        SUM(CASE WHEN substr(o.order_date,1,7) IN (${inB}) THEN 1 ELSE 0 END) prev_orders,
        COALESCE(SUM(CASE WHEN substr(o.order_date,1,7) IN (${inA}) THEN o.qty ELSE 0 END),0) qty,
        COALESCE(SUM(CASE WHEN substr(o.order_date,1,7) IN (${inB}) THEN o.qty ELSE 0 END),0) prev_qty
       FROM customers c LEFT JOIN orders o ON o.ledger_id=c.ledger_id
         AND (substr(o.order_date,1,7) IN (${inA}) OR substr(o.order_date,1,7) IN (${inB}))
       GROUP BY c.ledger_id, c.ledger_name HAVING orders > 0 OR prev_orders > 0
       ORDER BY qty DESC LIMIT 500`,
      [...qMonths(y, q), ...qMonths(cy, cq), ...qMonths(y, q), ...qMonths(cy, cq), ...qMonths(y, q), ...qMonths(cy, cq)]);
    const data = rows.map((r) => {
      const vO = r.orders - r.prev_orders, vQ = +(r.qty - r.prev_qty).toFixed(2);
      return { ...r, variance_orders: vO, variance_orders_pct: r.prev_orders ? +((vO / r.prev_orders) * 100).toFixed(1) : null,
        variance_qty: vQ, variance_qty_pct: r.prev_qty ? +((vQ / r.prev_qty) * 100).toFixed(1) : null };
    });
    res.json({ success: true, p1_label: fmtQ(cy, cq), p2_label: fmtQ(y, q),
      display: `${fmtQ(cy, cq)} - ${fmtQ(y, q)}`, data, message: '' });
  } catch (e) { next(e); }
});

// Follow-up reminders from real order frequency. Early rules (settings):
// weekly cycle → 2 days early; ~15-day cycle → 5 days; monthly → 6 days.
reportRouter.get('/followup', staffOnly, async (req, res, next) => {
  try {
    const s = await db.getSettings();
    if (String(s.reminders_enabled).toLowerCase() === 'no') {
      return res.json({ success: true, data: [], enabled: false, message: 'Reminders disabled in Settings.' });
    }
    const earlyW = parseInt(s.reminder_weekly_days, 10) || 2;
    const earlyF = parseInt(s.reminder_fortnight_days, 10) || 5;
    const earlyM = parseInt(s.reminder_monthly_days, 10) || 6;
    const rows = await db.all(`SELECT ledger_id, order_date FROM orders WHERE order_date IS NOT NULL ORDER BY order_date`);
    const byCust = {};
    for (const r of rows) {
      byCust[r.ledger_id] = byCust[r.ledger_id] || [];
      if (!byCust[r.ledger_id].includes(r.order_date)) byCust[r.ledger_id].push(r.order_date);
    }
    const names = {};
    for (const c of await db.all(`SELECT ledger_id, ledger_name FROM customers`)) names[c.ledger_id] = c.ledger_name;
    const today = todayISO();
    const out = [];
    for (const [lid, dates] of Object.entries(byCust)) {
      if (dates.length < 2) continue;
      dates.sort();
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      let cycle, early;
      if (avg <= 9) { cycle = 'Weekly'; early = earlyW; }
      else if (avg <= 20) { cycle = 'Every 2 weeks / 15 days'; early = earlyF; }
      else if (avg <= 45) { cycle = 'Monthly'; early = earlyM; }
      else { cycle = 'Longer cycle'; early = earlyM; }
      const last = dates[dates.length - 1];
      const since = Math.round((new Date(today) - new Date(last)) / 86400000);
      const expected = new Date(new Date(last).getTime() + avg * 86400000).toISOString().slice(0, 10);
      const remindOn = new Date(new Date(last).getTime() + (avg - early) * 86400000).toISOString().slice(0, 10);
      out.push({
        ledger_id: lid, ledger_name: names[lid] || lid, cycle, early_days: early,
        last_order_date: last, avg_gap_days: Math.round(avg), expected_next_date: expected,
        remind_on: remindOn, days_since: since, reminder_due: since >= avg - early,
        status: since > avg * 1.5 ? 'Overdue' : (since >= avg - early ? 'Reminder Due' : 'Active'),
      });
    }
    out.sort((a, b) => b.days_since - a.days_since);
    res.json({ success: true, data: out, enabled: true, message: '' });
  } catch (e) { next(e); }
});
reportRouter.get('/new-customers', staffOnly, async (req, res, next) => {
  try {
    // A customer is new when their FIRST-EVER order date falls in the period.
    // Month+Year selector (?month=YYYY-MM); from/to range also accepted.
    let from = null, to = null, periodLabel = '';
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [yy, mm] = req.query.month.split('-').map(Number);
      const lastDay = new Date(yy, mm, 0).getDate();
      from = `${req.query.month}-01`;
      to = `${req.query.month}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = fmtMonth(req.query.month);
    } else {
      from = req.query.from || null;
      to = req.query.to || null;
      periodLabel = [from, to].filter(Boolean).join(' → ');
    }
    const firsts = await db.all(
      `SELECT o.ledger_id, c.ledger_name, MIN(o.order_date) first_date
       FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id
       WHERE o.order_date IS NOT NULL AND o.order_date != ''
       GROUP BY o.ledger_id, c.ledger_name`);
    const out = [];
    for (const f of firsts) {
      if (from && f.first_date < from) continue;
      if (to && f.first_date > to) continue;
      const firstLine = await db.get(
        `SELECT order_id, qty FROM orders WHERE ledger_id=? AND order_date=? ORDER BY order_id LIMIT 1`,
        [f.ledger_id, f.first_date]);
      out.push({
        ledger_id: f.ledger_id, ledger_name: f.ledger_name,
        first_order_date: f.first_date,
        first_order_qty: firstLine ? firstLine.qty : null,
        first_order_id: firstLine ? firstLine.order_id : null,
      });
    }
    out.sort((a, b) => a.first_order_date.localeCompare(b.first_order_date));
    res.json({ success: true, data: out, total: out.length, period: periodLabel, message: '' });
  } catch (e) { next(e); }
});

// Customers who have NOT ordered this month (master + real order data).
reportRouter.get('/not-ordered', staffOnly, async (req, res, next) => {
  try {
    const month = req.query.month || todayISO().slice(0, 7);
    const ordered = await db.all(`SELECT DISTINCT ledger_id FROM orders WHERE substr(order_date,1,7)=?`, [month]);
    const set = new Set(ordered.map(r => r.ledger_id));
    const all = await db.all(`SELECT ledger_id, ledger_name, payment_type, route, route_day, mobile FROM customers WHERE status='Active' ORDER BY ledger_name`);
    const rows = all.filter(c => !set.has(c.ledger_id));
    res.json({ success: true, data: rows, total: rows.length, month, message: '' });
  } catch (e) { next(e); }
});

// Customer order history + lifetime qty + favourite blend + frequency.
reportRouter.get('/customer/:id', staffOnly, async (req, res, next) => {
  try {
    const orders = await db.all(`SELECT * FROM orders WHERE ledger_id=? ORDER BY order_date DESC LIMIT 500`, [req.params.id]);
    const blendQty = {};
    for (const o of orders) blendQty[o.blend_snapshot] = (blendQty[o.blend_snapshot] || 0) + Number(o.qty);
    const fav = Object.entries(blendQty).sort((a, b) => b[1] - a[1])[0];
    res.json({
      success: true,
      data: [{
        total_orders: orders.length,
        lifetime_qty: orders.reduce((s, o) => s + Number(o.qty), 0),
        favourite_blend: fav ? fav[0] : null,
        last_order_date: orders.length ? orders[0].order_date : null,
        orders,
      }],
      message: '',
    });
  } catch (e) { next(e); }
});

// Quantity by blend/product with MTD/MoM/YoY windows.
reportRouter.get('/blend-qty', staffOnly, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const where = [];
    const params = [];
    if (from) { where.push(`order_date>=?`); params.push(from); }
    if (to) { where.push(`order_date<=?`); params.push(to); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await db.all(`SELECT blend_snapshot blend, COUNT(*) orders, SUM(qty) qty FROM orders ${w} GROUP BY blend_snapshot ORDER BY qty DESC LIMIT 200`, params);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

// Billing / delivery summaries.
reportRouter.get('/billing', staffOnly, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const where = [`billing_status='Billed'`];
    const params = [];
    if (from) { where.push(`billing_date>=?`); params.push(from); }
    if (to) { where.push(`billing_date<=?`); params.push(to); }
    const rows = await db.all(`SELECT o.*, c.ledger_name FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id
      WHERE ${where.join(' AND ')} ORDER BY billing_date DESC LIMIT 500`, params);
    res.json({ success: true, data: rows, total: rows.length, message: '' });
  } catch (e) { next(e); }
});

reportRouter.get('/audit', staffOnly, async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 200`);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

reportRouter.get('/errors', staffOnly, async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT * FROM error_log ORDER BY id DESC LIMIT 200`);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

/* ---------------- routes/holiday.routes.js ---------------- */
const holidayRouter = express.Router();

holidayRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT * FROM holidays ORDER BY date`);
    res.json({ success: true, data: rows, message: '' });
  } catch (e) { next(e); }
});

holidayRouter.post('/', staffOnly, async (req, res, next) => {
  try {
    const { date, name, type } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, data: [], message: 'Holiday Date required (YYYY-MM-DD)' });
    if (!name) return res.status(400).json({ success: false, data: [], message: 'Holiday Name required' });
    await db.run(`INSERT INTO holidays(date, name, type) VALUES(?,?,?)
      ON CONFLICT(date) DO UPDATE SET name=excluded.name, type=excluded.type`, [date, name, type || '']);
    await db.audit({ username: req.user.username, action: 'HOLIDAY_CHANGED', entity: 'holidays', record_id: date, new_value: req.body });
    res.json({ success: true, data: [], message: 'Holiday saved' });
  } catch (e) { next(e); }
});

holidayRouter.delete('/:date', staffOnly, async (req, res, next) => {
  try {
    await db.run(`DELETE FROM holidays WHERE date=?`, [req.params.date]);
    await db.audit({ username: req.user.username, action: 'HOLIDAY_CHANGED', entity: 'holidays', record_id: req.params.date, new_value: 'deleted' });
    res.json({ success: true, data: [], message: 'Holiday removed' });
  } catch (e) { next(e); }
});

// Working-day check used by billing-date pickers: weekends + holiday master.
holidayRouter.get('/check/:date', staffOnly, async (req, res, next) => {
  try {
    const d = new Date(req.params.date + 'T00:00:00');
    const dow = d.getDay();
    const h = await db.get(`SELECT * FROM holidays WHERE date=?`, [req.params.date]);
    const isWeekend = dow === 0 || dow === 6;
    res.json({ success: true, data: [{ date: req.params.date, is_holiday: !!h, holiday_name: h ? h.name : null, is_weekend: isWeekend, is_working_day: !h && !isWeekend }], message: '' });
  } catch (e) { next(e); }
});

/* ---------------- routes/settings.routes.js ---------------- */
const settingsRouter = express.Router();

const PUBLIC_KEYS = ['company_name', 'company_logo'];

settingsRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const s = await db.getSettings();
    const out = { ...s };
    if (req.user.role !== 'admin') {
      // Non-admins see company identity + reminder rules, never SMTP secrets.
      for (const k of Object.keys(out)) {
        if (![...PUBLIC_KEYS, 'reminders_enabled', 'reminder_weekly_days', 'reminder_fortnight_days', 'reminder_monthly_days'].includes(k)) out[k] = '';
      }
    } else {
      out.smtp_pass = out.smtp_pass ? '********' : '';
    }
    res.json({ success: true, data: [out], message: '' });
  } catch (e) { next(e); }
});

// Company identity (name + logo). Logo: PNG/JPG data URL ≤ ~250KB.
settingsRouter.put('/', adminOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const pairs = {};
    if (b.company_name !== undefined) {
      if (!String(b.company_name).trim()) return res.status(400).json({ success: false, data: [], message: 'Company name is required.' });
      pairs.company_name = String(b.company_name).trim();
    }
    if (b.company_logo !== undefined) {
      const du = String(b.company_logo || '');
      if (du && !/^data:image\/(png|jpeg|jpg);base64,/.test(du)) return res.status(400).json({ success: false, data: [], message: 'Logo must be a PNG or JPG image.' });
      pairs.company_logo = du;
    }
    const emailKeys = ['billing_email_enabled', 'billing_email_recipients', 'billing_email_subject',
      'eod_email_enabled', 'eod_email_recipients', 'eod_email_subject',
      'smtp_host', 'smtp_port', 'smtp_user', 'reminders_enabled',
      'reminder_weekly_days', 'reminder_fortnight_days', 'reminder_monthly_days'];
    for (const k of emailKeys) if (b[k] !== undefined) pairs[k] = String(b[k]);
    if (b.smtp_pass) pairs.smtp_pass = String(b.smtp_pass); // blank keeps existing
    const recips = (pairs.billing_email_recipients ?? '') + ',' + (pairs.eod_email_recipients ?? '');
    for (const e of recips.split(',')) {
      const t = e.trim();
      if (t && !/.+@.+\..+/.test(t)) return res.status(400).json({ success: false, data: [], message: `Invalid email: ${t}` });
    }
    if (pairs.smtp_host !== undefined && /.+@.+\..+/.test(pairs.smtp_host.trim())) {
      return res.status(400).json({ success: false, data: [], message: `SMTP Host "${pairs.smtp_host.trim()}" looks like an email address. Enter the server host, e.g. smtp.gmail.com.` });
    }
    await db.saveSettings(pairs);
    await db.audit({ username: req.user.username, action: 'SETTINGS_CHANGED', entity: 'settings', record_id: Object.keys(pairs).join(',') });
    res.json({ success: true, data: [], message: 'Settings saved' });
  } catch (e) { next(e); }
});

// Scheduler/trigger status: recent email audit trail + last runs.
settingsRouter.get('/email-status', staffOnly, async (req, res, next) => {
  try {
    res.json({ success: true, data: [await schedulerStatus()], message: '' });
  } catch (e) { next(e); }
});

// Test email that reports the REAL result (never claims success on failure).
settingsRouter.post('/test-email', adminOnly, async (req, res, next) => {
  try {
    const kind = req.body.kind === 'eod' ? 'eod' : 'billing';
    const r = await sendTestEmail(kind);
    res.json({ success: true, data: [r], message: `Test ${kind} email sent.` });
  } catch (e) {
    await db.logError({ username: req.user.username, api_endpoint: 'test-email', action: 'send', http_status: 500, message: e.message });
    res.status(502).json({ success: false, data: [], message: `Test email FAILED: ${e.message}` });
  }
});

/* ---------------- routes/import.routes.js ---------------- */
const importRouter = express.Router();

// Templates use the application's actual expected headers. ID columns are
// included for reference but left blank — the system generates them.
const TEMPLATES = {
  delivered: ['Order ID', 'Order Date', 'Ledger Name', 'Blend Name', 'Qty', 'UOM', 'Route', 'Route Day', 'Billing Date', 'Delivered On', 'Remarks'],
  customers: ['Ledger ID', 'Ledger Name', 'Mobile', 'Address', 'Route', 'Route Day', 'Payment Type', 'Approved Blend', 'Status'],
  products: ['SKU ID', 'Product Name', 'UOM', 'Std Price', 'Status'],
  orders: ['Ledger Name', 'Blend Name', 'Qty', 'UOM', 'Order Date', 'Billing Date', 'Remarks'],
};

// One-shot master snapshot for in-memory validation (no per-row scans).
// Callers reload it right before use, so SAVE always sees the latest data.
async function loadLists() {
  const customers = await db.all(`SELECT * FROM customers`);
  const products = await db.all(`SELECT * FROM products`);
  const approvals = new Set((await db.all(`SELECT ledger_id, product_id FROM approvals`))
    .map((a) => `${a.ledger_id}|${a.product_id}`));
  const orderKeys = new Map();
  for (const o of await db.all(`SELECT order_id, ledger_id, order_date, qty, product_id FROM orders`)) {
    orderKeys.set(dupKey(o.ledger_id, o.order_date, Number(o.qty), o.product_id), o.order_id);
  }
  return { customers, products, approvals, orderKeys };
}

importRouter.get('/template/:target', staffOnly, (req, res) => {
  const cols = TEMPLATES[req.params.target];
  if (!cols) return res.status(400).json({ success: false, data: [], message: 'Unknown template' });
  const csv = cols.join(',') + '\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.target}-template.csv"`);
  res.send(csv);
});

// CSV parsing (handles quotes) — shared by preview/confirm.
function parseCsv(text) {
  const rows = [];
  let row = [], val = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { val += '"'; i++; }
        else q = false;
      } else val += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(val); val = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(val); rows.push(row); row = []; val = '';
    } else val += ch;
  }
  row.push(val); rows.push(row);
  return rows;
}

function toObjects(csvText) {
  const rows = parseCsv(csvText).filter((r) => r.some((x) => String(x).trim() !== ''));
  if (rows.length < 2) return { headers: [], objs: [] };
  const headers = rows[0].map((h) => String(h).trim());
  return {
    headers,
    objs: rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      return o;
    }),
  };
}

async function sharedNextLedgerId() {
  const rows = await db.all(`SELECT ledger_id FROM customers`);
  let max = 10000;
  for (const r of rows) {
    const m = /^CUS(\d+)$/.exec(r.ledger_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'CUS' + (max + 1);
}

async function sharedNextSkuId() {
  const rows = await db.all(`SELECT sku_id FROM products`);
  let max = 0;
  for (const r of rows) {
    const m = /^SKU(\d+)$/.exec(r.sku_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'SKU' + (max + 1);
}

async function resolveCustomer(r) {
  if (r['Ledger ID']) return db.get(`SELECT * FROM customers WHERE ledger_id=?`, [r['Ledger ID']]);
  if (r['Ledger Name']) return db.get(`SELECT * FROM customers WHERE ledger_name_norm=?`, [normalizeName(r['Ledger Name'])]);
  return null;
}

async function resolveProductId(blendText) {
  if (!blendText) return null;
  const p = await db.get(`SELECT id FROM products WHERE name_norm=?`, [normalizeName(blendText)]);
  return p ? p.id : null;
}

async function validateRow(target, r, seen, lists) {
  const item = { status: 'valid', issues: [], row: r };
  const bad = (m) => { item.status = 'invalid'; item.issues.push(m); };
  const warn = (m) => { if (item.status === 'valid') item.status = 'valid_with_warnings'; item.issues.push(m); };
  const L = lists || null; // null => fall back to direct DB reads (single-row callers)

  if (target === 'customers') {
    const name = (r['Ledger Name'] || '').trim();
    if (!name) { bad('Ledger Name is required.'); return item; }
    const norm = normalizeName(name);
    const exact = L
      ? L.customers.find((c) => (c.ledger_name_norm || normalizeName(c.ledger_name)) === norm) || null
      : await db.get(`SELECT ledger_id, ledger_name FROM customers WHERE ledger_name_norm=?`, [norm]);
    if (exact) {
      if (r['Ledger ID'] && r['Ledger ID'] !== exact.ledger_id) bad(`Name matches existing customer ${exact.ledger_id}.`);
      else { item.status = 'duplicate'; item.issues.push(`Matches existing customer ${exact.ledger_id} — will update, not duplicate.`); item.match_id = exact.ledger_id; }
      return item;
    }
    if (r['Ledger ID']) {
      const byId = L
        ? L.customers.find((c) => c.ledger_id === r['Ledger ID']) || null
        : await db.get(`SELECT ledger_id FROM customers WHERE ledger_id=?`, [r['Ledger ID']]);
      if (byId) { item.status = 'duplicate'; item.issues.push(`Ledger ID ${r['Ledger ID']} exists — will update.`); item.match_id = byId.ledger_id || r['Ledger ID']; return item; }
    }
    // Fuzzy guard: a close-but-inexact name maps to the existing customer
    // (update path) or is flagged for review — never a second customer.
    const allC = L ? L.customers : await db.all(`SELECT ledger_id, ledger_name FROM customers LIMIT 2000`);
    const cm = bestMatch(name, allC, (c) => c.ledger_name);
    if (cm.status === 'matched') {
      item.status = 'duplicate';
      item.issues.push(`Closest Match: "${name}" → existing customer ${cm.match.ledger_id} "${cm.match.ledger_name}" — will update, not duplicate.`);
      item.match_id = cm.match.ledger_id;
      item.matched = [{ field: 'Ledger Name', uploaded: name, matched_to: cm.match.ledger_name, status: 'Closest Match', score: cm.score }];
      return item;
    }
    if (cm.status === 'ambiguous' || cm.status === 'review') {
      bad(`Manual review required — "${name}" is close to: ${cm.candidates.join('; ')}. Correct it or pick the existing customer.`);
      return item;
    }
    const terms = (r['Payment Type'] || 'Credit').trim();
    if (!['Advance', 'Credit'].includes(terms)) bad('Payment Type must be Advance or Credit.');
    const key = 'cust|' + norm;
    if (seen.has(key)) { item.status = 'duplicate'; item.issues.push('Duplicate row within this file.'); }
    else seen.add(key);
  } else if (target === 'products') {
    const name = (r['Product Name'] || '').trim();
    if (!name) { bad('Product Name is required.'); return item; }
    const norm = normalizeName(name);
    const exact = L
      ? L.products.find((p) => (p.name_norm || normalizeName(p.name)) === norm) || null
      : await db.get(`SELECT id, name FROM products WHERE name_norm=?`, [norm]);
    if (exact) { item.status = 'duplicate'; item.issues.push(`Matches canonical product "${exact.name}" — will update, not duplicate.`); item.match_id = exact.id; return item; }
    const allP = L ? L.products : await db.all(`SELECT id, name FROM products LIMIT 2000`);
    const pm = bestMatch(name, allP, (p) => p.name);
    if (pm.status === 'matched') {
      item.status = 'duplicate';
      item.issues.push(`Closest Match: "${name}" → canonical product "${pm.match.name}" — will update, not duplicate.`);
      item.match_id = pm.match.id;
      item.matched = [{ field: 'Product Name', uploaded: name, matched_to: pm.match.name, status: 'Closest Match', score: pm.score }];
      return item;
    }
    if (pm.status === 'ambiguous' || pm.status === 'review') {
      bad(`Manual review required — "${name}" is close to: ${pm.candidates.join('; ')}. Correct it or pick the existing product.`);
      return item;
    }
    if (r['UOM'] && !UOMS.includes(r['UOM'].trim())) bad('UOM must be KG/LTR/PAC.');
    const key = 'prod|' + norm;
    if (seen.has(key)) { item.status = 'duplicate'; item.issues.push('Duplicate row within this file.'); }
    else seen.add(key);
  } else if (target === 'delivered') {
    // Uploaded → Closest-match Ledger → permanent ID → Closest-match Blend →
    // permanent product → approved-blend check → duplicate engine.
    // Only Ledger Name, Blend and Qty must come from the file.
    const led = await resolveLedger({ ledger_id: r['Ledger ID'], ledger_name: r['Ledger Name'] }, L);
    let cust = led.customer || null;
    if (led.status === 'exact') item.ledger_id = cust.ledger_id;
    else if (led.status === 'matched') {
      item.ledger_id = cust.ledger_id;
      item.matched = item.matched || [];
      item.matched.push({ field: 'Ledger Name', uploaded: (r['Ledger Name'] || '').trim(), matched_to: cust.ledger_name, status: 'Closest Match', score: led.score });
      warn(`Ledger Closest Match: "${(r['Ledger Name'] || '').trim()}" → "${cust.ledger_name}".`);
    } else if (led.status === 'ambiguous' || led.status === 'review') {
      bad(led.message); return item;
    } else if (!led.createName) { bad('Ledger Name is required.'); return item; }
    else {
      item.create_customer = led.createName;
      warn(`New customer "${led.createName}" — will be created with an auto ID.`);
    }
    const bl = await resolveBlend(r['Blend Name'], L);
    if (bl.status !== 'exact' && bl.status !== 'matched') { bad(bl.message); return item; }
    const pid = bl.product.id;
    if (bl.status === 'matched') {
      item.matched = item.matched || [];
      item.matched.push({ field: 'Blend Name', uploaded: (r['Blend Name'] || '').trim(), matched_to: bl.product.name, status: 'Closest Match', score: bl.score });
      warn(`Blend Closest Match: "${(r['Blend Name'] || '').trim()}" → "${bl.product.name}".`);
    }
    if (cust) {
      const approved = L ? L.approvals.has(`${cust.ledger_id}|${pid}`)
        : await db.get(`SELECT 1 FROM approvals WHERE ledger_id=? AND product_id=?`, [cust.ledger_id, pid]);
      if (!approved) {
        // Auto-approve on SAVE: the blend is a real product, just not yet
        // approved for this ledger. Shown in preview, added on SAVE.
        item.auto_approve = { ledger_id: cust.ledger_id, product_id: pid };
        warn(`"${bl.product.name}" is not yet approved for "${cust.ledger_name}" — will be added to their approved blends on SAVE.`);
      }
    } else {
      warn('Blend approval will be added for the new customer automatically.');
    }
    item.product_id = pid;
    const q = Number(r['Qty']);
    if (!Number.isFinite(q) || q <= 0) bad('Qty must be greater than zero.');
    if (r['UOM'] && !UOMS.includes(r['UOM'].trim())) bad('UOM must be KG/LTR/PAC.');
    item.order_date = parseFlexDate(r['Order Date']);
    if (r['Order Date'] && !item.order_date) bad(`Order Date "${r['Order Date']}" not recognized.`);
    item.billing_date = parseFlexDate(r['Billing Date']);
    if (r['Billing Date'] && !item.billing_date) bad(`Billing Date "${r['Billing Date']}" not recognized.`);
    item.delivered_on = parseFlexDate(r['Delivered On']);
    if (!item.delivered_on) bad(`Delivered On "${r['Delivered On'] || ''}" not recognized — use DD-MM-YYYY or YYYY-MM-DD.`);
    if (item.status === 'invalid') return item;
    if (r['Order ID']) {
      if (/^ORDORD/i.test(r['Order ID'])) warn(`Order ID "${r['Order ID']}" has a doubled prefix — check the source file. It will be saved as-is.`);
      const ex = await db.get(`SELECT order_id FROM orders WHERE order_id=?`, [r['Order ID']]);
      if (ex) { item.status = 'duplicate'; item.issues.push(`Order ID ${r['Order ID']} exists — will update.`); item.match_id = ex.order_id; return item; }
    }
    // Enrichment preview: show exactly what will be saved.
    const ec = cust || null;
    item.enriched = {
      route: r['Route'] || (ec && ec.route) || '',
      route_day: r['Route Day'] || (ec && ec.route_day) || '',
      route_from_master: !r['Route'] && !!(ec && ec.route),
      route_day_from_master: !r['Route Day'] && !!(ec && ec.route_day),
      order_date: item.order_date || item.billing_date || '',
      new_customer: !cust ? item.create_customer : null,
    };
    // System-wide duplicate rule: Ledger + Order Date + Quantity + Blend.
    // In-file repeats flagged separately; existing records flagged as system dupes.
    const od = item.order_date || item.billing_date || '';
    const dq = Number(r['Qty']);
    const lkey = cust ? cust.ledger_id : 'new:' + normalizeName(item.create_customer);
    const fkey = dupKey(lkey, od, dq, pid);
    if (seen.has(fkey)) {
      item.status = 'duplicate';
      item.issues.push('Duplicate — Repeated in uploaded file. Only the first occurrence will be saved.');
      return item;
    }
    seen.add(fkey);
    if (cust) {
      const key = dupKey(cust.ledger_id, od, dq, pid);
      const hitId = L ? L.orderKeys.get(key) : null;
      if (hitId) {
        item.status = 'duplicate';
        item.issues.push(`Duplicate — Already exists as ${hitId} (same Ledger, Order Date, Quantity and Blend). Will not be saved.`);
        return item;
      }
      if (!L) {
        const hit = await findOrderDuplicate({ ledger_id: cust.ledger_id, order_date: od, qty: dq, product_id: pid });
        if (hit) {
          item.status = 'duplicate';
          item.issues.push(dupMessage(hit) + ' Will not be saved.');
          return item;
        }
      }
    }
  } else if (target === 'orders') {
    // Unknown ledgers are NOT auto-created here: add the customer first.
    const ledO = await resolveLedger({ ledger_name: r['Ledger Name'] }, L);
    const custO = ledO.customer || null;
    if (!custO) {
      if (ledO.status === 'ambiguous' || ledO.status === 'review') bad(ledO.message);
      else bad(`Unknown Customer/Ledger "${(r['Ledger Name'] || '').trim()}" — no reliable match found. Add the customer first or fix the name.`);
      return item;
    }
    item.ledger_id = custO.ledger_id;
    if (ledO.status === 'matched') {
      item.matched = [{ field: 'Ledger Name', uploaded: (r['Ledger Name'] || '').trim(), matched_to: custO.ledger_name, status: 'Closest Match', score: ledO.score }];
      warn(`Ledger Closest Match: "${(r['Ledger Name'] || '').trim()}" → "${custO.ledger_name}".`);
    }
    const blO = await resolveBlend(r['Blend Name'], L);
    if (blO.status !== 'exact' && blO.status !== 'matched') { bad(blO.message); return item; }
    const pidO = blO.product.id;
    if (blO.status === 'matched') {
      item.matched = item.matched || [];
      item.matched.push({ field: 'Blend Name', uploaded: (r['Blend Name'] || '').trim(), matched_to: blO.product.name, status: 'Closest Match', score: blO.score });
      warn(`Blend Closest Match: "${(r['Blend Name'] || '').trim()}" → "${blO.product.name}".`);
    }
    const approvedO = L ? L.approvals.has(`${custO.ledger_id}|${pidO}`) : null;
    if (!approvedO) {
      warn(`"${blO.product.name}" is not yet approved for "${custO.ledger_name}" — will be added to their approved blends on SAVE.`);
    }
    const qO = Number(r['Qty']);
    if (!Number.isFinite(qO) || qO <= 0) bad('Qty must be greater than zero.');
    let uomO = (r['UOM'] || '').trim();
    if (!uomO) { uomO = 'KG'; warn('UOM blank — defaulted to KG.'); }
    if (!UOMS.includes(uomO)) bad('UOM must be KG/LTR/PAC.');
    item.uom = uomO;
    item.order_date = parseFlexDate(r['Order Date']) || todayISO();
    if (r['Order Date'] && !parseFlexDate(r['Order Date'])) bad(`Order Date "${r['Order Date']}" not recognized.`);
    item.billing_date = parseFlexDate(r['Billing Date']);
    if (r['Billing Date'] && !item.billing_date) bad(`Billing Date "${r['Billing Date']}" not recognized.`);
    if (item.status === 'invalid') return item;
    item.product_id = pidO;
    item.enriched = {
      ledger_name: custO.ledger_name, blend_name: blO.product.name,
      route: custO.route || '', route_day: custO.route_day || '',
      payment_terms: custO.payment_type, order_date: item.order_date,
    };
    const fkeyO = dupKey(custO.ledger_id, item.order_date, qO, pidO);
    if (seen.has(fkeyO)) {
      item.status = 'duplicate';
      item.issues.push('Duplicate — Repeated in uploaded file. Only the first occurrence will be saved.');
      return item;
    }
    seen.add(fkeyO);
    const sysIdO = L ? L.orderKeys.get(fkeyO) : null;
    if (sysIdO) {
      item.status = 'duplicate';
      item.issues.push(`Duplicate — Already exists as ${sysIdO} (same Ledger, Order Date, Quantity and Blend). Will not be saved.`);
      return item;
    }
    if (!L) {
      const hitO = await findOrderDuplicate({ ledger_id: custO.ledger_id, order_date: item.order_date, qty: qO, product_id: pidO });
      if (hitO) {
        item.status = 'duplicate';
        item.issues.push(dupMessage(hitO) + ' Will not be saved.');
        return item;
      }
    }
  } else {
    bad('Unknown target.');
  }
  return item;
}

async function previewRows(target, objs, lists) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < objs.length; i++) {
    const item = await validateRow(target, objs[i], seen, lists || null);
    item.rowNum = i + 1;
    out.push(item);
  }
  return out;
}

importRouter.post('/preview', staffOnly, async (req, res, next) => {
  try {
    const { target, csv } = req.body || {};
    if (!TEMPLATES[target]) return res.status(400).json({ success: false, data: [], message: 'Unknown target' });
    const { headers, objs } = toObjects(csv || '');
    if (!objs.length) return res.status(400).json({ success: false, data: [], message: 'Empty file.' });
    // Whole file, every row: masters + order keys read ONCE, then in-memory.
    const lists = await loadLists();
    const rows = await previewRows(target, objs, lists);
    const summary = { total: rows.length, valid: 0, invalid: 0, duplicates: 0 };
    for (const r of rows) {
      if (r.status === 'valid' || r.status === 'valid_with_warnings') summary.valid++;
      else if (r.status === 'invalid') summary.invalid++;
      else summary.duplicates++;
    }
    res.json({ success: true, data: { headers, rows, summary }, message: '' });
  } catch (e) { next(e); }
});

importRouter.post('/confirm', staffOnly, async (req, res, next) => {
  try {
    const { target, csv } = req.body || {};
    if (!TEMPLATES[target]) return res.status(400).json({ success: false, data: [], message: 'Unknown target' });
    // Double-SAVE guard: identical content saved before returns the same result.
    const hash = crypto.createHash('sha256').update(target + '\n' + (csv || '')).digest('hex');
    if (completedSaves.has(hash)) {
      const prev = completedSaves.get(hash);
      return res.json({ success: true, data: prev.report, message: prev.message + ' (already saved — no new records)', duplicate_save: true });
    }
    // Serialize concurrent saves so two rapid clicks cannot interleave.
    const run = async () => runConfirm(target, csv || '', req.user.username);
    const result = await (saveChain = saveChain.then(run, run));
    completedSaves.set(hash, result);
    if (completedSaves.size > 50) completedSaves.delete(completedSaves.keys().next().value);
    res.json({ success: true, data: result.report, message: result.message });
  } catch (e) { next(e); }
});

let saveChain = Promise.resolve();
const completedSaves = new Map();

async function runConfirm(target, csv, username) {
    const { objs } = toObjects(csv);
    // SAVE re-validates everything against the LATEST data (never trusts preview).
    const lists = await loadLists();
    const rows = await previewRows(target, objs, lists);
    let created = 0, updated = 0, rejected = 0, skipped = 0, duplicates = 0;
    const report = [];
    const savedKeys = new Set();
    // In-memory order-ID sequencing (single-threaded + mutex + transaction = safe).
    let seqCache = { prefix: '', next: 1 };
    let seqO = null;
    async function nextOrderIdFast() {
      const stamp = todayISO().replace(/-/g, '');
      if (seqCache.prefix !== stamp) {
        const last = await db.get(`SELECT order_id FROM orders WHERE order_id LIKE 'ORD${stamp}%' AND order_id NOT LIKE 'ORDORD%' ORDER BY order_id DESC LIMIT 1`);
        seqCache = { prefix: stamp, next: last ? parseInt(last.order_id.slice(-4), 10) + 1 : 1 };
      }
      return `ORD${stamp}${String(seqCache.next++).padStart(4, '0')}`;
    }
    await db.run('BEGIN IMMEDIATE');
    try {
    for (const item of rows) {
      const r = item.row;
      if (item.status === 'invalid') { rejected++; report.push({ row: item.rowNum, status: 'rejected', reason: item.issues.join('; ') }); continue; }
      // Duplicates are reported, never saved, never silent.
      if (item.status === 'duplicate' && !item.match_id) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', reason: item.issues.join('; ') }); continue; }
      try {
        if (target === 'customers') {
          if (item.match_id) {
            await db.run(`UPDATE customers SET ledger_name=?, ledger_name_norm=?, mobile=?, mobile_norm=?, address=?, route=?, route_day=?, payment_type=?, status=?, updated_at=datetime('now') WHERE ledger_id=?`,
              [r['Ledger Name'].trim(), normalizeName(r['Ledger Name']), r['Mobile'] || null, normalizePhone(r['Mobile'] || ''),
               r['Address'] || null, r['Route'] || null, r['Route Day'] || null,
               ['Advance', 'Credit'].includes((r['Payment Type'] || '').trim()) ? r['Payment Type'].trim() : 'Credit',
               r['Status'] || 'Active', item.match_id]);
            if ((r['Approved Blend'] || '').trim()) {
              const pid = await resolveProductId(r['Approved Blend']);
              if (pid) await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [item.match_id, pid]);
            }
            updated++;
            report.push({ row: item.rowNum, status: 'updated', ledger_id: item.match_id });
          } else {
            const id = await sharedNextLedgerId();
            await db.run(`INSERT INTO customers(ledger_id, ledger_name, ledger_name_norm, mobile, mobile_norm, address, route, route_day, payment_type, status, created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              [id, r['Ledger Name'].trim(), normalizeName(r['Ledger Name']), r['Mobile'] || null, normalizePhone(r['Mobile'] || ''),
               r['Address'] || null, r['Route'] || null, r['Route Day'] || null,
               ['Advance', 'Credit'].includes((r['Payment Type'] || '').trim()) ? r['Payment Type'].trim() : 'Credit',
               r['Status'] || 'Active', new Date().toISOString()]);
            if ((r['Approved Blend'] || '').trim()) {
              const pid = await resolveProductId(r['Approved Blend']);
              if (pid) await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [id, pid]);
            }
            await db.audit({ username, action: 'CUSTOMER_CREATED', entity: 'customers', record_id: id, new_value: { via: 'bulk' } });
            created++;
            report.push({ row: item.rowNum, status: 'created', ledger_id: id });
          }
        } else if (target === 'products') {
          if (item.match_id) {
            await db.run(`UPDATE products SET uom=?, status=?, std_price=?, updated_at=datetime('now') WHERE id=?`,
              [UOMS.includes((r['UOM'] || '').trim()) ? r['UOM'].trim() : 'KG', r['Status'] || 'Active', Number(r['Std Price'] || 0), item.match_id]);
            updated++;
            report.push({ row: item.rowNum, status: 'updated' });
          } else {
            const sku = await sharedNextSkuId();
            await db.run(`INSERT INTO products(sku_id, name, name_norm, uom, status, std_price) VALUES(?,?,?,?,?,?)`,
              [sku, r['Product Name'].trim(), normalizeName(r['Product Name']), UOMS.includes((r['UOM'] || '').trim()) ? r['UOM'].trim() : 'KG', r['Status'] || 'Active', Number(r['Std Price'] || 0)]);
            await db.audit({ username, action: 'PRODUCT_CREATED', entity: 'products', record_id: sku, new_value: { via: 'bulk' } });
            created++;
            report.push({ row: item.rowNum, status: 'created', sku_id: sku });
          }
        } else if (target === 'delivered') {
          // Use the validated identity from SAVE-time re-validation
          // (exact, Closest Match, or newly created). Never re-resolve blind.
          let cust = item.ledger_id
            ? await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [item.ledger_id])
            : await resolveCustomer(r);
          if (!cust && item.create_customer) {
            const norm = normalizeName(item.create_customer);
            cust = await db.get(`SELECT * FROM customers WHERE ledger_name_norm=?`, [norm]);
            if (!cust) {
              const id = await sharedNextLedgerId();
              await db.run(`INSERT INTO customers(ledger_id, ledger_name, ledger_name_norm, payment_type, status, created_at)
                VALUES(?,?,?,?,?,?)`, [id, item.create_customer.trim(), norm, 'Credit', 'Active', new Date().toISOString()]);
              await db.audit({ username, action: 'CUSTOMER_CREATED', entity: 'customers', record_id: id, new_value: { via: 'delivered-bulk' } });
              cust = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [id]);
              item.new_customer_id = id;
            } else {
              item.ledger_id = cust.ledger_id;
            }
          }
          if (!cust) throw new Error('Unknown Customer/Ledger.');
          await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [cust.ledger_id, item.product_id]);
          const prod = await db.get(`SELECT name FROM products WHERE id=?`, [item.product_id]);
          if (item.match_id) {
            // Update existing delivered record — never a second row.
            await db.run(`UPDATE orders SET qty=?, uom=?, billing_date=?, delivered_on=?, remarks=?, updated_at=datetime('now') WHERE order_id=?`,
              [Number(r['Qty']), (r['UOM'] || '').trim() || 'KG', item.billing_date || null, item.delivered_on, r['Remarks'] || null, item.match_id]);
            updated++;
            report.push({ row: item.rowNum, status: 'updated', order_id: item.match_id });
          } else {
            // SAVE-TIME re-check against latest data (another user may have
            // saved the same order after preview): Order ID + dup identity.
            if ((r['Order ID'] || '').trim()) {
              const exNow = await db.get(`SELECT order_id FROM orders WHERE order_id=?`, [(r['Order ID'] || '').trim()]);
              if (exNow) {
                await db.run(`UPDATE orders SET qty=?, uom=?, billing_date=?, delivered_on=?, remarks=?, updated_at=datetime('now') WHERE order_id=?`,
                  [Number(r['Qty']), (r['UOM'] || '').trim() || 'KG', item.billing_date || null, item.delivered_on, r['Remarks'] || null, exNow.order_id]);
                updated++;
                report.push({ row: item.rowNum, status: 'updated', order_id: exNow.order_id });
                continue;
              }
            }
            const odNow = item.order_date || item.billing_date || '';
            const fkeyNow = dupKey(cust.ledger_id, odNow, Number(r['Qty']), item.product_id);
            if (savedKeys.has(fkeyNow)) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', reason: 'Duplicate — Repeated in uploaded file.' }); continue; }
            const hitNow = await findOrderDuplicate({ ledger_id: cust.ledger_id, order_date: odNow, qty: Number(r['Qty']), product_id: item.product_id });
            if (hitNow) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', reason: dupMessage(hitNow) }); continue; }
            savedKeys.add(fkeyNow);
            // Missing Route/Day auto-filled from customer master; missing Order ID generated.
            let order_id = (r['Order ID'] || '').trim();
            if (!order_id) order_id = await nextOrderIdFast();
            const idem = `bulk-delivered:${order_id}`;
            const dup = await db.get(`SELECT order_id FROM orders WHERE idempotency_key=?`, [idem]);
            if (dup) { report.push({ row: item.rowNum, status: 'duplicate', order_id: dup.order_id }); continue; }
            await db.run(`INSERT INTO orders(order_id, order_date, ledger_id, product_id, blend_snapshot, qty, uom, route, route_day,
              billing_date, delivered_on, remarks, payment_type, payment_status, billing_status, delivery_status, unit_price, total, idempotency_key, created_by)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Billed','Delivered',0,0,?,?)`,
              [order_id, item.order_date || item.billing_date || todayISO(), cust.ledger_id, item.product_id, prod.name,
               Number(r['Qty']), (r['UOM'] || '').trim() || 'KG', r['Route'] || cust.route, r['Route Day'] || cust.route_day,
               item.billing_date || null, item.delivered_on, r['Remarks'] || null,
               cust.payment_type, cust.payment_type === 'Credit' ? 'Credit' : 'Payment Received',
               idem, username]);
            created++;
            report.push({ row: item.rowNum, status: 'created', order_id, ...(item.new_customer_id ? { new_customer: item.new_customer_id } : {}) });
          }
        } else if (target === 'orders') {
          // New rows in Order Tracker. SAVE-time re-check (latest data).
          const custO = await db.get(`SELECT * FROM customers WHERE ledger_id=?`, [item.ledger_id]);
          if (!custO) throw new Error('Customer no longer exists.');
          const odO = item.order_date;
          const fkO = dupKey(custO.ledger_id, odO, Number(r['Qty']), item.product_id);
          if (savedKeys.has(fkO)) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', reason: 'Duplicate — Repeated in uploaded file.' }); continue; }
          const hitO = await findOrderDuplicate({ ledger_id: custO.ledger_id, order_date: odO, qty: Number(r['Qty']), product_id: item.product_id });
          if (hitO) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', reason: dupMessage(hitO) }); continue; }
          savedKeys.add(fkO);
          const prodO = await db.get(`SELECT name, std_price FROM products WHERE id=?`, [item.product_id]);
          // Auto-approve the resolved blend for this ledger (shown in preview).
          await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [custO.ledger_id, item.product_id]);
          const cpr = await db.get(`SELECT price FROM customer_prices WHERE ledger_id=? AND product_id=?`, [custO.ledger_id, item.product_id]);
          const unit = cpr ? Number(cpr.price) : Number((prodO && prodO.std_price) || 0);
          const daystamp = todayISO().replace(/-/g, '');
          if (seqO === null) {
            const lastO = await db.get(`SELECT order_id FROM orders WHERE order_id LIKE 'ORD${daystamp}%' ORDER BY order_id DESC LIMIT 1`);
            seqO = lastO ? parseInt(lastO.order_id.slice(-4), 10) + 1 : 1;
          }
          const order_id = `ORD${daystamp}${String(seqO++).padStart(4, '0')}`;
          const idem = `bulk-orders:${fkO}`;
          const dupO = await db.get(`SELECT order_id FROM orders WHERE idempotency_key=?`, [idem]);
          if (dupO) { duplicates++; report.push({ row: item.rowNum, status: 'duplicate', order_id: dupO.order_id }); continue; }
          await db.run(`INSERT INTO orders(order_id, order_date, ledger_id, product_id, blend_snapshot, qty, uom, route, route_day,
            billing_date, remarks, payment_type, payment_status, billing_status, delivery_status, unit_price, total, idempotency_key, created_by)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [order_id, odO, custO.ledger_id, item.product_id, prodO.name, Number(r['Qty']), item.uom || 'KG',
             custO.route, custO.route_day, item.billing_date || null, r['Remarks'] || null,
             custO.payment_type,
             custO.payment_type === 'Credit' ? 'Credit' : 'Pending',
             'Pending', 'Pending',
             unit, unit * Number(r['Qty']), idem, username]);
          created++;
          report.push({ row: item.rowNum, status: 'created', order_id });
        }
      } catch (err) {
        rejected++;
        report.push({ row: item.rowNum, status: 'rejected', reason: err.message });
      }
    }
    } catch (fatal) {
      try { await db.run('ROLLBACK'); } catch {}
      throw fatal;
    }
    await db.run('COMMIT');
    await db.audit({ username, action: 'BULK_IMPORT', entity: target, record_id: `${created} created, ${updated} updated, ${duplicates} duplicates, ${rejected} rejected` });
    const total = rows.length;
    const message = `Upload Complete — Total Rows: ${total}, New Records: ${created}, Duplicate Rows: ${duplicates}, Invalid Rows: ${rejected}, Saved: ${created + updated}`;
    return { report, message };
}

/* ---------------- routes/admin.routes.js ---------------- */
const adminRouter = express.Router();

// Detect duplicate groups: same Ledger + Order Date + Qty + Blend (canonical IDs).
// Returns groups with the canonical keeper marked (earliest created; seed wins ties).
adminRouter.get('/duplicates', adminOnly, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT o.order_id, o.ledger_id, c.ledger_name, o.order_date, o.qty, o.product_id,
              o.blend_snapshot, o.billing_status, o.delivery_status, o.created_by, o.created_at
       FROM orders o JOIN customers c ON c.ledger_id=o.ledger_id
       ORDER BY o.ledger_id, o.order_date, o.product_id, o.qty, o.created_at`);
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.ledger_id}|${r.order_date || ''}|${Number(r.qty)}|${r.product_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const out = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const sorted = members.slice().sort((a, b) => {
        if (a.created_at !== b.created_at) return String(a.created_at).localeCompare(String(b.created_at));
        const sa = a.created_by === 'seed' ? 0 : 1, sb = b.created_by === 'seed' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return String(a.order_id).localeCompare(String(b.order_id));
      });
      out.push({ keep: sorted[0].order_id, remove: sorted.slice(1).map((m) => m.order_id), members });
    }
    res.json({ success: true, data: out, total: out.length, message: '' });
  } catch (e) { next(e); }
});

// Merge: delete only the confirmed duplicate rows, keep the canonical one.
adminRouter.post('/duplicates/merge', adminOnly, async (req, res, next) => {
  try {
    let ids = Array.isArray(req.body.order_ids) ? req.body.order_ids : null;
    if (!ids) {
      // Recompute groups server-side (never trust the client's keep/remove choice).
      const rows = await db.all(`SELECT order_id, ledger_id, order_date, qty, product_id, created_by, created_at FROM orders`);
      const groups = new Map();
      for (const r of rows) {
        const k = `${r.ledger_id}|${r.order_date || ''}|${Number(r.qty)}|${r.product_id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      ids = [];
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const sorted = members.slice().sort((a, b) => {
          if (a.created_at !== b.created_at) return String(a.created_at).localeCompare(String(b.created_at));
          const sa = a.created_by === 'seed' ? 0 : 1, sb = b.created_by === 'seed' ? 0 : 1;
          if (sa !== sb) return sa - sb;
          return String(a.order_id).localeCompare(String(b.order_id));
        });
        sorted.slice(1).forEach((m) => ids.push(m.order_id));
      }
    }
    if (!ids.length) return res.json({ success: true, data: [{ removed: 0 }], message: 'No duplicates found.' });
    if (ids.length > 2000) return res.status(400).json({ success: false, data: [], message: 'Too many at once; merge in smaller batches.' });
    const ph = ids.map(() => '?').join(',');
    const r = await db.run(`DELETE FROM orders WHERE order_id IN (${ph})`, ids);
    await db.audit({ username: req.user.username, action: 'DUPLICATES_MERGED', entity: 'orders', record_id: `${r.changes} duplicate row(s) removed` });
    res.json({ success: true, data: [{ removed: r.changes }], message: `${r.changes} duplicate row(s) removed; originals kept.` });
  } catch (e) { next(e); }
});

// Normalize double-prefix Order IDs (ORDORD… → ORD…).
// Preview (dry_run=1) or apply. Collision-safe:
//  - normalized ID free → rename (keeps history, fixes display)
//  - normalized ID exists with SAME identity → drop the double-prefixed dup
//  - normalized ID exists with DIFFERENT identity → conflict, left untouched
adminRouter.post('/normalize-order-ids', adminOnly, async (req, res, next) => {
  try {
    const dry = req.body.dry_run !== false && req.body.apply !== true;
    const rows = await db.all(`SELECT * FROM orders WHERE order_id LIKE 'ORDORD%'`);
    const plan = [];
    for (const r of rows) {
      const fixed = r.order_id.replace(/^ORDORD/, 'ORD');
      const ex = await db.get(`SELECT * FROM orders WHERE order_id=?`, [fixed]);
      if (!ex) {
        plan.push({ from: r.order_id, to: fixed, action: 'rename' });
      } else {
        const same = ex.ledger_id === r.ledger_id && (ex.order_date || '') === (r.order_date || '') &&
          Number(ex.qty) === Number(r.qty) && ex.product_id === r.product_id;
        plan.push({ from: r.order_id, to: fixed, action: same ? 'drop-duplicate' : 'conflict (left alone)', existing: fixed });
      }
    }
    if (dry) return res.json({ success: true, data: plan, total: plan.length, message: `${plan.length} double-prefixed IDs found.` });
    let renamed = 0, dropped = 0;
    await db.run('BEGIN IMMEDIATE');
    try {
      for (const p of plan) {
        if (p.action === 'rename') {
          await db.run(`UPDATE orders SET order_id=?, updated_at=datetime('now') WHERE order_id=?`, [p.to, p.from]);
          await db.run(`UPDATE emailed_lines SET order_id=? WHERE order_id=?`, [p.to, p.from]);
          renamed++;
        } else if (p.action === 'drop-duplicate') {
          await db.run(`DELETE FROM orders WHERE order_id=?`, [p.from]);
          dropped++;
        }
      }
      await db.run('COMMIT');
    } catch (e) {
      try { await db.run('ROLLBACK'); } catch {}
      throw e;
    }
    await db.audit({ username: req.user.username, action: 'ORDER_IDS_NORMALIZED', entity: 'orders', record_id: `${renamed} renamed, ${dropped} dropped` });
    res.json({ success: true, data: plan, message: `${renamed} renamed to single ORD, ${dropped} exact duplicates removed.` });
  } catch (e) { next(e); }
});

/* ---------------- seed.js ---------------- */
// Imports seed-data.json (extracted from "Final Web App .xlsx").
// Idempotent: INSERT OR IGNORE / upserts; re-running never duplicates.





async function seed() {
  await db.initializeDatabase();
  await ensureAdmin();
  // Re-normalize master name keys (normalization rules evolve; IDs never change).
  for (const c of await db.all(`SELECT ledger_id, ledger_name, ledger_name_norm FROM customers`)) {
    const n = normalizeName(c.ledger_name);
    if (n !== c.ledger_name_norm) await db.run(`UPDATE customers SET ledger_name_norm=? WHERE ledger_id=?`, [n, c.ledger_id]);
  }
  for (const p of await db.all(`SELECT id, name, name_norm FROM products`)) {
    const n = normalizeName(p.name);
    if (n !== p.name_norm) await db.run(`UPDATE products SET name_norm=? WHERE id=?`, [n, p.id]);
  }
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (!fs.existsSync(seedPath)) { console.log('No seed-data.json, admin ensured.'); return; }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  // Products first (approvals + orders need ids). Preserve SKU IDs.
  const prodIdByNorm = {};
  for (const p of seed.products) {
    const norm = normalizeName(p.name);
    await db.run(`INSERT OR IGNORE INTO products(sku_id, name, name_norm, uom, status) VALUES(?,?,?,?,?)`,
      [p.sku_id, p.name, norm, ['KG', 'LTR', 'PAC'].includes(p.uom) ? p.uom : 'KG', p.status || 'Active']);
    const row = await db.get(`SELECT id FROM products WHERE name_norm=?`, [norm]);
    if (row) prodIdByNorm[norm] = row.id;
  }

  // Customers: preserve permanent ledger IDs from workbook Key sheet.
  const seen = await db.get(`SELECT COUNT(*) c FROM customers`);
  for (const c of seed.customers) {
    await db.run(`INSERT OR IGNORE INTO customers(ledger_id, ledger_name, ledger_name_norm, status, emp_name, address, route, route_day, payment_type, mobile, mobile_norm, city, area, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.ledger_id, c.ledger_name, normalizeName(c.ledger_name), c.status || 'Active', c.emp_name, c.address, c.route,
       c.route_day, ['Advance', 'Credit'].includes(c.payment_type) ? c.payment_type : 'Credit',
       c.mobile, normalizePhone(c.mobile || ''), c.city, c.area, new Date().toISOString()]);
  }

  // Approvals (customer-specific blends). Unknown blend names resolve to new products (canonical).
  for (const a of seed.approvals) {
    const norm = normalizeName(a.blend);
    let pid = prodIdByNorm[norm];
    if (!pid) {
      await db.run(`INSERT OR IGNORE INTO products(name, name_norm, uom, status) VALUES(?,?, 'KG','Active')`, [a.blend.trim(), norm]);
      const row = await db.get(`SELECT id FROM products WHERE name_norm=?`, [norm]);
      pid = row.id;
      prodIdByNorm[norm] = pid;
    }
    await db.run(`INSERT OR IGNORE INTO approvals(ledger_id, product_id) VALUES(?,?)`, [a.ledger_id, pid]);
  }

  // Orders import runs ONCE (guarded): the DUP-rename for reused workbook IDs
  // is not repeat-safe, so never re-import seed orders on later boots.
  const alreadySeeded = (await db.get(`SELECT COUNT(*) c FROM orders WHERE created_by='seed'`)).c;
  if (alreadySeeded > 0) {
    console.log(`Seed orders already present (${alreadySeeded}), skipping order import.`);
  } else {
  const nameToId = {};
  const custs = await db.all(`SELECT ledger_id, ledger_name_norm FROM customers`);
  for (const c of custs) nameToId[c.ledger_name_norm] = c.ledger_id;
  const seenOrderIds = new Set();
  let orderCount = 0;
  for (const o of seed.orders) {
    const ledger_id = nameToId[normalizeName(o.ledger_name || '')];
    if (!ledger_id) continue;
    const pid = prodIdByNorm[normalizeName(o.blend || '')] || null;
    const cust = await db.get(`SELECT payment_type FROM customers WHERE ledger_id=?`, [ledger_id]);
    const payment_type = cust ? cust.payment_type : 'Credit';
    let order_id = o.order_id;
    if (seenOrderIds.has(order_id)) {
      let n = 1;
      while (seenOrderIds.has(`${o.order_id}-DUP${n}`)) n++;
      order_id = `${o.order_id}-DUP${n}`;
      await db.audit({ username: 'seed', action: 'ORDER_ID_DEDUPED', entity: 'orders', record_id: order_id, old_value: o.order_id, new_value: o });
    }
    seenOrderIds.add(order_id);
    await db.run(`INSERT OR IGNORE INTO orders(order_id, order_date, ledger_id, product_id, blend_snapshot, qty, uom, route, route_day,
      billing_date, remarks, payment_type, payment_status, billing_status, delivered_on, delivery_status, idempotency_key, created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'seed:'||?, 'seed')`,
      [order_id, o.order_date || o.billing_date || '2026-08-01', ledger_id, pid, (o.blend || '').trim(),
       Number(o.qty) || 1, ['KG', 'LTR', 'PAC'].includes(o.uom) ? o.uom : 'KG', o.route, o.route_day,
       o.billing_date || o.order_date || '2026-08-01', o.remarks,
       payment_type, payment_type === 'Credit' ? 'Credit' : 'Payment Received', 'Billed',
       o.delivered_on || o.billing_date, 'Delivered', order_id]);
    orderCount++;
  }
  } // end once-only seed order import

  for (const h of seed.holidays) {
    if (!h.date) continue;
    await db.run(`INSERT OR IGNORE INTO holidays(date, name, type) VALUES(?,?,?)`, [h.date, h.name, h.type]);
  }

  const counts = {
    customers: (await db.get(`SELECT COUNT(*) c FROM customers`)).c,
    products: (await db.get(`SELECT COUNT(*) c FROM products`)).c,
    approvals: (await db.get(`SELECT COUNT(*) c FROM approvals`)).c,
    orders: (await db.get(`SELECT COUNT(*) c FROM orders`)).c,
    holidays: (await db.get(`SELECT COUNT(*) c FROM holidays`)).c,
  };
  console.log('Seed complete:', JSON.stringify(counts));
}

/* ---------------- server.js ---------------- */
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Dashboard cache: dashboard data is identical for every user, so a short
// in-memory TTL keeps repeat loads in single-digit ms. Busted on any write.
const DASH_TTL_MS = 30000;
const dashCache = { at: 0, payload: null };
function bustDash(req, res, next) { if (req.method !== 'GET') dashCache.at = 0; next(); }

app.use(express.json({ limit: '10mb' }));
app.disable('x-powered-by');
app.use(compression({ threshold: 1024 })); // gzip JSON payloads for sub-100ms delivery

async function boot() {
  await db.initializeDatabase();
  await seed();
}

app.use('/api/auth', authRouter);
app.use('/api/customers', authenticate, bustDash, customerRouter);
app.use('/api/products', authenticate, bustDash, productRouter);
app.use('/api/orders', authenticate, bustDash, orderRouter);
app.use('/api/reports', authenticate, reportRouter);
app.use('/api/holidays', authenticate, holidayRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/import', importRouter);
app.use('/api/admin', adminRouter);

// customer/product/order/report/holiday routers already carry their own guards;
// /api/customers etc. mounted with authenticate above AND per-route staffOnly.
// Remove double-auth noise: express allows stacked middleware, harmless.

app.get('/api/health', (req, res) => res.json({ success: true, data: [{ ok: true }], message: '' }));

app.use(express.static(__dirname, { index: 'index.html', redirect: false }));
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get(/^(?!\/api).+/, (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Central error handler: logs, user gets a simple message (no stack traces).
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, next) => {
  const status = err.status || 500;
  const safeMessage = status >= 500 ? 'Server error. Please try again or contact the administrator.' : (err.message || 'Request failed');
  try {
    await db.logError({
      username: (req.user && req.user.username) || null,
      api_endpoint: req.originalUrl || '', action: req.method,
      http_status: status, message: err.message, details: err.stack,
    });
  } catch {}
  res.status(status).json({ success: false, data: [], message: safeMessage });
});

boot().then(() => {
  startScheduler(); // 10:00 billing email, 18:00 EOD email
  app.listen(PORT, HOST, () => console.log(`Coffee ERP listening on ${HOST}:${PORT}`));
}).catch((e) => { console.error('Boot failed:', e); process.exit(1); });