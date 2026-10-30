// What dec-intern does on a schedule.
//
// "매일 아침 8시에 어제 커밋 요약해 줘" is one file in ~/.config/dec-intern/jobs/: a few frontmatter lines
// (when, where, with which tools) and the request as the body, written by the assistant with the
// same Write tool and the same approval as a memory, or by hand. The engine reads the folder every
// minute, runs whatever is due as one short Claude Code run of its own, and leaves the answer as a
// card in the panel, where "이어서 대화" continues from that run's session.
//
// Deliberate limits:
//  * read-only tools unless the file says otherwise (`tools: edit` may change files in its folder,
//    `tools: full` may also run commands) — a job that can act is the person's explicit choice,
//    visible in the file, never the default. Such a job also waits for the person's approval in the
//    Settings tab, given for that exact file: anything that changes the file (an agent included)
//    takes the approval away again, so an agent can never write itself a job with more power;
//  * a job that can act needs its own folder: not the home folder and not anything that contains
//    Dec Intern's own settings, so it cannot rewrite its jobs or its memory;
//  * one job at a time, never two runs of the same job, and a job missed while the Mac was asleep
//    runs once when it wakes, not once per missed slot;
//  * a failed run leaves a card too, and waits for its next slot instead of retrying in a loop.
//
//   node jobs.mjs                 # every job, with its next run and last result
//   node jobs.mjs run <slug>      # one job now, printing what it answered
//   node jobs.mjs next "0 8 * * 1-5"   # when that schedule fires next
import './migrate.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import * as proactive from './proactive.mjs';
import * as routines from './routines.mjs';
import { holdsSchedule, releaseSchedule } from './lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
export const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dec-intern', 'jobs');
// DEC_INTERN_JOBS_STATE: another state file, so a trial run in a temporary XDG_CONFIG_HOME leaves the real one alone.
const STATE = process.env.DEC_INTERN_JOBS_STATE || path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern', 'jobs.json');
const TICK_MS = 60e3;
// What a job that may act can never have as its folder, or inside it: its own jobs and memory, Claude
// Code's settings (which would grant future runs anything), and Dec Intern's support files.
const PROTECTED = [path.dirname(DIR), path.join(os.homedir(), '.config', 'dec-intern'), path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern')];
const TOOLS = {
  read: 'Read,Glob,Grep,WebFetch,WebSearch',
  edit: '', // Claude Code's core set (launch.zsh), edits in the folder approved, commands refused
  full: '', // the same, and nothing is refused
};

// ---- cron ----

const NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function field(spec, min, max, what) {
  const out = new Set();
  const value = s => {
    if (/^[a-z]{3}$/i.test(s)) { const v = NAMES[s.toLowerCase()]; if (v === undefined) throw Error(`${what}: unknown name "${s}"`); return v }
    if (!/^\d+$/.test(s)) throw Error(`${what}: "${s}" is not a number`);
    return Number(s);
  };
  for (const part of String(spec).split(',')) {
    const m = /^(\*|[a-z]{3}|\d+)(?:-([a-z]{3}|\d+))?(?:\/(\d+))?$/i.exec(part.trim());
    if (!m) throw Error(`${what}: cannot read "${part}"`);
    let from = m[1] === '*' ? min : value(m[1]);
    let to = m[1] === '*' ? max : m[2] !== undefined ? value(m[2]) : m[3] ? max : from;
    const step = m[3] ? Number(m[3]) : 1;
    // 7 is Sunday as well as 0: "0-7" and "1-7" mean every day and Monday to Sunday.
    let sunday = false;
    if (what === 'weekday') { if (from === 7 && to === 7) from = to = 0; else if (to === 7) { to = 6; sunday = true } }
    if (step < 1) throw Error(`${what}: step must be at least 1`);
    if (from < min || to > max || from > to && !(what === 'weekday' && to === 0)) throw Error(`${what}: ${part} is outside ${min}-${max}`);
    if (what === 'weekday' && to === 0 && from > 0) { for (let v = from; v <= 6; v += step) out.add(v); out.add(0); continue } // e.g. fri-sun
    for (let v = from; v <= to; v += step) out.add(v);
    if (sunday) out.add(0);
  }
  return out;
}
export function parseCron(text) {
  const f = String(text || '').trim().split(/\s+/);
  if (f.length !== 5) throw Error('a schedule has five fields: minute hour day month weekday');
  return {
    min: field(f[0], 0, 59, 'minute'), hour: field(f[1], 0, 23, 'hour'), dom: field(f[2], 1, 31, 'day'),
    mon: field(f[3], 1, 12, 'month'), dow: field(f[4], 0, 6, 'weekday'), domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}
// `every: 5m` / `every: 2h`: shorthand for the cron it means (*/5 * * * *, 0 */2 * * *). Steps restart at
// each hour or day as cron's do, so a step that does not divide 60 (or 24) leaves a shorter gap at the turn.
export function parseEvery(text) {
  const m = /^(\d+)\s*(m|min|분|h|시간)$/i.exec(String(text || '').trim());
  const n = m ? Number(m[1]) : 0, hours = m && /^(h|시간)$/i.test(m[2]);
  if (!m || n < 1 || n > (hours ? 23 : 59)) throw Error('every: a number of minutes (5m, 1–59) or hours (2h, 1–23)');
  return hours ? `0 ${n === 1 ? '*' : `*/${n}`} * * *` : `${n === 1 ? '*' : `*/${n}`} * * * *`;
}
// The first minute strictly after `after` that the schedule names, in local time, or null when
// there is none within 400 days (31 Feb). Both day fields given means either, as cron has it.
export function nextRun(cron, after = Date.now()) {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 400 * 864e5;
  for (let guard = 0; guard < 200000 && d.getTime() <= limit; guard++) {
    if (!cron.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue }
    const dayOk = cron.domStar && cron.dowStar ? true
      : cron.domStar ? cron.dow.has(d.getDay())
      : cron.dowStar ? cron.dom.has(d.getDate())
      : cron.dom.has(d.getDate()) || cron.dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue }
    if (!cron.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue }
    if (!cron.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue }
    return d.getTime();
  }
  return null;
}
// "2026-10-28 09:00" (local), or anything Date can read.
function parseAt(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(text).trim());
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Date.parse(text);
  if (!Number.isFinite(t)) throw Error(`at: cannot read "${text}" (use 2026-10-28 09:00)`);
  return t;
}

