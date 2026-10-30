// Dec Intern checks itself: the offline checks, the bench of everyday tasks, the route judgments and the web holdout,
// against the last numbers it accepted (engine/eval/baseline.json). Prints a Korean report and writes the run to
// ~/Library/Application Support/dec-intern/self-check/<date>.json. Nothing is changed; the self-improvement job
// (docs/jobs/self-check.md) reads the report and decides what to fix.
//
//   OPENAI_API_KEY=dec://OPENAI_API_KEY OPENROUTER_API_KEY=dec://OPENROUTER_API_KEY GLM_VIA=openrouter dec-secret run -- \
//     node engine/eval/self-check.mjs [--quick] [--no-web] [--repeat 1]
//
// --quick runs bench tasks 1-8 only (a minute); the full run is the 38 tasks (ten minutes or so, under a dollar).
// Exit code 0 when everything is at or above the baseline, 1 when something is below it or failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = k => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : d };
const QUICK = flag('quick'), NO_WEB = flag('no-web'), REPEAT = arg('repeat', '1'), STATE_ONLY = flag('state');
const OUT = path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern', 'self-check');
const BASELINE = path.join(here, 'baseline.json');
const MODEL = 'routed:glm-5.3/glm-5.3-flash';

// The offline checks bring their own pretend keys and servers: the real ones (tokens, base urls, the key order) stay out.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_BASE_URL|_TOKEN)$|^DEC_INTERN_(RK\d+_|ROUTE_KEYS|ROUTES_FILE|ROUTE_HEALTH)|^GLM_VIA$/.test(k)));
const run = (args, {timeoutMs = 20 * 60_000, clean = false} = {}) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, env: clean ? cleanEnv() : process.env});
  return {code: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT'};
};
const jsonl = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } };
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;

const report = {at: new Date().toISOString(), quick: QUICK, stateOnly: STATE_ONLY, state: null, checks: {}, bench: null, route: null, web: null, below: [], failures: []};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-intern-self-check-'));

