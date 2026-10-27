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
import {BISU_TOOLS} from './bisu-tools.mjs';
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
const cwd = fs.realpathSync(process.cwd());

// Claude Code's tool names, as launch.zsh and the jobs still spell them, to this engine's tools.
const NAME = {Read: 'read_file', Write: 'write_file', Edit: 'edit_file', MultiEdit: 'edit_file', Glob: 'list_files', Grep: 'search_files', Bash: 'run_command', WebFetch: 'web_fetch', WebSearch: 'web_search', Task: 'delegate', Agent: 'delegate'};
const plain = n => String(n).trim().replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
const EXTRA = {...BISU_TOOLS};
let wanted = flags.tools && flags.tools !== 'default'
  ? [...new Set(flags.tools.split(',').map(t => NAME[t.trim()] || t.trim()).filter(t => TOOLS[t] || EXTRA[t] || t === 'delegate'))]
  : [...Object.keys(TOOLS), 'web_search', 'delegate'];
// A run that may change files (a chat, an edit job) also gets memory and scheduling.
if (wanted.includes('write_file')) wanted.push('remember', 'forget', 'schedule_job');
const preAllowed = new Set(String(flags.allowedTools || flags['allowed-tools'] || '').split(',').map(t => NAME[t.trim()] || plain(t)).filter(Boolean));

// Two GLM models with separate jobs, and Decisions choosing between them for each message
// (judge.planTurn says which and why):
// - GLM-5.3 is the assistant: conversation, memory, schedules, the web, past conversations, the Mac.
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
  `\n## Now\n- Folder: ${cwd}\n- Time: ${new Date().toLocaleString('ko-KR', {dateStyle: 'full', timeStyle: 'short'})}\n- macOS, zsh`,
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
  if (kind === 'read') return !inside;
  // The web, memory and scheduling show on the page as steps; asking first would only add friction
  // (an edit/full job still waits for its own approval in Settings).
  if (kind === 'net' || kind === 'memory' || kind === 'delegate') return false;
  if (kind === 'write') return !(MODE === 'acceptEdits' && inside);
  return true;
}
// Never cleared by the judge, whatever it says: these always go to the person.
const RED_FLAGS = /(^|[\s;&|(])(rm|rmdir|mv|sudo|su|chmod|chown|chflags|kill|pkill|killall|dd|mkfs|diskutil|launchctl|defaults|osascript|shortcuts|scp|ssh|rsync|curl|wget|nc|ftp|open|brew|pip3?\s+install|npm\s+(publish|install\s+-g|i\s+-g|uninstall\s+-g)|yarn\s+global|git\s+(push|reset|clean|rebase|filter-branch|checkout\s+--|restore|stash\s+(drop|clear)|branch\s+-D|remote))\b|>\s*[~/]|\bcrontab\b|\bsecurity\b/;
const CLEAR_BELOW = 0.15; // from engine/eval/judge-bench.mjs: 19/20 safe commands cleared, 0/20 risky ones
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
  emit({type: 'control_request', request_id, request: {subtype: 'can_use_tool', tool_name: name, input: args}});
  const r = await answer;
  if (r.behavior === 'allow') return {allow: true, args: r.updatedInput || args};
  return {allow: false, message: r.message};
}

// ---- one turn ----
let abort = null;
// ---- long conversations ----
// Past this many characters (about 80k tokens of Korean and code), everything before the new message
// is replaced by a summary the cheap model writes; the transcript keeps both.
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

