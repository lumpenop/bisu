// What bisu brings you when you did not ask.
//
// A secretary that only answers is a search box. This is the other half: on a slow cadence, bisu
// starts one short read-only Claude Code run of its own, looks at what you have been doing, and
// leaves at most one thing worth your attention — a README that is still empty, a migration that
// stopped halfway, a loose end from yesterday. It waits in the panel until you open it.
//
// Deliberate limits, because it spends money and your attention:
//  * read-only tools (Read, Glob, Grep) and a different system prompt — it cannot act, so a bad
//    suggestion costs a few cents and nothing else. Saying yes is what starts real work, in a real
//    chat, with the ordinary approval for every edit;
//  * one run per `intervalHours` (24 by default), nothing during quiet hours, never while another
//    run is going, and no run at all while two suggestions are already waiting unread;
//  * a failed run is retried in 30 minutes, not immediately;
//  * an empty answer is a valid answer, and a suggestion too close to one it already made — in any
//    status, including dismissed — is dropped instead of being reworded and served again.
//
//   node proactive.mjs            # the state and the last suggestions
//   node proactive.mjs run        # one run now, printing what it decided
//
// The same list of items also carries what a scheduled job answered (ui/jobs.mjs, kind 'job'), so
// the panel card and the dot on the menu bar are one mechanism; those never count as suggestions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
const FILE = path.join(CONFIG_DIR, 'proactive.json');

const DEFAULTS = { enabled: true, intervalHours: 24, quietFrom: 23, quietTo: 8 };
const KEEP = 40;      // how much history the page can show, and how far back dedupe looks
const MAX_WAITING = 2; // unread suggestions before it stops looking for more
const RETRY_MS = 30 * 60e3;
const TIMEOUT_MS = Number(process.env.BISU_SUGGEST_TIMEOUT || 150) * 1e3;
const TICK_MS = 10 * 60e3;

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch {}
  const s = { ...DEFAULTS, ...saved, items: Array.isArray(saved.items) ? saved.items.filter(i => i && typeof i.id === 'string') : [] };
  for (const k of ['enabled']) if (typeof s[k] !== 'boolean') s[k] = DEFAULTS[k];
  for (const k of ['intervalHours', 'quietFrom', 'quietTo']) if (!Number.isFinite(s[k])) s[k] = DEFAULTS[k];
  s.intervalHours = Math.min(24 * 14, Math.max(1, s.intervalHours));
  s.quietFrom = Math.min(23, Math.max(0, Math.round(s.quietFrom)));
  s.quietTo = Math.min(23, Math.max(0, Math.round(s.quietTo)));
  for (const k of ['lastRun', 'lastAttempt']) if (!Number.isFinite(s[k])) s[k] = 0;
  if (typeof s.lastError !== 'string') s.lastError = null;
  return s;
}

let state = load();
let running = null;
// Filled in by the engine: recent runs, open chats and the resolved models. Without it (a CLI run)
// the suggestion run still works, with only the memory and whatever it can read itself.
let contextFn = async () => ({});

function save() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...state, items: state.items.slice(0, KEEP) }, null, 1));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('bisu proactive: cannot save:', e.message) }
}
export function setContext(fn) { if (typeof fn === 'function') contextFn = fn }

const hourOf = d => d.getHours();
// Quiet hours wrap around midnight by default (23 → 8), so both shapes have to work.
export function isQuiet(d = new Date()) {
  const h = hourOf(d), from = state.quietFrom, to = state.quietTo;
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}
// The moment the cadence says it may look again, moved past quiet hours so `nextAt` is not a lie.
function nextAt() {
  const base = (state.lastError ? state.lastAttempt : state.lastRun) || 0;
  if (!base) return Date.now();
  const gap = state.lastError ? RETRY_MS : state.intervalHours * 3600e3;
  const at = new Date(base + gap);
  for (let i = 0; i < 48 && isQuiet(at); i++) at.setTime(at.getTime() + 3600e3);
  return at.getTime();
}
// null when a run is allowed now, otherwise the reason it is not. `force` is the person asking for
// one on the page or from the menu: it ignores the clock and the quiet hours, but not a run that is
// already going or a queue that is already full.
export function due(now = Date.now(), force = false) {
  if (!state.enabled) return 'off';
  if (running) return 'running';
  if (state.items.filter(i => i.status === 'new' && i.kind !== 'job').length >= MAX_WAITING) return 'waiting';
  if (!force && now < nextAt()) return 'early';
  if (!force && isQuiet(new Date(now))) return 'quiet';
  return null;
}