// 0. The app as it runs: the installed copy against the repository, the last day of its log, dec, launchd, the
// scheduled jobs' last errors, and whether the repository is clean. (--state: only this, in seconds, no model.)
async function appState() {
  const st = {installed: null, stale: [], logErrors: [], dec: null, launchd: null, jobErrors: [], git: null};
  const app = path.join(os.homedir(), 'Applications', 'Dec Intern.app', 'Contents', 'Resources', 'app');
  st.installed = fs.existsSync(app) ? app : null;
  if (st.installed) {
    const walk = (dir, rel = '') => { let out = []; for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.name === 'eval' || e.name === 'fonts' || e.name === 'node_modules') continue; out = out.concat(e.isDirectory() ? walk(path.join(dir, e.name), r) : [r]) } return out };
    const files = [...walk(path.join(root, 'ui'), 'ui'), ...walk(path.join(root, 'engine'), 'engine'), 'launch.zsh', 'agents.json', 'prompt.md', 'prompt-suggest.md', 'prompt-job.md', 'prompt-goal.md'];
    for (const f of files) { try { if (fs.readFileSync(path.join(root, f), 'utf8') !== fs.readFileSync(path.join(app, f), 'utf8')) st.stale.push(f) } catch { st.stale.push(f + ' (not in the app)') } }
  }
  try {
    const log = fs.readFileSync(path.join(os.homedir(), 'Library', 'Logs', 'dec-intern', 'dec-intern.log'), 'utf8').split('\n');
    const since = Date.now() - 24 * 3600_000;
    st.logErrors = log.filter(l => { const t = Date.parse(l.slice(0, 20)); return t > since && /error|failed|could not|멈췄|exit [1-9]/i.test(l) && !/self-check/.test(l) }).slice(-20).map(l => l.slice(0, 200));
  } catch {}
  try { const dec = await import('../dec.mjs'); const h = await dec.health(); st.dec = {endpoint: h.endpoint, paired: h.paired, fastMode: h.fastMode, tabs: h.tabs} } catch (e) { st.dec = {error: e.message} }
  try { const r = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/local.dec.intern.jobs`], {encoding: 'utf8'}); st.launchd = r.status !== 0 ? '등록 안 됨' : /state = running/.test(r.stdout || '') ? '실행 중' : '등록됨 (대기)' } catch {}
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library', 'Application Support', 'dec-intern', 'jobs.json'), 'utf8')); for (const [slug, v] of Object.entries(j.jobs || j)) if (v && v.lastError) st.jobErrors.push(`${slug}: ${String(v.lastError).slice(0, 160)}`) } catch {}
  try { const g = a => spawnSync('/usr/bin/git', a, {cwd: root, encoding: 'utf8'}).stdout.trim(); st.git = {branch: g(['rev-parse', '--abbrev-ref', 'HEAD']), head: g(['rev-parse', '--short', 'HEAD']), dirty: g(['status', '--short']).split('\n').filter(Boolean).length} } catch {}
  return st;
}
report.state = await appState();
if (report.state.logErrors.length) report.failures.push({where: 'app log (24h)', what: `${report.state.logErrors.length} lines, last: ${report.state.logErrors.at(-1)}`});
for (const e of report.state.jobErrors) report.failures.push({where: 'job', what: e});

// 1. The offline checks: pass or fail, no model.
if (!STATE_ONLY) for (const name of ['jobs-check', 'routes-check']) {
  const r = run([path.join(here, `${name}.mjs`)], {timeoutMs: 3 * 60_000, clean: true});
  report.checks[name] = r.code === 0 ? 'ok' : `failed: ${r.out.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`;
  if (r.code !== 0) report.failures.push({where: name, what: report.checks[name]});
}

// 2. The bench: every task once (or 1-8 with --quick), the engine's own routing.
if (!STATE_ONLY) {
  const file = path.join(tmp, 'bench.jsonl');
  const r = run([path.join(here, 'bench.mjs'), '--models', MODEL, '--only', QUICK ? '1-8' : '1-38', '--repeat', REPEAT, '--out', file]);
  const rows = jsonl(file);
  const pass = rows.filter(x => x.pass).length;
  report.bench = {pass, total: rows.length, rate: pct(pass, rows.length), ms: r.ms, cost: rows.reduce((s, x) => s + (x.cost || 0), 0),
    failed: rows.filter(x => !x.pass).map(x => ({task: x.task, name: x.name, rep: x.rep, route: x.route, tools: x.tools, answer: String(x.answer || '').slice(0, 240), error: x.error || null}))};
  if (!rows.length) report.failures.push({where: 'bench', what: `no results: ${r.out.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`});
  for (const f of report.bench.failed) report.failures.push({where: `bench #${f.task} ${f.name}`, what: f.answer || f.error || '(no answer)'});
}

// 3. The route judgments (Decisions only, cheap).
if (!STATE_ONLY) {
  const r = run([path.join(here, 'judge-bench.mjs'), '--only', 'route'], {timeoutMs: 10 * 60_000});
  const m = /route: (\d+)\/(\d+) right/.exec(r.out);
  const wrong = r.out.split('\n').filter(l => /^\s+\w+→\w+:/.test(l)).map(l => l.trim());
  report.route = m ? {right: +m[1], total: +m[2], rate: pct(+m[1], +m[2]), wrong} : {error: r.out.trim().split('\n').slice(-2).join(' / ').slice(0, 300)};
  if (!m) report.failures.push({where: 'route', what: report.route.error});
}

// 4. The web holdout, with Dec Intern driving dec (practice sites only). Skipped without dec.
if (!NO_WEB && !STATE_ONLY) {
  let decUp = false;
  try { const dec = await import('../dec.mjs'); decUp = !!(await dec.up({start: true})) } catch {}
  if (!decUp) report.web = {skipped: 'dec is not available (not installed, or its agent connection is off)'};
  else {
    const file = path.join(tmp, 'web.jsonl');
    const r = spawnSync(process.execPath, [path.join(here, 'web-tasks.mjs'), '--set', 'holdout6', '--modes', 'dec', '--repeat', '1'], {cwd: root, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 << 20, env: process.env});
    fs.writeFileSync(file, r.stdout || '');
    const rows = jsonl(file);
    const pass = rows.filter(x => x.pass).length;
    report.web = {pass, total: rows.length, rate: pct(pass, rows.length), failed: rows.filter(x => !x.pass).map(x => ({task: x.task, status: x.status, answer: String(x.answer || '').slice(0, 200)}))};
    if (!rows.length) report.failures.push({where: 'web', what: `no results: ${String(r.stderr || '').trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`});
    for (const f of report.web.failed) report.failures.push({where: `web ${f.task}`, what: `${f.status}: ${f.answer}`});
  }
}

// 5. Against the baseline: a rate under the accepted one by more than the margin is "below".
let base = {};
try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch {}
const margin = base.margin ?? 5;
const cmp = (name, rate, ref) => { if (rate == null || ref == null) return; if (rate < ref - margin) report.below.push({what: name, now: rate, baseline: ref}) };
cmp('bench', report.bench?.rate, QUICK ? base.benchQuick : base.bench);
cmp('route', report.route?.rate, base.route);
if (report.web && !report.web.skipped) cmp('web', report.web.rate, base.web);

fs.mkdirSync(OUT, {recursive: true});
const file = path.join(OUT, report.at.replace(/[:.]/g, '-') + '.json');
fs.writeFileSync(file, JSON.stringify(report, null, 1));
fs.rmSync(tmp, {recursive: true, force: true});

// The report, for the job and for a person.
const lines = [];
lines.push(`자기 점검 ${report.at.slice(0, 16).replace('T', ' ')}${STATE_ONLY ? ' (앱 상태만)' : QUICK ? ' (빠르게: 과제 1-8)' : ''}`);
{
  const st = report.state;
  lines.push(`- 저장소: ${st.git ? `${st.git.branch} ${st.git.head}${st.git.dirty ? `, 작업 중인 변경 ${st.git.dirty}개` : ', 깨끗함'}` : '모름'}`);
  lines.push(`- 설치된 앱: ${!st.installed ? '없음' : st.stale.length ? `저장소와 다른 파일 ${st.stale.length}개 (${st.stale.slice(0, 5).join(', ')}${st.stale.length > 5 ? ' …' : ''}) — 다시 설치하면 맞춰져요` : '저장소와 같음'}`);
  lines.push(`- 앱 로그 24시간: ${st.logErrors.length ? `오류 ${st.logErrors.length}줄, 마지막: ${st.logErrors.at(-1)}` : '오류 없음'}`);
  lines.push(`- Dec: ${st.dec?.error ? st.dec.error : `${st.dec?.endpoint}${st.dec?.paired ? ', 등록됨' : ''}${st.dec?.fastMode ? ', 빠른 모드' : ''}${st.dec?.tabs != null ? `, 탭 ${st.dec.tabs}` : ''}`}`);
  lines.push(`- launchd 예약: ${st.launchd || '모름'}${st.jobErrors.length ? ` · 작업 오류 ${st.jobErrors.length}건: ${st.jobErrors.join(' | ')}` : ''}`);
}
for (const [k, v] of Object.entries(report.checks)) lines.push(`- ${k}: ${v}`);
if (report.bench) lines.push(`- 벤치: ${report.bench.pass}/${report.bench.total} (${report.bench.rate}%, 기준 ${(QUICK ? base.benchQuick : base.bench) ?? '없음'}%) · ${(report.bench.ms / 1000).toFixed(0)}초 · $${report.bench.cost.toFixed(3)}`);
if (report.route) lines.push(report.route.error ? `- 라우팅: 실패 — ${report.route.error}` : `- 라우팅: ${report.route.right}/${report.route.total} (${report.route.rate}%, 기준 ${base.route ?? '없음'}%)${report.route.wrong.length ? `\n  틀림: ${report.route.wrong.join(' | ')}` : ''}`);
if (report.web) lines.push(report.web.skipped ? `- 웹: 건너뜀 — ${report.web.skipped}` : `- 웹 holdout6 (dec): ${report.web.pass}/${report.web.total} (${report.web.rate}%, 기준 ${base.web ?? '없음'}%)`);
if (report.failures.length) { lines.push('', `실패 ${report.failures.length}건:`); for (const f of report.failures) lines.push(`- ${f.where}: ${f.what}`) }
if (report.below.length) { lines.push('', '기준보다 낮음:'); for (const b of report.below) lines.push(`- ${b.what}: 지금 ${b.now}%, 기준 ${b.baseline}%`) }
lines.push('', `기록: ${file}`);
lines.push(report.below.length || report.failures.some(f => !/^bench #/.test(f.where)) ? '결론: 손볼 것이 있어요.' : report.failures.length ? '결론: 기준 안이지만 틀린 과제가 있어요.' : '결론: 전부 기준 이상이에요.');
console.log(lines.join('\n'));
process.exit(report.below.length || report.failures.some(f => !/^bench #/.test(f.where)) ? 1 : 0);