// ---- the job files ----

// Any file name the folder can hold (Korean included), but never a path.
const slugOk = s => typeof s === 'string' && s.length > 0 && s.length <= 120 && !/[\/\\\0]/.test(s) && !s.startsWith('.');
const expand = p => p.replace(/^~(?=\/|$)/, os.homedir());

// One file → one job, or one job with an `error` the Settings tab shows instead of a next run.
function parseJob(file) {
  const slug = path.basename(file, '.md');
  let st = null, text = '';
  try { st = fs.statSync(file); text = fs.readFileSync(file, 'utf8') } catch (e) { return { slug, file, error: e.message } }
  const job = { slug, file, mtime: st.mtimeMs, hash: createHash('sha256').update(text).digest('hex'), name: slug, schedule: null, cron: null, at: null, cwd: os.homedir(), tools: 'read', enabled: true, awake: false, cu: false, bot: 'dec-intern', model: null, timeoutMin: 10, prompt: '', error: null };
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) throw Error('the file needs a frontmatter block (--- … ---) and the request below it');
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      // A value may be quoted, as YAML allows (name: "@someone 새 글"): the quotes are not part of it.
      const k = kv[1].toLowerCase(), v = kv[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
      if (k === 'name' && v) job.name = v.slice(0, 80);
      else if (k === 'schedule') { job.schedule = v; job.cron = parseCron(v) }
      else if (k === 'every') { job.cron = parseCron(parseEvery(v)); job.schedule = `every ${v}` }
      else if (k === 'at') { job.at = parseAt(v); job.schedule = v }
      else if (k === 'cwd' && v) job.cwd = expand(v);
      else if (k === 'tools') { if (!(v in TOOLS)) throw Error(`tools: "${v}" — use read, edit or full`); job.tools = v }
      else if (k === 'enabled') job.enabled = !/^(false|no|off|0)$/i.test(v);
      else if (k === 'awake') job.awake = /^(true|yes|on|1)$/i.test(v);
      // Computer use (cu_* tools: look at and press things in other apps), for jobs that watch another app.
      else if (k === 'cu') job.cu = /^(true|yes|on|1)$/i.test(v);
      // Which bot it runs as (ui/bots.mjs); a job without one belongs to the default bot.
      else if (k === 'bot' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v)) job.bot = v === 'bisu' ? 'dec-intern' : v;
      else if (k === 'routine' && routines.validSlug(v)) job.routine = v;
      else if (k === 'model' && v) job.model = v;
      else if (k === 'timeout') { const n = Number(v); if (Number.isFinite(n)) job.timeoutMin = Math.min(60, Math.max(1, n)) }
    }
    job.prompt = m[2].trim();
    // A job that runs a routine (ui/routines.mjs) asks for the routine's steps, read at each run; its approval
    // hash covers the routine's text too, so changing an edit/full routine needs a new approval.
    if (job.routine) {
      const r = routines.read(job.routine), text = routines.raw(job.routine);
      if (!r) throw Error(`routine: ${job.routine} does not exist`);
      // Pausing is not a change to what it does, so the paused line is left out of the hash.
      job.hash = createHash('sha256').update(text.replace(/^paused\s*:.*$/m, '') + '\n' + job.hash).digest('hex');
      job.routinePaused = r.paused;
      job.prompt = routines.prompt(r) + (job.prompt ? `\n\n${job.prompt}` : '');
    }
    if (!job.cron && !job.at) throw Error('needs a `schedule:` (cron, five fields), an `every:` (5m, 2h) or an `at:` (one time)');
    if (!job.prompt) throw Error('the request below the frontmatter is empty');
    if (!fs.statSync(job.cwd, { throwIfNoEntry: false })?.isDirectory()) throw Error(`cwd: ${job.cwd} is not a folder`);
    if (job.cu && job.tools !== 'full') throw Error('cu: true needs tools: full (it presses things in other apps)');
    if (job.tools !== 'read') {
      const cwd = path.resolve(job.cwd);
      const inside = (a, b) => a === b || a.startsWith(b + path.sep);
      if (cwd === os.homedir() || PROTECTED.some(d => inside(d, cwd) || inside(cwd, d)))
        throw Error(`tools: ${job.tools} needs its own project folder as cwd — not ${cwd === os.homedir() ? 'the home folder' : 'a folder that holds dec-intern\'s or Claude Code\'s settings'}`);
    }
  } catch (e) { job.error = String(e.message || e) }
  return job;
}

