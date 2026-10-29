#!/usr/bin/env node
// bisu's own engine, behind the same command-line protocol bisu already speaks.
//
// launch.zsh starts this instead of Claude Code when BISU_ENGINE=native, with the flags it always
// passes, so the chat page (stream-json in and out, approvals over stdio, interrupt, queued
// messages, resume) and the one-shot runs of scheduled jobs and suggestions (-p --output-format
// json) work unchanged. Only the subset of flags bisu uses is understood; the rest is ignored.
//
// The model is Z.ai GLM (engine/glm.mjs). Tools are engine/tools.mjs. Conversations are kept by
// engine/store.mjs.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {runTurn} from './loop.mjs';
import {TOOLS, insideCwd, resolvePath} from './tools.mjs';
import {Transcript, loadMessages} from './store.mjs';
import * as judge from './judge.mjs';
import {BISU_TOOLS, isDefaultBot} from './bisu-tools.mjs';
import * as rules from '../ui/rules.mjs';
import {CALENDAR_TOOLS, nowLines} from './calendar.mjs';
import {BROWSER_TOOLS} from './browser.mjs';
import {WATCH_TOOLS} from '../ui/claude-watch.mjs';
import {connect as connectMcp} from './mcp.mjs';
import {complete} from './glm.mjs';

// ---- arguments ----
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('-')) { positional.push(a); continue }
  const k = a.replace(/^-+/, '');
  const takes = ['input-format', 'output-format', 'resume', 'append-system-prompt-file', 'system-prompt-file', 'tools', 'permission-mode', 'agents', 'mcp-config', 'settings', 'effort', 'allowedTools', 'allowed-tools', 'permission-prompt-tool', 'model'];
  if (takes.includes(k)) flags[k] = argv[++i]; else flags[k] = true;
}
const PRINT = !!(flags.p || flags.print);
const STREAM_IN = flags['input-format'] === 'stream-json';
const OUT = flags['output-format'] || 'text';
const PARTIAL = !!flags['include-partial-messages'];
const REPLAY = !!flags['replay-user-messages'];
const PROMPT_TOOL = flags['permission-prompt-tool'] === 'stdio';
const MODE = flags['dangerously-skip-permissions'] ? 'bypassPermissions' : (flags['permission-mode'] || 'default');
// --effort (launch.zsh passes BISU_EFFORT as it) is the base reasoning level; judge.planTurn reads it.
if (['low', 'medium', 'high'].includes(flags.effort)) process.env.BISU_EFFORT = flags.effort;
const cwd = fs.realpathSync(process.cwd());

// Claude Code's tool names, as launch.zsh and the jobs still spell them, to this engine's tools.
const NAME = {Read: 'read_file', Write: 'write_file', Edit: 'edit_file', MultiEdit: 'edit_file', Glob: 'list_files', Grep: 'search_files', Bash: 'run_command', WebFetch: 'web_fetch', WebSearch: 'web_search', Task: 'delegate', Agent: 'delegate'};
const plain = n => String(n).trim().replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
const EXTRA = {...BISU_TOOLS, ...CALENDAR_TOOLS, ...BROWSER_TOOLS, ...WATCH_TOOLS};
let wanted = flags.tools && flags.tools !== 'default'
  ? [...new Set(flags.tools.split(',').map(t => NAME[t.trim()] || t.trim()).filter(t => TOOLS[t] || EXTRA[t] || t === 'delegate'))]
  : [...Object.keys(TOOLS), 'web_search', 'delegate'];
// A run that may change files (a chat, an edit job) also gets memory, scheduling, bots and the calendar;
// one that only reads (a read job, like a morning summary) may still read the calendar and the Claude app's sessions.
if (wanted.includes('write_file')) wanted.push('remember', 'forget', 'profile_set', 'memory_compact', ...(isDefaultBot() ? ['bot_memory'] : []), 'schedule_job', 'goal_add', 'goal_list', 'bot_create', 'bot_update', 'routine_save', 'bot_handoff', ...Object.keys(CALENDAR_TOOLS), ...Object.keys(BROWSER_TOOLS), 'claude_sessions');
else if (wanted.includes('read_file')) wanted.push('calendar_list', 'reminders_list', 'claude_sessions');
const preAllowed = new Set(String(flags.allowedTools || flags['allowed-tools'] || '').split(',').map(t => NAME[t.trim()] || plain(t)).filter(Boolean));

// Two GLM models with separate jobs, and Decisions choosing between them for each message
// (judge.planTurn says which and why):
// - GLM-5.3 is the assistant: conversation, memory, schedules, the web, past conversations, the Mac,
//   and the planning of work that bundles several independent pieces (a line naming the parts, one
//   delegate per part, the reports checked when they come back).
// - GLM-5.3-Flash does the work in the folder, and every background worker: on bisu's benchmark it
//   passed every hands-on task, faster and far cheaper than GLM-5.3 (engine/eval/bench.mjs).
// The roles saved for the Claude Code engine (OpenRouter slugs) are not this engine's: it has its own.
const MODEL = flags.model || process.env.BISU_NATIVE_MODEL || 'glm-5.3';
const WORK_MODEL = process.env.BISU_NATIVE_WORK_MODEL || 'glm-5.3-flash';
// How permission works: 'risky' asks only for what the judge does not clear (the default), 'always'
// asks for every change and command.
const APPROVE = process.env.BISU_APPROVE === 'always' ? 'always' : 'risky';

