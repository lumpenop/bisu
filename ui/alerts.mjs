// What bisu says when nobody is looking at it: macOS banners, a word before the next meeting, and
// keeping the Mac awake so it can still answer.
//
// Notices are kept here and the shell (mac/native/bisu.swift) collects them from /api/notices every
// few seconds, the same way it already reads the chats for the menu bar icon, and shows each one as
// a macOS notification. It leaves out the ones about a conversation when bisu's window is on screen.
// Telegram (ui/telegram.mjs) is told about each notice too and sends the meeting ones.
//
// Awake: while on power, `caffeinate -s` keeps the system from sleeping (-w ties it to our pid, so a
// dead engine leaves no assertion behind). The display still sleeps as usual, and a closed lid still
// sleeps. When it holds is the person's choice (`awakeMode`):
//   always · timer (until `awakeUntil`, then off) · tasks (while a turn, a background agent, a job or a
//   goal runs, at most `awakeMaxH` hours in a row) · off.
// A job marked 「실행 중엔 맥 깨어 있게」 holds it while it runs, whatever the mode.
//
// Meetings: once a minute, events that start within `before` minutes (10 by default) and have not
// been announced. Read the way the briefing reads them: only if bisu already has full access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { eventKit, parseWhen, ymd } from '../engine/calendar.mjs';
import * as proactive from './proactive.mjs';
import { holdsSchedule } from './lock.mjs';

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
const FILE = path.join(CONFIG_DIR, 'alerts.json');
const BEFORE = [0, 5, 10, 15, 30];
const KINDS = ['approvals', 'replies', 'cards', 'events'];
const MODES = ['always', 'timer', 'tasks', 'off'];
const DEFAULTS = { awakeMode: 'tasks', awakeMaxH: 4, before: 10, banners: Object.fromEntries(KINDS.map(k => [k, true])) };
const KEEP = 60;

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch {}
  const banners = { ...DEFAULTS.banners };
  for (const k of KINDS) if (typeof s.banners?.[k] === 'boolean') banners[k] = s.banners[k];
  // Before the modes there was one switch: on kept the Mac awake all the time, so it stays 「always」.
  const awakeMode = MODES.includes(s.awakeMode) ? s.awakeMode : s.awake === true ? 'always' : s.awake === false ? 'off' : DEFAULTS.awakeMode;
  return {
    awakeMode,
    awakeUntil: Number(s.awakeUntil) || 0,
    awakeMaxH: Number(s.awakeMaxH) >= 1 && Number(s.awakeMaxH) <= 24 ? Number(s.awakeMaxH) : DEFAULTS.awakeMaxH,
    before: BEFORE.includes(s.before) ? s.before : DEFAULTS.before,
    banners,
    sent: Array.isArray(s.sent) ? s.sent : [],
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
  };
}
function save(patch) {
  const s = { ...load(), ...patch };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('bisu alerts: cannot save:', e.message) }
  return s;
}

// ---- notices ----
const BOOT = randomBytes(4).toString('hex'), BOOT_AT = Date.now();
const notices = [], listeners = new Set();
let seq = 0;
const BANNER_OF = { approval: 'approvals', reply: 'replies', card: 'cards', event: 'events' };
export function onNotice(fn) { listeners.add(fn) }
// { kind, title, body, chat? } — `banner` says whether the shell shows it; listeners hear all of them.
export function notice({ kind, title, body = '', chat = null }) {
  const key = BANNER_OF[kind];
  const n = { id: ++seq, at: Date.now(), kind, title: String(title || '덱 인턴').slice(0, 120), body: String(body || '').slice(0, 400), chat,
    banner: !key || load().banners[key] !== false };
  notices.push(n);
  if (notices.length > KEEP) notices.splice(0, notices.length - KEEP);
  for (const fn of listeners) { try { fn(n) } catch {} }
  return n;
}
// The shell asks with the last id it showed; `boot` changes when the engine restarts and ids start over.
export function since(after = 0) {
  return { boot: BOOT, last: seq, notices: notices.filter(n => n.id > after && n.banner) };
}

// ---- what happens in the chats ----
const plain = t => String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1')
  .replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