export function list() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort() } catch { return [] }
  return names.map(n => parseJob(path.join(DIR, n)));
}

// ---- state: what ran, when, how it went ----

// Re-read whenever the file changed under us: `node jobs.mjs run x` in a terminal and the engine
// both write it, and each used to overwrite the other with what it loaded at start.
let state = { runs: {}, approved: {}, awake: {} }, stateMtime = -1;
function fresh() {
  let m = -1;
  try { m = fs.statSync(STATE).mtimeMs } catch {}
  if (m === stateMtime) return;
  stateMtime = m;
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch {}
  state = s && typeof s === 'object' ? s : {};
  if (!state.runs || typeof state.runs !== 'object') state.runs = {};
  if (!state.approved || typeof state.approved !== 'object') state.approved = {};
  if (!state.awake || typeof state.awake !== 'object') state.awake = {};
}
fresh();
function save() {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE);
    stateMtime = fs.statSync(STATE).mtimeMs;
  } catch (e) { console.error('dec-intern jobs: cannot save:', e.message) }
}
// Read the latest state, change one job's record, write it back — with no await in between.
function record(slug, patch) { fresh(); Object.assign(runOf(slug), patch); save() }
const runOf = slug => state.runs[slug] || (state.runs[slug] = { lastRun: 0, lastAttempt: 0, lastError: null, lastResult: null, lastSession: null });

