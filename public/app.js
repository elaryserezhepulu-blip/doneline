/* Doneline app — vanilla JS, no build step. */
(() => {
  'use strict';
  const P = window.QuickParse;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dl.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-DL': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok) throw new Error((data && data.error) || r.statusText);
    return data;
  }

  const VIEWS = [
    { id: 'today', name: 'Today', ic: '☀' },
    { id: 'upcoming', name: 'Upcoming', ic: '📅' },
    { id: 'all', name: 'All tasks', ic: '☰' },
    { id: 'someday', name: 'Someday', ic: '☁' },
    { id: 'done', name: 'Done', ic: '✓' },
  ];
  const REPEAT_LBL = { daily: 'every day', weekdays: 'weekdays', weekly: 'every week', biweekly: 'every 2 weeks', monthly: 'every month', yearly: 'every year' };
  const REMIND_LBL = { '-1': 'No email reminder', 0: 'At due time', 5: '5 min before', 10: '10 min before', 15: '15 min before', 30: '30 min before', 60: '1 hour before', 120: '2 hours before', 1440: '1 day before' };
  const PRIO_LBL = ['None', 'Low', 'Medium', 'High'];

  const S = {
    me: null, tasks: [], people: [],
    view: store.get('view', 'today'), search: '', open: null, sel: null,
    disabled: new Set(), undo: null, collapsed: new Set(store.get('collapsed', ['done-today'])),
  };

  // ---------- dates ----------
  const tz = () => (S.me && S.me.tz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = () => P.nowIn(tz()).date;
  function dateObj(d) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); }
  function dayLabel(d, long) {
    const t = today(); const diff = P.daysBetween(t, d);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    const o = dateObj(d);
    if (diff > 1 && diff < 7) return o.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) + (long ? ' · ' + o.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
    const sameYear = d.slice(0, 4) === t.slice(0, 4);
    return o.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
  }
  const localDateOfTs = (ts) => P.nowIn(tz(), ts).date;
  const localTimeOfTs = (ts) => P.nowIn(tz(), ts).time;

  // ---------- sorting & grouping ----------
  function cmpOpen(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ad = a.due_date || '9999', bd = b.due_date || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const at = a.due_time || '99', bt = b.due_time || '99';
    if (at !== bt) return at < bt ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id - b.id;
  }
  const open = () => S.tasks.filter((t) => !t.done_at);
  const doneSorted = () => S.tasks.filter((t) => t.done_at).sort((a, b) => b.done_at - a.done_at);

  function sections() {
    const t = today();
    const tomorrow = P.addDays(t, 1);
    const o = open().sort(cmpOpen);
    if (S.search) {
      const q = S.search.toLowerCase();
      const hit = (x) => x.title.toLowerCase().includes(q) || x.notes.toLowerCase().includes(q) || x.tags.some((g) => g.includes(q.replace(/^#/, '')));
      return [
        { key: 's-open', title: 'Open', tasks: o.filter(hit) },
        { key: 's-done', title: 'Done', tasks: doneSorted().filter(hit) },
      ];
    }
    const v = S.view;
    if (v === 'today') {
      const overdue = o.filter((x) => x.due_date && x.due_date < t);
      const todays = o.filter((x) => x.due_date === t);
      const doneToday = doneSorted().filter((x) => localDateOfTs(x.done_at) === t);
      return [
        { key: 'overdue', title: 'Overdue', red: true, tasks: overdue, action: overdue.length ? { id: 'move-overdue', label: 'Move all to today' } : null },
        { key: 'today', title: overdue.length ? 'Today' : null, tasks: todays, always: true },
        { key: 'done-today', title: 'Completed today', tasks: doneToday, collapsible: true },
      ];
    }
    if (v === 'upcoming') {
      const out = [];
      const end = P.addDays(t, 14);
      for (let d = tomorrow; d <= end; d = P.addDays(d, 1)) {
        const list = o.filter((x) => x.due_date === d);
        if (list.length) out.push({ key: 'd' + d, title: dayLabel(d, true), tasks: list, date: d });
      }
      const later = o.filter((x) => x.due_date && x.due_date > end);
      if (later.length) out.push({ key: 'later', title: 'Later', tasks: later });
      return out;
    }
    if (v === 'someday') return [{ key: 'someday', tasks: o.filter((x) => !x.due_date) }];
    if (v === 'done') {
      const groups = new Map();
      for (const x of doneSorted()) {
        const d = localDateOfTs(x.done_at);
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(x);
      }
      return [...groups].map(([d, list]) => ({ key: 'done' + d, title: dayLabel(d), tasks: list }));
    }
    // 'all' and tag views
    let list = o;
    let doneList = [];
    if (v.startsWith('tag:')) {
      const tag = v.slice(4);
      list = o.filter((x) => x.tags.includes(tag));
      doneList = doneSorted().filter((x) => x.tags.includes(tag)).slice(0, 50);
    }
    const weekEnd = P.addDays(t, 7);
    const out = [
      { key: 'a-over', title: 'Overdue', red: true, tasks: list.filter((x) => x.due_date && x.due_date < t) },
      { key: 'a-today', title: 'Today', tasks: list.filter((x) => x.due_date === t) },
      { key: 'a-tom', title: 'Tomorrow', tasks: list.filter((x) => x.due_date === tomorrow) },
      { key: 'a-week', title: 'Next 7 days', tasks: list.filter((x) => x.due_date > tomorrow && x.due_date <= weekEnd) },
      { key: 'a-later', title: 'Later', tasks: list.filter((x) => x.due_date > weekEnd) },
      { key: 'a-none', title: 'No date', tasks: list.filter((x) => !x.due_date) },
    ];
    if (doneList.length) out.push({ key: 'tag-done', title: 'Completed', tasks: doneList, collapsible: true });
    return out;
  }

  // ---------- rendering ----------
  const personById = (id) => S.people.find((p) => p.id === id);
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  function metaHTML(x, sec) {
    const t = today();
    const bits = [];
    if (x.done_at) {
      bits.push(`<span>✓ ${esc(dayLabel(localDateOfTs(x.done_at)))} ${esc(localTimeOfTs(x.done_at))}</span>`);
    } else if (x.due_date) {
      const showDate = !(sec && (sec.key === 'today' || sec.key === 'a-today' || sec.key === 'a-tom' || sec.date === x.due_date));
      const cls = x.due_date < t ? 'od' : x.due_date === t ? 'td' : '';
      const txt = [showDate ? dayLabel(x.due_date) : '', x.due_time || ''].filter(Boolean).join(' · ');
      if (txt) bits.push(`<span class="${cls}">${x.due_date < t ? '⚠ ' : ''}${esc(txt)}</span>`);
    }
    if (x.repeat) bits.push(`<span>↻ ${esc(REPEAT_LBL[x.repeat])}</span>`);
    if (x.remind >= 0 && !x.done_at && x.due_date) bits.push(`<span title="Email reminder: ${esc(REMIND_LBL[x.remind])}">🔔</span>`);
    if (x.notes.trim()) bits.push('<span title="Has notes">≡ note</span>');
    for (const g of x.tags) bits.push(`<span class="tg">#${esc(g)}</span>`);
    const ppl = x.people.map(personById).filter(Boolean);
    if (ppl.length) bits.push(`<span title="${esc(ppl.map((p) => p.name).join(', '))}">${ppl.map((p) => `<i class="av">${esc(initials(p.name))}</i>`).join('')}</span>`);
    return bits.join('');
  }

  function detailHTML(x) {
    const t = today();
    const nextMon = P.nextWeekday(t, 1, false);
    const datePills = [['Today', t], ['Tomorrow', P.addDays(t, 1)], ['Next Mon', nextMon], ['+1 week', P.addDays(x.due_date || t, 7)], ['No date', '']]
      .map(([l, d]) => `<button type="button" class="pill ${x.due_date === (d || null) ? 'on' : ''}" data-setdate="${d}">${l}</button>`).join('');
    const prio = PRIO_LBL.map((l, i) => `<button type="button" class="pill pr${i} ${x.priority === i ? 'on' : ''}" data-prio="${i}">${l}</button>`).join('');
    const ppl = S.people.length
      ? S.people.map((p) => `<button type="button" class="pill ${x.people.includes(p.id) ? 'on' : ''}" data-person="${p.id}" title="${esc(p.email)}">${esc(p.name)}</button>`).join('')
      : '<span class="hint" style="margin:0">Add people in Settings to email them about tasks.</span>';
    const rep = `<select data-f="repeat"><option value="">Doesn't repeat</option>${Object.entries(REPEAT_LBL).map(([k, l]) => `<option value="${k}" ${x.repeat === k ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select>`;
    const rem = `<select data-f="remind" ${x.due_date ? '' : 'disabled title="Set a date first"'}>${Object.entries(REMIND_LBL).map(([k, l]) => `<option value="${k}" ${String(x.remind) === k ? 'selected' : ''}>📧 ${l}</option>`).join('')}</select>`;
    return `<div class="detail">
      <input class="d-title" data-f="title" value="${esc(x.title)}" maxlength="500">
      <textarea class="d-notes" data-f="notes" placeholder="Notes… (saved automatically)">${esc(x.notes)}</textarea>
      <div class="d-row"><span class="d-lbl">When</span>${datePills}
        <input type="date" data-f="due_date" value="${x.due_date || ''}"><input type="time" data-f="due_time" value="${x.due_time || ''}" ${x.due_date ? '' : 'disabled'}></div>
      <div class="d-row"><span class="d-lbl">Priority</span>${prio}</div>
      <div class="d-row"><span class="d-lbl">Repeat</span>${rep}${rem}</div>
      <div class="d-row"><span class="d-lbl">Tags</span><input class="tags-in" data-f="tags" value="${esc(x.tags.join(', '))}" placeholder="uni, home"></div>
      <div class="d-row"><span class="d-lbl">People</span>${ppl}</div>
      <div class="d-foot"><span>Created ${esc(dayLabel(localDateOfTs(x.created_at)))}${x.done_at ? ' · done ' + esc(dayLabel(localDateOfTs(x.done_at))) : ''}</span>
        <span class="btns"><button type="button" class="btn danger small" data-act="delete">Delete</button><button type="button" class="btn small" data-act="close">Done editing</button></span></div>
    </div>`;
  }

  function taskHTML(x, sec) {
    const cls = ['task', 'p' + x.priority, x.done_at ? 'done' : '', S.open === x.id ? 'open' : '', S.sel === x.id ? 'sel' : ''].join(' ');
    const qa = x.done_at ? '' : `<div class="qa">
      <button type="button" data-act="today" title="Today (T)">Today</button>
      <button type="button" data-act="tomorrow" title="Tomorrow (M)">Tmrw</button>
      <button type="button" data-act="week" title="Next week (W)">+Week</button></div>`;
    return `<div class="${cls}" data-id="${x.id}">
      <button type="button" class="check" data-act="toggle" aria-label="${x.done_at ? 'Mark as not done' : 'Complete'}"></button>
      <div class="tbody" data-act="expand"><div class="title">${x.pinned ? '📌 ' : ''}${esc(x.title)}</div><div class="meta">${metaHTML(x, sec)}</div></div>
      ${qa}
      ${S.open === x.id ? detailHTML(x) : ''}
    </div>`;
  }

  function emptyHTML() {
    const map = {
      today: ['🎉', 'All clear for today', 'Add something above, or enjoy the free time.'],
      upcoming: ['🗓', 'Nothing planned', 'Tasks with a future date show up here.'],
      someday: ['☁', 'No someday tasks', 'Tasks without a date land here.'],
      done: ['✓', 'Nothing completed yet', 'Completed tasks are kept here, grouped by day.'],
    };
    const [big, h, p] = S.search ? ['⌕', 'No matches', 'Try another word.'] : (map[S.view] || ['✨', 'No tasks', 'Type a task above and press Enter.']);
    return `<div class="empty-state"><div class="big">${big}</div><h3>${h}</h3><p>${p}</p></div>`;
  }

  let flatIds = [];
  function renderList() {
    const secs = sections();
    flatIds = [];
    let html = '';
    const hasMain = secs.some((s) => !s.collapsible && s.tasks.length);
    for (const s of secs) {
      if (!s.tasks.length) continue;
      const collapsed = s.collapsible && S.collapsed.has(s.key);
      html += `<div class="sec ${collapsed ? 'collapsed' : ''}" data-sec="${s.key}">`;
      if (s.title) {
        html += `<div class="sec-h ${s.red ? 'red' : ''}">${s.collapsible ? `<button type="button" class="act" style="margin:0;color:inherit" data-collapse="${s.key}">${collapsed ? '▸' : '▾'}</button>` : ''}${esc(s.title)} <span class="cnt">${s.tasks.length}</span>
          ${s.action ? `<button type="button" class="act" data-secact="${s.action.id}">${s.action.label}</button>` : ''}</div>`;
      }
      for (const x of s.tasks) { html += taskHTML(x, s); if (!collapsed) flatIds.push(x.id); }
      html += '</div>';
    }
    if (!hasMain) html = emptyHTML() + html;
    $('#list').innerHTML = html;
    if (S.sel && !flatIds.includes(S.sel)) S.sel = null;
  }

  function counts() {
    const t = today();
    const o = open();
    return {
      overdue: o.filter((x) => x.due_date && x.due_date < t).length,
      today: o.filter((x) => x.due_date && x.due_date <= t).length,
      upcoming: o.filter((x) => x.due_date && x.due_date > t).length,
      all: o.length,
      someday: o.filter((x) => !x.due_date).length,
      done: S.tasks.filter((x) => x.done_at && localDateOfTs(x.done_at) === t).length,
    };
  }

  function streak() {
    const days = new Set(S.tasks.filter((x) => x.done_at).map((x) => localDateOfTs(x.done_at)));
    let d = today();
    if (!days.has(d)) d = P.addDays(d, -1);
    let n = 0;
    while (days.has(d)) { n++; d = P.addDays(d, -1); }
    return n;
  }

  function renderChrome() {
    const c = counts();
    const n = { today: c.today, upcoming: c.upcoming, all: c.all, someday: c.someday, done: c.done };
    $('#views').innerHTML = VIEWS.map((v, i) => `<button type="button" class="vbtn ${S.view === v.id && !S.search ? 'on' : ''}" data-view="${v.id}" title="${v.name} (${i + 1})">
      <span class="ic">${v.ic}</span>${v.name}<span class="n ${v.id === 'today' && c.overdue ? 'red' : ''}">${n[v.id] || ''}</span></button>`).join('');
    const tagCounts = {};
    for (const x of open()) for (const g of x.tags) tagCounts[g] = (tagCounts[g] || 0) + 1;
    const tags = Object.keys(tagCounts).sort();
    $('#tags').innerHTML = tags.length
      ? tags.map((g) => `<button type="button" class="vbtn ${S.view === 'tag:' + g ? 'on' : ''}" data-view="tag:${esc(g)}"><span class="ic">#</span>${esc(g)}<span class="n">${tagCounts[g]}</span></button>`).join('')
      : '<div class="empty">Add #tags to tasks</div>';
    $('#tabbar').innerHTML = VIEWS.filter((v) => v.id !== 'someday').map((v) => `<button type="button" class="${S.view === v.id ? 'on' : ''}" data-view="${v.id}">
      <span class="ic">${v.ic}</span>${v.name.replace(' tasks', '')}${v.id === 'today' && c.today ? `<span class="badge">${c.today}</span>` : ''}</button>`).join('')
      + '<button type="button" data-open="settings"><span class="ic">⚙</span>More</button>';

    const view = VIEWS.find((v) => v.id === S.view);
    let title = view ? view.name : '#' + S.view.slice(4);
    let sub = '';
    if (S.search) { title = 'Search'; sub = `Results for “${S.search}”`; }
    else if (S.view === 'today') sub = dateObj(today()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + (c.overdue ? ` · ${c.overdue} overdue` : '');
    else if (S.view === 'done') sub = `${S.tasks.filter((x) => x.done_at).length} completed in total`;
    $('#viewTitle').textContent = title;
    $('#viewSub').textContent = sub;
    const st = streak();
    $('#stats').innerHTML = `<b>${c.done}</b> done today${st > 1 ? ` · 🔥 <b>${st}</b>-day streak` : ''}`;
    document.title = (c.today ? `(${c.today}) ` : '') + (S.me ? S.me.site_name : 'Doneline');
  }

  function render() { renderChrome(); renderList(); }

  // ---------- quick add ----------
  const qa = $('#qa');
  function viewDefaults() {
    const t = today();
    if (S.view === 'today') return { due_date: t, label: 'Today' };
    if (S.view === 'upcoming') return { due_date: P.addDays(t, 1), label: 'Tomorrow' };
    if (S.view.startsWith('tag:')) return { tag: S.view.slice(4), label: '#' + S.view.slice(4) };
    return {};
  }
  const parseNow = (text) => P.parse(text, { tz: tz(), people: S.people, disabled: S.disabled });

  function currentToken() {
    const pos = qa.selectionStart ?? qa.value.length;
    const before = qa.value.slice(0, pos);
    const m = before.match(/(^|\s)([#@])([\p{L}\p{N}_.\-/]*)$/u);
    return m ? { sym: m[2], q: m[3].toLowerCase(), start: pos - m[3].length - 1, end: pos } : null;
  }
  function suggestions() {
    const tok = currentToken();
    if (!tok) return [];
    if (tok.sym === '@') return S.people.filter((p) => p.name.toLowerCase().includes(tok.q)).slice(0, 5).map((p) => ({ tok, text: '@' + p.name.split(/\s+/)[0].toLowerCase(), label: '@' + p.name }));
    const tags = [...new Set(S.tasks.flatMap((x) => x.tags))].filter((g) => g.startsWith(tok.q) && g !== tok.q).slice(0, 6);
    return tags.map((g) => ({ tok, text: '#' + g, label: '#' + g }));
  }
  let suggs = [];
  function renderChips() {
    const v = qa.value.trim();
    const box = $('#chips');
    suggs = suggestions();
    if (!v && !suggs.length) { box.innerHTML = ''; return; }
    const r = parseNow(qa.value);
    const out = [];
    const chip = (type, label) => out.push(`<span class="chip">${esc(label)}<button type="button" data-unparse="${type}" title="Keep as text">✕</button></span>`);
    if (r.due_date) chip('date', '📅 ' + dayLabel(r.due_date));
    if (r.due_time) chip('time', '⏰ ' + r.due_time);
    if (r.repeat) chip('repeat', '↻ ' + REPEAT_LBL[r.repeat]);
    if (r.priority) chip('priority', '⚑ ' + PRIO_LBL[r.priority]);
    for (const g of r.tags) chip('tag', '#' + g);
    for (const id of r.people) { const p = personById(id); if (p) chip('person', '👤 ' + p.name); }
    const d = viewDefaults();
    if (!r.due_date && d.due_date && v) out.push(`<span class="chip hint">→ ${esc(d.label)}</span>`);
    if (d.tag && !r.tags.includes(d.tag) && v) out.push(`<span class="chip hint">→ #${esc(d.tag)}</span>`);
    if (r.due_time && v) out.push('<span class="chip hint">📧 email reminder at that time</span>');
    for (const [i, s] of suggs.entries()) out.push(`<span class="chip sugg" data-sugg="${i}">${esc(s.label)}${i === 0 ? ' <kbd>Tab</kbd>' : ''}</span>`);
    box.innerHTML = out.join('');
  }
  function applySuggestion(i) {
    const s = suggs[i];
    if (!s) return;
    qa.value = qa.value.slice(0, s.tok.start) + s.text + ' ' + qa.value.slice(s.tok.end);
    const pos = s.tok.start + s.text.length + 1;
    qa.setSelectionRange(pos, pos);
    qa.focus();
    renderChips();
  }

  function bodyFromText(text) {
    const r = parseNow(text);
    const d = viewDefaults();
    const body = {
      title: r.title, due_date: r.due_date || d.due_date || null, due_time: r.due_time, priority: r.priority,
      tags: d.tag && !r.tags.includes(d.tag) ? [...r.tags, d.tag] : r.tags, people: r.people, repeat: r.repeat,
    };
    body.remind = body.due_time ? 0 : -1;
    return body;
  }
  async function addTasks(texts) {
    const created = [];
    for (const text of texts) {
      try { created.push(await api('POST', '/api/tasks', bodyFromText(text))); } catch (e) { toast('Could not add: ' + e.message); }
    }
    S.tasks.push(...created);
    S.disabled.clear();
    render();
    for (const c of created) { const el = $(`.task[data-id="${c.id}"]`); if (el) el.classList.add('flash'); }
    if (created.length === 1) {
      const c = created[0];
      const where = c.due_date ? dayLabel(c.due_date) : 'Someday';
      const visible = flatIds.includes(c.id);
      toast(visible ? `Added` : `Added to ${where}`, () => removeTask(c.id, true));
    } else if (created.length) toast(`Added ${created.length} tasks`);
  }
  $('#quick').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = qa.value.trim();
    if (!v) return;
    qa.value = '';
    renderChips();
    addTasks([v]);
  });
  qa.addEventListener('input', () => { if (!qa.value.trim()) S.disabled.clear(); renderChips(); });
  qa.addEventListener('click', renderChips);
  qa.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && suggs.length) { e.preventDefault(); applySuggestion(0); }
    if (e.key === 'Escape') { qa.blur(); }
  });
  qa.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*([-*•]|\d+[.)]|\[[ x]?\])\s*/i, '').trim()).filter(Boolean);
    if (lines.length > 1) {
      e.preventDefault();
      if (confirm(`Add ${lines.length} tasks?\n\n• ${lines.slice(0, 8).join('\n• ')}${lines.length > 8 ? '\n…' : ''}`)) addTasks(lines);
    }
  });
  $('#chips').addEventListener('click', (e) => {
    const un = e.target.closest('[data-unparse]');
    if (un) { S.disabled.add(un.dataset.unparse); renderChips(); qa.focus(); return; }
    const sg = e.target.closest('[data-sugg]');
    if (sg) applySuggestion(Number(sg.dataset.sugg));
  });

  // ---------- task actions ----------
  const find = (id) => S.tasks.find((x) => x.id === id);
  function replaceTask(t) { const i = S.tasks.findIndex((x) => x.id === t.id); if (i >= 0) S.tasks[i] = t; else S.tasks.push(t); }

  async function patch(id, changes, { rerender = true, undoable = false } = {}) {
    const x = find(id);
    if (!x) return;
    const before = {};
    for (const k of Object.keys(changes)) before[k] = x[k];
    Object.assign(x, changes);
    if (!x.due_date) x.due_time = null;
    if (rerender) render();
    if (undoable) S.undo = () => patch(id, before);
    try { replaceTask(await api('PATCH', `/api/tasks/${id}`, changes)); if (rerender && S.open !== id) render(); } catch (e) { toast('Save failed: ' + e.message); }
  }

  async function toggleDone(id) {
    const x = find(id);
    if (!x) return;
    if (x.done_at) {
      const r = await api('POST', `/api/tasks/${id}/uncomplete`, {});
      replaceTask(r);
      render();
      toast('Restored');
      return;
    }
    const el = $(`.task[data-id="${id}"]`);
    if (el) el.classList.add('completing');
    if (S.open === id) S.open = null;
    const idx = flatIds.indexOf(id);
    try {
      const r = await api('POST', `/api/tasks/${id}/complete`, {});
      await new Promise((res) => setTimeout(res, el ? 380 : 0));
      replaceTask(r.task);
      if (r.next) S.tasks.push(r.next);
      render();
      if (S.sel === id) S.sel = flatIds[Math.min(idx, flatIds.length - 1)] ?? null, renderList();
      const undo = async () => {
        replaceTask(await api('POST', `/api/tasks/${id}/uncomplete`, { remove_next: r.next ? r.next.id : 0 }));
        if (r.next) S.tasks = S.tasks.filter((t) => t.id !== r.next.id);
        render();
      };
      S.undo = undo;
      const left = counts().today;
      const msg = r.next ? `Done ✓ · next on ${dayLabel(r.next.due_date)}` : S.view === 'today' && left === 0 ? 'Done ✓ — all clear today 🎉' : `Done ✓ ${x.title}`;
      toast(msg, undo);
    } catch (e) {
      if (el) el.classList.remove('completing');
      toast('Failed: ' + e.message);
    }
  }

  async function removeTask(id, silent) {
    const x = find(id);
    if (!x) return;
    S.tasks = S.tasks.filter((t) => t.id !== id);
    if (S.open === id) S.open = null;
    render();
    try { await api('DELETE', `/api/tasks/${id}`); } catch (e) { toast('Delete failed'); return; }
    if (silent) return;
    const undo = async () => {
      const { id: _drop, ...copy } = x;
      const t = await api('POST', '/api/tasks', copy);
      S.tasks.push(t);
      render();
    };
    S.undo = undo;
    toast(`Deleted “${x.title}”`, undo);
  }

  function reschedule(id, kind) {
    const t = today();
    const d = { today: t, tomorrow: P.addDays(t, 1), week: P.nextWeekday(t, 1, false), someday: null }[kind];
    const x = find(id);
    if (!x || x.done_at) return;
    patch(id, { due_date: d }, { undoable: true });
    toast(d ? `Moved to ${dayLabel(d)}` : 'Moved to Someday', S.undo);
  }

  // ---------- list events ----------
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const collapse = e.target.closest('[data-collapse]');
    if (collapse) {
      const k = collapse.dataset.collapse;
      S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k);
      store.set('collapsed', [...S.collapsed]);
      renderList();
      return;
    }
    const secAct = e.target.closest('[data-secact]');
    if (secAct && secAct.dataset.secact === 'move-overdue') {
      const t = today();
      const ids = open().filter((x) => x.due_date && x.due_date < t).map((x) => x.id);
      const before = ids.map((id) => [id, find(id).due_date]);
      for (const id of ids) find(id).due_date = t;
      render();
      api('POST', '/api/tasks/bulk', { ids, patch: { due_date: t } }).then((r) => r.forEach(replaceTask));
      S.undo = async () => {
        for (const [id, d] of before) find(id).due_date = d;
        render();
        for (const [id, d] of before) await api('PATCH', `/api/tasks/${id}`, { due_date: d });
      };
      toast(`Moved ${ids.length} to today`, S.undo);
      return;
    }
    const row = e.target.closest('.task');
    if (!row) return;
    const id = Number(row.dataset.id);
    const x = find(id);
    const act = e.target.closest('[data-act]');
    const a = act && act.dataset.act;
    if (a === 'toggle') return toggleDone(id);
    if (a === 'today' || a === 'tomorrow' || a === 'week') return reschedule(id, a);
    if (a === 'delete') return removeTask(id);
    if (a === 'close') { S.open = null; render(); return; }
    if (a === 'expand') {
      S.open = S.open === id ? null : id;
      S.sel = id;
      renderList();
      if (S.open) { const n = $(`.task[data-id="${id}"] .d-notes`); if (n) autoGrow(n); }
      return;
    }
    const sd = e.target.closest('[data-setdate]');
    if (sd) { patch(id, { due_date: sd.dataset.setdate || null }); return; }
    const pr = e.target.closest('[data-prio]');
    if (pr) { patch(id, { priority: Number(pr.dataset.prio) }); return; }
    const pp = e.target.closest('[data-person]');
    if (pp && x) {
      const pid = Number(pp.dataset.person);
      const people = x.people.includes(pid) ? x.people.filter((p) => p !== pid) : [...x.people, pid];
      const ch = { people };
      if (people.length && x.due_date && x.remind < 0) ch.remind = 0;
      patch(id, ch);
    }
  });
  const saveTimers = {};
  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(400, el.scrollHeight + 2) + 'px'; }
  list.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (f !== 'title' && f !== 'notes') return;
    const id = Number(e.target.closest('.task').dataset.id);
    if (f === 'notes') autoGrow(e.target);
    clearTimeout(saveTimers[id + f]);
    const val = e.target.value;
    saveTimers[id + f] = setTimeout(() => { if (f === 'title' && !val.trim()) return; patch(id, { [f]: val }, { rerender: false }); }, 450);
  });
  list.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (!f || f === 'title' || f === 'notes') return;
    const id = Number(e.target.closest('.task').dataset.id);
    const x = find(id);
    let v = e.target.value;
    if (f === 'tags') v = v.split(/[,\s]+/).map((s) => s.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
    if (f === 'remind') v = Number(v);
    if (f === 'repeat') v = v || null;
    if (f === 'due_date') v = v || null;
    if (f === 'due_time') v = v || null;
    const ch = { [f]: v };
    if (f === 'due_time' && v && x && x.remind < 0) ch.remind = 0;
    if (f === 'repeat' && v && x && !x.due_date) ch.due_date = today();
    patch(id, ch);
  });
  list.addEventListener('keydown', (e) => {
    if (e.target.dataset.f === 'title' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  // ---------- navigation ----------
  function setView(v) {
    S.view = v; S.search = ''; $('#search').value = ''; S.open = null; S.sel = null;
    store.set('view', v);
    render();
    window.scrollTo({ top: 0 });
  }
  document.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { setView(v.dataset.view); return; }
    const o = e.target.closest('[data-open="settings"]');
    if (o) openSettings();
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnHelp').addEventListener('click', () => $('#help').showModal());
  $('#search').addEventListener('input', (e) => { S.search = e.target.value.trim(); S.open = null; render(); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; S.search = ''; render(); e.target.blur(); } });

  function moveSel(dir) {
    if (!flatIds.length) return;
    let i = flatIds.indexOf(S.sel);
    i = i < 0 ? (dir > 0 ? 0 : flatIds.length - 1) : Math.max(0, Math.min(flatIds.length - 1, i + dir));
    S.sel = flatIds[i];
    $$('.task.sel').forEach((el) => el.classList.remove('sel'));
    const el = $(`.task[data-id="${S.sel}"]`);
    if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest' }); }
  }

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) { e.target.blur(); return; }
      if (S.open) { S.open = null; renderList(); return; }
      S.sel = null; renderList(); return;
    }
    if (typing || e.ctrlKey && e.key.toLowerCase() !== 'z' || e.metaKey && e.key.toLowerCase() !== 'z' || e.altKey) return;
    const k = e.key;
    const sel = S.sel;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); runUndo(); return; }
    if (k === 'n' || k === 'a') { e.preventDefault(); qa.focus(); return; }
    if (k === '/') { e.preventDefault(); $('#search').focus(); return; }
    if (k === '?') { $('#help').showModal(); return; }
    if (/^[1-5]$/.test(k)) { setView(VIEWS[Number(k) - 1].id); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
    if (k === 'u') { runUndo(); return; }
    if (!sel) return;
    if (k === 'x' || k === ' ') { e.preventDefault(); toggleDone(sel); }
    else if (k === 'Enter' || k === 'e') { e.preventDefault(); S.open = S.open === sel ? null : sel; renderList(); if (S.open) $(`.task[data-id="${sel}"] .d-title`)?.focus(); }
    else if (k === 't') reschedule(sel, 'today');
    else if (k === 'm') reschedule(sel, 'tomorrow');
    else if (k === 'w') reschedule(sel, 'week');
    else if (k === 's') reschedule(sel, 'someday');
    else if (k === 'p') { const x = find(sel); if (x) patch(sel, { priority: (x.priority + 1) % 4 }, { undoable: true }); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); const i = flatIds.indexOf(sel); removeTask(sel); S.sel = flatIds[Math.min(i, flatIds.length - 1)] ?? null; renderList(); }
  });
  async function runUndo() {
    if (!S.undo) { toast('Nothing to undo'); return; }
    const u = S.undo; S.undo = null;
    try { await u(); toast('Undone'); } catch (e) { toast('Undo failed'); }
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, undo) {
    const el = $('#toast');
    el.innerHTML = `<span class="msg">${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
    if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); S.undo = null; undo(); };
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2400);
  }

  // ---------- settings ----------
  async function openSettings() {
    const d = $('#settings');
    $('#sEmail').value = S.me.email || '';
    $('#sDigestTime').value = S.me.digest_time;
    $('#sTz').value = S.me.tz;
    $('#sDigestOn').checked = S.me.digest_on;
    const mm = $('#mailMode');
    if (S.me.mail_mode === 'preview') {
      mm.className = 'hint warn';
      mm.innerHTML = '⚠ Email is in <b>preview mode</b>: messages are saved below but not sent. Set <code>BREVO_API_KEY</code> + <code>MAIL_FROM_EMAIL</code> (hosting) or <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code> (local) and restart to send real email.';
    } else {
      mm.className = 'hint ok';
      mm.textContent = `✓ Sending real email via ${S.me.mail_mode} from ${S.me.mail_from}`;
    }
    if (!$('#tzList').children.length && Intl.supportedValuesOf) {
      $('#tzList').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${z}">`).join('');
    }
    renderPeople();
    loadOutbox();
    d.showModal();
  }
  function renderPeople() {
    $('#peopleList').innerHTML = S.people.length ? S.people.map((p) => `<div class="person" data-pid="${p.id}">
      <i class="av" style="width:26px;height:26px;font-size:11px">${esc(initials(p.name))}</i>
      <div style="min-width:0"><div><b>${esc(p.name)}</b> <span class="hint" style="margin:0">@${esc(p.name.split(/\s+/)[0].toLowerCase())}</span></div><div class="em">${esc(p.email)}</div></div>
      <div class="sp"><label class="chk" title="Morning digest of their tasks"><input type="checkbox" data-pdigest ${p.digest ? 'checked' : ''}> digest</label>
      <button type="button" class="del" data-pdel title="Remove">✕</button></div></div>`).join('')
      : '<p class="hint" style="margin:0">No people yet.</p>';
  }
  async function loadOutbox() {
    try {
      const rows = await api('GET', '/api/outbox');
      $('#outbox').innerHTML = rows.length ? rows.map((r) => `<a href="/api/outbox/${r.id}" target="_blank" rel="noopener" title="${esc(r.error || r.to_addr)}">
        <span class="st ${r.status}">${r.status}</span><span class="sj">${esc(r.subject)} → ${esc(r.to_addr)}</span><span class="tm">${esc(dayLabel(localDateOfTs(r.created_at)))} ${esc(localTimeOfTs(r.created_at))}</span></a>${r.error ? `<div class="ob-err">${esc(r.error)}</div>` : ''}`).join('')
        : '<p class="hint" style="margin:0">No emails yet.</p>';
    } catch { /* ignore */ }
  }
  $('#sSave').addEventListener('click', async () => {
    try {
      S.me = await api('PUT', '/api/settings', { email: $('#sEmail').value.trim(), tz: $('#sTz').value.trim(), digest_time: $('#sDigestTime').value, digest_on: $('#sDigestOn').checked });
      S.tasks = await api('GET', '/api/tasks');
      render();
      toast('Settings saved');
    } catch (e) { alert(e.message); }
  });
  $('#sTest').addEventListener('click', async () => {
    try { await api('POST', '/api/email/test'); toast(S.me.mail_mode === 'preview' ? 'Saved to outbox (preview mode)' : 'Test email sent — check Gmail'); loadOutbox(); } catch (e) { alert(e.message); loadOutbox(); }
  });
  $('#sDigestNow').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/email/digest'); toast(`Digest sent (${r.sent} email${r.sent === 1 ? '' : 's'})`); loadOutbox(); } catch (e) { alert(e.message); }
  });
  $('#personForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const p = await api('POST', '/api/people', { name: $('#pName').value, email: $('#pEmail').value, digest: $('#pDigest').checked });
      S.people.push(p); S.people.sort((a, b) => a.name.localeCompare(b.name));
      e.target.reset(); renderPeople(); render();
    } catch (err) { alert(err.message); }
  });
  $('#peopleList').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-pdigest]')) return;
    const id = Number(e.target.closest('.person').dataset.pid);
    const p = await api('PATCH', `/api/people/${id}`, { digest: e.target.checked });
    S.people = S.people.map((x) => (x.id === id ? p : x));
  });
  $('#peopleList').addEventListener('click', async (e) => {
    if (!e.target.matches('[data-pdel]')) return;
    const id = Number(e.target.closest('.person').dataset.pid);
    const p = personById(id);
    if (!confirm(`Remove ${p.name}? They will stop getting emails.`)) return;
    await api('DELETE', `/api/people/${id}`);
    S.people = S.people.filter((x) => x.id !== id);
    for (const t of S.tasks) t.people = t.people.filter((x) => x !== id);
    renderPeople(); render();
  });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/settings/password', { current: $('#pwCur').value, next: $('#pwNew').value }); e.target.reset(); toast('Password changed'); } catch (err) { alert(err.message); }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/'; });

  // ---------- boot ----------
  async function refresh() {
    const [tasks, people] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/people')]);
    // keep local edits of the open task (avoid clobbering what you're typing)
    S.tasks = tasks; S.people = people;
    if (!S.open) render(); else renderChrome();
  }
  async function boot() {
    S.me = await api('GET', '/api/me');
    if (!VIEWS.some((v) => v.id === S.view) && !S.view.startsWith('tag:')) S.view = 'today';
    await refresh();
    if (matchMedia('(min-width: 761px)').matches) qa.focus();
    // re-sync when coming back to the tab (e.g. after clicking "Done" in an email), and roll over at midnight
    let lastDay = today();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
    setInterval(() => { if (today() !== lastDay) { lastDay = today(); render(); } }, 60000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  boot().catch((e) => { $('#list').innerHTML = `<div class="empty-state"><h3>Couldn't load</h3><p>${esc(e.message)}</p></div>`; });
})();
