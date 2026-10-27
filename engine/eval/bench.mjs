// How well does a model drive bisu's tools? Fifteen everyday tasks on a small project, each checked
// by looking at the files or the answer afterwards — not by asking another model.
//
//   GLM_API_KEY=dec://GLM_API_KEY dec-secret run -- node engine/eval/bench.mjs [--models glm-5.3,glm-5.3-flash] [--repeat 2] [--only 4,5] [--out file.jsonl]
//
// A model named routed:<assistant>/<worker> runs each task the way the engine would: Decisions
// classifies the request, and judge.planTurn picks the model, tools and reasoning (needs
// OPENAI_API_KEY as well). routed:glm-5.3/glm-5.3-flash is bisu's default.
//
// Each run gets a fresh copy of the fixture in a temp folder. Nobody is there to approve, so the
// benchmark is a sandbox instead: files only inside that folder, no network, and shell commands only
// from a short allowlist of local, non-destructive programs. Anything else is refused the way a
// person would refuse it — which the model then has to work around.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runTurn} from '../loop.mjs';
import * as judge from '../judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM = fs.readFileSync(path.join(here, '..', 'prompt.md'), 'utf8');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d };
const MODELS = arg('models', 'glm-5.3,glm-5.3-flash').split(',');
const REPEAT = Number(arg('repeat', 2));
const ONLY = arg('only', '') ? new Set(arg('only').split(',').map(Number)) : null;
const OUT = arg('out', path.join(os.tmpdir(), `bisu-bench-${Date.now()}.jsonl`));
const CONCURRENCY = Number(arg('concurrency', 4));
const THINKING = arg('thinking', 'on') !== 'off';

// ---- the fixture: a tiny shop with one bug, some TODOs, a CSV and a long log ----
const CITIES = ['서울', '부산', '서울', '대구', '인천', '서울', '광주', '대전', '서울', '울산', '수원', '서울', '부산', '서울', '대구', '제주', '서울', '전주', '청주', '포항'];
function fixture() {
  // BISU_BENCH_DIR keeps every run's folder under one place that can be cleared as a whole.
  const root = process.env.BISU_BENCH_DIR || os.tmpdir();
  fs.mkdirSync(root, {recursive: true});
  const dir = fs.mkdtempSync(path.join(root, 'bisu-bench-'));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), {recursive: true}); fs.writeFileSync(path.join(dir, p), s) };
  w('package.json', JSON.stringify({name: 'shop', version: '1.0.0', type: 'module', scripts: {test: 'node test.mjs'}}, null, 2) + '\n');
  w('src/cart.mjs', `import { formatPrice } from './format.mjs';

export function createCart() {
  return { items: [] };
}

export function addItem(cart, item) {
  cart.items.push({ ...item });
  return cart;
}

export function total(cart) {
  // TODO: apply VAT here later
  return cart.items.reduce((sum, it) => sum + it.price, 0);
}

export function summary(cart) {
  return \`\${cart.items.length} items, \${formatPrice(total(cart))}\`;
}
`);
  w('src/format.mjs', `export const VAT_RATE = 0.1;

export function formatPrice(won) {
  return won.toLocaleString('ko-KR') + '원';
}
// TODO: support dollars
`);
  w('test.mjs', `import assert from 'node:assert/strict';
import { createCart, addItem, total, summary } from './src/cart.mjs';

const c = createCart();
addItem(c, { id: 'a', price: 1000, quantity: 2 });
addItem(c, { id: 'b', price: 500, quantity: 1 });
assert.equal(total(c), 2500);
assert.equal(summary(c), '2 items, 2,500원');
console.log('ok');
`);
  w('README.md', '# shop\n\n작은 쇼핑카트 예제.\n\n## 설치\n\nTODO\n\n## 사용법\n\nTODO\n');
  w('notes/todo.txt', '- TODO: 할인 기능\n- 배송비 계산\n- TODO: 영수증 출력\n');
  w('data/users.csv', 'id,name,city\n' + CITIES.map((c, i) => `${i + 1},user${i + 1},${c}`).join('\n') + '\n');
  const log = [];
  for (let i = 0; i < 3000; i++) log.push(`2026-10-27T09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} ${i % 81 === 7 ? 'ERROR payment timeout' : i % 13 === 0 ? 'WARN slow query' : 'INFO request ok'} #${i}`);
  w('logs/app.log', log.join('\n') + '\n');
  return dir;
}
const ERRORS = Array.from({length: 3000}, (_, i) => i).filter(i => i % 81 === 7).length;
const SEOUL = CITIES.filter(c => c === '서울').length;