const promptFile = flags['system-prompt-file'] || flags['append-system-prompt-file'];
const system = [
  promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'),
  `\n## Now\n- Folder: ${cwd}\n${nowLines()}\n- macOS, zsh`,
].join('\n');

// ---- session ----
const sessionId = flags.resume && /^[0-9a-f-]{36}$/.test(flags.resume) ? flags.resume : randomUUID();
const messages = (flags.resume && loadMessages(sessionId)) || [];
const transcript = new Transcript(sessionId, cwd);
const usageTotal = {inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0};
let costTotal = 0;

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const out = OUT === 'stream-json' ? emit : () => {};

// ---- permission ----
// Reading anywhere inside the folder, and fetching the web, need nobody. Changing files asks unless
// the mode accepts edits inside the folder; commands ask unless permissions are bypassed. A run with
// no one to ask (no stdio prompt tool) refuses what would have needed asking.
const pending = new Map(); // request_id -> resolve
const always = new Set();
function needsAsking(name, args) {
  if (MODE === 'bypassPermissions' || preAllowed.has(name) || always.has(name)) return false;
  const kind = (TOOLS[name] || EXTRA[name])?.kind;
  const inside = args.path === undefined || insideCwd({cwd}, resolvePath({cwd}, args.path));
  // The folder's rules files are already in the prompt, so reading one again asks nothing, wherever it
  // is (a parent folder, ~/.claude); changing one still asks like any write outside the folder.
  if (kind === 'read') return !inside && !(args.path !== undefined && RULE_FILES.has(resolvePath({cwd}, args.path)));
  // The web, memory, scheduling and the calendar show on the page as steps; asking first would only
  // add friction (an edit/full job still waits for its own approval in Settings). Deleting from the
  // calendar or reminders always asks.
  if (kind === 'net' || kind === 'memory' || kind === 'delegate' || kind === 'calendar') return false;
  if (kind === 'write') return !(MODE === 'acceptEdits' && inside);
  return true;
}
// Never cleared by the judge, whatever it says: these always go to the person.
const RED_FLAGS = /(^|[\s;&|(])(rm|rmdir|mv|sudo|su|chmod|chown|chflags|kill|pkill|killall|dd|mkfs|diskutil|launchctl|defaults|osascript|shortcuts|scp|ssh|rsync|curl|wget|nc|ftp|open|brew|pip3?\s+install|npm\s+(publish|install\s+-g|i\s+-g|uninstall\s+-g)|yarn\s+global|git\s+(push|reset|clean|rebase|filter-branch|checkout\s+--|restore|stash\s+(drop|clear)|branch\s+-D|remote))\b|>\s*[~/]|\bcrontab\b|\bsecurity\b/;
const CLEAR_BELOW = judge.RISK_CLEAR;
let currentRequest = '';
async function canUseTool(name, args) {
  if (!needsAsking(name, args)) return {allow: true};
  // Changes and commands inside the folder that the judge rates harmless run without asking.
  const kind = (TOOLS[name] || EXTRA[name])?.kind;
  const inside = args.path === undefined || insideCwd({cwd}, resolvePath({cwd}, args.path));
  // A new file inside the folder destroys nothing: no judgment needed.
  if (APPROVE === 'risky' && name === 'write_file' && inside && !fs.existsSync(resolvePath({cwd}, args.path))) {
    out({type: 'system', subtype: 'auto_allowed', tool_name: name, input: args, reason: '새 파일', session_id: sessionId});
    return {allow: true};
  }
  if (APPROVE === 'risky' && inside && (kind === 'write' || kind === 'exec') && !(kind === 'exec' && RED_FLAGS.test(String(args.command || ''))) && judge.available()) {
    let existing = null;
    if (name === 'write_file') { try { existing = fs.readFileSync(resolvePath({cwd}, args.path), 'utf8').split('\n').length } catch {} }
    const r = await judge.risk(name, args, {cwd, userText: currentRequest, existing});
    if (r) {
      const worst = Math.max(r.destructive, r.external, r.system);
      out({type: 'system', subtype: 'bisu_judgment', kind: 'risk', tool_name: name, scores: r, cleared: worst < CLEAR_BELOW, session_id: sessionId});
      if (worst < CLEAR_BELOW) {
        out({type: 'system', subtype: 'auto_allowed', tool_name: name, input: args, reason: `위험도 ${worst.toFixed(2)}`, session_id: sessionId});
        return {allow: true};
      }
    }
  }
  if (!PROMPT_TOOL && !process.stdin.isTTY) return {allow: false, message: 'this run cannot ask for permission'};
  if (!PROMPT_TOOL) return terminalAsk(name, args);
  const request_id = randomUUID();
  const answer = new Promise(resolve => pending.set(request_id, resolve));
  const description = (TOOLS[name] || EXTRA[name])?.describe?.({}, args) || undefined;
  emit({type: 'control_request', request_id, request: {subtype: 'can_use_tool', tool_name: name, input: args, ...(description ? {description} : {})}});
  const r = await answer;
  if (r.behavior === 'allow') return {allow: true, args: r.updatedInput || args};
  return {allow: false, message: r.message};
}

// ---- one turn ----
let abort = null;
// ---- long conversations ----
// Past this many characters (about 80k tokens of Korean and code), everything before the new message
// is replaced by a summary the cheap model writes; the transcript keeps both.
// "@봇이름" asks for another bot (bot_handoff), so a message that names one is never a tool-less chat turn.
const mentioned = r => r && r.route === 'chat' && /(^|\s)@[^\s@]/.test(currentRequest) ? {...r, route: 'other'} : r;
const COMPACT_AT = Number(process.env.BISU_COMPACT_CHARS) || 200_000;
async function compactIfLong() {
  const size = JSON.stringify(messages).length;
  if (size < COMPACT_AT || messages.length < 6) return;
  const text = messages.map(m => m.role === 'tool' ? `[도구 결과] ${String(m.content).slice(0, 800)}`
    : m.role === 'assistant' ? `bisu: ${m.content || ''}${(m.tool_calls || []).map(t => `\n[도구 ${t.function.name}] ${t.function.arguments.slice(0, 300)}`).join('')}`
    : `사람: ${m.content}`).join('\n\n').slice(-180_000);
  try {
    const r = await complete({model: 'glm-5.3-flash', thinking: false, maxTokens: 2000, messages: [
      {role: 'system', content: '너는 대화 기록을 요약한다. 이 요약만 보고 대화를 이어갈 수 있어야 한다: 사람이 원한 것, 결정된 것, 바뀐 파일과 그 이유, 남은 일, 사람의 말투와 선호. 한국어, 항목 목록, 1500자 이내.'},
      {role: 'user', content: text}]});
    if (!r.text?.trim()) return;
    messages.length = 0;
    messages.push({role: 'user', content: `[이전 대화 요약]\n${r.text.trim()}`}, {role: 'assistant', content: '알겠어, 이어서 할게.'});
    transcript.summary(r.text.trim());
    out({type: 'system', subtype: 'bisu_judgment', kind: 'compacted', from: size, session_id: sessionId});
  } catch {}
}

// ---- the team: workers do big jobs in the background while bisu keeps talking ----
// bisu briefs a worker and goes on talking with the person; the worker's report comes back as a
// message, read against the brief by the judge. From there bisu can send the work back with feedback
// (the same worker carries on with everything it already did), answer a worker that stopped to ask,
// stop one, or look at where they all are. Workers handed out in the same turn report together, once
// the last of them is done; a question comes through at once.
const AGENTS = (() => { try { return JSON.parse(flags.agents || '{}') } catch { return {} } })();
// The base prompt's working rules, without its voice: a worker reports to bisu, not to the person.
// The folder's CLAUDE.md files (ui/rules.mjs): a worker changes the project's files, so it follows them too.
const FOLDER_RULES = (b => b ? b + '\n' : '')(rules.block(cwd, 6000));
const RULE_FILES = new Set(rules.files(cwd).map(f => f.file));
const WORKING = (s => s.includes('## Working') ? '## Working' + s.split('## Working')[1].split('\n## ')[0] : '')(fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'));
const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files', 'run_command', 'web_fetch', 'web_search'];
const screenTools = () => Object.keys(EXTRA).filter(n => n.startsWith('cu_'));
const ROLES = {
  developer: {label: '개발 담당', tools: () => FILE_TOOLS, about: 'development work of any size: writing, changing or fixing code, tests, scripts, config, builds'},
  publisher: {label: '퍼블리싱 담당', tools: () => FILE_TOOLS, about: 'large markup and styling jobs: a whole page, many components, a layout overhaul'},
  refactorer: {label: '리팩토링 담당', tools: () => FILE_TOOLS, about: 'large refactors across several files or a whole module'},
  researcher: {label: '조사 담당', tools: () => ['web_search', 'web_fetch', 'read_file', 'list_files', 'search_files', 'write_file'],
    about: 'looking things up: web research, comparing options, reading docs or many files, and writing up what it found; changes no code',
    prompt: 'You are a careful researcher. Check what you find against more than one source when it matters, name your sources, and say plainly what you could not confirm. Write a file only if the brief asks for one.'},
  // Works on the screen, so only one at a time, and only when bisu can operate the Mac at all.
  mac: {label: '맥 담당', model: MODEL, tools: () => [...screenTools(), 'calendar_list', 'reminders_list'], screen: true,
    about: 'a longer job in other apps on this Mac, on screen (it takes over the mouse and keyboard while it works; one at a time)'},
};
const roleNames = () => Object.keys(ROLES).filter(k => !ROLES[k].screen || screenTools().length);
const team = new Map();
let wake = null;   // set by the stream mode: queue a message for the main conversation
let turnNo = 0;    // workers handed out in the same turn of bisu's report together
let turnEffort = judge.EFFORT; // the turn's reasoning level; a worker handed out in it keeps it
const MAX_ROUNDS = 4;
const ASK_WAIT_MS = 30 * 60e3;
const active = () => [...team.values()].filter(w => w.status === 'running' || w.status === 'asking');
const STATUS = {running: '하는 중', asking: '묻는 중 · 답을 기다려', done: '끝냄', failed: '끝내지 못함', stopped: '멈춤'};
const clipTo = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s };

// The worker's own way to stop and ask: it waits for bisu's answer_worker (or gives up after a while).
const askTool = w => ({
  description: 'Ask bisu, who gave you this task, something you cannot find out yourself and that blocks the task: a missing detail, or a choice only the person can make. You wait for the answer, then carry on. Never ask about what you can look up or decide sensibly yourself.',
  parameters: {type: 'object', properties: {question: {type: 'string'}}, required: ['question']},
  kind: 'delegate',
  async run(ctx, {question}) {
    if (!wake) return {text: 'Nobody can answer right now. Make the most reasonable choice, and say in your report what you chose and why.'};
    w.status = 'asking'; w.question = String(question);
    out({type: 'system', subtype: 'task_progress', task_id: w.id, description: `질문: ${clipTo(question, 90)}`, session_id: sessionId});
    const answer = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ASK_WAIT_MS);
      const stop = () => { clearTimeout(timer); resolve(null) };
      ctx.signal?.addEventListener('abort', stop, {once: true});
      w.answer = a => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', stop); resolve(a) };
      wake(`(bisu: ${w.label}(작업 ${w.id})이 묻고 있어: "${question}"\n맡긴 일: ${clipTo(w.brief, 400)}\n\n알면 answer_worker로 바로 답해. 사람만 정할 수 있는 거면 사람에게 물어보고, 답을 들으면 answer_worker로 전해. 담당은 답을 기다리며 멈춰 있어.)`);
    });
    w.answer = null; w.question = null;
    if (ctx.signal?.aborted) return {text: 'Stopped.', error: true};
    w.status = 'running';
    return {text: answer == null ? 'No answer came. Make the most reasonable choice, and say in your report what you chose and why.' : `bisu: ${answer}`};
  },
});

