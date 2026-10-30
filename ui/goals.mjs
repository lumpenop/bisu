// Goals: what the person wants done over days or weeks ("이번 달 안에 블로그 글 세 편", "출장 준비 챙겨 줘"),
// which dec-intern works on a little at a time, by itself, the way Muse keeps a Goals tab.
//
// A goal is one JSON file in ~/.config/dec-intern/goals/: what it is, what done looks like, the plan (a few
// steps with their state), notes, a log of what each session did, and the person's answers. Every few
// hours (outside the quiet hours of 먼저 찾아오기) the engine gives it one short run of Dec Intern's own
// engine with prompt-goal.md: plan it if there is no plan yet, do the next step that can be done now,
// and write down what happened with goal_update. When a run needs the person — a decision, something
// only they know — it leaves a question: the goal waits, and the question goes to the panel, the
// Mac's banners and Telegram (a reply there answers it).
//
// Deliberate limits: a goal run reads (files in its folder, the web, the calendar), adds events and
// reminders, and writes only into the goal itself (plan, notes, log). It never edits files, runs
// commands or deletes anything, so it needs no approval; one run at a time; nothing in quiet hours.
// It runs on whichever engine the chats use: Claude Code reaches the same tools through Dec Intern's MCP server.
//
//   node goals.mjs                 # every goal with its state
//   node goals.mjs run <id>        # one session now, printing what it did
import './migrate.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
export const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dec-intern', 'goals');
const TICK_MS = 60e3;
const RUN_MIN = 15;
// What a goal run may use: looking (files in its folder, the web, the calendar), adding events and
// reminders, and its own goal. Dec Intern's own engine takes them by name; Claude Code gets the read tools
// here and the rest from Dec Intern's MCP server, which launch.zsh narrows to this list when DEC_INTERN_GOAL_ID is set.
export const RUN_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch,calendar_list,calendar_add,reminders_list,reminder_add,reminder_change,goal_update';
const CLAUDE_TOOLS = 'Read,Glob,Grep,WebFetch';
const STATUS = ['active', 'waiting', 'paused', 'done'];
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n) + '…' : s };
const expand = p => path.resolve(String(p || '').replace(/^~(?=\/|$)/, os.homedir()) || os.homedir());

// ---- the files ----
const idOk = id => /^g-[0-9a-f]{6}$/.test(String(id || ''));
const fileOf = id => path.join(DIR, `${id}.json`);
export function read(id) {
  if (!idOk(id)) return null;
  try { return normal(JSON.parse(fs.readFileSync(fileOf(id), 'utf8'))) } catch { return null }
}
function normal(g) {
  return { id: g.id, title: String(g.title || '목표'), detail: String(g.detail || ''), due: g.due || null, cwd: g.cwd || os.homedir(),
    every: Number.isFinite(g.every) ? g.every : 6, status: STATUS.includes(g.status) ? g.status : 'active', created: g.created || Date.now(),
    steps: Array.isArray(g.steps) ? g.steps : [], notes: String(g.notes || ''), log: Array.isArray(g.log) ? g.log : [],
    question: g.question || null, answers: Array.isArray(g.answers) ? g.answers : [], nextAt: g.nextAt ?? 0,
    lastRun: g.lastRun || 0, lastError: g.lastError || null, lastSession: g.lastSession || null, updatedAt: g.updatedAt || 0, doneAt: g.doneAt || 0 };
}
function write(g) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = fileOf(g.id) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(g, null, 1));
  fs.renameSync(tmp, fileOf(g.id));
  return g;
}
export function all() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter(f => /^g-[0-9a-f]{6}\.json$/.test(f)) } catch {}
  const order = { waiting: 0, active: 1, paused: 2, done: 3 };
  return names.map(f => read(f.slice(0, -5))).filter(Boolean).sort((a, b) => order[a.status] - order[b.status] || b.created - a.created);
}
export function create({ title, detail = '', due = null, cwd = '', every = 6 } = {}) {
  const t = clip(title, 80);
  if (!t) throw Object.assign(Error('목표를 한 줄로 적어 주세요'), { status: 400 });
  const dir = expand(cwd);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(Error(`폴더가 없어요: ${dir}`), { status: 400 });
  const d = due && /^\d{4}-\d{2}-\d{2}$/.test(String(due)) ? String(due) : null;
  const g = normal({ id: 'g-' + randomBytes(3).toString('hex'), title: t, detail: clip(detail, 1000), due: d, cwd: dir,
    every: Math.min(72, Math.max(1, Number(every) || 6)), status: 'active', created: Date.now(), nextAt: 0 });
  return write(g);
}

