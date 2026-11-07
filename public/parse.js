/* QuickParse — turns "Call mom tomorrow 7pm #family !2 every week" into a structured task. */
(function (g) {
  'use strict';
  const L = '\\p{L}\\p{N}';
  const B = `(?<![${L}])`;
  const E = `(?![${L}])`;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const wdIndex = (s) => WD.indexOf(String(s).slice(0, 3).toLowerCase());
  const monIndex = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()) + 1;

  const pad = (n) => String(n).padStart(2, '0');
  function ymd(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const split = (s) => s.split('-').map(Number);
  const addDays = (s, n) => { const [y, m, d] = split(s); return ymd(y, m, d + n); };
  function addMonths(s, n) {
    const [y, m, d] = split(s);
    const first = new Date(Date.UTC(y, m - 1 + n, 1));
    const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return ymd(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, dim));
  }
  const weekday = (s) => { const [y, m, d] = split(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const daysBetween = (a, b) => { const [y1, m1, d1] = split(a); const [y2, m2, d2] = split(b); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5); };
  function nextWeekday(from, wd, includeToday) {
    let diff = (wd - weekday(from) + 7) % 7;
    if (diff === 0 && !includeToday) diff = 7;
    return addDays(from, diff);
  }
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  const fmts = {};
  function nowIn(tz, ts = Date.now()) {
    const f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
    const p = {};
    for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }

  const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };

  function parse(text, opts = {}) {
    const tz = opts.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = nowIn(tz);
    const today = now.date;
    const people = opts.people || [];
    const off = opts.disabled || new Set();
    const res = { title: '', due_date: null, due_time: null, priority: 0, tags: [], people: [], repeat: null, found: [] };
    let s = ' ' + text + ' ';
    let timeDefault = null;

    function rule(type, pattern, fn, flags = 'iu') {
      if (off.has(type)) return;
      const re = new RegExp(pattern, flags);
      s = s.replace(re, (...m) => {
        const r = fn(m);
        if (r === false) return m[0];
        res.found.push({ type, raw: m[0].trim() });
        return ' ';
      });
    }
    const setDate = (d) => { if (res.due_date) return false; res.due_date = d; return true; };
    const setTime = (h, mi) => {
      if (res.due_time || h > 23 || mi > 59) return false;
      res.due_time = `${pad(h)}:${pad(mi)}`; return true;
    };

    // --- repeat
    rule('repeat', `${B}(every\\s+(?:other\\s+)?(?:day|weekday|week|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|daily|weekly|monthly|yearly|weekdays|каждый\\s+день|ежедневно|еженедельно)${E}`, (m) => {
      const t = m[0].toLowerCase().replace(/\s+/g, ' ');
      const w = t.replace(/^every (other )?/, '');
      const other = t.includes('other');
      if (t === 'weekdays' || w === 'weekday') res.repeat = 'weekdays';
      else if (w === 'day' || t === 'daily' || t.startsWith('кажд') || t === 'ежедневно') res.repeat = 'daily';
      else if (w === 'week' || t === 'weekly' || t === 'еженедельно') res.repeat = other ? 'biweekly' : 'weekly';
      else if (w === 'month' || t === 'monthly') res.repeat = 'monthly';
      else if (w === 'year' || t === 'yearly') res.repeat = 'yearly';
      else {
        const i = wdIndex(w); if (i < 0) return false;
        res.repeat = other ? 'biweekly' : 'weekly';
        if (!off.has('date')) res.due_date = res.due_date || nextWeekday(today, i, true);
      }
    });

    // --- "in 2 hours", "in 3 days"
    rule('date', `${B}in\\s+(\\d{1,3}|an?|one|two|three|four|five|ten)\\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w|months?)${E}`, (m) => {
      const n = NUMW[m[1].toLowerCase()] || Number(m[1]);
      const u = m[2].toLowerCase();
      if (/^(min|h)/.test(u)) {
        if (res.due_date || res.due_time || off.has('time')) return false;
        const ts = Date.now() + n * (u.startsWith('h') ? 3600e3 : 60e3);
        const p = nowIn(tz, ts);
        res.due_date = p.date; res.due_time = p.time; return true;
      }
      if (u.startsWith('d')) return setDate(addDays(today, n));
      if (u.startsWith('w')) return setDate(addDays(today, 7 * n));
      return setDate(addMonths(today, n));
    });

    // --- absolute dates
    const finishDate = (y, mo, d, explicitYear) => {
      if (mo < 1 || mo > 12 || d < 1) return false;
      if (y < 100) y += 2000;
      if (d > dim(y, mo)) return false;
      let out = ymd(y, mo, d);
      if (!explicitYear && out < today) out = ymd(y + 1, mo, d);
      return setDate(out);
    };
    const [ty] = split(today);
    rule('date', `${B}(\\d{4})-(\\d{2})-(\\d{2})${E}`, (m) => finishDate(+m[1], +m[2], +m[3], true));
    rule('date', `${B}(?:on\\s+)?${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${E}`, (m) => finishDate(m[3] ? +m[3] : ty, monIndex(m[1]), +m[2], !!m[3]));
    rule('date', `${B}(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}(?:\\s+(\\d{4}))?${E}`, (m) => finishDate(m[3] ? +m[3] : ty, monIndex(m[2]), +m[1], !!m[3]));
    rule('date', `${B}(?:on\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?${E}(?!\\s*(?:h|hrs?|hours?|min|mins|minutes?|km|kg|g|l|m|%|x|times|раз|час))`, (m) => finishDate(m[3] ? +m[3] : ty, +m[2], +m[1], !!m[3]));

    // --- relative words
    rule('date', `${B}(day\\s+after\\s+tomorrow|послезавтра)${E}`, () => setDate(addDays(today, 2)));
    rule('date', `${B}(today|сегодня)${E}`, () => setDate(today));
    rule('date', `${B}(tonight|this\\s+evening|вечером)${E}`, () => { if (!setDate(today)) return false; timeDefault = '20:00'; return true; });
    rule('date', `${B}(tomorrow|tmrw?|tmr|завтра)${E}`, () => setDate(addDays(today, 1)));
    rule('date', `${B}next\\s+week${E}`, () => setDate(nextWeekday(today, 1, false)));
    rule('date', `${B}next\\s+month${E}`, () => setDate(addMonths(today, 1)));
    rule('date', `${B}(?:this\\s+)?weekend${E}`, () => setDate(nextWeekday(today, 6, true)));
    rule('date', `${B}(?:(on|this|next)\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)${E}`,
      (m) => setDate(nextWeekday(today, wdIndex(m[2]), (m[1] || '').toLowerCase() === 'this')));
    rule('date', `${B}(on|this|next)\\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\\.?${E}`,
      (m) => setDate(nextWeekday(today, wdIndex(m[2]), m[1].toLowerCase() === 'this')));

    // --- times
    rule('time', `${B}(?:at\\s+|в\\s+)?(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?![${L}])`, (m) => {
      let h = +m[1]; const mi = +(m[2] || 0); const pm = m[3].toLowerCase().startsWith('p');
      if (h < 1 || h > 12) return false;
      if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0;
      return setTime(h, mi);
    });
    rule('time', `${B}(?:at\\s+|в\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, (m) => setTime(+m[1], +m[2]));
    rule('time', `${B}(?:at|в)\\s+([01]?\\d|2[0-3])${E}`, (m) => { let h = +m[1]; if (h >= 1 && h <= 6) h += 12; return setTime(h, 0); });
    rule('time', `${B}(?:at\\s+)?(noon|midday)${E}`, () => setTime(12, 0));
    if (!res.due_time && timeDefault && !off.has('time')) res.due_time = timeDefault;

    // --- priority
    rule('priority', `(?<=\\s)(!!!|!!|!|![123]|!high|!med(?:ium)?|!low|p[123])(?=\\s)`, (m) => {
      const t = m[1].toLowerCase();
      res.priority = ['!!!', '!1', '!high', 'p1'].includes(t) ? 3 : ['!!', '!2', '!med', '!medium', 'p2'].includes(t) ? 2 : 1;
    });

    // --- tags & people (many)
    rule('tag', `(?<=\\s)#([\\p{L}\\p{N}_\\-/]+)`, (m) => { const t = m[1].toLowerCase(); if (!res.tags.includes(t)) res.tags.push(t); }, 'giu');
    rule('person', `(?<=\\s)@([\\p{L}\\p{N}_.\\-]+)`, (m) => {
      const q = m[1].toLowerCase();
      const p = people.find((x) => x.name.toLowerCase() === q) || people.find((x) => x.name.toLowerCase().split(/\s+/)[0] === q)
        || people.find((x) => x.name.toLowerCase().startsWith(q)) || people.find((x) => x.email.toLowerCase().split('@')[0] === q);
      if (!p) return false;
      if (!res.people.includes(p.id)) res.people.push(p.id);
    }, 'giu');

    // time without a date → today if still ahead, otherwise tomorrow
    if (res.due_time && !res.due_date) res.due_date = res.due_time > now.time ? today : addDays(today, 1);
    if (res.repeat && !res.due_date) res.due_date = today;
    if (res.repeat === 'weekdays' && [0, 6].includes(weekday(res.due_date))) res.due_date = nextWeekday(res.due_date, 1, false);

    let title = s.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) title = title.replace(/\s+(at|on|by|in|from|to|в|на|до)$/i, '').replace(/^(at|on|by)\s+/i, '').trim();
    title = title.replace(/^[,;:\-–]+|[,;:\-–]+$/g, '').trim();
    res.title = title || text.trim();
    return res;
  }

  g.QuickParse = { parse, nowIn, addDays, addMonths, weekday, daysBetween, nextWeekday };
})(typeof window !== 'undefined' ? window : globalThis);