// One round of a worker's work: the brief, or feedback on what it reported.
function runRound(w, text, parent) {
  const role = ROLES[w.role];
  w.status = 'running'; w.rounds++; w.reported = false; w.group = turnNo; w.parent = parent || w.parent;
  w.abort = new AbortController();
  const startAt = w.messages.length;
  w.messages.push({role: 'user', content: text});
  out({type: 'system', subtype: 'task_started', task_id: w.id, task_type: 'local_agent', subagent_type: w.role,
    description: (w.rounds > 1 ? '다시 · ' : '') + clipTo(w.rounds > 1 ? text.replace(/^\(bisu의 피드백\)\s*/, '') : w.brief, 120), session_id: sessionId});
  const model = role.model || WORK_MODEL;
  return runTurn({
    model, thinking: true, effort: w.effort, maxSteps: 60, tools: [...role.tools(), 'ask_bisu'], extraTools: {...EXTRA, ask_bisu: askTool(w)}, canUseTool,
    system: `${AGENTS[w.role]?.prompt || role.prompt || 'You are a careful worker.'}\n\n${WORKING}\n\n${FOLDER_RULES}You are a worker for 덱 인턴 (bisu), the person's assistant. Nobody talks to you but bisu. Do the task, check it worked, then report in a few lines: what you did (files, where), how you checked it, anything left open. Never say you did what you did not do. If something only the person can decide blocks you, ask_bisu.\n- Folder: ${cwd}\n${nowLines()}`,
    messages: w.messages,
    ctx: {cwd, readFiles: w.readFiles, signal: w.abort.signal, env: {}},
    shouldContinue: judge.watchProgress(text, w.messages, {startAt}),
    checkAnswer: judge.watchClaims(text),
    onEvent: ev => {
      if (ev.kind === 'tool' && ev.name !== 'ask_bisu') out({type: 'system', subtype: 'task_progress', task_id: w.id, description: `${ev.name} ${ev.input?.path || ev.input?.command || ev.input?.query || ''}`.slice(0, 100), session_id: sessionId});
    },
    onMessage: (m, meta) => {
      if (m.role === 'assistant') {
        const content = [];
        if (meta.text) content.push({type: 'text', text: meta.text});
        for (const c of meta.toolCalls || []) { let input = {}; try { input = JSON.parse(c.arguments || '{}') } catch {} content.push({type: 'tool_use', id: c.id, name: c.name, input}) }
        out({type: 'assistant', message: {model, content}, parent_tool_use_id: w.parent, session_id: sessionId});
      } else if (m.role === 'tool') out({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, is_error: !!meta.error}]}, parent_tool_use_id: w.parent, session_id: sessionId});
    },
  }).catch(e => ({stop: 'error', error: e.message, actions: [], cost: 0})).then(async stats => {
    costTotal += stats.cost || 0;
    w.actions.push(...(stats.actions || []));
    const ok = stats.stop === 'done' || stats.stop === 'judged_done';
    w.status = w.abort.signal.aborted ? 'stopped' : ok ? 'done' : 'failed';
    w.report = stats.text || stats.error || '(보고 없음)';
    // Read against the brief before bisu sees it: a report that does not show the work is a reason to look.
    w.review = w.status === 'done' ? await judge.reviewReport(w.brief, w.actions, w.report, {feedback: w.rounds > 1 ? text : ''}) : null;
    out({type: 'system', subtype: 'task_notification', task_id: w.id, status: w.status === 'done' ? 'completed' : w.status === 'stopped' ? 'stopped' : 'failed', summary: clipTo(w.report, 300), session_id: sessionId});
    if (w.review != null) out({type: 'system', subtype: 'bisu_judgment', kind: 'review', task_id: w.id, confidence: w.review, session_id: sessionId});
    report(w);
    return w;
  });
}