// A job that may change things runs only as the person approved it, byte for byte.
export const needsApproval = job => !job.error && job.tools !== 'read' && state.approved[job.slug] !== job.hash;

// When this job fires next: after its last run, or after the file was written if it never ran, so
// a job created at nine with "every day at eight" waits for tomorrow instead of firing at once.
export function nextAt(job, now = Date.now()) {
  if (job.error || !job.enabled || job.routinePaused || needsApproval(job)) return null;
  const r = runOf(job.slug);
  if (job.at) return r.lastRun >= job.at ? null : job.at;
  return nextRun(job.cron, Math.max(r.lastRun || 0, job.mtime || 0));
}

let running = null; // {slug, at}
let contextFn = async () => ({});
export function setContext(fn) { if (typeof fn === 'function') contextFn = fn }

export function snapshot() {
  fresh();
  const now = Date.now();
  return {
    dir: DIR,
    running: running ? { ...running } : null,
    jobs: list().map(j => {
      const r = runOf(j.slug);
      return { slug: j.slug, name: j.name, schedule: j.schedule, once: !!j.at, cwd: j.cwd, tools: j.tools, enabled: j.enabled, model: j.model, error: j.error, needsApproval: needsApproval(j), prompt: j.prompt.slice(0, 600),
        nextAt: nextAt(j, now), lastRun: r.lastRun || null, lastError: r.lastError, lastResult: r.lastResult, lastSession: r.lastSession, running: running?.slug === j.slug, awake: awakeOf(j), bot: j.bot, routine: j.routine || null };
    }),
  };
}

