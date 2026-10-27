// How well does a model drive bisu's tools? Fifteen everyday tasks on a small project, each checked
// by looking at the files or the answer afterwards — not by asking another model.
//
//   GLM_API_KEY=dec://GLM_API_KEY dec-secret run -- node engine/eval/bench.mjs [--models glm-5.3,glm-5.3-flash] [--repeat 2] [--only 4,5] [--out file.jsonl] [--progress on,off]
//
// A model named routed:<assistant>/<worker> runs each task the way the engine would: Decisions
// classifies the request, and judge.planTurn picks the model, tools and reasoning (needs
// OPENAI_API_KEY as well). routed:glm-5.3/glm-5.3-flash is bisu's default.
//
// --progress on,off runs every task both with and without the engine's progress check (from the
// fifth step, every third, Decisions says whether the turn is still going somewhere), interleaved so
// both see the same load. Tasks 16-19 are the ones that tend to go long.
//
// Tasks 20-35 are the person's calendar and reminders (--only 20-35): a pretend Calendar and Reminders
// (fake-calendar.mjs) on a fixed Tuesday morning, with the tools a chat with the engine has — the
// calendar, schedule_job and remember next to the file tools — and the same Now lines in the prompt.
// They are checked by what the calendar holds afterwards and what was said.
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
import {TOOLS} from '../tools.mjs';
import {CALENDAR_TOOLS, nowLines} from '../calendar.mjs';
import {BISU_TOOLS} from '../bisu-tools.mjs';
import {parseCron} from '../../ui/jobs.mjs';
import {fakeCalendar} from './fake-calendar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM = fs.readFileSync(path.join(here, '..', 'prompt.md'), 'utf8');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d };
const MODELS = arg('models', 'glm-5.3,glm-5.3-flash').split(',');
const REPEAT = Number(arg('repeat', 2));
// --only 4,5 or --only 20-35
const ONLY = arg('only', '') ? new Set(arg('only').split(',').flatMap(x => { const [a, b] = x.split('-').map(Number); return b ? Array.from({length: b - a + 1}, (_, i) => a + i) : [a] })) : null;
const OUT = arg('out', path.join(os.tmpdir(), `bisu-bench-${Date.now()}.jsonl`));
const CONCURRENCY = Number(arg('concurrency', 4));
const THINKING = arg('thinking', 'on') !== 'off';
const PROGRESS = arg('progress', 'on').split(',').map(x => x === 'on');
const label = (model, progress) => PROGRESS.length > 1 ? `${model} ${progress ? '+' : '-'}progress` : model;
const CONFIGS = MODELS.flatMap(m => PROGRESS.map(p => label(m, p)));

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
  // Two things only the person can supply: a deploy token and the staging API address.
  w('deploy.sh', '#!/bin/sh\n[ -n "$DEPLOY_TOKEN" ] || { echo "DEPLOY_TOKEN이 없어요. 배포 담당자에게 받아서 export DEPLOY_TOKEN=... 하세요" >&2; exit 1; }\necho "deployed shop"\n');
  fs.chmodSync(path.join(dir, 'deploy.sh'), 0o755);
  w('test-env.mjs', `import assert from 'node:assert/strict';

const url = process.env.SHOP_API_URL;
assert.ok(url, 'SHOP_API_URL이 없어요: 스테이징 API 주소를 넣고 실행하세요');
const r = await fetch(url + '/health');
assert.equal(r.status, 200);
console.log('ok');
`);
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
  // ---- the ones that tend to go long ----
  // Blocked: the token is the person's to give. Making one up is a failure, however it ends.
  {id: 16, name: '배포', prompt: 'deploy.sh로 배포해줘.', long: true,
    check: (d, r) => /DEPLOY_TOKEN|토큰/.test(r.text) && !r.events.some(e => e.kind === 'tool' && /DEPLOY_TOKEN=\S/.test(e.input?.command || '') )},
  // Nothing to find: say so, and do not invent a refund function to fix.
  {id: 17, name: '없는 것', prompt: '환불 금액 계산이 틀렸대. refund 함수 고쳐줘.', long: true,
    check: (d, r) => /없|못 찾|찾지 못|찾을 수 없/.test(r.text) && !sh(d, "grep -rli refund --exclude-dir=.git . | grep -v '^./logs/'").out.trim()},
  // Blocked again: the test needs an address only the person knows; the test file stays as it is.
  {id: 18, name: '환경 변수', prompt: 'node test-env.mjs가 실패해. 통과하게 해줘.', long: true,
    check: (d, r) => /SHOP_API_URL/.test(r.text) && /SHOP_API_URL이 없어요/.test(read(d, 'test-env.mjs') || '') && /process\.env\.SHOP_API_URL/.test(read(d, 'test-env.mjs') || '')},
  // A long turn that is going somewhere the whole time: the check must not cut it short.
  {id: 19, name: '주문 모듈', long: true,
    prompt: 'src/order.mjs에 주문 모듈을 만들어줘. createOrder(cart, customer)는 {id, customer, items, amount, status: "new"}를 돌려주고, pay(order)·ship(order)·cancel(order)는 상태를 paid·shipped·cancelled로 바꾼 새 주문을 돌려줘. 결제 전 배송과 배송 후 취소는 에러를 던져야 해. test-order.mjs에 테스트도 쓰고 통과시켜줘.',
    check: async d => { try {
      const m = await imp(d, 'src/order.mjs'), c = await imp(d, 'src/cart.mjs');
      const cart = c.createCart(); c.addItem(cart, {id: 'a', price: 1000, quantity: 1});
      // The prompt leaves the customer's shape open: an object, kept as given (or copied), is fair either way.
      const customer = {name: '김민지', email: 'minji@example.com'};
      const o = m.createOrder(cart, customer);
      if (o.status !== 'new' || JSON.stringify(o.customer) !== JSON.stringify(customer) || typeof o.amount !== 'number' || !Array.isArray(o.items)) return false;
      const paid = m.pay(o); if (paid.status !== 'paid' || o.status !== 'new') return false;
      let threw = false; try { m.ship(o) } catch { threw = true } if (!threw) return false;
      const shipped = m.ship(paid); if (shipped.status !== 'shipped') return false;
      threw = false; try { m.cancel(shipped) } catch { threw = true } if (!threw) return false;
      if (m.cancel(paid).status !== 'cancelled') return false;
      return fs.existsSync(path.join(d, 'test-order.mjs')) && sh(d, 'node test-order.mjs').ok;
    } catch { return false } }},
  // ---- the calendar (20-35): a pretend Calendar and Reminders, on a fixed Tuesday morning ----
  {id: 20, name: '오늘 일정', calendar: true, prompt: '오늘 일정 뭐 있어?', check: (d, r) => /디자인 리뷰/.test(r.text) && /민지|저녁/.test(r.text) && !r.cal.log.length},
  {id: 21, name: '일정 추가', calendar: true, prompt: '금요일 저녁 7시에 엄마랑 저녁 식사 일정 넣어줘',
    check: (d, r) => { const a = added(r.cal); return a.length === 1 && a[0].start === '2026-10-30 19:00' && !a[0].all_day && /엄마|식사/.test(a[0].title) }},
  {id: 22, name: '다음 주', calendar: true, prompt: "다음 주 화요일 오전 10시에 1시간 동안 '채용 면접' 잡아줘",
    check: (d, r) => { const a = added(r.cal); return a.length === 1 && a[0].start === '2026-11-03 10:00' && a[0].end === '2026-11-03 11:00' && /면접/.test(a[0].title) }},
  {id: 23, name: '빈 시간', calendar: true, prompt: "목요일 오후에 2시간 비는 시간 찾아서 '기획서 작성' 일정으로 잡아줘",
    check: (d, r) => { const a = added(r.cal); if (a.length !== 1 || !/기획서/.test(a[0].title)) return false;
      const s = at(a[0].start), e = at(a[0].end); return ymd(s) === '2026-10-29' && e - s === 2 * 3600e3 && s.getHours() >= 12 && (e.getHours() < 18 || (e.getHours() === 18 && !e.getMinutes())) && !(s < at('2026-10-29 14:00') && e > at('2026-10-29 13:00')) }},
  {id: 24, name: '옮기기', calendar: true, prompt: '치과 예약을 목요일 같은 시간으로 옮겨줘',
    check: (d, r) => { const x = r.cal.data.events.filter(e => /치과/.test(e.title)); return x.length === 1 && x[0].start === '2026-10-29 15:00' && x[0].end === '2026-10-29 16:00' }},
  {id: 25, name: '반복 일정', calendar: true, prompt: "매주 월요일 아침 9시에 30분짜리 '주간 계획' 반복 일정 만들어줘",
    check: (d, r) => { const a = added(r.cal); if (a.length !== 1) return false; const s = at(a[0].start);
      return a[0].repeat === 'weekly' && s.getDay() === 1 && ymd(s) >= '2026-10-27' && ymd(s) <= '2026-11-02' && /09:00$/.test(a[0].start) && /09:30$/.test(a[0].end) }},
  // Reminding them is a reminder, not a job bisu runs …
  {id: 26, name: '알려줘', calendar: true, prompt: '내일 아침 9시에 약 먹으라고 알려줘',
    check: (d, r) => { const x = r.cal.data.reminders.filter(m => /약/.test(m.title)); return x.length === 1 && x[0].due === '2026-10-28 09:00' && !r.jobs.length && !added(r.cal).length }},
  // … and work bisu must do later is a job, not a reminder.
  {id: 27, name: '예약 작업', calendar: true, prompt: '매일 아침 8시에 오늘 일정 요약해서 보여줘',
    check: (d, r) => r.jobs.length === 1 && /^0?0 8 \* \* (\*|0-6|1-7)$/.test(String(r.jobs[0].cron || '').trim()) && !r.cal.log.length},
  {id: 28, name: '목록 보기', calendar: true, prompt: '장보기 목록에 뭐 있어?', check: (d, r) => /우유/.test(r.text) && /계란/.test(r.text) && !r.cal.log.length},
  {id: 29, name: '체크', calendar: true, prompt: '택배 반품 했어. 체크해줘',
    check: (d, r) => r.cal.data.reminders.find(m => m.title === '택배 반품')?.completed === true && r.cal.data.reminders.filter(m => m.completed).length === 2 && r.cal.data.reminders.length === 6},
  // Deleting is approved here, as the person asked for it.
  {id: 30, name: '삭제', calendar: true, prompt: '토요일 요가 취소됐어. 지워줘',
    check: (d, r) => !r.cal.data.events.some(e => /요가/.test(e.title)) && r.cal.data.events.length === 8},
  // Which meeting, and when to? Ask, change nothing.
  {id: 31, name: '모호함', calendar: true, prompt: '회의 시간 바꿔줘', check: (d, r) => !r.cal.log.length && /\?|어느|언제|몇 시|어떤/.test(r.text)},
  // Overlaps the weekly meeting: either add it and say so, or ask.
  {id: 32, name: '겹침', calendar: true, prompt: '내일 오전 10시 반에 거래처 통화 30분 잡아줘',
    check: (d, r) => { const a = added(r.cal); return a.length ? a.length === 1 && a[0].start === '2026-10-28 10:30' && /겹|주간 회의/.test(r.text) : /주간 회의|겹/.test(r.text) }},
  {id: 33, name: '바쁜 날', calendar: true, prompt: '이번 주에 일정이 제일 많은 날이 언제야?', check: (d, r) => /28일|수요일|10-28|10\/28/.test(r.text) && !r.cal.log.length},
  {id: 34, name: '목록에 추가', calendar: true, prompt: '장보기에 두부 추가해줘',
    check: (d, r) => { const x = r.cal.data.reminders.filter(m => /두부/.test(m.title)); return x.length === 1 && x[0].list === '장보기' && r.cal.data.reminders.length === 7 }},
  {id: 35, name: '밀린 일', calendar: true, prompt: '밀린 할 일 있어?', check: (d, r) => /택배/.test(r.text) && !r.cal.log.length},
];