// What a worker actually did, for the record bisu keeps (session_search reads it later): tool and
// target, each once, in order. The arguments are clipped in the log, so the target is picked out by
// name rather than parsed.
function actionsLine(actions) {
  const seen = new Set(), items = [];
  for (const a of actions || []) {
    const m = /"(path|command|pattern|query|url|worker)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(a.args || '');
    const item = `${a.name}${m ? ' ' + clipTo(m[2].replace(/\s+/g, ' '), 60) : ''}${a.ok ? '' : ' (실패)'}`;
    if (seen.has(item)) continue;
    seen.add(item); items.push(item);
  }
  return items.length ? clipTo(items.join(', '), 700) : '(도구를 쓰지 않음)';
}
function reportText(w) {
  const r = w.review, n = r == null ? '' : ` (${r.toFixed(2)})`;
  const review = r == null ? '' : r >= judge.REVIEW.short
    ? `\n검토: 보고와 실제로 한 일을 맞춰 보면 맡긴 일 중 빠졌거나 확인되지 않은 게 있어 보여${n}. 직접 확인하고, 모자라면 send_back으로 무엇이 모자란지 구체적으로 되돌려 보내.`
    : r >= judge.REVIEW.unsure
      ? `\n검토: 맡긴 일 중 일부가 빠졌을 수 있어${n}. 맡긴 일을 항목마다 결과와 맞춰 봐.`
      : `\n검토: 보고가 맡긴 일과 맞아 보여${n}. 그래도 결과를 한 번 직접 봐.`;
  return `[${w.label} · 작업 ${w.id} · ${STATUS[w.status]}${w.rounds > 1 ? ` · ${w.rounds}번째` : ''}]\n맡긴 일: ${clipTo(w.brief, 500)}\n한 일: ${actionsLine(w.actions)}\n보고: ${clipTo(w.report, 3000)}${review}`;
}
// When the last worker of a turn is done, bisu hears from all of them at once. One the person stopped
// from the page needs no word from bisu, but it no longer holds the others back.
function report(w) {
  if (!wake) return;
  if (w.status === 'stopped') { w.reported = true; if (w.stoppedBy === 'bisu') return }
  const group = [...team.values()].filter(x => x.group === w.group);
  if (group.some(x => x.status === 'running' || x.status === 'asking')) return;
  const due = group.filter(x => !x.reported);
  if (!due.length) return;
  for (const x of due) x.reported = true;
  wake(`(bisu: 맡긴 일${due.length > 1 ? ` ${due.length}개가` : '이'} 끝났어. 사람에게 알리기 전에 확인해.\n\n${due.map(reportText).join('\n\n')}\n\n할 일: 결과를 직접 확인하고(파일을 읽거나 실행해 봐), 맡긴 일과 다르거나 모자라면 send_back으로 그 담당에게 되돌려 보내. 다 됐으면 사람에게 무엇이 됐는지 짧게 알려줘.)`);
}