export function snapshot() {
  return {
    enabled: state.enabled, intervalHours: state.intervalHours,
    quietFrom: state.quietFrom, quietTo: state.quietTo,
    lastRun: state.lastRun || null, lastError: state.lastError,
    running: !!running, due: due(), nextAt: nextAt(),
    items: state.items.slice(0, 20),
    waiting: state.items.filter(i => i.status === 'new' && !i.seen).length,
  };
}

export function configure(patch = {}) {
  if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
  for (const k of ['intervalHours', 'quietFrom', 'quietTo']) {
    if (patch[k] === undefined || patch[k] === null) continue;
    const n = Number(patch[k]);
    if (Number.isFinite(n)) state[k] = n;
  }
  state.intervalHours = Math.min(24 * 14, Math.max(1, Math.round(state.intervalHours)));
  state.quietFrom = Math.min(23, Math.max(0, Math.round(state.quietFrom)));
  state.quietTo = Math.min(23, Math.max(0, Math.round(state.quietTo)));
  save();
  return snapshot();
}

export function resolve(id, status) {
  const item = state.items.find(i => i.id === id);
  if (!item) throw Object.assign(Error('no such suggestion'), { status: 404 });
  item.status = status;
  item.seen = true;
  item.resolvedAt = Date.now();
  save();
  return item;
}
export function markSeen(id) {
  const item = state.items.find(i => i.id === id);
  if (!item || item.seen) return;
  item.seen = true;
  save();
}
export function get(id) { return state.items.find(i => i.id === id) || null }
// A card from elsewhere (a scheduled job's answer): shown like a suggestion, never deduplicated
// against one, never counted as one.
export function push(item) {
  state.items.unshift({ status: 'new', seen: false, ...item, at: item.at || Date.now() });
  state.items = state.items.slice(0, KEEP);
  save();
  return item;
}

// ---- the run itself ----

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// What the model was asked about, in as few tokens as it can be useful with.
function userPrompt(ctx) {
  const now = new Date();
  const lines = [`지금: ${now.toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' })}`];

  const runs = (ctx.runs || []).slice(0, 10);
  if (runs.length) {
    lines.push('', '최근 작업 (bisu 실행, 최신순):');
    for (const r of runs) {
      const when = r.start ? new Date(r.start).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '?';
      lines.push(`- ${when} · ${r.cwd || '?'}${r.title ? ' · ' + r.title : ''}${r.prompt ? ' · ' + clean(r.prompt, 120) : ''}`);
    }
  }
  const chats = (ctx.chats || []).slice(0, 6);
  if (chats.length) {
    lines.push('', '지금 열려 있는 대화:', ...chats.map(c => `- ${c.cwd}${c.title ? ' · ' + c.title : ''}`));
  }

  const past = state.items.filter(i => i.kind !== 'job').slice(0, 12);
  if (past.length) {
    lines.push('', '이미 한 제안 (되풀이 금지 — 표현만 바꾸는 것도 안 됨):');
    for (const i of past) {
      const when = new Date(i.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
      const how = { accepted: '받아들임', dismissed: '거절함', new: '아직 안 봄' }[i.status] || i.status;
      lines.push(`- ${when} · ${i.title} (${how})`);
    }
  }
  lines.push('', '위를 보고, 지금 말할 만한 게 있으면 계약대로 JSON 하나만 출력해. 없으면 {"suggestions":[]}.');
  return lines.join('\n');
}

let child = null;
function runClaude(prompt, models) {
  return new Promise((resolve, reject) => {
    const main = process.env.BISU_PROACTIVE_MODEL || models?.dev || process.env.BISU_DEV_MODEL || 'deepseek/deepseek-v4.1-flash';
    const args = ['-f', path.join(root, 'launch.zsh'), main, models?.code || 'qwen/qwen3.8-max-0902', main,
      path.join(root, 'agents.json'), '-p', prompt, '--output-format', 'json'];
    const env = {
      ...process.env,
      // Its own system prompt, its own tools, no computer use: this run reads and answers, nothing more.
      BISU_PROMPT: path.join(root, 'prompt-suggest.md'),
      BISU_TOOLS: 'Read,Glob,Grep',
      BISU_CU: '0',
      BISU_EFFORT: '',
    };
    const proc = spawn('zsh', args, { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let out = '', err = '';
    const kill = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d });
    proc.stderr.on('data', d => { err = (err + d).slice(-2000) });
    proc.on('error', e => { clearTimeout(kill); child = null; reject(e) });
    proc.on('close', code => {
      clearTimeout(kill);
      child = null;
      if (code !== 0) {
        const why = err.split('\n').filter(l => l.trim() && !/connectors are disabled/.test(l)).slice(-2).join(' ') || `exit ${code}`;
        return reject(Error(why.trim()));
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) return reject(Error(clean(envelope.result, 200) || 'the model returned an error'));
        resolve(String(envelope.result ?? ''));
      } catch { reject(Error('the suggest run printed no json')) }
    });
  });
}