// ---- the run ----

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
let child = null;
function runClaude(job, models) {
  return new Promise((resolve, reject) => {
    const main = job.model || models?.main || process.env.DEC_INTERN_MODEL || 'z-ai/glm-5.3';
    const now = new Date().toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' });
    const prompt = `[예약 작업 "${job.name}" · ${job.schedule} · 지금 ${now} · 폴더 ${job.cwd}]\n\n${job.prompt}`;
    const args = ['-f', path.join(root, 'launch.zsh'), main, models?.code || process.env.DEC_INTERN_CODE_MODEL || 'qwen/qwen3.8-max-0902',
      models?.dev || process.env.DEC_INTERN_DEV_MODEL || 'deepseek/deepseek-v4.1-flash', path.join(root, 'agents.json'), '-p', prompt, '--output-format', 'json'];
    if (job.tools === 'edit') args.push('--permission-mode', 'acceptEdits');
    if (job.tools === 'full') args.push('--dangerously-skip-permissions');
    const env = { ...process.env, DEC_INTERN_PROMPT: path.join(root, 'prompt-job.md'), DEC_INTERN_CU: job.cu ? '1' : '0', DEC_INTERN_EFFORT: '', DEC_INTERN_BOT: job.bot || 'dec-intern' };
    if (TOOLS[job.tools]) env.DEC_INTERN_TOOLS = TOOLS[job.tools]; else delete env.DEC_INTERN_TOOLS;
    const proc = spawn('zsh', args, { cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let out = '', err = '';
    const kill = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, job.timeoutMin * 60e3);
    proc.stdout.on('data', d => { out += d });
    proc.stderr.on('data', d => { err = (err + d).slice(-2000) });
    proc.on('error', e => { clearTimeout(kill); child = null; reject(e) });
    proc.on('close', code => {
      clearTimeout(kill);
      child = null;
      let envelope = null;
      try { envelope = JSON.parse(out) } catch {}
      if (code !== 0 && !envelope) {
        const why = err.split('\n').filter(l => l.trim() && !/connectors are disabled/.test(l)).slice(-2).join(' ') || `exit ${code}`;
        return reject(Error(why.trim()));
      }
      if (!envelope) return reject(Error('the run printed no json'));
      if (envelope.is_error) return reject(Object.assign(Error(clean(envelope.result, 300) || 'the model returned an error'), { session: envelope.session_id }));
      resolve({ text: String(envelope.result ?? ''), session: envelope.session_id || null, cost: envelope.total_cost_usd });
    });
  });
}

// Runs one job now. `force` is the person asking (Settings, the shell): it ignores the schedule, but
// not a run that is already going.
export async function run(slug, { reason = 'timer', force = false } = {}) {
  fresh();
  const job = list().find(j => j.slug === slug);
  if (!job) throw Object.assign(Error(`no job "${slug}"`), { status: 404 });
  if (job.error) throw Object.assign(Error(`${job.slug}: ${job.error}`), { status: 400 });
  if (needsApproval(job)) return { skipped: 'approval' };
  if (running) return { skipped: 'running' };
  if (!force && !job.enabled) return { skipped: 'off' };
  // Taken before the first await: a second click, or the clock ticking while the context is being
  // gathered, must already see this run.
  running = { slug: job.slug, at: Date.now(), reason };
  const ctx = await contextFn().catch(() => ({}));
  if (ctx.key === false) { running = null; return { skipped: 'nokey' } }
  record(job.slug, { lastAttempt: Date.now() });
  const card = { id: randomUUID(), at: Date.now(), kind: 'job', job: job.slug, title: job.name, cwd: job.cwd, status: 'new', seen: false };
  try {
    const out = await runClaude(job, ctx.models);
    const { body, done, quiet } = markers(out.text);
    record(job.slug, { lastRun: Date.now(), lastError: null, lastSession: out.session, lastResult: clean(body, 200) || (quiet ? '(조용)' : '') });
    running = null;
    if (done) finish(job);
    if (!quiet || done) {
      proactive.push({ ...card, title: done ? `${job.name} — 끝` : job.name, body: body.slice(0, 2000), sessionId: out.session });
      notify(done ? `${job.name} — 끝` : job.name, body);
    }
    return { ok: true, text: out.text, session: out.session, cost: out.cost, done, quiet };
  } catch (e) {
    // A failure counts as the run: the next slot is the next try, and the card says what happened.
    const why = String(e.message || e).slice(0, 300);
    record(job.slug, { lastRun: Date.now(), lastError: why, lastSession: e.session || null });
    running = null;
    proactive.push({ ...card, title: `${job.name} — 실패`, body: why, sessionId: e.session || null, error: why });
    notify(`${job.name} — 실패`, why);
    return { error: why };
  }
}

// What a run may end its answer with (prompt-job.md): [끝] — the job is finished and retires itself;
// [조용] — nothing worth telling, so no card and no notification. Either on a line of its own.
export function markers(text) {
  let t = String(text ?? '');
  const done = /^\s*\[(끝|DONE)\]\s*$/mi.test(t), quiet = /^\s*\[(조용|QUIET)\]\s*$/mi.test(t);
  t = t.replace(/^\s*\[(끝|DONE|조용|QUIET)\]\s*$/gmi, '').trim();
  return { body: t, done, quiet: quiet && !done };
}
// A finished job is moved to jobs/.done/, never deleted: the file is the person's.
function finish(job) {
  try {
    const dir = path.join(DIR, '.done');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(job.file, path.join(dir, `${job.slug}.${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`));
    fresh(); delete state.approved[job.slug]; save();
  } catch (e) { console.error('dec-intern jobs: cannot retire', job.slug, e.message) }
}
// A macOS notification (Notification Center banner, no dialog). DEC_INTERN_NOTIFY=0 turns it off.
export function notify(title, body) {
  if (process.env.DEC_INTERN_NOTIFY === '0' || process.platform !== 'darwin') return;
  const q = s => JSON.stringify(String(s).replace(/\s+/g, ' ').trim().slice(0, 180));
  execFile('/usr/bin/osascript', ['-e', `display notification ${q(body || ' ')} with title "Dec Intern" subtitle ${q(title)}`], () => {});
}

// Enabling, disabling and deleting edit the person's file, since the file is the job.
export function setEnabled(slug, on) {
  const job = list().find(j => j.slug === slug);
  if (!job) throw Object.assign(Error(`no job "${slug}"`), { status: 404 });
  let text = fs.readFileSync(job.file, 'utf8');
  const line = `enabled: ${on ? 'true' : 'false'}`;
  if (/^enabled\s*:.*$/m.test(text)) text = text.replace(/^enabled\s*:.*$/m, line);
  else text = text.replace(/^---\r?\n/, `---\n${line}\n`);
  fs.writeFileSync(job.file, text);
  return snapshot();
}
// 「실행 중엔 맥 깨어 있게」: kept in the state file, not the job file, so switching it does not change the
// file and with it the approval. `awake: true` in the file's frontmatter turns it on too.
function awakeOf(job) { return state.awake[job.slug] ?? !!job.awake }
export function setAwake(slug, on) {
  fresh();
  const job = list().find(j => j.slug === slug);
  if (!job) throw Object.assign(Error(`no job "${slug}"`), { status: 404 });
  state.awake[job.slug] = !!on;
  save();
  return snapshot();
}
// The running job, and whether it asked to keep the Mac awake while it runs (ui/alerts.mjs asks).
export function runningAwake() {
  if (!running) return null;
  const job = list().find(j => j.slug === running.slug);
  return { slug: running.slug, name: job?.name || running.slug, awake: !!(job && awakeOf(job)) };
}
export function approve(slug) {
  fresh();
  const job = list().find(j => j.slug === slug);
  if (!job) throw Object.assign(Error(`no job "${slug}"`), { status: 404 });
  if (job.error) throw Object.assign(Error(`${job.slug}: ${job.error}`), { status: 400 });
  state.approved[job.slug] = job.hash;
  save();
  return snapshot();
}
export function remove(slug) {
  if (!slugOk(slug)) throw Object.assign(Error('bad job name'), { status: 400 });
  const file = path.join(DIR, `${slug}.md`);
  if (!fs.existsSync(file)) throw Object.assign(Error(`no job "${slug}"`), { status: 404 });
  fs.unlinkSync(file);
  fresh();
  delete state.runs[slug];
  delete state.approved[slug];
  save();
  return snapshot();
}

// ---- the clock ----

async function tick() {
  if (running || !holdsSchedule()) return;
  fresh();
  const now = Date.now();
  for (const job of list()) {
    const at = nextAt(job, now);
    if (at === null || at > now) continue;
    await run(job.slug, { reason: 'timer' }).catch(e => console.error('dec-intern jobs:', e.message));
    return; // one per tick: the next due job goes a minute later
  }
}
let timer = null;
export function start() {
  if (timer || process.env.DEC_INTERN_JOBS === '0') return;
  setTimeout(() => { tick().catch(() => {}) }, 20e3).unref?.();
  timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS);
  timer.unref?.();
}
export function stop() { clearInterval(timer); timer = null; try { child?.kill('SIGTERM') } catch {} releaseSchedule() }

