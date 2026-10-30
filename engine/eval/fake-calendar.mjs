// A pretend Calendar and Reminders for the benchmark. It answers exactly as mac/cal/dec-intern-cal.swift
// does (same fields, local "YYYY-MM-DD HH:MM" times, repeating events listed one occurrence at a
// time), keeps everything in memory, and logs every change for the checks — so the calendar tools
// are measured without touching anyone's real calendar.
import {parseWhen, wire, ymd} from '../calendar.mjs';

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const STEP = {daily: (d, i) => addDays(d, i), weekly: (d, i) => addDays(d, 7 * i),
  monthly: (d, i) => new Date(d.getFullYear(), d.getMonth() + i, d.getDate(), d.getHours(), d.getMinutes()),
  yearly: (d, i) => new Date(d.getFullYear() + i, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes())};
const at = s => parseWhen(s)?.date;
// An all-day event's end is its last day; as a span it runs to the start of the day after.
const endOf = x => x.all_day ? addDays(at(x.end), 1) : at(x.end);

// fail: {method: {times, message}} makes a call fail the way the helper can (a timeout, no access).
export function fakeCalendar({calendars = ['개인', '회사'], lists = ['미리 알림', '장보기'], events = [], reminders = [], fail = {}} = {}) {
  let n = 0;
  const ev = events.map(e => ({id: `EV-${++n}`, location: '', notes: '', calendar: calendars[0], all_day: !parseWhen(e.start).timed, end: e.start, repeat: '', until: '', skip: [], ...e}));
  const rem = reminders.map(r => ({id: `RE-${++n}`, due: '', list: lists[0], completed: false, notes: '', priority: '', ...r}));
  const log = [];
  const shown = (e, o = e) => ({id: e.id, title: e.title, start: o.start, end: o.end, all_day: e.all_day, location: e.location, notes: e.notes, calendar: e.calendar, recurring: e.repeat || ''});
  // Occurrences that touch [from, to): a plain event once, a repeating one every time it comes round.
  function* occurrences(e, from, to) {
    if (!e.repeat) { if (at(e.start) < to && endOf(e) > from) yield {start: e.start, end: e.end}; return }
    const s0 = at(e.start), len = at(e.end) - s0, timed = !e.all_day, until = e.until ? addDays(at(e.until), 1) : null;
    for (let i = 0; i < 5000; i++) {
      const s = STEP[e.repeat](s0, i);
      if (s >= to || (until && s >= until)) return;
      const o = {start: wire({date: s, timed}), end: wire({date: new Date(+s + len), timed})};
      if (!e.skip.includes(o.start) && endOf({...e, ...o}) > from) yield o;
    }
  }
  const find = id => { const e = ev.find(x => x.id === id); if (!e) throw new Error('no such event'); return e };
  const occurrenceOf = (e, occ) => { if (!e.repeat || !occ) return {start: e.start, end: e.end}; const d = at(occ); return [...occurrences(e, d, addDays(d, 1))].find(o => o.start === occ) || {start: e.start, end: e.end} };
  // Moving keeps the length; an all-day event that gets a time becomes an hour long.
  function apply(t, a) {
    for (const k of ['title', 'location', 'notes', 'calendar']) if (a[k] !== undefined && a[k] !== null && !(k === 'title' && !a[k])) t[k] = a[k];
    if (a.start) {
      const s = parseWhen(a.start), len = t.all_day ? 3600e3 : Math.max(at(t.end) - at(t.start), 60e3);
      t.all_day = !s.timed;
      t.start = a.start;
      t.end = a.end || (s.timed ? wire({date: new Date(+s.date + len), timed: true}) : a.start);
    } else if (a.end) t.end = a.end;
  }
  const remShown = r => ({id: r.id, title: r.title, due: r.due, list: r.list, completed: r.completed, notes: r.notes, priority: r.priority});
  const findR = id => { const r = rem.find(x => x.id === id); if (!r) throw new Error('no such reminder'); return r };
  const api = {
    // What the calendar holds now, for the checks (events and reminders are the backend's own calls).
    log, data: {events: ev, reminders: rem},
    async calendars() { return {calendars: calendars.map((name, i) => ({name, writable: true, default: i === 0})), lists: lists.map((name, i) => ({name, writable: true, default: i === 0}))} },
    async events({from, to}) {
      const f = at(from), t = addDays(at(to), 1);
      return ev.flatMap(e => [...occurrences(e, f, t)].map(o => shown(e, o))).sort((a, b) => at(a.start) - at(b.start));
    },
    async addEvent(a) {
      const e = {id: `EV-${++n}`, title: a.title, start: a.start, end: a.end, all_day: !!a.all_day, location: a.location || '', notes: a.notes || '', calendar: a.calendar || calendars[0], repeat: a.repeat || '', until: a.repeat_until || '', skip: [], alert: a.alert_minutes ?? null};
      ev.push(e); log.push({op: 'add_event', ...a});
      return shown(e);
    },
    async updateEvent(a) {
      const e = find(a.id), o = occurrenceOf(e, a.occurrence), before = shown(e, o);
      log.push({op: 'update_event', ...a});
      if (e.repeat && a.occurrence && !a.all) {
        // One occurrence changed: it leaves the series and becomes an event of its own.
        e.skip.push(o.start);
        const d = {...e, id: `EV-${++n}`, start: o.start, end: o.end, repeat: '', until: '', skip: []};
        apply(d, a); ev.push(d);
        return {before, event: shown(d)};
      }
      if (e.repeat && a.start) {
        const t = {...e, start: o.start, end: o.end}; apply(t, a);
        const shift = at(t.start) - at(o.start), len = at(t.end) - at(t.start);
        Object.assign(e, t, {start: wire({date: new Date(+at(e.start) + shift), timed: !t.all_day})});
        e.end = wire({date: new Date(+at(e.start) + len), timed: !t.all_day});
        return {before, event: shown(e, {start: t.start, end: t.end})};
      }
      apply(e, a);
      return {before, event: shown(e, e.repeat ? occurrenceOf(e, a.occurrence) : e)};
    },
    async deleteEvent(a) {
      const e = find(a.id), o = occurrenceOf(e, a.occurrence), gone = shown(e, o);
      log.push({op: 'delete_event', ...a});
      if (e.repeat && a.occurrence && !a.all) e.skip.push(o.start);
      else if (e.repeat && a.occurrence && a.occurrence !== e.start) e.until = ymd(addDays(at(o.start), -1));
      else ev.splice(ev.indexOf(e), 1);
      return gone;
    },
    async reminders({list, completed}) { return rem.filter(r => (!list || r.list === list) && (completed || !r.completed)).map(remShown) },
    async addReminder(a) {
      const r = {id: `RE-${++n}`, title: a.title, due: a.due || '', list: a.list || lists[0], completed: false, notes: a.notes || '', priority: a.priority || ''};
      rem.push(r); log.push({op: 'add_reminder', ...a});
      return remShown(r);
    },
    async updateReminder(a) {
      const r = findR(a.id), before = remShown(r);
      log.push({op: 'update_reminder', ...a});
      for (const k of ['title', 'notes', 'list', 'priority']) if (a[k] !== undefined && a[k] !== null && !(k === 'title' && !a[k])) r[k] = a[k];
      if (a.due !== undefined) r.due = a.due || '';
      if (typeof a.completed === 'boolean') r.completed = a.completed;
      return {before, reminder: remShown(r)};
    },
    async deleteReminder(a) {
      const r = findR(a.id); log.push({op: 'delete_reminder', ...a});
      rem.splice(rem.indexOf(r), 1);
      return remShown(r);
    },
  };
  for (const [m, f] of Object.entries(fail)) {
    const real = api[m];
    let left = f.times ?? Infinity;
    api[m] = async (...a) => { if (left-- > 0) throw new Error(f.message || 'timed out'); return real(...a) };
  }
  return api;
}