const workerArg = {type: 'string', description: 'The task id from delegate.'};
const findWorker = id => team.get(String(id || '').trim());
EXTRA.delegate = {
  get description() {
    return `Hand a sizeable piece of work to a worker that does it in the background while you keep talking with the person. Workers: ${roleNames().map(k => `${k} — ${AGENTS[k]?.description ? clipTo(AGENTS[k].description, 160) : ROLES[k].about}`).join(' | ')}. Give one complete brief: the files, the goal, what done looks like. To split a job, call delegate once per part in the same turn; they report together when the last one is done. The report comes back as a message: check it, and send_back what is wrong or missing.`;
  },
  get parameters() { return {type: 'object', properties: {worker: {type: 'string', enum: roleNames()}, task: {type: 'string'}}, required: ['worker', 'task']} },
  kind: 'delegate',
  async run(ctx, {worker, task}) {
    const role = ROLES[worker] && roleNames().includes(worker) ? worker : 'developer';
    if (ROLES[role].screen && active().some(w => ROLES[w.role].screen)) return {text: '맥 담당이 이미 화면을 쓰고 있어. 그 일이 끝난 뒤에 맡겨.', error: true};
    const w = {id: randomUUID().slice(0, 8), role, label: ROLES[role].label, brief: String(task), messages: [], readFiles: new Set(), actions: [], rounds: 0, status: 'running', parent: ctx.callId || null, effort: turnEffort};
    team.set(w.id, w);
    const job = runRound(w, String(task), ctx.callId);
    if (wake) return {text: `${w.label}에게 맡겼어 (작업 ${w.id}). 끝나면 보고가 메시지로 와. 사람에게 맡겼다고 한 줄로 말하고 이번 답을 마쳐.`};
    // A one-shot run has nobody to come back to: it waits for the report.
    await job;
    return {text: `${w.label} 보고 (${STATUS[w.status]}):\n${w.report}`, error: w.status !== 'done'};
  },
};
EXTRA.send_back = {
  description: 'Send a worker\'s finished work back with feedback: what is wrong or missing, specifically. The same worker carries on with everything it already did, and reports again.',
  parameters: {type: 'object', properties: {task_id: workerArg, feedback: {type: 'string'}}, required: ['task_id', 'feedback']},
  kind: 'delegate',
  async run(ctx, {task_id, feedback}) {
    const w = findWorker(task_id);
    if (!w) return {text: `작업 ${task_id}은 없어 (오래돼서 정리됐을 수 있어). 필요하면 delegate로 새로 맡겨.`, error: true};
    if (w.status === 'running' || w.status === 'asking') return {text: `${w.label}은 아직 하는 중이야. 보고를 기다리거나, 방향이 틀렸으면 stop_worker로 멈춘 뒤 다시 맡겨.`, error: true};
    if (w.rounds >= MAX_ROUNDS) return {text: `${w.label}에게 이미 ${w.rounds}번 맡겼어. 더 되돌리지 말고, 사람에게 지금 상태와 막힌 점을 말하고 어떻게 할지 물어봐.`, error: true};
    if (ROLES[w.role].screen && active().some(x => ROLES[x.role].screen)) return {text: '맥 담당이 이미 화면을 쓰고 있어. 그 일이 끝난 뒤에 되돌려 보내.', error: true};
    const job = runRound(w, `(bisu의 피드백) ${feedback}\n\n이 피드백대로 고치고, 확인한 다음 다시 짧게 보고해.`, ctx.callId);
    if (wake) return {text: `${w.label}에게 되돌려 보냈어 (작업 ${w.id}, ${w.rounds}번째). 끝나면 다시 보고가 와. 사람에게 한 줄로 말하고 이번 답을 마쳐.`};
    await job;
    return {text: `${w.label} 보고 (${STATUS[w.status]}):\n${w.report}`, error: w.status !== 'done'};
  },
};
EXTRA.answer_worker = {
  description: 'Answer a worker that stopped to ask you something. It carries on with your answer.',
  parameters: {type: 'object', properties: {task_id: workerArg, answer: {type: 'string'}}, required: ['task_id', 'answer']},
  kind: 'delegate',
  async run(ctx, {task_id, answer}) {
    const w = findWorker(task_id);
    if (!w || w.status !== 'asking' || !w.answer) return {text: `작업 ${task_id}은 지금 답을 기다리고 있지 않아.`, error: true};
    w.answer(String(answer));
    return {text: `${w.label}에게 전했어. 이어서 하고 있어.`};
  },
};
EXTRA.stop_worker = {
  description: 'Stop a worker that is going the wrong way or is no longer needed.',
  parameters: {type: 'object', properties: {task_id: workerArg}, required: ['task_id']},
  kind: 'delegate',
  async run(ctx, {task_id}) {
    const w = findWorker(task_id);
    if (!w || !(w.status === 'running' || w.status === 'asking')) return {text: `작업 ${task_id}은 지금 하고 있지 않아.`, error: true};
    w.stoppedBy = 'bisu'; w.abort.abort(new Error('stopped'));
    return {text: `${w.label}을 멈췄어.`};
  },
};
EXTRA.team_status = {
  description: 'Where every worker of this conversation is: what each was given, whether it is working, asking or done, and its last report.',
  parameters: {type: 'object', properties: {}},
  kind: 'delegate',
  async run() {
    if (!team.size) return {text: '맡긴 일이 없어.'};
    return {text: [...team.values()].map(w => `${w.label} · 작업 ${w.id} · ${STATUS[w.status]}${w.rounds > 1 ? ` · ${w.rounds}번째` : ''}\n맡긴 일: ${clipTo(w.brief, 200)}${w.question ? `\n묻는 것: ${w.question}` : ''}${w.report && w.status !== 'running' ? `\n보고: ${clipTo(w.report, 400)}` : ''}`).join('\n\n')};
  },
};
const TEAM_TOOLS = ['send_back', 'answer_worker', 'stop_worker', 'team_status'];
if (wanted.includes('delegate')) wanted.push(...TEAM_TOOLS);
// A turn that only carries the team's news (a report, a question) is bisu's own business: no routing
// (a report could pass for small talk and lose its tools), the assistant's model, and no claims check
// (what it tells the person was done by the worker, and the report was already read against the brief).
const wakeTexts = new Set();
const TEAM_HINT = 'This message is from your team, not from the person. Deal with it (check, send_back, answer_worker), then tell the person in a line or two only what they need to know.';
// The page's stop button on one worker.
function stopWorker(id) { const w = findWorker(id); if (w && (w.status === 'running' || w.status === 'asking')) { w.stoppedBy = 'person'; w.abort.abort(new Error('stopped')) } }