// What a run (goal_update) may change. Called inside Dec Intern's engine, so it only writes the file; the
// engine that started the run sees the change when the run ends.
const MARKS = { x: 'done', X: 'done', '~': 'doing', '!': 'blocked', ' ': 'todo', '': 'todo' };
// The plan as a model sends it: an array of {text, status}, that array as a JSON string, or plain lines
// ("1. [x] 항공권 비교 — 피치 21만 원"), which weaker tool callers manage more reliably.
export function readSteps(steps) {
  if (typeof steps === 'string') {
    const t = steps.trim();
    if (t.startsWith('[')) { try { return readSteps(JSON.parse(t)) } catch {} }
    return t.split('\n').map(l => /^\s*(?:[-*]|\d+[.)])?\s*(?:\[(.?)\]\s*)?(.+?)\s*$/.exec(l)).filter(m => m && m[2])
      .map(m => { const [text, note] = m[2].split(/\s+[—–]\s+/); return { text, status: MARKS[m[1] ?? ''] || 'todo', ...(note ? { note } : {}) } });
  }
  return Array.isArray(steps) ? steps : null;
}
export function applyUpdate(id, { steps, log, notes, question, done, next_hours } = {}) {
  const g = read(id);
  if (!g) throw Error(`no goal ${id}`);
  const did = [];
  steps = readSteps(steps);
  if (Array.isArray(steps) && steps.length) {
    g.steps = steps.slice(0, 12).map(s => ({ text: clip(s?.text ?? s, 200), status: ['todo', 'doing', 'done', 'blocked'].includes(s?.status) ? s.status : 'todo', ...(s?.note ? { note: clip(s.note, 300) } : {}) })).filter(s => s.text);
    did.push(`plan: ${g.steps.filter(s => s.status === 'done').length}/${g.steps.length} done`);
  }
  if (log) { g.log.push({ at: Date.now(), text: clip(log, 500) }); g.log = g.log.slice(-40); did.push('log') }
  if (typeof notes === 'string') { g.notes = clip(notes, 8000); did.push('notes') }
  if (question) { g.question = { text: clip(question, 500), at: Date.now() }; g.status = 'waiting'; did.push('question (the goal now waits for them)') }
  if (done) { g.status = 'done'; g.doneAt = Date.now(); g.question = null; did.push('done') }
  next_hours = Number(next_hours);
  if (!did.length && !(Number.isFinite(next_hours) && next_hours > 0)) throw Error('Nothing was saved: id alone changes nothing. Send the fields to save, for example {"id": "' + id + '", "steps": "1. [x] 항공권 비교\\n2. [ ] 숙소 후보 3곳", "log": "항공권 3개 비교함", "notes": "- 피치 21만 원 (출처 …)"} — and "question" when you need the person, "done": true when it is reached.');
  if (Number.isFinite(next_hours) && next_hours > 0) { g.nextAt = Date.now() + Math.min(72, Math.max(1, next_hours)) * 3600e3; did.push(`next session in ${Math.min(72, Math.max(1, next_hours))}h`) }
  g.updatedAt = Date.now();
  write(g);
  return did;
}

// ---- the person ----
export function answer(id, text) {
  const g = read(id);
  if (!g) throw Object.assign(Error('그런 목표가 없어요'), { status: 404 });
  const a = clip(text, 1000);
  if (!a) throw Object.assign(Error('답이 비어 있어요'), { status: 400 });
  g.answers.push({ q: g.question?.text || null, a, at: Date.now() }); g.answers = g.answers.slice(-20);
  g.question = null;
  if (g.status === 'waiting') g.status = 'active';
  g.nextAt = 0;   // the next tick takes it up
  return write(g);
}
export function setStatus(id, status) {
  const g = read(id);
  if (!g) throw Object.assign(Error('그런 목표가 없어요'), { status: 404 });
  if (status === 'paused') g.status = 'paused';
  else if (status === 'active') { g.status = g.question ? 'waiting' : 'active'; if (g.doneAt && !g.question) g.doneAt = 0; g.nextAt = 0 }
  return write(g);
}
export function remove(id) {
  if (!read(id)) throw Object.assign(Error('그런 목표가 없어요'), { status: 404 });
  fs.unlinkSync(fileOf(id));
}

