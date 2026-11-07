'use strict';
/*
 * Doneline — a private, single-owner notes & to-do board.
 * - Public landing page (indexable by search engines)
 * - Owner-only app behind a password (+ one-time setup code)
 * - Gmail reminders, daily digest, one-click "Done / Tomorrow" links in emails
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- tiny .env loader ----------
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const express = require('express');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 7070;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE = BASE_URL.startsWith('https://');
const SITE_NAME = process.env.SITE_NAME || 'Doneline';
const SITE_TAGLINE = process.env.SITE_TAGLINE || 'Write it down. Get it done.';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'doneline.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  due_time TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  people TEXT NOT NULL DEFAULT '[]',
  repeat TEXT,
  remind INTEGER NOT NULL DEFAULT -1,
  remind_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT, subject TEXT, html TEXT, status TEXT, error TEXT, created_at INTEGER
);
`);

const getSetting = (k, d = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : String(v));

if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
const SECRET = getSetting('secret');
const hasOwner = () => !!getSetting('owner_hash');

// One-time setup code so nobody else can claim the app once it is online.
let SETUP_CODE = process.env.SETUP_CODE || null;
if (!hasOwner() && !SETUP_CODE) SETUP_CODE = String(crypto.randomInt(100000, 999999));

// ---------- time helpers (owner's timezone) ----------
const fmtCache = new Map();
function partsIn(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return p;
}
function localNow(tz, ts = Date.now()) {
  const p = partsIn(ts, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function tzOffset(ts, tz) {
  const p = partsIn(ts, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz);
  return ts;
}
const pad = (n) => String(n).padStart(2, '0');
function ymd(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return ymd(y, m, d + n); }
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, dim));
}
function weekday(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function nextRepeat(date, rep) {
  switch (rep) {
    case 'daily': return addDays(date, 1);
    case 'weekdays': { let n = addDays(date, 1); while ([0, 6].includes(weekday(n))) n = addDays(n, 1); return n; }
    case 'weekly': return addDays(date, 7);
    case 'biweekly': return addDays(date, 14);
    case 'monthly': return addMonths(date, 1);
    case 'yearly': return addMonths(date, 12);
    default: return null;
  }
}
const tz = () => getSetting('tz', 'Asia/Almaty');
function validTz(z) { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } }

// ---------- tasks ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
const REMINDS = [-1, 0, 5, 10, 15, 30, 60, 120, 1440];
const clampInt = (v, a, b) => Math.max(a, Math.min(b, Math.round(Number(v) || 0)));

function rowToTask(r) {
  if (!r) return null;
  return { ...r, tags: JSON.parse(r.tags || '[]'), people: JSON.parse(r.people || '[]'), pinned: !!r.pinned, reminded: !!r.reminded };
}
function cleanTask(b, base) {
  const t = { ...base };
  if ('title' in b) t.title = String(b.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if ('notes' in b) t.notes = String(b.notes ?? '').slice(0, 20000);
  if ('due_date' in b) t.due_date = DATE_RE.test(b.due_date || '') ? b.due_date : null;
  if ('due_time' in b) t.due_time = TIME_RE.test(b.due_time || '') ? b.due_time : null;
  if (!t.due_date) t.due_time = null;
  if ('priority' in b) t.priority = clampInt(b.priority, 0, 3);
  if ('tags' in b) t.tags = Array.isArray(b.tags)
    ? [...new Set(b.tags.map((x) => String(x).trim().replace(/^#/, '').toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20) : [];
  if ('people' in b) t.people = Array.isArray(b.people) ? [...new Set(b.people.map(Number).filter(Number.isInteger))].slice(0, 20) : [];
  if ('repeat' in b) t.repeat = REPEATS.includes(b.repeat) ? b.repeat : null;
  if ('remind' in b) t.remind = REMINDS.includes(Number(b.remind)) ? Number(b.remind) : -1;
  if ('pinned' in b) t.pinned = !!b.pinned;
  return t;
}
function computeRemindAt(t) {
  if (t.done_at || !t.due_date || t.remind < 0) return null;
  const time = t.due_time || getSetting('digest_time', '08:00');
  return zonedToUtc(t.due_date, time, tz()) - t.remind * 60000;
}
function saveTask(t, prev) {
  const now = Date.now();
  t.remind_at = computeRemindAt(t);
  if (!prev || prev.remind_at !== t.remind_at) t.reminded = t.remind_at != null && t.remind_at < now - 60000;
  const vals = [t.title, t.notes || '', t.due_date ?? null, t.due_time ?? null, t.priority || 0, JSON.stringify(t.tags || []),
    JSON.stringify(t.people || []), t.repeat ?? null, t.remind ?? -1, t.remind_at ?? null, t.reminded ? 1 : 0, t.pinned ? 1 : 0, t.done_at ?? null];
  if (prev) {
    db.prepare(`UPDATE tasks SET title=?, notes=?, due_date=?, due_time=?, priority=?, tags=?, people=?, repeat=?, remind=?,
      remind_at=?, reminded=?, pinned=?, done_at=?, updated_at=? WHERE id=?`).run(...vals, now, prev.id);
    return getTask(prev.id);
  }
  const r = db.prepare(`INSERT INTO tasks(title, notes, due_date, due_time, priority, tags, people, repeat, remind, remind_at,
    reminded, pinned, done_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, now, now);
  return getTask(Number(r.lastInsertRowid));
}
const getTask = (id) => rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));

// ---------- email ----------
let transporter = null;
let mailMode = 'preview';
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
  });
  mailMode = 'gmail';
} else if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  mailMode = 'smtp';
}
const FROM = process.env.MAIL_FROM || (process.env.GMAIL_USER ? `${SITE_NAME} <${process.env.GMAIL_USER}>` : `${SITE_NAME} <no-reply@localhost>`);

async function sendMail(to, subject, html) {
  const now = Date.now();
  const ins = db.prepare('INSERT INTO outbox(to_addr, subject, html, status, error, created_at) VALUES(?,?,?,?,?,?)');
  if (!transporter) {
    ins.run(to, subject, html, 'preview', null, now);
    console.log(`[mail:preview] to=${to} subject="${subject}"`);
  } else {
    try {
      await transporter.sendMail({ from: FROM, to, subject, html });
      ins.run(to, subject, html, 'sent', null, now);
      console.log(`[mail] sent to=${to} subject="${subject}"`);
    } catch (e) {
      ins.run(to, subject, html, 'error', String(e.message || e), now);
      console.error('[mail] failed', e.message);
      throw e;
    }
  }
  db.prepare('DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT 300)').run();
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (id) => crypto.createHmac('sha256', SECRET).update(`task:${id}`).digest('hex').slice(0, 24);
const actionUrl = (id) => `${BASE_URL}/t/${id}/${sign(id)}`;
const PRIO = ['', 'Low', 'Medium', 'High'];
const PRIO_COLOR = ['#9aa3af', '#3b82f6', '#f59e0b', '#ef4444'];

function prettyDate(d) {
  if (!d) return 'No date';
  const t = localNow(tz()).date;
  if (d === t) return 'Today';
  if (d === addDays(t, 1)) return 'Tomorrow';
  if (d === addDays(t, -1)) return 'Yesterday';
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function taskLineHtml(t, withActions) {
  const when = `${prettyDate(t.due_date)}${t.due_time ? ' · ' + t.due_time : ''}`;
  const actions = withActions
    ? `<a href="${actionUrl(t.id)}?a=done" style="background:#16a34a;color:#fff;text-decoration:none;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600;margin-right:6px">✓ Done</a>
       <a href="${actionUrl(t.id)}?a=tomorrow" style="background:#eef2ff;color:#4338ca;text-decoration:none;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600">→ Tomorrow</a>`
    : '';
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
    <div style="font-size:16px;font-weight:600;color:#111"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PRIO_COLOR[t.priority]};margin-right:8px"></span>${escHtml(t.title)}</div>
    <div style="font-size:13px;color:#6b7280;margin:4px 0 8px 18px">${escHtml(when)}${t.priority ? ' · ' + PRIO[t.priority] : ''}${t.tags.length ? ' · ' + t.tags.map((x) => '#' + escHtml(x)).join(' ') : ''}</div>
    ${t.notes ? `<div style="font-size:13px;color:#374151;margin:0 0 8px 18px;white-space:pre-wrap">${escHtml(t.notes.slice(0, 400))}</div>` : ''}
    <div style="margin-left:18px">${actions}</div></td></tr>`;
}
function emailShell(heading, inner, footer = '') {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-size:13px;font-weight:700;color:#6366f1;letter-spacing:.04em">✓ ${escHtml(SITE_NAME.toUpperCase())}</div>
  <h1 style="font-size:22px;margin:8px 0 16px">${heading}</h1>
  <table style="width:100%;border-collapse:collapse">${inner}</table>
  <p style="margin-top:20px"><a href="${BASE_URL}/app" style="color:#6366f1;font-weight:600">Open ${escHtml(SITE_NAME)} →</a></p>
  <p style="font-size:12px;color:#9ca3af">${footer}</p></div>`;
}
function ownerEmail() { return getSetting('owner_email'); }
function peopleByIds(ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM people WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

async function sendReminder(t) {
  const when = `${prettyDate(t.due_date)}${t.due_time ? ' at ' + t.due_time : ''}`;
  const subject = `⏰ ${t.title} — ${when}`;
  const owner = ownerEmail();
  const jobs = [];
  if (owner) jobs.push(sendMail(owner, subject, emailShell('Reminder', taskLineHtml(t, true))));
  for (const p of peopleByIds(t.people)) {
    if (p.email === owner) continue;
    jobs.push(sendMail(p.email, subject, emailShell(`Hi ${escHtml(p.name)}, a reminder for you`, taskLineHtml(t, false),
      `You receive this because you were added to this task on ${escHtml(SITE_NAME)}.`)));
  }
  await Promise.allSettled(jobs);
}

function openTasksForDigest(today) {
  return db.prepare(`SELECT * FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?
    ORDER BY due_date, due_time IS NULL, due_time, priority DESC`).all(today).map(rowToTask);
}
async function sendDigest(force = false) {
  const zone = tz();
  const { date: today } = localNow(zone);
  const all = openTasksForDigest(today);
  const owner = ownerEmail();
  const jobs = [];
  const section = (title, list, actions) => list.length
    ? `<tr><td style="padding-top:14px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">${title} (${list.length})</td></tr>${list.map((t) => taskLineHtml(t, actions)).join('')}` : '';
  if (owner && (all.length || force)) {
    const overdue = all.filter((t) => t.due_date < today);
    const todays = all.filter((t) => t.due_date === today);
    const inner = all.length ? section('Overdue', overdue, true) + section('Today', todays, true)
      : '<tr><td style="color:#6b7280">Nothing due today. Enjoy the free time 🎉</td></tr>';
    const subject = `📋 Today: ${todays.length} task${todays.length === 1 ? '' : 's'}${overdue.length ? ` · ${overdue.length} overdue` : ''}`;
    jobs.push(sendMail(owner, subject, emailShell(`Good morning! Here's your day`, inner)));
  }
  for (const p of db.prepare('SELECT * FROM people WHERE active = 1 AND digest = 1').all()) {
    if (p.email === owner) continue;
    const mine = all.filter((t) => t.people.includes(p.id));
    if (!mine.length) continue;
    jobs.push(sendMail(p.email, `📋 ${mine.length} task${mine.length === 1 ? '' : 's'} for you today`,
      emailShell(`Hi ${escHtml(p.name)}, here's what's on for you`, section('Due', mine, false),
        `You receive this daily digest from ${escHtml(SITE_NAME)}.`)));
  }
  const res = await Promise.allSettled(jobs);
  return res.length;
}

// ---------- scheduler ----------
let ticking = false;
async function tick() {
  if (ticking || !hasOwner()) return;
  ticking = true;
  try {
    const due = db.prepare('SELECT * FROM tasks WHERE done_at IS NULL AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?').all(Date.now()).map(rowToTask);
    for (const t of due) {
      db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(t.id);
      await sendReminder(t);
    }
    if (getSetting('digest_on', '1') === '1') {
      const { date, time } = localNow(tz());
      if (time >= getSetting('digest_time', '08:00') && getSetting('last_digest') !== date) {
        setSetting('last_digest', date);
        await sendDigest();
      }
    }
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    ticking = false;
  }
}
setInterval(tick, 20000);

// ---------- auth ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw) {
  const salt = getSetting('owner_salt');
  const hash = getSetting('owner_hash');
  if (!salt || !hash) return false;
  const a = Buffer.from(hashPw(pw, salt).hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const COOKIE = 'dl_sess';
function startSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 90 * 24 * 3600;
  db.prepare('INSERT INTO sessions(id, expires) VALUES(?, ?)').run(sha(token), Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);
}
function isAuthed(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return false;
  const r = db.prepare('SELECT expires FROM sessions WHERE id = ?').get(sha(tok));
  return !!r && r.expires > Date.now();
}
const failures = new Map();
function tooMany(ip) {
  const f = failures.get(ip);
  return f && f.count >= 8 && Date.now() - f.first < 15 * 60000;
}
function noteFail(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  next();
});
app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: false }));

const tpl = (file) => fs.readFileSync(path.join(__dirname, 'views', file), 'utf8')
  .replaceAll('{{SITE_NAME}}', escHtml(SITE_NAME))
  .replaceAll('{{SITE_TAGLINE}}', escHtml(SITE_TAGLINE))
  .replaceAll('{{BASE_URL}}', escHtml(BASE_URL));

app.get('/', (req, res) => res.type('html').send(tpl('index.html')));
app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nAllow: /$\nDisallow: /app\nDisallow: /api/\nDisallow: /t/\nDisallow: /login\nSitemap: ${BASE_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${BASE_URL}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/app');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(tpl('login.html'));
});
app.get('/app', (req, res) => {
  if (!isAuthed(req)) return res.redirect('/login');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(tpl('app.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

// --- auth API
app.get('/api/auth/state', (req, res) => res.json({ owner: hasOwner(), authed: isAuthed(req) }));
app.post('/api/auth/setup', (req, res) => {
  if (hasOwner()) return res.status(400).json({ error: 'Already set up' });
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const { email, password, code, tz: zone } = req.body || {};
  if (String(code || '').trim() !== SETUP_CODE) { noteFail(ip); return res.status(403).json({ error: 'Wrong setup code (see the server console).' }); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { salt, hash } = hashPw(String(password));
  setSetting('owner_email', email.trim().toLowerCase());
  setSetting('owner_salt', salt);
  setSetting('owner_hash', hash);
  setSetting('tz', validTz(zone) ? zone : 'Asia/Almaty');
  setSetting('digest_time', '08:00');
  setSetting('digest_on', '1');
  setSetting('last_digest', localNow(tz()).date);
  SETUP_CODE = null;
  seedWelcome();
  startSession(res);
  res.json({ ok: true });
});
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!checkPw(String(req.body?.password || ''))) { noteFail(ip); return res.status(401).json({ error: 'Wrong password' }); }
  failures.delete(ip);
  startSession(res);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  const tok = parseCookies(req)[COOKIE];
  if (tok) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(tok));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}`);
  res.json({ ok: true });
});

// --- everything else under /api requires the owner + CSRF header
app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not signed in' });
  if (req.method !== 'GET' && req.get('X-DL') !== '1') return res.status(403).json({ error: 'Bad request origin' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function meJson() {
  return {
    email: ownerEmail(), tz: tz(), digest_time: getSetting('digest_time', '08:00'), digest_on: getSetting('digest_on', '1') === '1',
    mail_mode: mailMode, mail_from: FROM, site_name: SITE_NAME, base_url: BASE_URL,
  };
}
app.get('/api/me', (req, res) => res.json(meJson()));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.email !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return res.status(400).json({ error: 'Invalid email' });
    setSetting('owner_email', b.email.trim().toLowerCase());
  }
  if (b.tz !== undefined) { if (!validTz(b.tz)) return res.status(400).json({ error: 'Unknown timezone' }); setSetting('tz', b.tz); }
  if (b.digest_time !== undefined) { if (!TIME_RE.test(b.digest_time)) return res.status(400).json({ error: 'Invalid time' }); setSetting('digest_time', b.digest_time); }
  if (b.digest_on !== undefined) setSetting('digest_on', b.digest_on ? '1' : '0');
  if (b.tz !== undefined || b.digest_time !== undefined) {
    // timezone / digest time changes move reminder moments
    for (const t of db.prepare('SELECT * FROM tasks WHERE done_at IS NULL').all().map(rowToTask)) saveTask(t, t);
  }
  res.json(meJson());
});
app.post('/api/settings/password', (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPw(String(current || ''))) return res.status(401).json({ error: 'Current password is wrong' });
  if (String(nw || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const { salt, hash } = hashPw(String(nw));
  setSetting('owner_salt', salt);
  setSetting('owner_hash', hash);
  db.prepare('DELETE FROM sessions').run();
  startSession(res);
  res.json({ ok: true });
});

// --- tasks
app.get('/api/tasks', (req, res) => res.json(db.prepare('SELECT * FROM tasks ORDER BY id').all().map(rowToTask)));
app.post('/api/tasks', (req, res) => {
  const t = cleanTask(req.body || {}, { title: '', notes: '', priority: 0, tags: [], people: [], repeat: null, remind: -1, pinned: false });
  if (!t.title) return res.status(400).json({ error: 'Title is required' });
  if (req.body?.done_at) t.done_at = Number(req.body.done_at) || null;
  res.json(saveTask(t, null));
});
app.patch('/api/tasks/:id', (req, res) => {
  const prev = getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const t = cleanTask(req.body || {}, prev);
  if (!t.title) t.title = prev.title;
  res.json(saveTask(t, prev));
});
app.post('/api/tasks/bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const out = [];
  for (const id of ids.slice(0, 500)) {
    const prev = getTask(id);
    if (prev) out.push(saveTask(cleanTask(req.body.patch || {}, prev), prev));
  }
  res.json(out);
});
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
function completeTask(prev) {
  let next = null;
  if (prev.repeat && !prev.done_at) {
    const today = localNow(tz()).date;
    let d = nextRepeat(prev.due_date || today, prev.repeat);
    while (d < today) d = nextRepeat(d, prev.repeat);
    next = saveTask({ ...prev, id: undefined, due_date: d, done_at: null, reminded: false }, null);
  }
  const task = saveTask({ ...prev, done_at: Date.now() }, prev);
  return { task, next };
}
app.post('/api/tasks/:id/complete', (req, res) => {
  const prev = getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  if (prev.done_at) return res.json({ task: prev, next: null });
  res.json(completeTask(prev));
});
app.post('/api/tasks/:id/uncomplete', (req, res) => {
  const prev = getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const removeNext = Number(req.body?.remove_next);
  if (removeNext) db.prepare('DELETE FROM tasks WHERE id = ? AND done_at IS NULL').run(removeNext);
  res.json(saveTask({ ...prev, done_at: null }, prev));
});

// --- people (who gets emails)
const cleanPerson = (b) => ({
  name: String(b.name || '').trim().slice(0, 80),
  email: String(b.email || '').trim().toLowerCase().slice(0, 200),
  digest: b.digest ? 1 : 0,
  active: b.active === false ? 0 : 1,
});
app.get('/api/people', (req, res) => res.json(db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all()));
app.post('/api/people', (req, res) => {
  const p = cleanPerson(req.body || {});
  if (!p.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return res.status(400).json({ error: 'Name and a valid email are required' });
  const r = db.prepare('INSERT INTO people(name, email, digest, active, created_at) VALUES(?,?,?,?,?)').run(p.name, p.email, p.digest, p.active, Date.now());
  res.json(db.prepare('SELECT * FROM people WHERE id = ?').get(Number(r.lastInsertRowid)));
});
app.patch('/api/people/:id', (req, res) => {
  const prev = db.prepare('SELECT * FROM people WHERE id = ?').get(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const p = cleanPerson({ ...prev, digest: !!prev.digest, active: !!prev.active, ...req.body });
  if (!p.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return res.status(400).json({ error: 'Name and a valid email are required' });
  db.prepare('UPDATE people SET name=?, email=?, digest=?, active=? WHERE id=?').run(p.name, p.email, p.digest, p.active, prev.id);
  res.json(db.prepare('SELECT * FROM people WHERE id = ?').get(prev.id));
});
app.delete('/api/people/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM people WHERE id = ?').run(id);
  for (const t of db.prepare("SELECT * FROM tasks WHERE people LIKE '%' || ? || '%'").all(String(id)).map(rowToTask)) {
    if (t.people.includes(id)) saveTask({ ...t, people: t.people.filter((x) => x !== id) }, t);
  }
  res.json({ ok: true });
});

// --- email tools
app.post('/api/email/test', async (req, res) => {
  const to = ownerEmail();
  try {
    await sendMail(to, `✅ ${SITE_NAME} email works`, emailShell('Email delivery works 🎉',
      `<tr><td style="color:#374151">Reminders and your daily digest will arrive at <b>${escHtml(to)}</b>.</td></tr>`));
    res.json({ ok: true, mode: mailMode });
  } catch (e) { res.status(500).json({ error: 'Sending failed: ' + e.message }); }
});
app.post('/api/email/digest', async (req, res) => {
  try { const n = await sendDigest(true); res.json({ ok: true, sent: n }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/outbox', (req, res) => res.json(db.prepare('SELECT id, to_addr, subject, status, error, created_at FROM outbox ORDER BY id DESC LIMIT 25').all()));
app.get('/api/outbox/:id', (req, res) => {
  const r = db.prepare('SELECT html FROM outbox WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).end();
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(r.html);
});
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="doneline-export-${localNow(tz()).date}.json"`);
  res.json({ exported_at: new Date().toISOString(), tasks: db.prepare('SELECT * FROM tasks').all().map(rowToTask), people: db.prepare('SELECT * FROM people').all() });
});

// --- one-click actions from email (GET shows a confirm page so mail scanners can't trigger it)
function verifySig(id, sig) {
  const a = Buffer.from(sign(id));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function actionPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>${escHtml(title)} · ${escHtml(SITE_NAME)}</title><link rel="stylesheet" href="/action.css"></head>
  <body><main class="card"><div class="brand">✓ ${escHtml(SITE_NAME)}</div>${body}</main></body></html>`;
}
app.get('/t/:id/:sig', (req, res) => {
  const id = Number(req.params.id);
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!verifySig(id, req.params.sig)) return res.status(403).type('html').send(actionPage('Invalid link', '<h1>This link is not valid.</h1>'));
  const t = getTask(id);
  if (!t) return res.type('html').send(actionPage('Gone', '<h1>This task no longer exists.</h1><a class="btn ghost" href="/app">Open app</a>'));
  if (t.done_at) return res.type('html').send(actionPage('Done', `<h1>Already done ✓</h1><p class="t">${escHtml(t.title)}</p><a class="btn ghost" href="/app">Open app</a>`));
  const a = req.query.a === 'tomorrow' ? 'tomorrow' : 'done';
  res.type('html').send(actionPage('Confirm', `<p class="t">${escHtml(t.title)}</p>
    <form method="post"><input type="hidden" name="a" value="done"><button class="btn ${a === 'done' ? '' : 'ghost'}">✓ Mark as done</button></form>
    <form method="post"><input type="hidden" name="a" value="tomorrow"><button class="btn ${a === 'tomorrow' ? '' : 'ghost'}">→ Move to tomorrow</button></form>`));
});
app.post('/t/:id/:sig', (req, res) => {
  const id = Number(req.params.id);
  if (!verifySig(id, req.params.sig)) return res.status(403).send('Invalid link');
  const t = getTask(id);
  if (!t) return res.redirect(`/t/${id}/${req.params.sig}`);
  let msg;
  if (req.body.a === 'tomorrow') {
    saveTask({ ...t, due_date: addDays(localNow(tz()).date, 1) }, t);
    msg = 'Moved to tomorrow →';
  } else {
    completeTask(t);
    msg = 'Done! ✓';
  }
  res.type('html').send(actionPage(msg, `<h1>${msg}</h1><p class="t">${escHtml(t.title)}</p><a class="btn ghost" href="/app">Open app</a>`));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).type('html').send(actionPage('Not found', '<h1>Page not found</h1><a class="btn ghost" href="/">Home</a>')));

function seedWelcome() {
  if (db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n) return;
  const today = localNow(tz()).date;
  const base = { notes: '', due_time: null, priority: 0, tags: [], people: [], repeat: null, remind: -1, pinned: false };
  const seed = [
    { title: 'Try the quick-add: type “Call mom tomorrow 7pm #family !2”', due_date: today, priority: 3, tags: ['welcome'] },
    { title: 'Press X (or click the circle) to complete a task', due_date: today, tags: ['welcome'] },
    { title: 'Open Settings → add people who should get email reminders', due_date: today, tags: ['welcome'] },
    { title: 'Press ? to see all keyboard shortcuts', due_date: null, tags: ['welcome'] },
  ];
  for (const s of seed) saveTask({ ...base, ...s }, null);
}

app.listen(PORT, () => {
  console.log(`\n  ${SITE_NAME} running → ${BASE_URL}`);
  console.log(`  Email: ${mailMode === 'preview' ? 'PREVIEW mode (set GMAIL_USER + GMAIL_APP_PASSWORD in .env to really send)' : mailMode}`);
  if (!hasOwner()) console.log(`\n  ▶ First-time setup: open ${BASE_URL}/login and use setup code: ${SETUP_CODE}\n`);
  tick();
});
