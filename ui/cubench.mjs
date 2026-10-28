// The computer-use benchmark (engine/eval/cu-bench.mjs), run from Settings rather than a terminal:
// it inherits the engine's keys and, being bisu's own child, bisu's Accessibility grant.
//
// One run at a time. "check" and "dry" start at once; a real run waits a little first, so whoever
// pressed the button can step away before the mouse starts moving. Its output is kept for the page,
// and its results are read back from the file it writes, which stays in bisu's support folder so the
// last run is still there after a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const BENCH = () => process.env.BISU_CU_BENCH || path.join(root, 'engine', 'eval', 'cu-bench.mjs');
const DIR = process.env.BISU_CU_BENCH_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'cu-bench');
const MODES = new Set(['check', 'dry', 'run']);
const MODELS = new Set(['glm-5.3', 'glm-5.3-flash']);
const LOG_KEEP = 400;

let run = null; // {mode, repeat, models, startsAt, startedAt, endedAt, exit, log, out, child, timer, stopped}

const rowsOf = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } };
// The newest results file, for a page opened after bisu restarted.
function lastFile() {
  try { return fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort().map(f => path.join(DIR, f)).pop() || null } catch { return null }
}

export function snapshot() {
  const out = run?.out || lastFile();
  return {
    available: fs.existsSync(BENCH()),
    state: !run ? 'idle' : run.startedAt == null && run.exit == null ? 'waiting' : run.exit == null ? 'running' : 'done',
    mode: run?.mode || (out ? 'run' : null), repeat: run?.repeat ?? null, models: run?.models ?? null,
    startsAt: run?.startsAt ?? null, startedAt: run?.startedAt ?? null, endedAt: run?.endedAt ?? (out && !run ? fs.statSync(out).mtimeMs : null),
    exit: run?.exit ?? null, stopped: !!run?.stopped,
    log: run ? run.log.slice(-LOG_KEEP) : [],
    rows: out && (run?.mode ?? 'run') === 'run' ? rowsOf(out) : [],
  };
}

export function start({ mode = 'check', repeat = 2, models = 'glm-5.3', delaySec } = {}) {
  if (run && run.exit == null) throw Object.assign(Error('이미 하고 있어요. 끝나거나 멈춘 뒤에 다시 눌러 주세요.'), { status: 409 });
  if (!MODES.has(mode)) throw Object.assign(Error('bad mode'), { status: 400 });
  if (!fs.existsSync(BENCH())) throw Object.assign(Error('이 bisu에는 시험이 들어 있지 않아요. 앱을 다시 설치해 주세요.'), { status: 404 });
  const list = String(models).split(',').filter(m => MODELS.has(m));
  const n = Math.min(3, Math.max(1, Math.round(Number(repeat) || 2)));
  const wait = mode === 'run' ? Math.min(300, Math.max(0, Number(delaySec ?? 30))) : 0;
  run = { mode, repeat: mode === 'run' ? n : null, models: mode === 'run' ? (list.length ? list : ['glm-5.3']) : null,
    startsAt: Date.now() + wait * 1e3, startedAt: null, endedAt: null, exit: null, log: [], out: null, child: null, timer: null, stopped: false };
  const go = () => {
    const r = run;
    r.startedAt = Date.now();
    const args = [BENCH()];
    if (mode === 'check') args.push('--check');
    else if (mode === 'dry') args.push('--dry');
    else {
      fs.mkdirSync(DIR, { recursive: true });
      r.out = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      args.push('--repeat', String(r.repeat), '--models', r.models.join(','), '--out', r.out);
    }
    const child = r.child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = buf => { for (const line of String(buf).split('\n')) if (line.trim()) { r.log.push(line); if (r.log.length > LOG_KEEP * 2) r.log.splice(0, LOG_KEEP) } };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', e => { take(e.message); r.exit = -1; r.endedAt = Date.now() });
    child.on('close', code => { r.exit = code ?? -1; r.endedAt = Date.now() });
  };
  if (wait) run.timer = setTimeout(go, wait * 1e3); else go();
  return snapshot();
}

// Waiting: cancelled. Running: the bench puts the task in progress back and stops.
export function stop() {
  if (!run || run.exit != null) return snapshot();
  run.stopped = true;
  if (run.startedAt == null) { clearTimeout(run.timer); run.exit = 0; run.endedAt = Date.now() }
  else try { run.child.kill('SIGINT') } catch {}
  return snapshot();
}
// The engine is going away: do not leave the screen to an orphan.
export function shutdown() { if (run?.child && run.exit == null) try { run.child.kill('SIGTERM') } catch {} }