async function turn(text, {team = false} = {}) {
  currentRequest = text;
  turnNo++;
  await compactIfLong();
  const t0 = Date.now();
  // What kind of request this is decides who answers (GLM-5.3, or Flash for work in the folder;
  // GLM-5.3 again when the work is several jobs, to split it), whether tools are offered, and a
  // one-line hint.
  const recent = messages.slice(-6).filter(m => m.role !== 'tool').map(m => `${m.role === 'user' ? '사람' : 'bisu'}: ${String(m.content || '').slice(0, 200)}`).join('\n');
  const r = team ? null : await judge.route(text, {recent, folder: judge.folderSummary(cwd)});
  const {model, tools, thinking, effort, hint, split} = team ? {model: MODEL, tools: wanted, thinking: true, effort: judge.EFFORT, hint: TEAM_HINT} : judge.planTurn(mentioned(r), {model: MODEL, workModel: WORK_MODEL, tools: wanted});
  turnEffort = effort;
  if (r) out({type: 'system', subtype: 'bisu_judgment', kind: 'route', route: r.route, confidence: r.confidence, hard: r.hard, split: r.split, planned: !!split, model, effort, session_id: sessionId});
  messages.push({role: 'user', content: text});
  transcript.user(text);
  abort = new AbortController();
  const ctx = {cwd, readFiles: new Set(), signal: abort.signal, env: {}};
  let msgId = 0;
  const startAt = messages.length;
  const stats = await runTurn({
    model, system: hint ? `${system}\n\n## This request\n${hint}` : system, messages, tools, extraTools: EXTRA, ctx, thinking, effort, canUseTool,
    // Every few steps of a long turn, ask whether it is still going somewhere.
    shouldContinue: judge.watchProgress(text, messages, {startAt, onJudgment: p =>
      out({type: 'system', subtype: 'bisu_judgment', kind: 'progress', state: p.state, confidence: p.confidence, session_id: sessionId})}),
    // An answer that claims a change no tool made this turn is sent back once to do it or say so.
    checkAnswer: team ? null : judge.watchClaims(text, {onJudgment: c =>
      out({type: 'system', subtype: 'bisu_judgment', kind: 'claim', confidence: c.p, acted: c.acted, session_id: sessionId})}),
    onMessage: (m, meta) => {
      if (m.role === 'assistant') {
        const id = `msg_${sessionId.slice(0, 8)}_${Date.now()}_${msgId++}`;
        transcript.assistant({model: 'z-ai/' + model, text: meta.text, toolCalls: meta.toolCalls, usage: meta.usage, id});
        const u = meta.usage || {};
        const cached = u.prompt_tokens_details?.cached_tokens || 0;
        usageTotal.inputTokens += (u.prompt_tokens || 0) - cached; usageTotal.cacheReadInputTokens += cached; usageTotal.outputTokens += u.completion_tokens || 0;
        const content = [];
        if (meta.text) content.push({type: 'text', text: meta.text});
        for (const c of meta.toolCalls || []) { let input = {}; try { input = JSON.parse(c.arguments || '{}') } catch { input = {raw: c.arguments} } content.push({type: 'tool_use', id: c.id, name: c.name, input}) }
        out({type: 'assistant', message: {id, model, content, usage: u}, parent_tool_use_id: null, session_id: sessionId});
      } else if (m.role === 'tool') {
        transcript.toolResult(m.tool_call_id, m.content, meta.error);
        out({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, is_error: !!meta.error}]}, parent_tool_use_id: null, session_id: sessionId});
      }
    },
    onEvent: ev => {
      if (ev.kind === 'delta' && PARTIAL) out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: ev.text}}, parent_tool_use_id: null, session_id: sessionId});
      if (ev.kind === 'delta' && OUT === 'text' && !PRINT) process.stdout.write(ev.text);
    },
  });
  abort = null;
  costTotal += stats.cost || 0;
  const result = {type: 'result', subtype: stats.stop === 'error' ? 'error_during_execution' : 'success', is_error: stats.stop === 'error' || stats.stop === 'filtered',
    num_turns: stats.steps, duration_ms: Date.now() - t0, result: stats.text || stats.error || '', session_id: sessionId,
    total_cost_usd: costTotal + judge.cost(), modelUsage: {['z-ai/' + MODEL]: usageTotal}, bisu_native: true, stop: stats.stop, route: r?.route || null, model};
  return result;
}