// ---- command line ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2);
  const when = t => t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  if (mode === 'run' && arg) {
    const out = await run(arg, { reason: 'cli', force: true });
    if (out.error) process.stdout.write(`dec-intern: ${arg} failed — ${out.error}\n`);
    else if (out.skipped === 'approval') process.stdout.write(`dec-intern: ${arg} may change things and waits for approval in Settings (dec-intern ui)\n`);
    else if (out.skipped) process.stdout.write(`dec-intern: not now (${out.skipped})\n`);
    else process.stdout.write(`${out.text.trim()}\n\n(session ${out.session}${out.cost ? `, $${out.cost.toFixed(4)}` : ''})\n`);
  } else if (mode === 'tick') {
    // One look at the schedule, for launchd (`agent install`): runs only while no engine holds the schedule.
    // launchd starts it bare every minute; only when a job is due does it start again through dec-secret,
    // which turns the dec:// names into one-time tokens. Most minutes nothing runs and nothing is logged.
    const secret = process.env.DEC_INTERN_DEC_SECRET;
    if (secret && /^dec:\/\//.test(process.env.OPENROUTER_API_KEY || '')) {
      const now = Date.now();
      const due = !running && holdsSchedule() && (fresh(), list().some(j => { const at = nextAt(j, now); return at !== null && at <= now }));
      releaseSchedule();
      if (due) {
        const p = spawn(process.execPath, [secret, 'run', '--', process.execPath, fileURLToPath(import.meta.url), 'tick'], { stdio: 'inherit', env: { ...process.env, DEC_INTERN_DEC_SECRET: '' } });
        process.exitCode = await new Promise(res => p.on('close', c => res(c ?? 1)));
      }
    } else {
      try { await tick() } finally { releaseSchedule() }
    }
  } else if (mode === 'agent') {
    process.stdout.write(agent(arg) + '\n');
  } else if (mode === 'next' && arg) {
    const t = nextRun(parseCron(arg));
    process.stdout.write(`${t ? new Date(t).toString() : 'never'}\n`);
  } else {
    const s = snapshot();
    if (!s.jobs.length) process.stdout.write(`no jobs in ${s.dir}\n`);
    for (const j of s.jobs) {
      process.stdout.write(`${j.slug}  ${j.name}  [${j.schedule}${j.once ? ', once' : ''}]  ${j.tools}  ${j.enabled ? '' : '(off) '}${j.error ? `ERROR: ${j.error}` : j.needsApproval ? 'waits for approval in Settings' : `next ${when(j.nextAt)}`}\n`);
      if (j.lastRun) process.stdout.write(`    last ${when(j.lastRun)}: ${j.lastError ? `failed — ${j.lastError}` : j.lastResult || 'ok'}\n`);
    }
  }
}

