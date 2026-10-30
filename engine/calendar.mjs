// The person's Calendar and Reminders as tools: what is on, adding and moving events, to-dos, and
// "remind me at…" (a reminder with a time is what notifies them, on the phone too).
//
// The real ones go through EventKit (mac/cal/dec-intern-cal.swift, which mac/native/build.sh builds next to
// the computer-use helper). The benchmark hands in a pretend calendar as ctx.calendar instead
// (engine/eval/fake-calendar.mjs), so the same tools are measured without touching a real one.
//
// The model never sees EventKit's long identifiers: each event or reminder it is shown gets a short
// id for the conversation (e3, r2), and deleting needs the title too, so a wrong id cannot remove
// the wrong thing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';

const ok = text => ({text});
const err = text => ({text, error: true});

// ---- local times ----
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
// "2026-10-28 15:00", "2026-10-28T15:00" or "2026-10-28" → {date, timed}; anything else → null.
export function parseWhen(s) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (date.getMonth() !== +m[2] - 1 || date.getDate() !== +m[3] || (m[4] && +m[4] > 23)) return null;
  return {date, timed: m[4] != null};
}
export const wire = ({date, timed}) => timed ? `${ymd(date)} ${hm(date)}` : ymd(date);
const day = d => `${ymd(d)} (${WD[d.getDay()]})`;
// How a time reads in a tool result: the weekday next to every date, so a wrong day shows.
function when(start, end, allDay) {
  const s = parseWhen(start), e = parseWhen(end);
  if (!s) return String(start);
  if (allDay || !s.timed) return !e || ymd(e.date) === ymd(s.date) ? `${day(s.date)} 종일` : `${day(s.date)}–${day(e.date)} 종일`;
  if (!e) return `${day(s.date)} ${hm(s.date)}`;
  return ymd(e.date) === ymd(s.date) ? `${day(s.date)} ${hm(s.date)}–${hm(e.date)}` : `${day(s.date)} ${hm(s.date)} – ${day(e.date)} ${hm(e.date)}`;
}
const span = x => { const s = parseWhen(x.start), e = parseWhen(x.end); return s && {s: s.date, e: x.all_day ? addDays(midnight(e?.date || s.date), 1) : e?.date || s.date} };
const overlaps = (x, s, e) => { const t = span(x); return t && t.s < e && s < t.e };