// ---- workers: big jobs run in the background while bisu keeps talking ----
const AGENTS = (() => { try { return JSON.parse(flags.agents || '{}') } catch { return {} } })();
// The base prompt's working rules, without its voice: a worker reports to bisu, not to the person.
const WORKING = (s => s.includes('## Working') ? '## Working' + s.split('## Working')[1].split('\n## ')[0] : '')(fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'));
const WORKER_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files', 'run_command', 'web_fetch', 'web_search'];
const running = new Map();
let wake = null; // set by the stream mode: queue a message for the main conversation
EXTRA.delegate = {
  description: `Hand a sizeable piece of work to a worker that does it in the background while you keep talking with the person. Workers: ${Object.entries(AGENTS).filter(([k]) => k !== 'mac').map(([k, v]) => `${k} — ${String(v.description || '').slice(0, 160)}`).join(' | ') || 'developer — any development work'}. Give one complete brief: the files, the goal, what done looks like. You will get the result as a message when it is done; check it then.`,
  parameters: {type: 'object', properties: {worker: {type: 'string', enum: Object.keys(AGENTS).filter(k => k !== 'mac').length ? Object.keys(AGENTS).filter(k => k !== 'mac') : ['developer']}, task: {type: 'string'}}, required: ['worker', 'task']},
  kind: 'delegate',
  async run(ctx, {worker, task}) {
    const def = AGENTS[worker] || AGENTS.developer || {prompt: 'You are a careful developer.'};
    const task_id = randomUUID().slice(0, 8);
    const parent = ctx.callId || null;
    const label = {developer: '개발 담당', publisher: '퍼블리싱 담당', refactorer: '리팩토링 담당'}[worker] || worker;
    const wModel = WORK_MODEL;
    const wAbort = new AbortController();
    running.set(task_id, wAbort);
    out({type: 'system', subtype: 'task_started', task_id, task_type: 'local_agent', subagent_type: worker, description: String(task).slice(0, 120), session_id: sessionId});
    const job = runTurn({
      model: wModel, thinking: true, tools: WORKER_TOOLS, extraTools: EXTRA, canUseTool,
      system: `${def.prompt || ''}\n\n${WORKING}\n\nYou are a worker for bisu. Nobody talks to you; do the task, verify it, then report in a few lines: what changed (files), how you checked it, anything left open.\n- Folder: ${cwd}`,
      messages: [{role: 'user', content: String(task)}],
      ctx: {cwd, readFiles: new Set(), signal: wAbort.signal, env: {}},
      onEvent: ev => {
        if (ev.kind === 'tool') out({type: 'system', subtype: 'task_progress', task_id, description: `${ev.name} ${ev.input?.path || ev.input?.command || ''}`.slice(0, 100), session_id: sessionId});
      },
      onMessage: (m, meta) => {
        if (m.role === 'assistant') {
          const content = [];
          if (meta.text) content.push({type: 'text', text: meta.text});
          for (const c of meta.toolCalls || []) { let input = {}; try { input = JSON.parse(c.arguments || '{}') } catch {} content.push({type: 'tool_use', id: c.id, name: c.name, input}) }
          out({type: 'assistant', message: {model: wModel, content}, parent_tool_use_id: parent, session_id: sessionId});
        } else if (m.role === 'tool') out({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, is_error: !!meta.error}]}, parent_tool_use_id: parent, session_id: sessionId});
      },
    }).then(stats => {
      running.delete(task_id);
      costTotal += stats.cost || 0;
      const ok = stats.stop === 'done' || stats.stop === 'judged_done';
      out({type: 'system', subtype: 'task_notification', task_id, status: ok ? 'completed' : 'failed', summary: (stats.text || '').slice(0, 300), session_id: sessionId});
      return {ok, text: stats.text || stats.error || '(no report)'};
    }).catch(e => { running.delete(task_id); out({type: 'system', subtype: 'task_notification', task_id, status: 'failed', session_id: sessionId}); return {ok: false, text: e.message} });
    // Talking to someone: hand it off and report back when done. A one-shot run waits for it.
    if (wake) {
      job.then(r => wake(`(bisu: ${label}이 맡긴 일을 ${r.ok ? '끝냈어' : '끝내지 못했어'}. 보고:\n${r.text}\n\n필요하면 결과를 직접 확인하고, 사람에게 짧게 알려줘.)`));
      return {text: `${label}에게 맡겼어 (작업 ${task_id}). 끝나면 결과가 메시지로 와. 사람에게 맡겼다고 한 줄로 말하고 이번 답을 마쳐.`};
    }
    const r = await job;
    return {text: `${label} 보고 (${r.ok ? '완료' : '실패'}):\n${r.text}`, error: !r.ok};
  },
};