// ---- a session ----
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const when = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}` };
export function brief(g, now = new Date()) {
  // Calendar days, the way people count them: due tomorrow is "1일 남음" at any hour today.
  const left = g.due ? Math.round((new Date(g.due + 'T00:00') - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5) : null;
  const MARK = { todo: ' ', doing: '~', done: 'x', blocked: '!' };
  return [
    `[목표 ${g.id} · 지금 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${WD[now.getDay()]}) ${pad(now.getHours())}:${pad(now.getMinutes())} · 폴더 ${g.cwd}]`,
    `목표: ${g.title}`,
    g.detail && `다 되면: ${g.detail}`,
    g.due && `기한: ${g.due}${left != null ? (left >= 0 ? ` (${left}일 남음)` : ` (${-left}일 지남)`) : ''}`,
    `계획: ${g.steps.length ? '\n' + g.steps.map((s, i) => `${i + 1}. [${MARK[s.status] || ' '}] ${s.text}${s.note ? ` — ${s.note}` : ''}`).join('\n') : '(아직 없음 — 먼저 계획을 세워)'}`,
    g.notes && `메모:\n${clip(g.notes, 3000)}`,
    g.log.length && `지난 기록:\n${g.log.slice(-8).map(l => `- ${when(l.at)} ${l.text}`).join('\n')}`,
    g.answers.length && `사람의 답:\n${g.answers.slice(-5).map(a => `- ${a.q ? `Q: ${a.q} → ` : ''}A: ${a.a}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

let running = null, child = null, quietFn = () => false;
const listeners = new Set();
export function onGoal(fn) { listeners.add(fn) }
const tell = (kind, g) => { for (const fn of listeners) { try { fn(kind, g) } catch {} } };
export function setQuiet(fn) { if (typeof fn === 'function') quietFn = fn }
// The models the person chose for each role, as jobs get them.
let contextFn = async () => ({});
export function setContext(fn) { if (typeof fn === 'function') contextFn = fn }

function runEngine(g, models) {
  return new Promise((resolve, reject) => {
    const args = ['-f', path.join(root, 'launch.zsh'), models?.main || 'z-ai/glm-5.3', models?.code || 'qwen/qwen3.8-max-0902', models?.dev || 'deepseek/deepseek-v4.1-flash', path.join(root, 'agents.json'),
      '-p', brief(g), '--output-format', 'json'];
    // The engine the chats use (Settings → 엔진): both have the goal tools.
    const native = process.env.DEC_INTERN_ENGINE === 'native';
    const env = { ...process.env, DEC_INTERN_PROMPT: path.join(root, 'prompt-goal.md'), DEC_INTERN_TOOLS: native ? RUN_TOOLS : CLAUDE_TOOLS, DEC_INTERN_CU: '0', DEC_INTERN_GOAL_ID: g.id };
    const proc = spawn('zsh', args, { cwd: g.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let out = '', err = '';
    const kill = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, RUN_MIN * 60e3);
    proc.stdout.on('data', d => { out += d });
    proc.stderr.on('data', d => { err = (err + d).slice(-2000) });
    proc.on('error', e => { clearTimeout(kill); child = null; reject(e) });
    proc.on('close', code => {
      clearTimeout(kill); child = null;
      let j = null; try { j = JSON.parse(out) } catch {}
      if (!j) return reject(Error(err.split('\n').filter(l => l.trim()).slice(-2).join(' ') || `exit ${code}`));
      if (j.is_error) return reject(Object.assign(Error(clip(j.result, 300) || 'the model returned an error'), { session: j.session_id }));
      resolve({ text: String(j.result ?? ''), session: j.session_id || null, cost: j.total_cost_usd });
    });
  });
}

// One session of work on a goal. `force` is the person pressing 「지금 진행」.
export async function run(id, { force = false } = {}) {
  const g0 = read(id);
  if (!g0) throw Object.assign(Error('그런 목표가 없어요'), { status: 404 });
  if (running) return { skipped: 'running' };
  if (!force && g0.status !== 'active') return { skipped: g0.status };
  if (g0.status === 'done' || g0.status === 'waiting' && !force) return { skipped: g0.status };
  running = { id, at: Date.now() };
  const t0 = Date.now(), hadQuestion = g0.question?.at || 0;
  try {
    const ctx = await contextFn().catch(() => ({}));
    const r = await runEngine(g0, ctx.models).catch(e => ({ error: e }));
    const g = read(id) || g0;
    g.lastRun = Date.now(); g.lastSession = r.session || r.error?.session || g.lastSession;
    if (r.error) g.lastError = clip(r.error.message, 300);
    else if (g.updatedAt < t0) { g.lastError = '이번엔 진행 기록을 남기지 못했어요'; g.log.push({ at: Date.now(), text: clip(r.text, 300) || '(기록 없음)' }) }
    else g.lastError = null;
    // The run says when to look again; otherwise the goal's own pace, out of quiet hours.
    if (!(g.nextAt > Date.now())) g.nextAt = Date.now() + g.every * 3600e3;
    write(g);
    if (g.status === 'done' && g0.status !== 'done') tell('done', g);
    else if (g.question && g.question.at !== hadQuestion) tell('question', g);
    else if (r.error) tell('error', g);
    return { ok: !r.error, text: r.text || r.error?.message, goal: g };
  } finally { running = null }
}

export function snapshot() { return { dir: DIR, running: running ? { ...running } : null, goals: all() } }

async function tick() {
  if (running || quietFn()) return;
  const now = Date.now();
  const g = all().find(x => x.status === 'active' && (x.nextAt || 0) <= now);
  if (g) await run(g.id).catch(e => console.error('dec-intern goals:', e.message));
}
let timer = null;
export function start(holds = () => true) {
  if (timer || process.env.DEC_INTERN_GOALS === '0') return;
  timer = setInterval(() => { if (holds()) tick() }, TICK_MS);
  timer.unref?.();
}
export function stop() { clearInterval(timer); timer = null; try { child?.kill('SIGTERM') } catch {} }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'run') process.stdout.write(JSON.stringify(await run(process.argv[3], { force: true }), null, 1) + '\n');
  else for (const g of all()) process.stdout.write(`${g.id} · ${g.status} · ${g.title} · ${g.steps.filter(s => s.status === 'done').length}/${g.steps.length}\n`);
}