const said = new Map();
// Every event of every chat; `phone` is true for the chats Telegram talks through, whose answers
// already go to the phone.
export function onEvent(c, ev, { phone = false } = {}) {
  if (ev.past) return;
  // A turn or a background agent starting or ending changes whether the Mac should stay awake.
  if (ev.kind === 'status' || ev.kind === 'tasks') queueMicrotask(() => { try { decide() } catch {} });
  if (ev.kind === 'approval') {
    const what = ev.description || (ev.input?.command ? `$ ${ev.input.command}` : ev.input?.file_path || ev.input?.path || ev.tool || '');
    notice({ kind: 'approval', title: '확인이 필요해요', body: `${plain(what).slice(0, 200)}${c.title ? ` · ${c.title}` : ''}`, chat: c.id });
  } else if (ev.kind === 'user') said.set(c.id, null);
  else if (ev.kind === 'text' && !ev.parent) said.set(c.id, ev.text);
  else if (ev.kind === 'result') {
    const text = said.get(c.id); said.delete(c.id);
    if (phone) return;
    if (text) notice({ kind: 'reply', title: c.title || '덱 인턴', body: plain(text).slice(0, 240), chat: c.id });
    else if (ev.error) notice({ kind: 'reply', title: c.title || '덱 인턴', body: '끝까지 하지 못했어요.', chat: c.id });
  }
}

// Suggestions, job answers and the briefing, each once, from the moment this engine started.
const cardsSeen = new Set();
function cards() {
  for (const it of [...proactive.snapshot().items].reverse()) {
    if (it.status !== 'new' || cardsSeen.has(it.id) || (it.at || 0) < BOOT_AT) continue;
    cardsSeen.add(it.id);
    const head = it.kind !== 'job' ? 'bisu가 하나 찾았어요' : it.job === 'briefing' ? '아침 브리핑' : it.job === 'goal' ? (it.ask ? '목표 · 물어볼 게 있어요' : '목표') : '예약 작업';
    notice({ kind: 'card', title: `${head} · ${it.title || ''}`.replace(/ · $/, ''), body: plain(it.body).slice(0, 240) });
  }
}