// The "Now" lines of the system prompt: today with its weekday, this week and the next, and the
// next fourteen days, so "다음 주 화요일" is a lookup rather than arithmetic.
export function nowLines(now = new Date()) {
  const today = midnight(now), monday = addDays(today, -((now.getDay() + 6) % 7));
  const days = Array.from({length: 14}, (_, i) => { const d = addDays(today, i); return `${ymd(d).slice(5)} ${WD[d.getDay()]}${i === 0 ? '(오늘)' : i === 1 ? '(내일)' : ''}` });
  return [
    `- Time: ${day(now)} ${hm(now)}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `- This week: ${day(monday)} – ${day(addDays(monday, 6))}; next week: ${day(addDays(monday, 7))} – ${day(addDays(monday, 13))}`,
    `- Next 14 days: ${days.join(', ')}`,
  ].join('\n');
}

// ---- short ids ----
const books = new WeakMap();
function book(backend) { let b = books.get(backend); if (!b) books.set(backend, b = {byRef: new Map(), byId: new Map(), n: {e: 0, r: 0}}); return b }
// One occurrence of a repeating event is its own thing to move or delete: its start is part of the id.
const refOf = (kind, x) => kind + (kind === 'e' && x.recurring ? `${x.id}@${x.start}` : x.id);
function idFor(backend, kind, x, reuse) {
  const b = book(backend), ref = refOf(kind, x);
  const id = reuse || b.byRef.get(ref) || kind + (++b.n[kind]);
  b.byRef.set(ref, id);
  b.byId.set(id, {kind, id: x.id, occurrence: kind === 'e' && x.recurring ? x.start : null, title: x.title, item: x});
  return id;
}
const lookup = (backend, id) => book(backend).byId.get(String(id ?? '').trim().replace(/^\[|\]$/g, ''));

const REPEAT_KO = {daily: '매일 반복', weekly: '매주 반복', monthly: '매달 반복', yearly: '매년 반복'};
const eventText = x => `${when(x.start, x.end, x.all_day)} ${x.title}${x.location ? ` · ${x.location}` : ''}${x.calendar ? ` · ${x.calendar}` : ''}${x.recurring ? ` · ${REPEAT_KO[x.recurring] || '반복'}` : ''}`;
// In a listing, what has already ended (or is on now) says so: "오늘 남은 일정" must not count it.
const eventLine = (backend, x, reuse, now) => { const t = now && span(x); return `[${idFor(backend, 'e', x, reuse)}] ${eventText(x)}${!t ? '' : t.e <= now ? ' (끝남)' : t.s <= now ? ' (진행 중)' : ''}` };
function reminderText(r, now) {
  const d = parseWhen(r.due);
  const late = d && !r.completed && (d.timed ? d.date < now : ymd(d.date) < ymd(now));
  return `${r.completed ? '(완료) ' : ''}${r.title}${d ? ` · ${d.timed ? `알림 ${day(d.date)} ${hm(d.date)}` : `마감 ${day(d.date)}`}${late ? ' (지남)' : ''}` : ''}${r.list ? ` · ${r.list}` : ''}${r.priority === 'high' ? ' · 중요' : ''}`;
}
const reminderLine = (backend, r, now, reuse) => `[${idFor(backend, 'r', r, reuse)}] ${reminderText(r, now)}`;

// ---- where the calendar is ----
let shared = null;
const backendOf = ctx => ctx.calendar || (shared ??= eventKit());
const nowOf = ctx => ctx.now || new Date();
function failure(e) {
  const m = String(e?.message || e);
  if (m.startsWith('access-denied')) {
    const what = m.endsWith('reminders') ? ['reminders', '미리 알림'] : ['calendar', '캘린더'];
    return err(`덱 인턴 is not allowed to see their ${what[0]}. Tell them to allow 덱 인턴 in 시스템 설정 → 개인정보 보호 및 보안 → ${what[1]} (전체 접근), then ask again.`);
  }
  return err(`The calendar did not answer: ${m}`);
}
async function checkName(backend, kind, name) {
  if (!name) return null;
  const c = await backend.calendars();
  const names = (kind === 'list' ? c.lists : c.calendars).filter(x => x.writable !== false).map(x => x.name);
  return names.some(n => n === name) ? null : err(`There is no ${kind === 'list' ? 'reminders list' : 'calendar'} called "${name}". There are: ${names.join(', ')}.`);
}
const unknownId = (id, kind) => err(`No ${kind === 'e' ? 'event' : 'reminder'} ${id} in this conversation: list them first (${kind === 'e' ? 'calendar_list' : 'reminders_list'}) and use an id shown there.`);
const TIME = 'Local time, "YYYY-MM-DD HH:MM"';

export const CALENDAR_TOOLS = {
  calendar_list: {
    description: 'Events in their calendar between two days (both included), each with a short id (e1, e2…) for calendar_change and calendar_delete. Default: today and the next 6 days. query keeps only events whose title, place or notes contain it.',
    parameters: {type: 'object', properties: {from: {type: 'string', description: 'YYYY-MM-DD'}, to: {type: 'string', description: 'YYYY-MM-DD'}, query: {type: 'string'}}},
    kind: 'calendar',
    async run(ctx, {from, to, query}) {
      const b = backendOf(ctx), now = nowOf(ctx);
      const f = from ? parseWhen(from) : {date: midnight(now)};
      const t = to ? parseWhen(to) : f && {date: addDays(f.date, 6)};
      if (!f || !t) return err('from and to are days, like 2026-10-28.');
      if (t.date < midnight(f.date)) return err('to is before from.');
      if ((t.date - f.date) / 864e5 > 400) return err('At most about a year at a time.');
      try {
        const q = String(query || '').trim().toLowerCase();
        const events = (await b.events({from: ymd(f.date), to: ymd(t.date)})).filter(x => !q || [x.title, x.location, x.notes].some(v => String(v || '').toLowerCase().includes(q)));
        const range = `${day(f.date)} – ${day(t.date)}${q ? `, matching "${query}"` : ''}`;
        return ok(events.length ? `Events ${range} (now ${day(now)} ${hm(now)}):\n${events.map(x => eventLine(b, x, undefined, now)).join('\n')}` : `No events ${range}.`);
      } catch (e) { return failure(e) }
    },
  },
  calendar_add: {
    description: `Add an event to their calendar. start/end: ${TIME}; a day alone ("YYYY-MM-DD") makes an all-day event. Without end it lasts an hour. repeat makes it recurring. Says if it overlaps something.`,
    parameters: {type: 'object', properties: {
      title: {type: 'string'}, start: {type: 'string'}, end: {type: 'string'},
      location: {type: 'string'}, notes: {type: 'string'},
      calendar: {type: 'string', description: 'which calendar, by name; default: their default one'},
      alert_minutes: {type: 'integer', description: 'an alert this many minutes before'},
      repeat: {type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly']},
      repeat_until: {type: 'string', description: 'last day it repeats, YYYY-MM-DD; default: forever'},
    }, required: ['title', 'start']},
    kind: 'calendar',
    async run(ctx, {title, start, end, location, notes, calendar, alert_minutes, repeat, repeat_until}) {
      const b = backendOf(ctx);
      title = String(title).trim();
      const s = parseWhen(start);
      if (!s) return err(`start: ${TIME}, or "YYYY-MM-DD" for an all-day event.`);
      let e = end ? parseWhen(end) : null;
      if (end && !e) return err(`end: ${TIME} (a day for an all-day event).`);
      if (!e) e = s.timed ? {date: new Date(+s.date + 3600e3), timed: true} : s;
      if (s.timed !== e.timed) return err('start and end must both have a time, or both be days (all-day).');
      if (e.date < s.date || (s.timed && +e.date === +s.date)) return err('end must come after start.');
      if (repeat_until && !parseWhen(repeat_until)) return err('repeat_until is a day, YYYY-MM-DD.');
      try {
        const bad = await checkName(b, 'calendar', calendar); if (bad) return bad;
        const around = await b.events({from: ymd(s.date), to: ymd(e.date)});
        // The same title at the same time is already there: say so rather than add it twice.
        const dup = around.find(x => x.title.trim() === title && x.start === wire(s));
        if (dup) return ok(`Already in the calendar, so not added again: ${eventLine(b, dup)}`);
        const added = await b.addEvent({title, start: wire(s), end: wire(e), all_day: !s.timed, location, notes, calendar, alert_minutes, repeat, repeat_until});
        const clash = s.timed ? around.filter(x => !x.all_day && overlaps(x, s.date, e.date)) : [];
        return ok(`Added ${eventLine(b, added)}${clash.length ? `\nIt overlaps: ${clash.map(x => eventLine(b, x)).join('; ')}` : ''}`);
      } catch (x) { return failure(x) }
    },
  },
  calendar_change: {
    description: `Change an event listed by calendar_list or calendar_add: move it (start, and end if the length changes — moving keeps the length), rename it, or change the place or notes. For a repeating event it changes only that occurrence unless all_occurrences.`,
    parameters: {type: 'object', properties: {
      id: {type: 'string', description: 'e1, e2… as listed'},
      title: {type: 'string'}, start: {type: 'string'}, end: {type: 'string'}, location: {type: 'string'}, notes: {type: 'string'}, calendar: {type: 'string'},
      all_occurrences: {type: 'boolean', description: 'a repeating event: change this and the ones after it'},
    }, required: ['id']},
    kind: 'calendar',
    async run(ctx, {id, title, start, end, location, notes, calendar, all_occurrences}) {
      const b = backendOf(ctx), h = lookup(b, id);
      if (!h || h.kind !== 'e') return unknownId(id, 'e');
      const s = start ? parseWhen(start) : null, e = end ? parseWhen(end) : null;
      if (start && !s) return err(`start: ${TIME}, or a day for all-day.`);
      if (end && !e) return err(`end: ${TIME}, or a day for all-day.`);
      if (s && e && (e.date < s.date || (s.timed && +e.date === +s.date))) return err('end must come after start.');
      try {
        const bad = await checkName(b, 'calendar', calendar); if (bad) return bad;
        const r = await b.updateEvent({id: h.id, occurrence: h.occurrence, all: !!all_occurrences, title, start: s ? wire(s) : undefined, end: e ? wire(e) : undefined, location, notes, calendar});
        const now = span(r.event);
        const clash = !r.event.all_day && now ? (await b.events({from: ymd(now.s), to: ymd(now.e)})).filter(x => !x.all_day && !(x.id === r.event.id && x.start === r.event.start) && overlaps(x, now.s, now.e)) : [];
        return ok(`Changed [${id}] from ${eventText(r.before)}\nto ${eventLine(b, r.event, id)}${clash.length ? `\nIt now overlaps: ${clash.map(x => eventLine(b, x)).join('; ')}` : ''}`);
      } catch (x) { return failure(x) }
    },
  },
  calendar_delete: {
    description: 'Delete an event (e…) or a reminder (r…), by the id listed and its title. They are asked to approve first. For a repeating event it deletes only that occurrence unless all_occurrences.',
    parameters: {type: 'object', properties: {
      id: {type: 'string'}, title: {type: 'string', description: 'its title as listed, to be sure it is the right one'},
      all_occurrences: {type: 'boolean'},
    }, required: ['id', 'title']},
    kind: 'calendar-delete',
    // For the approval card: what would go, in words.
    describe: (ctx, {id, all_occurrences}) => { const h = lookup(backendOf(ctx), id); return h ? (h.kind === 'e' ? eventText(h.item) + (all_occurrences ? ' (이후 반복 전부)' : '') : reminderText(h.item, nowOf(ctx))) : '' },
    async run(ctx, {id, title, all_occurrences}) {
      const b = backendOf(ctx), h = lookup(b, id);
      if (!h) return unknownId(id, String(id).trim().startsWith('r') ? 'r' : 'e');
      const want = String(title || '').trim();
      if (want && !h.title.includes(want) && !want.includes(h.title)) return err(`${id} is "${h.title}", not "${want}". List again and use the id of the one meant.`);
      try {
        if (h.kind === 'e') await b.deleteEvent({id: h.id, occurrence: h.occurrence, all: !!all_occurrences});
        else await b.deleteReminder({id: h.id});
        book(b).byId.delete(String(id).trim());
        return ok(`Deleted ${h.kind === 'e' ? eventText(h.item) + (all_occurrences && h.item.recurring ? ' (and the occurrences after it)' : '') : reminderText(h.item, nowOf(ctx))}.`);
      } catch (x) { return failure(x) }
    },
  },
  reminders_list: {
    description: 'Their to-dos in Reminders, each with a short id (r1, r2…), what is due first. Only open ones unless include_completed.',
    parameters: {type: 'object', properties: {
      list: {type: 'string', description: 'one list by name; default: all'},
      query: {type: 'string'}, include_completed: {type: 'boolean'},
    }},
    kind: 'calendar',
    async run(ctx, {list, query, include_completed}) {
      const b = backendOf(ctx), now = nowOf(ctx);
      try {
        const bad = await checkName(b, 'list', list); if (bad) return bad;
        const q = String(query || '').trim().toLowerCase();
        const due = r => parseWhen(r.due)?.date.getTime() ?? Infinity;
        const items = (await b.reminders({list, completed: !!include_completed}))
          .filter(r => (!list || r.list === list) && (!q || [r.title, r.notes].some(v => String(v || '').toLowerCase().includes(q))))
          .sort((x, y) => (x.completed - y.completed) || (due(x) - due(y)));
        const where = `${list ? ` in ${list}` : ''}${q ? ` matching "${query}"` : ''}`;
        return ok(items.length ? `Reminders${where}:\n${items.map(r => reminderLine(b, r, now)).join('\n')}` : `No ${include_completed ? '' : 'open '}reminders${where}.`);
      } catch (e) { return failure(e) }
    },
  },
  reminder_add: {
    description: `Add a to-do to Reminders. With a due time (${TIME}) they get a notification then, on every device: this is how to "remind me at…". A day alone ("YYYY-MM-DD") is due that day without a notification.`,
    parameters: {type: 'object', properties: {
      title: {type: 'string'}, due: {type: 'string'},
      list: {type: 'string', description: 'which list, by name; default: their default one'},
      notes: {type: 'string'}, priority: {type: 'string', enum: ['high', 'medium', 'low']},
    }, required: ['title']},
    kind: 'calendar',
    async run(ctx, {title, due, list, notes, priority}) {
      const b = backendOf(ctx), now = nowOf(ctx);
      title = String(title).trim();
      const d = due ? parseWhen(due) : null;
      if (due && !d) return err(`due: ${TIME}, or "YYYY-MM-DD" for a day.`);
      try {
        const bad = await checkName(b, 'list', list); if (bad) return bad;
        const open = await b.reminders({list, completed: false});
        const dup = open.find(r => r.title.trim() === title && (!list || r.list === list) && (r.due || '') === (d ? wire(d) : ''));
        if (dup) return ok(`Already there, so not added again: ${reminderLine(b, dup, now)}`);
        const added = await b.addReminder({title, due: d ? wire(d) : undefined, list, notes, priority});
        return ok(`Added ${reminderLine(b, added, now)}${d?.timed ? (d.date < now ? '\nThat time has already passed.' : '\nThey get a notification at that time.') : ''}`);
      } catch (e) { return failure(e) }
    },
  },
  reminder_change: {
    description: 'Change a to-do listed by reminders_list or reminder_add: check it off (completed: true), rename it, move its due time ("" removes it), its list, notes or priority.',
    parameters: {type: 'object', properties: {
      id: {type: 'string', description: 'r1, r2… as listed'},
      completed: {type: 'boolean'}, title: {type: 'string'}, due: {type: 'string'},
      list: {type: 'string'}, notes: {type: 'string'}, priority: {type: 'string', enum: ['high', 'medium', 'low']},
    }, required: ['id']},
    kind: 'calendar',
    async run(ctx, {id, completed, title, due, list, notes, priority}) {
      const b = backendOf(ctx), h = lookup(b, id), now = nowOf(ctx);
      if (!h || h.kind !== 'r') return unknownId(id, 'r');
      const d = due ? parseWhen(due) : null;
      if (due && !d) return err(`due: ${TIME}, a day, or "" to remove it.`);
      try {
        const bad = await checkName(b, 'list', list); if (bad) return bad;
        const r = await b.updateReminder({id: h.id, completed, title, due: due === undefined ? undefined : d ? wire(d) : '', list, notes, priority});
        return ok(`Changed [${id}] from ${reminderText(r.before, now)}\nto ${reminderLine(b, r.reminder, now, id)}`);
      } catch (e) { return failure(e) }
    },
  },
};

// ---- EventKit, through the helper ----
const HELPER = () => process.env.DEC_INTERN_CAL_BIN || path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern', 'bin', 'dec-intern-cal');
export function eventKit(bin = HELPER()) {
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    if (!fs.existsSync(bin)) return reject(new Error('the calendar helper is not installed (mac/native/build.sh builds it)'));
    // The first call can wait while macOS asks them for access.
    const child = execFile(bin, [], {timeout: 120_000, maxBuffer: 16 << 20}, (e, stdout) => {
      let j = null; try { j = JSON.parse(String(stdout).trim().split('\n').pop()) } catch {}
      if (!j) return reject(new Error(e?.killed ? 'timed out' : e?.message || 'no answer'));
      j.ok ? resolve(j) : reject(new Error(j.error));
    });
    child.stdin.end(JSON.stringify({op, ...args}));
  });
  return {
    status: () => call('status'),
    request: () => call('request'),
    calendars: () => call('calendars'),
    events: a => call('events', a).then(j => j.events),
    addEvent: a => call('add_event', a).then(j => j.event),
    updateEvent: a => call('update_event', a),
    deleteEvent: a => call('delete_event', a).then(j => j.event),
    reminders: a => call('reminders', a).then(j => j.reminders),
    addReminder: a => call('add_reminder', a).then(j => j.reminder),
    updateReminder: a => call('update_reminder', a),
    deleteReminder: a => call('delete_reminder', a).then(j => j.reminder),
  };
}