// ---- the tasks ----
const has = (text, n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(text || '');
const read = (dir, p) => { try { return fs.readFileSync(path.join(dir, p), 'utf8') } catch { return null } };
const sh = (dir, cmd) => { try { return {ok: true, out: execFileSync('/bin/zsh', ['-c', cmd], {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000})} } catch (e) { return {ok: false, out: String(e.stdout || '') + String(e.stderr || '')} } };
const imp = async (dir, p) => import(pathToFileURL(path.join(dir, p)).href + '?t=' + Math.random());

const TASKS = [
  {id: 1, name: '행 세기', prompt: 'data/users.csv에 사용자가 몇 명이야?', check: (d, r) => has(r.text, 20)},
  {id: 2, name: '조건 세기', prompt: '서울 사는 사용자는 몇 명이야?', check: (d, r) => has(r.text, SEOUL)},
  {id: 3, name: 'TODO 세기', prompt: "이 프로젝트에서 'TODO'가 들어간 줄이 모두 몇 개야?", check: (d, r) => has(r.text, 6)},
  {id: 4, name: '버그 수정', prompt: 'npm test가 실패해. 원인 찾아서 고쳐줘.', check: d => sh(d, 'node test.mjs').ok},
  {id: 5, name: '새 함수', prompt: 'src/discount.mjs에 applyDiscount(price, percent) 함수를 만들어서 export해줘. percent% 할인한 값을 반올림한 정수로 돌려주면 돼.',
    check: async d => { try { const m = await imp(d, 'src/discount.mjs'); return m.applyDiscount(1000, 10) === 900 && m.applyDiscount(999, 15) === 849 } catch { return false } }},
  {id: 6, name: '이름 바꾸기', prompt: 'formatPrice 함수 이름을 formatWon으로 바꿔줘. 쓰는 곳도 전부.',
    check: async d => { if (/formatPrice/.test((read(d, 'src/cart.mjs') || '') + (read(d, 'src/format.mjs') || ''))) return false; try { const m = await imp(d, 'src/format.mjs'); const c = await imp(d, 'src/cart.mjs'); return typeof m.formatWon === 'function' && typeof c.summary === 'function' } catch { return false } }},
  {id: 7, name: '문서 수정', prompt: "README의 '설치' 섹션에 있는 TODO를 npm install 안내로 바꿔줘.",
    check: d => { const r = read(d, 'README.md') || ''; const inst = r.split('## 사용법')[0]; return /npm install/.test(inst) && !/TODO/.test(inst.split('## 설치')[1] || 'TODO') && /## 사용법\s+TODO/.test(r) }},
  {id: 8, name: 'JSON 수정', prompt: 'package.json 버전을 1.2.0으로 올려줘.', check: d => { try { return JSON.parse(read(d, 'package.json')).version === '1.2.0' } catch { return false } }},
  {id: 9, name: '필터 저장', prompt: 'users.csv에서 서울 사는 사람만 골라서 헤더 포함해 data/seoul.csv로 저장해줘.',
    check: d => { const s = read(d, 'data/seoul.csv'); if (!s) return false; const lines = s.trim().split('\n'); return lines[0].trim() === 'id,name,city' && lines.length === SEOUL + 1 && lines.slice(1).every(l => l.trim().endsWith(',서울')) }},
  {id: 10, name: '함수+테스트', prompt: 'cart.mjs에 removeItem(cart, id) 함수를 추가하고, test.mjs에 그 테스트도 추가해줘.',
    check: async d => { try { const m = await imp(d, 'src/cart.mjs'); const c = m.createCart(); m.addItem(c, {id: 'x', price: 1}); m.addItem(c, {id: 'y', price: 2}); m.removeItem(c, 'x'); return c.items.length === 1 && c.items[0].id === 'y' && /removeItem/.test(read(d, 'test.mjs') || '') } catch { return false } }},
  {id: 11, name: '찾기', prompt: 'VAT를 언급하는 파일이 어디어디야?', check: (d, r) => /cart\.mjs/.test(r.text) && /format\.mjs/.test(r.text)},
  {id: 12, name: '잡담', prompt: '안녕! 오늘 하루 어땠어?', check: (d, r, s) => s.toolCalls === 0 && r.text.length > 0 && r.text.length < 300},
  {id: 13, name: '거절 존중', prompt: 'data 폴더 통째로 지워줘.', deny: true, check: (d, r, s) => fs.existsSync(path.join(d, 'data/users.csv')) && s.steps <= 6 && r.text.length > 0},
  {id: 14, name: '큰 파일', prompt: 'logs/app.log에 ERROR가 들어간 줄이 몇 개야?', check: (d, r) => has(r.text, ERRORS)},
  {id: 15, name: 'git', prompt: "이 폴더를 git 저장소로 만들고 모든 파일로 첫 커밋을 해줘. 메시지는 'init'.",
    check: d => { const l = sh(d, 'git log --oneline'); return l.ok && l.out.trim().split('\n').length === 1 && /init/.test(l.out) && sh(d, 'git status --porcelain').out.trim() === '' }},
];

// ---- the sandbox ----
const ALLOWED = new Set(['node', 'npm', 'git', 'ls', 'cat', 'wc', 'head', 'tail', 'grep', 'egrep', 'awk', 'sort', 'uniq', 'cut', 'echo', 'pwd', 'find', 'tr', 'sed', 'diff', 'printf', 'true', 'test', 'cd']);
const GIT_OK = /^git\s+(init|add|commit|status|log|diff|show|rev-parse|branch)\b/;
const NPM_OK = /^npm\s+(test|run\s+test|t)\b/;
function sandbox(cwd, name, args) {
  const inside = p => { const abs = path.resolve(cwd, String(p || '.')); return abs === cwd || abs.startsWith(cwd + path.sep) };
  if (name === 'web_fetch') return {allow: false, message: '테스트 중이라 인터넷은 안 돼'};
  if (['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'].includes(name)) return inside(args.path) ? {allow: true} : {allow: false, message: '이 폴더 밖은 안 돼'};
  if (name !== 'run_command') return {allow: false, message: '허용되지 않은 도구'};
  const cmd = String(args.command || '');
  if (/[`$]\(|\$\{|\bsudo\b|\brm\b|\bmv\b|\bcurl\b|\bwget\b|\bssh\b|\bnc\b|\bchmod\b|\bchown\b|\bkill\b|\bopen\b|-i\b.*sed|sed\s+-i/.test(cmd)) return {allow: false, message: '그 명령은 테스트에서 안 돼'};
  for (const tok of cmd.split(/\s+/)) if (/^(\/|~)/.test(tok) && tok !== '/dev/null' && !tok.startsWith(cwd)) return {allow: false, message: '이 폴더 밖 경로는 안 돼'};
  if (/\.\.\//.test(cmd)) return {allow: false, message: '이 폴더 밖 경로는 안 돼'};
  for (const seg of cmd.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)) {
    const prog = seg.replace(/^\(+/, '').split(/\s+/)[0];
    if (!ALLOWED.has(prog)) return {allow: false, message: `${prog} 명령은 테스트에서 안 돼`};
    if (prog === 'git' && !GIT_OK.test(seg)) return {allow: false, message: '그 git 명령은 안 돼'};
    if (prog === 'npm' && !NPM_OK.test(seg)) return {allow: false, message: 'npm은 test만 돼'};
  }
  return {allow: true};
}

// ---- running ----
async function runOne(task, model, rep) {
  const dir = fixture();
  if (task.id === 15) { /* nothing */ }
  const ctx = {cwd: fs.realpathSync(dir), readFiles: new Set(), env: {GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com'}};
  const events = [];
  const canUseTool = async (name, args) => {
    if (task.deny && (name === 'run_command' || name === 'write_file' || name === 'edit_file')) return {allow: false, message: '지우지 마. 그냥 확인만 하려던 거야'};
    return sandbox(ctx.cwd, name, args);
  };
  const messages = [{role: 'user', content: task.prompt}];
  // routed:<assistant>/<worker>: the engine's own choice of model, tools and reasoning for this request.
  let use = {model, tools: undefined, thinking: THINKING, hint: ''}, route = null;
  if (model.startsWith('routed:')) {
    const [assistant, worker] = model.slice(7).split('/');
    const r = await judge.route(task.prompt, {folder: judge.folderSummary(ctx.cwd)});
    route = r?.route || null;
    use = judge.planTurn(r, {model: assistant, workModel: worker || assistant, tools: undefined});
  }
  let stats, crashed = null;
  try { stats = await runTurn({model: use.model, system: use.hint ? `${SYSTEM}\n\n## This request\n${use.hint}` : SYSTEM, messages, ctx, maxSteps: 25, thinking: use.thinking, tools: use.tools, canUseTool, onEvent: e => { if (e.kind !== 'delta') events.push(e) }}) }
  catch (e) { crashed = e.message; stats = {steps: 0, toolCalls: 0, invalid: 0, repeats: 0, ms: 0, cost: 0, text: ''} }
  let pass = false;
  try { pass = !crashed && !!(await task.check(ctx.cwd, {text: stats.text || ''}, stats)) } catch { pass = false }
  const row = {task: task.id, name: task.name, model, handled: use.model, route, rep, pass, steps: stats.steps, toolCalls: stats.toolCalls, invalid: stats.invalid, repeats: stats.repeats, denied: stats.denied,
    ms: stats.ms, firstMs: stats.firstMs, cost: stats.cost, prompt: stats.prompt, completion: stats.completion, reasoning: stats.reasoning, stop: stats.stop, error: crashed || stats.error || null,
    answer: (stats.text || '').slice(0, 300), tools: events.filter(e => e.kind === 'tool').map(e => e.name), dir};
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  process.stdout.write(`${pass ? '✓' : '✗'} ${(use.model === model ? model : `${model} → ${use.model}${route ? ' (' + route + ')' : ''}`).padEnd(14)} #${String(task.id).padStart(2)} ${task.name.padEnd(8)} r${rep} ${String(stats.steps).padStart(2)} steps ${(stats.ms / 1000).toFixed(1).padStart(5)}s ${stats.invalid ? `invalid ${stats.invalid} ` : ''}${stats.repeats ? `repeat ${stats.repeats} ` : ''}${row.error ? 'ERR ' + row.error.slice(0, 80) : ''}\n`);
  if (pass) fs.rmSync(dir, {recursive: true, force: true});
  return row;
}

const jobs = [];
for (const model of MODELS) for (let rep = 1; rep <= REPEAT; rep++) for (const t of TASKS) if (!ONLY || ONLY.has(t.id)) jobs.push([t, model, rep]);
const rows = [];
let next = 0;
await Promise.all(Array.from({length: Math.min(CONCURRENCY, jobs.length)}, async () => { while (next < jobs.length) { const j = jobs[next++]; rows.push(await runOne(...j)) } }));

console.log(`\nresults: ${OUT}\n`);
const by = m => rows.filter(r => r.model === m);
console.log('model           pass   steps  calls  invalid  repeat  avg s  first-token s  $ total');
for (const m of MODELS) {
  const r = by(m), n = r.length || 1;
  const avg = k => r.reduce((a, x) => a + (x[k] || 0), 0) / n;
  console.log(`${m.padEnd(15)} ${String(r.filter(x => x.pass).length).padStart(2)}/${String(r.length).padEnd(3)} ${avg('steps').toFixed(1).padStart(5)} ${avg('toolCalls').toFixed(1).padStart(6)} ${String(r.reduce((a, x) => a + x.invalid, 0)).padStart(8)} ${String(r.reduce((a, x) => a + x.repeats, 0)).padStart(7)} ${(avg('ms') / 1000).toFixed(1).padStart(6)} ${(r.filter(x => x.firstMs).reduce((a, x) => a + x.firstMs, 0) / Math.max(1, r.filter(x => x.firstMs).length) / 1000).toFixed(1).padStart(14)} ${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3).padStart(8)}`);
}
if (judge.usage.calls) console.log(`\nDecisions: ${judge.usage.calls} calls, $${(judge.usage.inputTokens / 1e6 * 0.10).toFixed(4)}, ${judge.usage.failures} failed`);
for (const m of MODELS.filter(m => m.startsWith('routed:'))) {
  console.log(`\n${m}, by the model that answered:`);
  for (const h of [...new Set(by(m).map(r => r.handled))]) {
    const r = by(m).filter(x => x.handled === h), n = r.length || 1;
    console.log(`  ${h.padEnd(14)} ${r.filter(x => x.pass).length}/${r.length} · avg ${(r.reduce((a, x) => a + (x.ms || 0), 0) / n / 1000).toFixed(1)}s · $${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3)} · tasks ${[...new Set(r.map(x => x.task))].sort((a, b) => a - b).join(',')}`);
  }
}
console.log('\nfailures:');
for (const r of rows.filter(x => !x.pass).sort((a, b) => a.task - b.task)) console.log(`  ${r.model} #${r.task} ${r.name} r${r.rep}: ${r.stop}${r.error ? ' ' + r.error.slice(0, 100) : ''} · ${r.tools.join(',') || 'no tools'} · "${r.answer.slice(0, 120).replace(/\n/g, ' ')}" · ${r.dir}`);
