// The morning card: today's events and the reminders that are due, read straight from the calendar.
//
// No model is asked. The card is the calendar's own entries in a few lines, so it costs nothing,
// takes a second and cannot invent a meeting. It comes once a day, from `hour` (8 by default) for
// four hours: a Mac asleep at eight gets it when it wakes, but nobody gets an "오늘" card at dinner.
// It reads only what bisu may already read — asking macOS for access is the person's step, in
// Settings — so a tick never puts a permission prompt on the screen.
//
//   node briefing.mjs        # what today's card would say, without leaving it
//   node briefing.mjs run    # leave it now
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eventKit, parseWhen, ymd } from '../engine/calendar.mjs';
import * as proactive from './proactive.mjs';
import { holdsSchedule } from './lock.mjs';

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
const FILE = path.join(CONFIG_DIR, 'briefing.json');
const DEFAULTS = { enabled: true, hour: 8 };
const WINDOW_H = 4;
const TICK_MS = 5 * 60e3;
const MAX_LINES = 8;

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch {}
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
    hour: Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23 ? s.hour : DEFAULTS.hour,
    lastDay: typeof s.lastDay === 'string' ? s.lastDay : null,
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
  };
}
function save(s) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('bisu briefing: cannot save:', e.message) }
}

// ---- the card ----
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const md = d => `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
const more = (lines, n) => n > lines.length ? [...lines, `· 그 밖에 ${n - lines.length}개`] : lines;

function eventLine(x, now) {
  const s = parseWhen(x.start), e = parseWhen(x.end);
  const today = ymd(now);
  let when;
  if (x.all_day || !s?.timed) when = '종일';
  else {
    const from = ymd(s.date) < today ? '어제부터' : hm(s.date);
    const to = !e ? '' : ymd(e.date) > today ? '–내일' : `–${hm(e.date)}`;
    when = from + to;
  }
  const ended = s?.timed && e?.timed && e.date <= now, on = s?.timed && e?.timed && s.date <= now && now < e.date;
  return `· ${when} ${x.title}${x.location ? ` · ${x.location}` : ''}${ended ? ' (끝남)' : on ? ' (진행 중)' : ''}`;
}
function reminderLine(r, now) {
  const d = parseWhen(r.due), today = ymd(now);
  const day = ymd(d.date) === today ? '오늘' : md(d.date);
  const late = d.timed ? d.date < now : ymd(d.date) < today;
  return `· ${r.title} — ${day}${d.timed ? ` ${hm(d.date)}` : ' 마감'}${late ? ', 지남' : ''}${r.priority === 'high' ? ' · 중요' : ''}`;
}
const dueBy = (r, now) => { const d = !r.completed && parseWhen(r.due); return d && ymd(d.date) <= ymd(now) };
const startOf = x => parseWhen(x.start)?.date?.getTime() ?? 0;

// What may be read, from the helper's status: "full" for each kind, or null for the whole card.
export async function access(cal = eventKit()) {
  try {
    const st = await cal.status();
    return { events: st.events === 'full', reminders: st.reminders === 'full', status: st };
  } catch (e) { return { events: false, reminders: false, error: e.message } }
}

// { title, body } for `now`, from a calendar with events() and reminders(); `can` says which of the
// two it may read.
export async function compose(cal, now = new Date(), can = { events: true, reminders: true }) {
  const out = [];
  if (can.events) {
    const events = (await cal.events({ from: ymd(now), to: ymd(now) })).sort((a, b) => (b.all_day - a.all_day) || startOf(a) - startOf(b));
    out.push(events.length ? `일정 ${events.length}개` : '일정 없음', ...more(events.slice(0, MAX_LINES).map(x => eventLine(x, now)), events.length));
  } else out.push('일정은 볼 수 없어요 (설정에서 캘린더 접근을 허용해 주세요)');
  if (can.reminders) {
    const due = (await cal.reminders({ completed: false })).filter(r => dueBy(r, now))
      .sort((a, b) => parseWhen(a.due).date - parseWhen(b.due).date);
    if (due.length) out.push(`할 일 ${due.length}개`, ...more(due.slice(0, MAX_LINES).map(r => reminderLine(r, now)), due.length));
  }
  const empty = can.events && can.reminders && out.length === 1 && out[0] === '일정 없음';
  return { title: `오늘 ${md(now)}`, body: empty ? '오늘은 일정도, 기한이 된 할 일도 없어요.' : out.join('\n') };
}

// ---- when ----
export function snapshot(now = new Date()) {
  const s = load();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.hour);
  if (s.lastDay === ymd(now) || now.getHours() >= s.hour + WINDOW_H) at.setDate(at.getDate() + 1);
  return { ...s, nextAt: at.getTime() };
}
export function configure(patch = {}) {
  const s = load();
  if (typeof patch.enabled === 'boolean') s.enabled = patch.enabled;
  const h = Number(patch.hour);
  if (patch.hour != null && Number.isInteger(h) && h >= 0 && h <= 23) s.hour = h;
  save(s);
  return snapshot();
}

let running = false;
// The tick, and the page's "지금 받아 보기" (force: any time, again today).
export async function run({ force = false, now = new Date(), cal = eventKit() } = {}) {
  const s = load();
  if (!force) {
    if (!s.enabled) return { skipped: 'off' };
    if (s.lastDay === ymd(now)) return { skipped: 'done' };
    const h = now.getHours();
    if (h < s.hour || h >= s.hour + WINDOW_H) return { skipped: 'early' };
  }
  if (running) return { skipped: 'running' };
  running = true;
  try {
    const can = await access(cal);
    // Not yet allowed: nothing to say, and asked again next tick in case they allow it meanwhile.
    if (!can.events && !can.reminders) return { skipped: 'access', error: can.error || null };
    const card = await compose(cal, now, can);
    // Yesterday's card, if nobody opened it, is old news.
    for (const it of proactive.snapshot().items) if (it.job === 'briefing' && it.status === 'new') proactive.resolve(it.id, 'dismissed');
    proactive.push({ id: randomUUID(), kind: 'job', job: 'briefing', ...card });
    save({ ...load(), lastDay: ymd(now), lastError: null });
    return { ok: true, ...card };
  } catch (e) {
    save({ ...load(), lastError: String(e.message || e).slice(0, 300) });
    return { error: String(e.message || e) };
  } finally { running = false }
}

let timer = null;
export function start() {
  if (timer || process.env.BISU_BRIEFING === '0') return;
  const tick = () => { if (holdsSchedule()) run().catch(() => {}) };
  setTimeout(tick, 60e3).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
export function stop() { clearInterval(timer); timer = null }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'run') process.stdout.write(JSON.stringify(await run({ force: true }), null, 1) + '\n');
  else {
    const cal = eventKit(), can = await access(cal);
    if (!can.events && !can.reminders) process.stdout.write(`bisu: no calendar access (${can.error || JSON.stringify(can.status)})\n`);
    else { const c = await compose(cal, new Date(), can); process.stdout.write(`${c.title}\n${c.body}\n`) }
  }
}