// ---- meetings ----
const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const LINK = /https:\/\/[^\s<>"')]+/;
let accessAt = 0, accessOk = null;
async function canRead(cal) {
  if (Date.now() - accessAt < 10 * 60e3 && accessOk !== null) return accessOk;
  try { accessOk = (await cal.status()).events === 'full' } catch { accessOk = false }
  accessAt = Date.now();
  return accessOk;
}
// The events of `now` that start within `before` minutes and were not announced yet.
export async function soon({ now = new Date(), cal = eventKit(), before = load().before, sent = load().sent } = {}) {
  if (!before) return [];
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const events = await cal.events({ from: ymd(now), to: ymd(tomorrow) });
  const out = [];
  for (const x of events) {
    const s = parseWhen(x.start);
    if (x.all_day || !s?.timed) continue;
    const ms = s.date - now, key = `${x.id}@${x.start}`;
    // A tick a little late still counts; one that comes after the start does not.
    if (ms <= 0 || ms > before * 60e3 + 30e3 || sent.includes(key)) continue;
    const e = parseWhen(x.end), link = (String(x.location || '').match(LINK) || String(x.notes || '').match(LINK) || [])[0];
    const place = x.location && !LINK.test(x.location) ? x.location : '';
    out.push({ key, title: `${Math.max(1, Math.round(ms / 60e3))}분 뒤 · ${x.title || '일정'}`,
      body: [`${hm(s.date)}${e?.timed ? `–${hm(e.date)}` : ''}${place ? ` · ${place}` : ''}`, link].filter(Boolean).join('\n') });
  }
  return out;
}
let checking = false;
async function meetings() {
  const s = load();
  if (!s.before || checking) return;
  checking = true;
  try {
    const cal = eventKit();
    if (!(await canRead(cal))) return;
    const due = await soon({ cal, before: s.before, sent: s.sent });
    if (due.length) save({ sent: [...s.sent, ...due.map(d => d.key)].slice(-100), lastError: null });
    for (const d of due) notice({ kind: 'event', title: d.title, body: d.body });
  } catch (e) { save({ lastError: String(e.message || e).slice(0, 200) }) }
  finally { checking = false }
}

// ---- awake ----
let caf = null;
function keepAwake(on) {
  if (on && !caf && process.env.BISU_AWAKE !== '0') {
    caf = spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
    const me = caf;
    caf.on('exit', () => { if (caf === me) caf = null });
    caf.on('error', () => { if (caf === me) caf = null });
  } else if (!on && caf) { caf.kill(); caf = null }
}
// What is running right now, from the server: [{what}] for turns, background agents, jobs and goals,
// and the running job if it asked to keep the Mac awake.
let workFn = () => ({ work: [], forced: null });
export function setWork(fn) { if (typeof fn === 'function') workFn = fn }
let workSince = 0, why = null;
function decide(now = Date.now()) {
  const s = load();
  let w = { work: [], forced: null };
  try { w = workFn() || w } catch {}
  if (w.work.length) { if (!workSince) workSince = now } else workSince = 0;
  // A timer that ran out turns itself off, so the page says off rather than a time in the past.
  if (s.awakeMode === 'timer' && s.awakeUntil && now >= s.awakeUntil) save({ awakeMode: 'off', awakeUntil: 0 });
  const mode = load().awakeMode;
  const capped = mode === 'tasks' && workSince && now - workSince > s.awakeMaxH * 3600e3;
  why = mode === 'always' ? 'always' : mode === 'timer' ? 'timer' : mode === 'tasks' && w.work.length && !capped ? 'tasks' : w.forced?.awake ? 'job' : null;
  keepAwake(!!why);
  return { work: w.work, forced: w.forced, capped: !!capped };
}
const power = () => new Promise(resolve => execFile('/usr/bin/pmset', ['-g', 'ps'], { timeout: 5000 }, (e, out) =>
  resolve(e ? null : /'AC Power'/.test(out) ? 'ac' : /'Battery Power'/.test(out) ? 'battery' : null)));

// ---- the page ----
export async function snapshot() {
  const d = decide(), s = load();
  let access = null;
  try { access = (await eventKit().status()).events === 'full' } catch {}
  const now = Date.now();
  return { awakeMode: s.awakeMode, awake: s.awakeMode !== 'off', awakeUntil: s.awakeMode === 'timer' ? s.awakeUntil : 0,
    remainingMs: s.awakeMode === 'timer' ? Math.max(0, s.awakeUntil - now) : 0, awakeMaxH: s.awakeMaxH, work: d.work, capped: d.capped,
    holding: why, keepingAwake: !!caf, power: await power(), before: s.before, banners: s.banners, access, lastError: s.lastError };
}
export async function configure(patch = {}) {
  const s = load(), next = {};
  if (typeof patch.awake === 'boolean') next.awakeMode = patch.awake ? 'always' : 'off';
  if (MODES.includes(patch.awakeMode)) {
    next.awakeMode = patch.awakeMode;
    if (patch.awakeMode === 'timer') {
      const min = Number(patch.minutes);
      if (!(min >= 1 && min <= 24 * 60)) throw Object.assign(Error('minutes: 1 to 1440'), { status: 400 });
      next.awakeUntil = Date.now() + Math.round(min) * 60e3;
    } else next.awakeUntil = 0;
  }
  if (Number(patch.awakeMaxH) >= 1 && Number(patch.awakeMaxH) <= 24) next.awakeMaxH = Math.round(Number(patch.awakeMaxH));
  if (BEFORE.includes(patch.before)) next.before = patch.before;
  if (patch.banners && typeof patch.banners === 'object') {
    next.banners = { ...s.banners };
    for (const k of KINDS) if (typeof patch.banners[k] === 'boolean') next.banners[k] = patch.banners[k];
  }
  save(next);
  decide();
  return snapshot();
}
export function test() { return notice({ kind: 'test', title: '덱 인턴', body: '이렇게 알려 드려요.' }) }

let timers = [];
export function start() {
  if (timers.length) return;
  decide();
  // Not gated by the schedule lock: each engine holds or lets go of its own assertion.
  const tick = setInterval(() => decide(), 15e3); tick.unref?.(); timers.push(tick);
  const every = (fn, ms) => { const t = setInterval(() => { if (holdsSchedule()) fn() }, ms); t.unref?.(); timers.push(t) };
  every(() => meetings().catch(() => {}), 60e3);
  every(cards, 15e3);
  setTimeout(() => { if (holdsSchedule()) meetings().catch(() => {}) }, 20e3).unref?.();
}
export function shutdown() { for (const t of timers) clearInterval(t); timers = []; keepAwake(false) }