// launchd: the schedule keeps running when the menu bar app is closed. Every minute launchd runs
// `jobs.mjs tick`, which goes through dec-secret (keys by name only) when a job is due; while the app
// or `dec-intern ui` is open, the scheduler lock is theirs and the tick does nothing.
function agent(cmd) {
  const label = 'local.dec.intern.jobs', plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const uid = process.getuid(), run = (...a) => { try { return require_('child_process').execFileSync('/bin/launchctl', a, { encoding: 'utf8', stdio: 'pipe' }) } catch (e) { return String(e.stderr || e.message) } };
  if (cmd === 'remove') { run('bootout', `gui/${uid}/${label}`); try { fs.unlinkSync(plist) } catch {} return 'removed' }
  if (cmd !== 'install') return /state = running|last exit code/.test(run('print', `gui/${uid}/${label}`)) ? `installed (${plist})` : 'not installed';
  const node = fs.realpathSync(process.execPath);
  const secret = [path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern', 'dec', 'sdk', 'dec-secret.mjs'), path.join(os.homedir(), 'Desktop', 'dec-browser-workbench', 'sdk', 'dec-secret.mjs')].find(f => fs.existsSync(f));
  const args = [node, fileURLToPath(import.meta.url), 'tick'];
  const logf = path.join(os.homedir(), 'Library', 'Logs', 'dec-intern-jobs.log');
  const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const PATHS = [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  // Keys by name only, as the app passes them (mac/main.cjs): dec-secret swaps each dec:// for a one-time
  // token. OpenAI only when dec holds it (computer use's decision model); a missing name stops dec-secret.
  const env = { PATH: PATHS };
  if (secret) {
    env.DEC_INTERN_DEC_SECRET = secret;
    env.OPENROUTER_API_KEY = 'dec://OPENROUTER_API_KEY';
    let names = '';
    try { names = require_('child_process').execFileSync(node, [secret, 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 6000 }) } catch {}
    if (/dec:\/\/OPENAI_API_KEY\b/.test(names)) env.OPENAI_API_KEY = 'dec://OPENAI_API_KEY';
  }
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${x(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${x(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${x(v)}</string>`).join('')}</dict>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${x(logf)}</string><key>StandardErrorPath</key><string>${x(logf)}</string>
</dict></plist>
`);
  run('bootout', `gui/${uid}/${label}`);
  const out = run('bootstrap', `gui/${uid}`, plist);
  return out.trim() ? `launchctl: ${out.trim()}` : `installed (${plist})`;
}