async function turn(text) {
  currentRequest = text;
  await compactIfLong();
  const t0 = Date.now();
  // What kind of request this is decides who answers (GLM-5.3, or Flash for work in the folder),
  // whether tools are offered, and a one-line hint.
  const recent = messages.slice(-6).filter(m => m.role !== 'tool').map(m => `${m.role === 'user' ? '사람' : 'bisu'}: ${String(m.content || '').slice(0, 200)}`).join('\n');
  const r = await judge.route(text, {recent, folder: judge.folderSummary(cwd)});
  const {model, tools, thinking, hint} = judge.planTurn(r, {model: MODEL, workModel: WORK_MODEL, tools: wanted});
  if (r) out({type: 'system', subtype: 'bisu_judgment', kind: 'route', route: r.route, confidence: r.confidence, hard: r.hard, model, session_id: sessionId});
  messages.push({role: 'user', content: text});
  transcript.user(text);
  abort = new AbortController();
  const ctx = {cwd, readFiles: new Set(), signal: abort.signal, env: {}};
  let msgId = 0, lastJudged = 0, circles = 0;
  const startAt = messages.length;
  const stats = await runTurn({
    model, system: hint ? `${system}\n\n## This request\n${hint}` : system, messages, tools, extraTools: EXTRA, ctx, thinking, canUseTool,
    // Every few steps of a long turn, ask whether it is still going somewhere.
    shouldContinue: async ({stats}) => {
      if (stats.steps < 5 || stats.steps - lastJudged < 3 || !judge.available()) return true;
      lastJudged = stats.steps;
      const steps = messages.slice(startAt).map(m => m.role === 'assistant'
        ? (m.tool_calls || []).map(t => `→ ${t.function.name} ${t.function.arguments.slice(0, 160)}`).join('\n') + (m.content ? `\n(said) ${String(m.content).slice(0, 200)}` : '')
        : m.role === 'tool' ? `   ${String(m.content).split('\n')[0].slice(0, 160)}` : '').filter(Boolean).join('\n');
      const p = await judge.progress(text, steps);
      if (!p) return true;
      out({type: 'system', subtype: 'bisu_judgment', kind: 'progress', state: p.state, confidence: p.confidence, session_id: sessionId});
      if (p.state === 'repeating' && p.confidence >= 0.75) {
        if (++circles >= 3) return false;
        return {nudge: '같은 방법을 반복하고 있어. 접근을 바꾸거나, 지금까지 알아낸 것으로 답해.'};
      }
      if (p.state === 'finished' && p.confidence >= 0.85) return {nudge: '이제 충분해. 도구는 그만 쓰고 사람에게 답해.'};
      if (p.state === 'blocked' && p.confidence >= 0.8) return {nudge: '사람의 확인이나 정보가 필요하면 지금 짧게 물어봐.'};
      return true;
    },
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
    total_cost_usd: costTotal + judge.usage.inputTokens / 1e6 * 0.10, modelUsage: {['z-ai/' + MODEL]: usageTotal}, bisu_native: true, stop: stats.stop, route: r?.route || null, model};
  return result;
}

// ---- bisu's MCP server: past sessions and computer use ----
if (flags['mcp-config']) {
  const mcp = await connectMcp(flags['mcp-config']).catch(() => null);
  if (mcp) {
    Object.assign(EXTRA, mcp.tools);
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
  wake = text => { queue.push(text); pump() };
  const pump = async () => {
    if (busy || !queue.length) { if (!busy && closing && !running.size) process.exit(0); return }
    busy = true;
    const taken = queue.splice(0);
    if (REPLAY) for (const t of taken) out({type: 'user', message: {role: 'user', content: t}, session_id: sessionId});
    const result = await turn(taken.join('\n\n'));
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
    } else if (j.type === 'control_request' && j.request?.subtype === 'interrupt') {
      abort?.abort(new Error('interrupted'));
      for (const [id, resolve] of pending) { pending.delete(id); resolve({behavior: 'deny', message: 'stopped'}) }
      emit({type: 'control_response', response: {subtype: 'success', request_id: j.request_id}});
    }
  });
  rl.on('close', () => { closing = true; if (!busy && !running.size) process.exit(0) });
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
