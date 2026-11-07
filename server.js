'use strict';
/*
 * Doneline — a private, single-owner notes & to-do board.
 * - Public landing page (indexable by search engines)
 * - Owner-only app behind a password (+ one-time setup code)
 * - Email reminders, daily digest, one-click "Done / Tomorrow" links in emails
 * Storage: Postgres when DATABASE_URL is set, otherwise a local SQLite file.
 * Email: Brevo HTTPS API (works on free hosts), Gmail SMTP, any SMTP, or preview mode.
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
const { openDb } = require('./db');

const PORT = Number(process.env.PORT) || 7070;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE = BASE_URL.startsWith('https://');
const SITE_NAME = process.env.SITE_NAME || 'Doneline';
const SITE_TAGLINE = process.env.SITE_TAGLINE || 'Write it down. Get it done.';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

let db; // set in main()
const settings = new Map(); // in-memory cache of the settings table

const getSetting = (k, d = null) => (settings.has(k) ? settings.get(k) : d);
async function setSetting(k, v) {
  const val = v == null ? null : String(v);
  settings.set(k, val);
  await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, val);
}
const hasOwner = () => !!getSetting('owner_hash');
let SECRET;
let SETUP_CODE = process.env.SETUP_CODE || null;

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
const getTask = async (id) => rowToTask(await db.get('SELECT * FROM tasks WHERE id = ?', id));
async function saveTask(t, prev) {
  const now = Date.now();
  t.remind_at = computeRemindAt(t);
  if (!prev || prev.remind_at !== t.remind_at) t.reminded = t.remind_at != null && t.remind_at < now - 60000;
  const vals = [t.title, t.notes || '', t.due_date ?? null, t.due_time ?? null, t.priority || 0, JSON.stringify(t.tags || []),
    JSON.stringify(t.people || []), t.repeat ?? null, t.remind ?? -1, t.remind_at ?? null, t.reminded ? 1 : 0, t.pinned ? 1 : 0, t.done_at ?? null];
  if (prev) {
    await db.run(`UPDATE tasks SET title=?, notes=?, due_date=?, due_time=?, priority=?, tags=?, people=?, repeat=?, remind=?,
      remind_at=?, reminded=?, pinned=?, done_at=?, updated_at=? WHERE id=?`, ...vals, now, prev.id);
    return getTask(prev.id);
  }
  const r = await db.get(`INSERT INTO tasks(title, notes, due_date, due_time, priority, tags, people, repeat, remind, remind_at,
    reminded, pinned, done_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, ...vals, now, now);
  return getTask(Number(r.id));
}

// ---------- email ----------
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER || 'no-reply@localhost';
const FROM_NAME = process.env.MAIL_FROM_NAME || SITE_NAME;
let mailMode = 'preview';
let deliver = null;
if (process.env.BREVO_API_KEY) {
  mailMode = 'brevo';
  deliver = async (to, subject, html) => {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: FROM_NAME, email: FROM_EMAIL }, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 300)}`);
  };
} else if ((process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) || process.env.SMTP_HOST) {
  const gmail = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const transporter = gmail
    ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } })
    : nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  mailMode = gmail ? 'gmail' : 'smtp';
  deliver = (to, subject, html) => transporter.sendMail({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, html });
}

async function sendMail(to, subject, html) {
  const ins = (status, err) => db.run('INSERT INTO outbox(to_addr, subject, html, status, error, created_at) VALUES(?,?,?,?,?,?)',
    to, subject, html, status, err, Date.now());
  try {
    if (!deliver) {
      await ins('preview', null);
      console.log(`[mail:preview] to=${to} subject="${subject}"`);
    } else {
      try {
        await deliver(to, subject, html);
        await ins('sent', null);
        console.log(`[mail] sent to=${to} subject="${subject}"`);
      } catch (e) {
        await ins('error', String(e.message || e));
        console.error('[mail] failed', e.message);
        throw e;
      }
    }
  } finally {
    await db.run('DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT 300)');
  }
}

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
const ownerEmail = () => getSetting('owner_email');
async function peopleByIds(ids) {
  if (!ids.length) return [];
  return db.all(`SELECT * FROM people WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
}

async function sendReminder(t) {
  const when = `${prettyDate(t.due_date)}${t.due_time ? ' at ' + t.due_time : ''}`;
  const subject = `⏰ ${t.title} — ${when}`;
  const owner = ownerEmail();
  const jobs = [];
  if (owner) jobs.push(sendMail(owner, subject, emailShell('Reminder', taskLineHtml(t, true))));
  for (const p of await peopleByIds(t.people)) {
    if (p.email === owner) continue;
    jobs.push(sendMail(p.email, subject, emailShell(`Hi ${escHtml(p.name)}, a reminder for you`, taskLineHtml(t, false),
      `You receive this because you were added to this task on ${escHtml(SITE_NAME)}.`)));
  }
  await Promise.allSettled(jobs);
}

async function sendDigest(force = false) {
  const { date: today } = localNow(tz());
  const all = (await db.all(`SELECT * FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?
    ORDER BY due_date, due_time IS NULL, due_time, priority DESC`, today)).map(rowToTask);
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
  for (const p of await db.all('SELECT * FROM people WHERE active = 1 AND digest = 1')) {
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

// ---------- scheduler (also triggered by GET /cron from an external pinger) ----------
let ticking = null;
function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    if (!hasOwner()) return;
    try {
      const due = (await db.all('SELECT * FROM tasks WHERE done_at IS NULL AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?', Date.now())).map(rowToTask);
      for (const t of due) {
        await db.run('UPDATE tasks SET reminded = 1 WHERE id = ?', t.id);
        await sendReminder(t);
      }
      if (getSetting('digest_on', '1') === '1') {
        const { date, time } = localNow(tz());
        if (time >= getSetting('digest_time', '08:00') && getSetting('last_digest') !== date) {
          await setSetting('last_digest', date);
          await sendDigest();
        }
      }
      await db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    } catch (e) {
      console.error('[tick]', e);
    }
  })().finally(() => { ticking = null; });
  return ticking;
}

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
async function startSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 90 * 24 * 3600;
  await db.run('INSERT INTO sessions(id, expires) VALUES(?, ?)', sha(token), Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);
}
async function isAuthed(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return false;
  const r = await db.get('SELECT expires FROM sessions WHERE id = ?', sha(tok));
  return !!r && Number(r.expires) > Date.now();
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
// wrap async handlers so errors become 500s instead of crashing
const A = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nAllow: /$\nDisallow: /app\nDisallow: /api/\nDisallow: /t/\nDisallow: /login\nDisallow: /cron\nSitemap: ${BASE_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${BASE_URL}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`));
// Keep-alive + scheduler trigger for free hosts that sleep. Safe to call by anyone: it only runs due work.
app.get('/cron', A(async (req, res) => {
  await tick();
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('text').send('ok');
}));

app.get('/login', A(async (req, res) => {
  if (await isAuthed(req)) return res.redirect('/app');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(tpl('login.html'));
}));
app.get('/app', A(async (req, res) => {
  if (!(await isAuthed(req))) return res.redirect('/login');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(tpl('app.html'));
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

// --- auth API
app.get('/api/auth/state', A(async (req, res) => res.json({ owner: hasOwner(), authed: await isAuthed(req) })));
app.post('/api/auth/setup', A(async (req, res) => {
  if (hasOwner()) return res.status(400).json({ error: 'Already set up' });
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const { email, password, code, tz: zone } = req.body || {};
  if (String(code || '').trim() !== SETUP_CODE) { noteFail(ip); return res.status(403).json({ error: 'Wrong setup code (see the server console / logs).' }); }
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'Enter a valid email' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { salt, hash } = hashPw(String(password));
  await setSetting('owner_email', email.trim().toLowerCase());
  await setSetting('owner_salt', salt);
  await setSetting('tz', validTz(zone) ? zone : 'Asia/Almaty');
  await setSetting('digest_time', '08:00');
  await setSetting('digest_on', '1');
  await setSetting('last_digest', localNow(tz()).date);
  await setSetting('owner_hash', hash);
  SETUP_CODE = null;
  await seedWelcome();
  await startSession(res);
  res.json({ ok: true });
}));
app.post('/api/auth/login', A(async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!checkPw(String(req.body?.password || ''))) { noteFail(ip); return res.status(401).json({ error: 'Wrong password' }); }
  failures.delete(ip);
  await startSession(res);
  res.json({ ok: true });
}));
app.post('/api/auth/logout', A(async (req, res) => {
  const tok = parseCookies(req)[COOKIE];
  if (tok) await db.run('DELETE FROM sessions WHERE id = ?', sha(tok));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}`);
  res.json({ ok: true });
}));

// --- everything else under /api requires the owner + CSRF header
app.use('/api', A(async (req, res, next) => {
  if (!(await isAuthed(req))) return res.status(401).json({ error: 'Not signed in' });
  if (req.method !== 'GET' && req.get('X-DL') !== '1') return res.status(403).json({ error: 'Bad request origin' });
  res.setHeader('Cache-Control', 'no-store');
  next();
}));

function meJson() {
  return {
    email: ownerEmail(), tz: tz(), digest_time: getSetting('digest_time', '08:00'), digest_on: getSetting('digest_on', '1') === '1',
    mail_mode: mailMode, mail_from: `${FROM_NAME} <${FROM_EMAIL}>`, site_name: SITE_NAME, base_url: BASE_URL,
  };
}
app.get('/api/me', (req, res) => res.json(meJson()));
app.put('/api/settings', A(async (req, res) => {
  const b = req.body || {};
  if (b.email !== undefined && !EMAIL_RE.test(b.email)) return res.status(400).json({ error: 'Invalid email' });
  if (b.tz !== undefined && !validTz(b.tz)) return res.status(400).json({ error: 'Unknown timezone' });
  if (b.digest_time !== undefined && !TIME_RE.test(b.digest_time)) return res.status(400).json({ error: 'Invalid time' });
  if (b.email !== undefined) await setSetting('owner_email', b.email.trim().toLowerCase());
  if (b.tz !== undefined) await setSetting('tz', b.tz);
  if (b.digest_time !== undefined) await setSetting('digest_time', b.digest_time);
  if (b.digest_on !== undefined) await setSetting('digest_on', b.digest_on ? '1' : '0');
  if (b.tz !== undefined || b.digest_time !== undefined) {
    // timezone / digest time changes move reminder moments
    for (const t of (await db.all('SELECT * FROM tasks WHERE done_at IS NULL')).map(rowToTask)) await saveTask(t, t);
  }
  res.json(meJson());
}));
app.post('/api/settings/password', A(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPw(String(current || ''))) return res.status(401).json({ error: 'Current password is wrong' });
  if (String(nw || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const { salt, hash } = hashPw(String(nw));
  await setSetting('owner_salt', salt);
  await setSetting('owner_hash', hash);
  await db.run('DELETE FROM sessions');
  await startSession(res);
  res.json({ ok: true });
}));

// --- tasks
app.get('/api/tasks', A(async (req, res) => res.json((await db.all('SELECT * FROM tasks ORDER BY id')).map(rowToTask))));
app.post('/api/tasks', A(async (req, res) => {
  const t = cleanTask(req.body || {}, { title: '', notes: '', priority: 0, tags: [], people: [], repeat: null, remind: -1, pinned: false });
  if (!t.title) return res.status(400).json({ error: 'Title is required' });
  if (req.body?.done_at) t.done_at = Number(req.body.done_at) || null;
  res.json(await saveTask(t, null));
}));
app.patch('/api/tasks/:id', A(async (req, res) => {
  const prev = await getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const t = cleanTask(req.body || {}, prev);
  if (!t.title) t.title = prev.title;
  res.json(await saveTask(t, prev));
}));
app.post('/api/tasks/bulk', A(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const out = [];
  for (const id of ids.slice(0, 500)) {
    const prev = await getTask(id);
    if (prev) out.push(await saveTask(cleanTask(req.body.patch || {}, prev), prev));
  }
  res.json(out);
}));
app.delete('/api/tasks/:id', A(async (req, res) => {
  await db.run('DELETE FROM tasks WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));
async function completeTask(prev) {
  let next = null;
  if (prev.repeat && !prev.done_at) {
    const today = localNow(tz()).date;
    let d = nextRepeat(prev.due_date || today, prev.repeat);
    while (d < today) d = nextRepeat(d, prev.repeat);
    next = await saveTask({ ...prev, id: undefined, due_date: d, done_at: null, reminded: false }, null);
  }
  const task = await saveTask({ ...prev, done_at: Date.now() }, prev);
  return { task, next };
}
app.post('/api/tasks/:id/complete', A(async (req, res) => {
  const prev = await getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  if (prev.done_at) return res.json({ task: prev, next: null });
  res.json(await completeTask(prev));
}));
app.post('/api/tasks/:id/uncomplete', A(async (req, res) => {
  const prev = await getTask(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const removeNext = Number(req.body?.remove_next);
  if (removeNext) await db.run('DELETE FROM tasks WHERE id = ? AND done_at IS NULL', removeNext);
  res.json(await saveTask({ ...prev, done_at: null }, prev));
}));

// --- people (who gets emails)
const cleanPerson = (b) => ({
  name: String(b.name || '').trim().slice(0, 80),
  email: String(b.email || '').trim().toLowerCase().slice(0, 200),
  digest: b.digest ? 1 : 0,
  active: b.active === false ? 0 : 1,
});
const getPerson = (id) => db.get('SELECT * FROM people WHERE id = ?', id);
app.get('/api/people', A(async (req, res) => res.json(await db.all('SELECT * FROM people ORDER BY lower(name)'))));
app.post('/api/people', A(async (req, res) => {
  const p = cleanPerson(req.body || {});
  if (!p.name || !EMAIL_RE.test(p.email)) return res.status(400).json({ error: 'Name and a valid email are required' });
  const r = await db.get('INSERT INTO people(name, email, digest, active, created_at) VALUES(?,?,?,?,?) RETURNING id', p.name, p.email, p.digest, p.active, Date.now());
  res.json(await getPerson(Number(r.id)));
}));
app.patch('/api/people/:id', A(async (req, res) => {
  const prev = await getPerson(Number(req.params.id));
  if (!prev) return res.status(404).json({ error: 'Not found' });
  const p = cleanPerson({ ...prev, digest: !!prev.digest, active: !!prev.active, ...req.body });
  if (!p.name || !EMAIL_RE.test(p.email)) return res.status(400).json({ error: 'Name and a valid email are required' });
  await db.run('UPDATE people SET name=?, email=?, digest=?, active=? WHERE id=?', p.name, p.email, p.digest, p.active, prev.id);
  res.json(await getPerson(prev.id));
}));
app.delete('/api/people/:id', A(async (req, res) => {
  const id = Number(req.params.id);
  await db.run('DELETE FROM people WHERE id = ?', id);
  for (const t of (await db.all("SELECT * FROM tasks WHERE people <> '[]'")).map(rowToTask)) {
    if (t.people.includes(id)) await saveTask({ ...t, people: t.people.filter((x) => x !== id) }, t);
  }
  res.json({ ok: true });
}));

// --- email tools
app.post('/api/email/test', A(async (req, res) => {
  const to = ownerEmail();
  try {
    await sendMail(to, `✅ ${SITE_NAME} email works`, emailShell('Email delivery works 🎉',
      `<tr><td style="color:#374151">Reminders and your daily digest will arrive at <b>${escHtml(to)}</b>.</td></tr>`));
    res.json({ ok: true, mode: mailMode });
  } catch (e) { res.status(500).json({ error: 'Sending failed: ' + e.message }); }
}));
app.post('/api/email/digest', A(async (req, res) => {
  try { const n = await sendDigest(true); res.json({ ok: true, sent: n }); } catch (e) { res.status(500).json({ error: e.message }); }
}));
app.get('/api/outbox', A(async (req, res) => res.json(await db.all('SELECT id, to_addr, subject, status, error, created_at FROM outbox ORDER BY id DESC LIMIT 25'))));
app.get('/api/outbox/:id', A(async (req, res) => {
  const r = await db.get('SELECT html FROM outbox WHERE id = ?', Number(req.params.id));
  if (!r) return res.status(404).end();
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(r.html);
}));
app.get('/api/export', A(async (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="doneline-export-${localNow(tz()).date}.json"`);
  res.json({ exported_at: new Date().toISOString(), tasks: (await db.all('SELECT * FROM tasks')).map(rowToTask), people: await db.all('SELECT * FROM people') });
}));

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
app.get('/t/:id/:sig', A(async (req, res) => {
  const id = Number(req.params.id);
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!verifySig(id, req.params.sig)) return res.status(403).type('html').send(actionPage('Invalid link', '<h1>This link is not valid.</h1>'));
  const t = await getTask(id);
  if (!t) return res.type('html').send(actionPage('Gone', '<h1>This task no longer exists.</h1><a class="btn ghost" href="/app">Open app</a>'));
  if (t.done_at) return res.type('html').send(actionPage('Done', `<h1>Already done ✓</h1><p class="t">${escHtml(t.title)}</p><a class="btn ghost" href="/app">Open app</a>`));
  const a = req.query.a === 'tomorrow' ? 'tomorrow' : 'done';
  res.type('html').send(actionPage('Confirm', `<p class="t">${escHtml(t.title)}</p>
    <form method="post"><input type="hidden" name="a" value="done"><button class="btn ${a === 'done' ? '' : 'ghost'}">✓ Mark as done</button></form>
    <form method="post"><input type="hidden" name="a" value="tomorrow"><button class="btn ${a === 'tomorrow' ? '' : 'ghost'}">→ Move to tomorrow</button></form>`));
}));
app.post('/t/:id/:sig', A(async (req, res) => {
  const id = Number(req.params.id);
  if (!verifySig(id, req.params.sig)) return res.status(403).send('Invalid link');
  const t = await getTask(id);
  if (!t) return res.redirect(`/t/${id}/${req.params.sig}`);
  let msg;
  if (req.body.a === 'tomorrow') {
    await saveTask({ ...t, due_date: addDays(localNow(tz()).date, 1) }, t);
    msg = 'Moved to tomorrow →';
  } else {
    if (!t.done_at) await completeTask(t);
    msg = 'Done! ✓';
  }
  res.type('html').send(actionPage(msg, `<h1>${msg}</h1><p class="t">${escHtml(t.title)}</p><a class="btn ghost" href="/app">Open app</a>`));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).type('html').send(actionPage('Not found', '<h1>Page not found</h1><a class="btn ghost" href="/">Home</a>')));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  if (req.path.startsWith('/api')) res.status(500).json({ error: 'Server error' });
  else res.status(500).type('html').send(actionPage('Error', '<h1>Something went wrong</h1><p>Try again in a moment.</p>'));
});

async function seedWelcome() {
  const c = await db.get('SELECT COUNT(*) AS n FROM tasks');
  if (Number(c.n)) return;
  const today = localNow(tz()).date;
  const base = { notes: '', due_time: null, priority: 0, tags: [], people: [], repeat: null, remind: -1, pinned: false };
  const seed = [
    { title: 'Try the quick-add: type “Call mom tomorrow 7pm #family !2”', due_date: today, priority: 3, tags: ['welcome'] },
    { title: 'Press X (or click the circle) to complete a task', due_date: today, tags: ['welcome'] },
    { title: 'Open Settings → add people who should get email reminders', due_date: today, tags: ['welcome'] },
    { title: 'Press ? to see all keyboard shortcuts', due_date: null, tags: ['welcome'] },
  ];
  for (const s of seed) await saveTask({ ...base, ...s }, null);
}

async function main() {
  db = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR });
  for (const r of await db.all('SELECT key, value FROM settings')) settings.set(r.key, r.value);
  if (!getSetting('secret')) await setSetting('secret', crypto.randomBytes(32).toString('hex'));
  SECRET = getSetting('secret');
  if (!hasOwner() && !SETUP_CODE) SETUP_CODE = String(crypto.randomInt(100000, 999999));
  setInterval(tick, 20000);
  app.listen(PORT, () => {
    console.log(`\n  ${SITE_NAME} running → ${BASE_URL}  (db: ${db.kind})`);
    console.log(`  Email: ${mailMode === 'preview' ? 'PREVIEW mode (set BREVO_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD to really send)' : mailMode + ' from ' + FROM_EMAIL}`);
    if (!hasOwner()) console.log(`\n  ▶ First-time setup: open ${BASE_URL}/login and use setup code: ${SETUP_CODE}\n`);
    tick();
  });
}
main().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