// The model answers with prose around the JSON often enough that both the fenced and the bare form
// have to work.
function extract(text) {
  const s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fence ? fence[1].trim() : s;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) throw Error('the suggest run did not answer with json');
  const j = JSON.parse(body.slice(a, b + 1));
  if (!Array.isArray(j.suggestions)) throw Error('the suggest run answered without a suggestions list');
  return j.suggestions;
}

const words = s => new Set(String(s).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean));
function alike(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return a.trim() === b.trim();
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common) >= 0.55;
}
// Rewording is what a model does when it is not told to hold back, so the action — the sentence it
// would actually run — is compared on its own, and only within the same project. Two suggestions
// about different folders are never the same suggestion.
function repeats(item) {
  return state.items.filter(i => i.kind !== 'job').slice(0, 20).some(old =>
    (!old.cwd || !item.cwd || old.cwd === item.cwd) &&
    (alike(item.action, old.action) || alike(item.title, old.title)));
}

// One suggestion is only kept if it is a real one, about a folder that exists, and not a re-run of
// something that was already said — dismissed ones included, which is the point of a secretary that
// you can say no to.
function worthwhile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clean(raw.title, 60), action = clean(raw.action, 300), body = clean(raw.body, 400);
  if (title.length < 4 || action.length < 8) return null;
  let cwd = typeof raw.cwd === 'string' && raw.cwd.startsWith('/') ? raw.cwd.replace(/\/+$/, '') : null;
  if (cwd && !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) cwd = null;
  const item = { id: randomUUID(), at: Date.now(), title, body, action, cwd, status: 'new', seen: false };
  if (repeats(item)) return null;
  return item;
}

async function ask(ctx) {
  const text = await runClaude(userPrompt(ctx), ctx.models);
  const raw = extract(text);
  const dropped = [];
  let added = 0;
  for (const candidate of raw.slice(0, 3)) {
    // Already counted as soon as it is unshifted, so this also stops a run that arrives with two.
    if (state.items.filter(i => i.status === 'new' && i.kind !== 'job').length >= MAX_WAITING) break;
    const item = worthwhile(candidate);
    if (!item) { dropped.push(clean(candidate?.title || '?', 40)); continue }
    state.items.unshift(item);
    added++;
  }
  state.items = state.items.slice(0, KEEP);
  return { added, dropped };
}

// The single entry point: the timer, the page and the menu all go through it, so nothing can start
// a second run while one is going.
export async function run({ reason = 'timer', force = false } = {}) {
  const why = due(Date.now(), force);
  if (why) return { skipped: why };
  const ctx = await contextFn().catch(() => ({}));
  // Nothing to spend: without a key the run would fail every ten minutes for no reason.
  if (ctx.key === false) return { skipped: 'nokey' };
  running = { at: Date.now(), reason };
  state.lastAttempt = Date.now();
  save();
  try {
    const result = await ask(ctx);
    state.lastRun = Date.now();
    state.lastError = null;
    running = null;
    save();
    return { ...result, reason };
  } catch (e) {
    state.lastError = String(e.message || e).slice(0, 300);
    running = null;
    save();
    return { error: state.lastError };
  }
}

let timer = null;
// Started by the engine. The first look waits a little, so opening bisu is never slowed down by it.
export function start() {
  if (timer || process.env.BISU_PROACTIVE === '0') return;
  const tick = () => { run().catch(() => {}) };
  setTimeout(tick, 45e3).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
export function stop() { clearInterval(timer); timer = null; try { child?.kill('SIGTERM') } catch {} }

// ---- command line ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'run') {
    // Typed by a person, so the clock and quiet hours do not apply — only a run that is going or a
    // queue that is already full.
    const out = await run({ reason: 'cli', force: true });
    if (out.error) process.stdout.write(`bisu: could not look around — ${out.error}\n`);
    else if (out.skipped) process.stdout.write(`bisu: not now (${out.skipped})\n`);
    else if (!out.added) process.stdout.write('bisu: nothing worth bringing up.\n');
    else {
      const it = snapshot().items[0];
      process.stdout.write(`\n${it.title}\n${it.body}\n\n  → ${it.action}${it.cwd ? `   (${it.cwd})` : ''}\n\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(snapshot(), null, 1) + '\n');
  }
}