// ---- bisu's MCP server: past sessions and computer use ----
if (flags['mcp-config']) {
  const mcp = await connectMcp(flags['mcp-config']).catch(() => null);
  if (mcp) {
    // The MCP server also carries the calendar, web search and goals for Claude Code chats; this
    // engine has its own, with their own permission kinds.
    for (const [n, t] of Object.entries(mcp.tools)) if (!EXTRA[n]) EXTRA[n] = t;
    if (wanted.includes('write_file') || wanted.includes('read_file')) for (const n of Object.keys(mcp.tools)) if (!wanted.includes(n) && (n.startsWith('session_') || wanted.includes('write_file'))) wanted.push(n);
    process.on('exit', () => mcp.close());
  }
}

// ---- modes ----
if (STREAM_IN) {
  // The chat page: messages and answers arrive as JSON lines; a message sent while a turn runs waits
  // and is taken with any others at the start of the next turn.
  out({type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd, tools: wanted, bisu_native: true});
  const queue = [];
  let busy = false, closing = false;
  // A worker that finishes wakes the conversation with its report, as if the person had said it.
  wake = text => { wakeTexts.add(text); queue.push(text); pump() };
  const pump = async () => {
    if (busy || !queue.length) { if (!busy && closing && !active().length) process.exit(0); return }
    busy = true;
    const taken = queue.splice(0);
    if (REPLAY) for (const t of taken) out({type: 'user', message: {role: 'user', content: t}, session_id: sessionId});
    const team = taken.every(t => wakeTexts.has(t));
    for (const t of taken) wakeTexts.delete(t);
    const result = await turn(taken.join('\n\n'), {team});
    out(result);
    busy = false;
    pump();
  };
  const rl = readline.createInterface({input: process.stdin});
  rl.on('line', line => {
    let j; try { j = JSON.parse(line) } catch { return }
    if (j.type === 'user') {
      const c = j.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
      if (text) { queue.push(text); pump() }
    } else if (j.type === 'control_response') {
      const r = j.response || {};
      const resolve = pending.get(r.request_id);
      if (resolve) { pending.delete(r.request_id); resolve(r.response || {behavior: 'deny'}) }
    } else if (j.type === 'control_request' && j.request?.subtype === 'stop_task') {
      stopWorker(j.request.task_id);
      emit({type: 'control_response', response: {subtype: 'success', request_id: j.request_id}});
    } else if (j.type === 'control_request' && j.request?.subtype === 'interrupt') {
      abort?.abort(new Error('interrupted'));
      for (const [id, resolve] of pending) { pending.delete(id); resolve({behavior: 'deny', message: 'stopped'}) }
      emit({type: 'control_response', response: {subtype: 'success', request_id: j.request_id}});
    }
  });
  rl.on('close', () => {
    closing = true;
    // Nobody is left to answer a worker that asked.
    for (const w of team.values()) w.answer?.(null);
    if (!busy && !active().length) process.exit(0);
  });
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { abort?.abort(); process.exit(143) });
} else if (PRINT) {
  // One-shot: the prompt is the argument (or stdin), the answer goes to stdout as text or JSON.
  let prompt = positional.join(' ');
  if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.trim()) { console.error('bisu: no prompt'); process.exit(2) }
  const result = await turn(prompt.trim());
  if (OUT === 'json') process.stdout.write(JSON.stringify(result) + '\n');
  else if (OUT === 'stream-json') emit(result);
  else process.stdout.write((result.result || '') + '\n');
  process.exit(result.is_error ? 1 : 0);
} else {
  // In a terminal: a plain conversation, with permission asked on the same line.
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  console.log(`bisu (${MODEL}) · ${cwd}${flags.resume ? ' · 이어서' : ''}\n끝내려면 Ctrl-D\n`);
  const ask = q => new Promise(r => rl.question(q, r));
  globalThis.terminalAskImpl = async (name, args) => {
    const what = name === 'run_command' ? args.command : name === 'edit_file' || name === 'write_file' ? `${name} ${args.path}` : `${name} ${JSON.stringify(args).slice(0, 120)}`;
    const a = (await ask(`\n  허용할까요? ${what}  [y/N/a=이번 대화 내내] `)).trim().toLowerCase();
    if (a === 'a') { always.add(name); return {allow: true} }
    return a === 'y' || a === 'yes' ? {allow: true} : {allow: false, message: '사용자가 거절함'};
  };
  for (;;) {
    const text = await ask('› ').catch(() => null);
    if (text == null) break;
    if (!text.trim()) continue;
    const r = await turn(text.trim());
    process.stdout.write('\n' + (r.is_error ? `(${r.result})\n` : '') + '\n');
  }
  rl.close();
}
function terminalAsk(name, args) { return globalThis.terminalAskImpl ? globalThis.terminalAskImpl(name, args) : {allow: false, message: 'no terminal'} }