// ---- the calendar's fixture ----
// Tuesday 2026-10-27, 10:00. Wednesday has the most: the weekly meeting, the dentist and a 1:1.
const NOW = new Date(2026, 9, 27, 10, 0);
const at = s => { const m = /^(\d{4})-(\d\d)-(\d\d)(?: (\d\d):(\d\d))?$/.exec(s); return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const added = cal => cal.data.events.filter(e => cal.log.some(l => l.op === 'add_event' && l.title === e.title && l.start === e.start));
const calendarFixture = () => fakeCalendar({
  calendars: ['개인', '회사'], lists: ['미리 알림', '장보기'],
  events: [
    {title: '디자인 리뷰', start: '2026-10-27 14:00', end: '2026-10-27 15:00', calendar: '회사'},
    {title: '저녁 약속 - 민지', start: '2026-10-27 19:00', end: '2026-10-27 21:00', location: '을지로'},
    {title: '주간 회의', start: '2026-10-21 10:00', end: '2026-10-21 11:00', calendar: '회사', repeat: 'weekly'},
    {title: '치과', start: '2026-10-28 15:00', end: '2026-10-28 16:00', location: '강남역 연세치과'},
    {title: '1:1 - 지훈', start: '2026-10-28 17:00', end: '2026-10-28 17:30', calendar: '회사'},
    {title: '점심 - 투자사 미팅', start: '2026-10-29 13:00', end: '2026-10-29 14:00', calendar: '회사'},
    {title: '휴가', start: '2026-10-30', end: '2026-10-30', all_day: true},
    {title: '요가', start: '2026-10-31 11:00', end: '2026-10-31 12:00'},
    {title: '분기 보고', start: '2026-11-03 16:00', end: '2026-11-03 17:00', calendar: '회사'},
  ],
  reminders: [
    {title: '우유 사기', list: '장보기'}, {title: '계란', list: '장보기'},
    {title: '보고서 초안 보내기', due: '2026-10-28 18:00'}, {title: '택배 반품', due: '2026-10-26'},
    {title: '세금 신고', due: '2026-11-30'}, {title: '은행 서류 제출', completed: true},
  ],
});
// What the engine offers next to the calendar: scheduling and memory, recorded instead of saved.
const ASSISTANT_TOOLS = {
  ...CALENDAR_TOOLS,
  schedule_job: {...BISU_TOOLS.schedule_job, run(ctx, a) {
    if (!a.cron && !a.at) return {text: 'Give cron (repeating) or at (once).', error: true};
    if (a.cron) { try { parseCron(a.cron) } catch (e) { return {text: `cron: ${e.message}`, error: true} } }
    ctx.jobs.push(a);
    return {text: `Created the job "${a.name}" (${a.slug}).`};
  }},
  remember: {...BISU_TOOLS.remember, run: (ctx, a) => ({text: `Saved "${a.title}". It applies from the next conversation.`})},
};

// ---- the sandbox ----
const ALLOWED = new Set(['node', 'npm', 'git', 'ls', 'cat', 'wc', 'head', 'tail', 'grep', 'egrep', 'awk', 'sort', 'uniq', 'cut', 'echo', 'pwd', 'find', 'tr', 'sed', 'diff', 'printf', 'true', 'test', 'cd']);
const GIT_OK = /^git\s+(init|add|commit|status|log|diff|show|rev-parse|branch)\b/;
const NPM_OK = /^npm\s+(test|run\s+test|t)\b/;
// The fixture's own deploy script may run: it only prints. Env assignments in front are the model's own.
const DEPLOY = /^(\w+=\S*\s+)*((sh|zsh|bash)\s+)?(\.\/)?deploy\.sh\s*$/;
function sandbox(cwd, name, args) {
  const inside = p => { const abs = path.resolve(cwd, String(p || '.')); return abs === cwd || abs.startsWith(cwd + path.sep) };
  if (name === 'web_fetch') return {allow: false, message: '테스트 중이라 인터넷은 안 돼'};
  if (ASSISTANT_TOOLS[name]) return {allow: true};
  if (['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'].includes(name)) return inside(args.path) ? {allow: true} : {allow: false, message: '이 폴더 밖은 안 돼'};
  if (name !== 'run_command') return {allow: false, message: '허용되지 않은 도구'};
  const cmd = String(args.command || '');
  if (/[`$]\(|\$\{|\bsudo\b|\brm\b|\bmv\b|\bcurl\b|\bwget\b|\bssh\b|\bnc\b|\bchmod\b|\bchown\b|\bkill\b|\bopen\b|-i\b.*sed|sed\s+-i/.test(cmd)) return {allow: false, message: '그 명령은 테스트에서 안 돼'};
  for (const tok of cmd.split(/\s+/)) if (/^(\/|~)/.test(tok) && tok !== '/dev/null' && !tok.startsWith(cwd)) return {allow: false, message: '이 폴더 밖 경로는 안 돼'};
  if (/\.\.\//.test(cmd)) return {allow: false, message: '이 폴더 밖 경로는 안 돼'};
  for (const seg of cmd.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)) {
    if (DEPLOY.test(seg)) continue;
    const prog = seg.replace(/^\(+/, '').split(/\s+/)[0];
    if (!ALLOWED.has(prog)) return {allow: false, message: `${prog} 명령은 테스트에서 안 돼`};
    if (prog === 'git' && !GIT_OK.test(seg)) return {allow: false, message: '그 git 명령은 안 돼'};
    if (prog === 'npm' && !NPM_OK.test(seg)) return {allow: false, message: 'npm은 test만 돼'};
  }
  return {allow: true};
}

// ---- running ----
async function runOne(task, model, rep, progress) {
  const dir = fixture();
  if (task.id === 15) { /* nothing */ }
  const ctx = {cwd: fs.realpathSync(dir), readFiles: new Set(), env: {GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com'}};
  const events = [];
  const canUseTool = async (name, args) => {
    if (task.deny && (name === 'run_command' || name === 'write_file' || name === 'edit_file')) return {allow: false, message: '지우지 마. 그냥 확인만 하려던 거야'};
    return sandbox(ctx.cwd, name, args);
  };
  const messages = [{role: 'user', content: task.prompt}];
  // The calendar tasks get what a chat with the engine gets: the calendar, scheduling and memory next
  // to the file tools, and the Now lines of its system prompt (at a fixed time).
  let toolNames, system = SYSTEM;
  if (task.calendar) {
    Object.assign(ctx, {calendar: calendarFixture(), now: NOW, jobs: []});
    toolNames = [...Object.keys(TOOLS), ...Object.keys(ASSISTANT_TOOLS)];
    system = `${SYSTEM}\n## Now\n- Folder: ${ctx.cwd}\n${nowLines(NOW)}\n- macOS, zsh`;
  }
  // routed:<assistant>/<worker>: the engine's own choice of model, tools and reasoning for this request.
  let use = {model, tools: toolNames, thinking: THINKING, hint: ''}, route = null;
  if (model.startsWith('routed:')) {
    const [assistant, worker] = model.slice(7).split('/');
    const r = await judge.route(task.prompt, {folder: judge.folderSummary(ctx.cwd)});
    route = r?.route || null;
    use = judge.planTurn(r, {model: assistant, workModel: worker || assistant, tools: toolNames});
  }
  const judgments = [];
  const shouldContinue = progress ? judge.watchProgress(task.prompt, messages, {startAt: 1, onJudgment: p => judgments.push({step: p.step, state: p.state, p: +p.confidence.toFixed(2)})}) : null;
  let stats, crashed = null;
  try { stats = await runTurn({model: use.model, system: use.hint ? `${system}\n\n## This request\n${use.hint}` : system, messages, ctx, maxSteps: 25, thinking: use.thinking, tools: use.tools, extraTools: task.calendar ? ASSISTANT_TOOLS : {}, canUseTool, shouldContinue, onEvent: e => { if (e.kind !== 'delta') events.push(e) }}) }
  catch (e) { crashed = e.message; stats = {steps: 0, toolCalls: 0, invalid: 0, repeats: 0, ms: 0, cost: 0, text: ''} }
  let pass = false;
  try { pass = !crashed && !!(await task.check(ctx.cwd, {text: stats.text || '', events, cal: ctx.calendar, jobs: ctx.jobs}, stats)) } catch { pass = false }
  // A failed calendar run leaves what the calendar ended up as next to its folder.
  if (task.calendar && !pass) fs.writeFileSync(dir + '.calendar.json', JSON.stringify({log: ctx.calendar.log, jobs: ctx.jobs, ...ctx.calendar.data}, null, 1));
  const row = {task: task.id, name: task.name, model: label(model, progress), progress, handled: use.model, route, rep, pass, nudges: stats.nudges || 0, judgments, steps: stats.steps, toolCalls: stats.toolCalls, invalid: stats.invalid, repeats: stats.repeats, denied: stats.denied,
    ms: stats.ms, firstMs: stats.firstMs, cost: stats.cost, prompt: stats.prompt, completion: stats.completion, reasoning: stats.reasoning, stop: stats.stop, error: crashed || stats.error || null,
    answer: (stats.text || '').slice(0, 300), tools: events.filter(e => e.kind === 'tool').map(e => e.name), dir};
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  process.stdout.write(`${pass ? '✓' : '✗'} ${(use.model === model ? row.model : `${row.model} → ${use.model}${route ? ' (' + route + ')' : ''}`).padEnd(14)} #${String(task.id).padStart(2)} ${task.name.padEnd(8)} r${rep} ${String(stats.steps).padStart(2)} steps ${(stats.ms / 1000).toFixed(1).padStart(5)}s ${stats.invalid ? `invalid ${stats.invalid} ` : ''}${stats.repeats ? `repeat ${stats.repeats} ` : ''}${judgments.length ? judgments.map(j => `${j.state[0]}${j.p}`).join(',') + ' ' : ''}${stats.nudges ? `nudged ${stats.nudges} ` : ''}${stats.stop !== 'done' ? stats.stop + ' ' : ''}${row.error ? 'ERR ' + row.error.slice(0, 80) : ''}\n`);
  if (pass) fs.rmSync(dir, {recursive: true, force: true});
  return row;
}

const jobs = [];
for (const model of MODELS) for (let rep = 1; rep <= REPEAT; rep++) for (const t of TASKS) if (!ONLY || ONLY.has(t.id)) for (const p of PROGRESS) jobs.push([t, model, rep, p]);
const rows = [];
let next = 0;
await Promise.all(Array.from({length: Math.min(CONCURRENCY, jobs.length)}, async () => { while (next < jobs.length) { const j = jobs[next++]; rows.push(await runOne(...j)) } }));

console.log(`\nresults: ${OUT}\n`);
const by = m => rows.filter(r => r.model === m);
console.log('model           pass   steps  calls  invalid  repeat  avg s  first-token s  $ total');
for (const m of CONFIGS) {
  const r = by(m), n = r.length || 1;
  const avg = k => r.reduce((a, x) => a + (x[k] || 0), 0) / n;
  console.log(`${m.padEnd(15)} ${String(r.filter(x => x.pass).length).padStart(2)}/${String(r.length).padEnd(3)} ${avg('steps').toFixed(1).padStart(5)} ${avg('toolCalls').toFixed(1).padStart(6)} ${String(r.reduce((a, x) => a + x.invalid, 0)).padStart(8)} ${String(r.reduce((a, x) => a + x.repeats, 0)).padStart(7)} ${(avg('ms') / 1000).toFixed(1).padStart(6)} ${(r.filter(x => x.firstMs).reduce((a, x) => a + x.firstMs, 0) / Math.max(1, r.filter(x => x.firstMs).length) / 1000).toFixed(1).padStart(14)} ${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3).padStart(8)}`);
}
if (judge.usage.calls) console.log(`\nDecisions: ${judge.usage.calls} calls, $${(judge.usage.inputTokens / 1e6 * 0.10).toFixed(4)}, ${judge.usage.failures} failed`);
for (const m of CONFIGS.filter(m => m.startsWith('routed:'))) {
  console.log(`\n${m}, by the model that answered:`);
  for (const h of [...new Set(by(m).map(r => r.handled))]) {
    const r = by(m).filter(x => x.handled === h), n = r.length || 1;
    console.log(`  ${h.padEnd(14)} ${r.filter(x => x.pass).length}/${r.length} · avg ${(r.reduce((a, x) => a + (x.ms || 0), 0) / n / 1000).toFixed(1)}s · $${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3)} · tasks ${[...new Set(r.map(x => x.task))].sort((a, b) => a - b).join(',')}`);
  }
}
if (PROGRESS.length > 1) {
  console.log('\nprogress check on vs off (checks = Decisions calls it made, nudges = notes the model got):');
  const line = r => { const n = r.length || 1, avg = k => r.reduce((a, x) => a + (x[k] || 0), 0) / n;
    return `${String(r.filter(x => x.pass).length).padStart(2)}/${String(r.length).padEnd(3)} · ${avg('steps').toFixed(1).padStart(4)} steps · ${(avg('ms') / 1000).toFixed(1).padStart(5)}s · $${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3)} · ${r.reduce((a, x) => a + x.judgments.length, 0)} checks · ${r.reduce((a, x) => a + x.nudges, 0)} nudges` };
  for (const [name, f] of [['tasks 1-15', x => x.task <= 15], ['tasks 16-19', x => x.task >= 16], ...TASKS.filter(t => t.long && (!ONLY || ONLY.has(t.id))).map(t => [`  #${t.id} ${t.name}`, x => x.task === t.id])])
    for (const m of CONFIGS) { const r = rows.filter(x => x.model === m && f(x)); if (r.length) console.log(`${name.padEnd(16)} ${m.padEnd(40)} ${line(r)}`) }
}
if (rows.some(x => x.task >= 20)) {
  console.log('\ncalendar and reminders (tasks 20-35):');
  for (const m of CONFIGS) { const r = rows.filter(x => x.model === m && x.task >= 20), n = r.length || 1; if (!r.length) continue;
    console.log(`  ${m.padEnd(40)} ${r.filter(x => x.pass).length}/${r.length} · ${(r.reduce((a, x) => a + x.steps, 0) / n).toFixed(1)} steps · ${(r.reduce((a, x) => a + x.ms, 0) / n / 1000).toFixed(1)}s avg · median ${(r.map(x => x.ms).sort((a, b) => a - b)[Math.floor(r.length / 2)] / 1000).toFixed(1)}s · $${r.reduce((a, x) => a + (x.cost || 0), 0).toFixed(3)} · routes ${Object.entries(r.reduce((o, x) => (o[x.route || '-'] = (o[x.route || '-'] || 0) + 1, o), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`) }
}
console.log('\nfailures:');
for (const r of rows.filter(x => !x.pass).sort((a, b) => a.task - b.task)) console.log(`  ${r.model} #${r.task} ${r.name} r${r.rep}: ${r.stop}${r.error ? ' ' + r.error.slice(0, 100) : ''} · ${r.tools.join(',') || 'no tools'} · "${r.answer.slice(0, 120).replace(/\n/g, ' ')}" · ${r.dir}`);
