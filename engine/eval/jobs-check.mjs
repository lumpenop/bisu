// Offline check of watch-until-done jobs (ui/jobs.mjs) and the Claude app's session states (ui/claude-watch.mjs):
//   node engine/eval/jobs-check.mjs
// Everything lives in a temporary folder: no real job, state file or transcript is read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-intern-jobs-check-'));
Object.assign(process.env, {XDG_CONFIG_HOME: path.join(dir, 'config'), DEC_INTERN_JOBS_STATE: path.join(dir, 'jobs.json'),
  DEC_INTERN_SCHEDULER_LOCK: path.join(dir, 'lock'), DEC_INTERN_CLAUDE_PROJECTS: path.join(dir, 'projects'), DEC_INTERN_NOTIFY: '0'});
const jobs = await import('../../ui/jobs.mjs');
const watch = await import('../../ui/claude-watch.mjs');

// every: shorthand for the cron it means.
assert.equal(jobs.parseEvery('30m'), '*/30 * * * *');
assert.equal(jobs.parseEvery('1m'), '* * * * *');
assert.equal(jobs.parseEvery('2h'), '0 */2 * * *');
assert.equal(jobs.parseEvery('10분'), '*/10 * * * *');
assert.throws(() => jobs.parseEvery('90m'));

// Markers on a line of their own; [끝] wins over [조용].
assert.deepEqual(jobs.markers('[조용]'), {body: '', done: false, quiet: true});
assert.deepEqual(jobs.markers('끝났어요\n[끝]'), {body: '끝났어요', done: true, quiet: false});
assert.deepEqual(jobs.markers('[조용]\n[끝]').quiet, false);
assert.equal(jobs.markers('글에 [조용] 이 들어 있음').quiet, false);

// A fresh install (no state file yet): listing, approving and the next run all work.
fs.mkdirSync(jobs.DIR, {recursive: true});
fs.mkdirSync(path.join(dir, 'watch'));
fs.writeFileSync(path.join(jobs.DIR, 'w.md'), `---\nname: "@someone 새 글"\nevery: 30m\ncwd: ${path.join(dir, 'watch')}\ntools: edit\n---\n새 글 있으면 알려줘\n`);
let s = jobs.snapshot();
assert.equal(s.jobs[0].name, '@someone 새 글');
// Under 「알아서 하기」 (the default) and 「전부 허용」 a job runs without a one-time approval; under 「전부 물어보기」 an edit
// or full job waits for one, and the approval is for the file as it is.
assert.equal(jobs.approveLevel(), 'auto');
assert.equal(s.jobs[0].needsApproval, false);
process.env.DEC_INTERN_APPROVE = 'ask';
s = jobs.snapshot();
assert.equal(s.jobs[0].needsApproval, true);
s = jobs.approve('w');
assert.equal(s.jobs[0].needsApproval, false);
assert.ok(s.jobs[0].nextAt > Date.now());
fs.writeFileSync(path.join(jobs.DIR, 'f.md'), `---\nevery: 30m\ncwd: ${path.join(dir, 'watch')}\ntools: full\n---\nx\n`);
assert.equal(jobs.snapshot().jobs.find(j => j.slug === 'f').needsApproval, true);
process.env.DEC_INTERN_APPROVE = 'auto';
assert.equal(jobs.snapshot().jobs.find(j => j.slug === 'f').needsApproval, false);   // the default asks for no job
process.env.DEC_INTERN_APPROVE = 'all';
assert.equal(jobs.snapshot().jobs.find(j => j.slug === 'f').needsApproval, false);
process.env.DEC_INTERN_APPROVE = 'ask';
fs.rmSync(path.join(jobs.DIR, 'f.md'));
// cu needs full tools.
fs.writeFileSync(path.join(jobs.DIR, 'c.md'), `---\nevery: 5m\ncwd: ${path.join(dir, 'watch')}\ntools: edit\ncu: true\n---\nx\n`);
assert.match(jobs.snapshot().jobs.find(j => j.slug === 'c').error, /cu: true needs tools: full/);

// The Claude app's sessions: judged by the last real message, not the bookkeeping after it.
const proj = path.join(watch.PROJECTS, '-Users-x-app');
fs.mkdirSync(proj, {recursive: true});
const now = Date.now();
const session = (id, lines, minutesAgo = 0) => {
  const f = path.join(proj, `${id}.jsonl`);
  const head = {type: 'user', entrypoint: 'claude-desktop', cwd: '/Users/x/app', message: {role: 'user', content: '시작'}};
  fs.writeFileSync(f, [head, ...lines, {type: 'cost-state'}, {type: 'last-prompt', lastPrompt: id}].map(l => JSON.stringify({entrypoint: 'sdk-cli', ...l})).join('\n') + '\n');
  const t = (now - minutesAgo * 60e3) / 1000;
  fs.utimesSync(f, t, t);
  return f;
};
const asst = (content, extra = {}) => ({type: 'assistant', message: {role: 'assistant', content}, ...extra});
const state = (f) => watch.judge(f, now);

let r = state(session('limit', [asst([{type: 'text', text: "You've hit your session limit · resets 10:50am"}], {isApiErrorMessage: true, error: 'rate_limit'})], 2));
assert.equal(r.state, '멈춤'); assert.match(r.why, /^한도: You've hit your session limit/); assert.equal(r.desktop, true);
r = state(session('error', [asst([{type: 'text', text: 'API Error: 500'}], {isApiErrorMessage: true, error: 'unknown'})]));
assert.equal(r.state, '멈춤'); assert.match(r.why, /^오류:/);
r = state(session('running', [asst([{type: 'tool_use', name: 'Bash', input: {}}])], 1));
assert.deepEqual([r.state, r.why], ['진행 중', 'Bash 실행 중']);
r = state(session('waiting', [asst([{type: 'tool_use', name: 'Bash', input: {}}])], 25));
assert.equal(r.state, '멈춤'); assert.match(r.why, /25분째 움직임 없음/);
r = state(session('retrying', [{type: 'system', subtype: 'api_error', error: {formatted: 'Connection dropped'}, retryAttempt: 2, maxRetries: 10}], 0));
assert.equal(r.state, '진행 중'); assert.match(r.why, /다시 시도 2\/10/);
r = state(session('stopped', [{type: 'user', message: {role: 'user', content: [{type: 'text', text: '[Request interrupted by user]'}]}}], 3));
assert.equal(r.state, '멈춤');
r = state(session('done', [asst([{type: 'text', text: '다 했어요.'}]), {type: 'user', isMeta: true, message: {role: 'user', content: 'meta'}}], 4));
assert.deepEqual([r.state, r.why], ['끝남', '다 했어요.']);
// A sidechain (a subagent's) message after the answer does not reopen the session.
r = state(session('side', [asst([{type: 'text', text: '끝.'}]), asst([{type: 'tool_use', name: 'Read'}], {isSidechain: true})]));
assert.equal(r.state, '끝남');
// Dec Intern's own `claude -p` runs are not the app's; `all` includes them.
fs.writeFileSync(path.join(proj, 'cli.jsonl'), JSON.stringify(asst([{type: 'text', text: 'ok'}], {entrypoint: 'sdk-cli'})) + '\n');
assert.ok(!watch.sessions({now}).some(x => x.id === 'cli'));
assert.ok(watch.sessions({now, all: true}).some(x => x.id === 'cli'));
assert.match((await watch.WATCH_TOOLS.claude_sessions.run({}, {title: 'limit'})).text, /^멈춤 · limit/);

console.log('jobs-check: all good');
