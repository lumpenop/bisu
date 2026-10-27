// bisu's judgments, made by OpenAI's Decisions API (gpt-6-luna): GLM talks and acts, this decides.
//
// Every judgment is a few multiple-choice or yes/no questions answered with probabilities, never
// free text. Each caller turns those into an action only above a threshold set from labeled
// examples (engine/eval/judge-bench.mjs), and every failure — no key, timeout, an odd answer —
// returns null, which callers treat as "not sure": ask the person, offer all tools, keep going.
import fs from 'node:fs';

const BASE = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = () => process.env.OPENAI_API_KEY || '';
const MODEL = process.env.BISU_DECISION_MODEL || 'gpt-6-luna';
export const available = () => !!KEY() && process.env.BISU_DECISIONS !== '0';

export const usage = {calls: 0, inputTokens: 0, ms: 0, failures: 0};

export async function ask(text, questions, {timeoutMs = 6000, signal} = {}) {
  if (!available()) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(BASE() + '/decisions', {
      method: 'POST',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      headers: {authorization: 'Bearer ' + KEY(), 'content-type': 'application/json'},
      body: JSON.stringify({model: MODEL, input: [{type: 'message', role: 'user', content: [{type: 'input_text', text}]}], questions}),
    });
    const j = await r.json().catch(() => null);
    usage.calls++; usage.ms += Date.now() - t0; usage.inputTokens += j?.usage?.input_tokens || 0;
    if (!r.ok || !Array.isArray(j?.answers)) { usage.failures++; return null }
    const out = {};
    j.answers.forEach((a, i) => {
      const name = a.name || questions[i]?.name;
      if (a.type === 'predicate' && typeof a.probability === 'number') out[name] = a.probability;
      else if (a.type === 'choice') out[name] = {choice: a.choice, confidence: a.confidence ?? null, p: Object.fromEntries((a.probabilities || []).map(x => [x.value, x.probability]))};
    });
    return out;
  } catch { usage.failures++; return null }
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s };

// ---- what kind of request is this ----
export const ROUTES = {
  chat: 'Conversation or a question that general knowledge answers, with no files, commands, web or memory needed. Not a question about the people, numbers or contents in the person\'s own files.',
  work: 'Needs to look at or change files in the working folder, or run commands there (reading, searching, editing, testing) — including questions about data the folder holds (how many users, which orders, what a setting is).',
  build: 'A sizeable piece of building: a new feature, many files, a whole page, a refactor across the project.',
  past: 'Refers to earlier conversations or earlier work with bisu ("지난번에", "전에 얘기한", "그때").',
  mac: "Operate the Mac outside the working folder: other apps, the screen, clipboard, windows, files elsewhere.",
  schedule: 'Asks for something to happen later or repeatedly ("매일 아침", "내일 9시에", "매주").',
  remember: 'Asks bisu to remember a fact or preference for future conversations, or to forget one.',
  web: 'Needs current information from the internet (news, prices, docs, anything recent).',
};
// folder: what the assistant has open (top-level names), so "서울 사는 사용자는 몇 명이야?" reads as a
// question about data/users.csv rather than about Seoul.
export async function route(userText, {recent = '', folder = ''} = {}) {
  const a = await ask(
    `${folder ? `The assistant works in a folder that contains: ${clip(folder, 600)}\n\n` : ''}${recent ? `Recent conversation:\n${clip(recent, 1500)}\n\n` : ''}The person now says to their assistant:\n"""${clip(userText, 2000)}"""`,
    [
      {type: 'choice', name: 'route', instructions: 'Which single kind of request is this, judged by what the assistant must do to answer well?', choices: Object.entries(ROUTES).map(([value, description]) => ({value, description}))},
      {type: 'predicate', name: 'hard', instructions: 'Does doing this well need careful multi-step reasoning, debugging, or substantial code or writing (not a lookup or a small edit)?'},
    ]);
  if (!a?.route) return null;
  return {route: a.route.choice, confidence: a.route.p[a.route.choice] ?? a.route.confidence ?? 0, p: a.route.p, hard: a.hard ?? null};
}

// What a route means for the turn: who answers, with which tools, how much reasoning, and a one-line
// hint for the system prompt.
// - GLM-5.3, the assistant, takes conversation and everything around it: memory, schedules, the web,
//   past conversations, the Mac, and anything the judge could not place.
// - Flash takes the work in the folder, small or large. Measured, not assumed: asked "서울 사는 사람 몇
//   명이야?" next to a users.csv, GLM-5.3 at low effort answered with Seoul's population three times out
//   of three, even when told to look at the files; Flash read the file and said 2 every time, at a
//   tenth of the cost (engine/eval/bench.mjs, live runs 2026-10-27).
// - Reasoning: GLM-5.3 needs it whenever tools are in play (at low effort it skipped the files); Flash
//   did the folder work as well without it and twice as fast, so it reasons only for a build or what
//   the judge calls hard. Plain conversation gets no tools and light reasoning. BISU_THINKING=on|off
//   forces it everywhere.
export const HINTS = {
  web: 'This needs current information: use web_fetch on a reliable source rather than answering from memory, and say where it came from.',
  past: 'This refers to earlier conversations: look them up (session_search, then session_show) before answering; if those tools are not available, say you cannot see past conversations yet.',
  build: 'This is a sizeable job: look at the project first, make a short plan, then work through it and verify (run the tests or the app) before answering.',
  schedule: 'This asks for something later or recurring: create a scheduled job (schedule_job) if that tool is available; otherwise say it cannot be scheduled yet.',
  remember: 'This asks you to remember or forget something: update memory (remember) if that tool is available.',
  mac: 'This is about the Mac outside the folder (apps, screen, clipboard): use the Mac tools if available; otherwise say what you would need.',
};
export const WORK_ROUTES = new Set(['work', 'build']);
export function planTurn(r, {model, workModel, tools}) {
  const force = process.env.BISU_THINKING;
  const think = wanted => force === 'on' ? true : force === 'off' ? false : wanted;
  const plan = {model, tools, thinking: think(true), hint: '', heavy: false};
  if (!r) return plan;
  if (r.route === 'chat' && r.confidence >= 0.7) { plan.tools = []; plan.thinking = think(false); return plan }
  // Only the kind of request decides who answers: a hard question about past work is still the assistant's.
  if (WORK_ROUTES.has(r.route)) {
    plan.model = workModel;
    plan.heavy = r.route === 'build' || (r.hard ?? 0) >= 0.7;
    plan.thinking = think(plan.heavy);
  }
  if (HINTS[r.route] && r.confidence >= 0.6) plan.hint = HINTS[r.route];
  return plan;
}

// ---- is this action safe to run without asking ----
// The top-level names of a folder, for route(): folders end in /, hidden ones are left out.
export function folderSummary(dir, max = 40) {
  try {
    const names = fs.readdirSync(dir, {withFileTypes: true}).filter(e => !e.name.startsWith('.')).map(e => e.name + (e.isDirectory() ? '/' : ''));
    return names.slice(0, max).join(', ') + (names.length > max ? `, … (${names.length} in all)` : '');
  } catch { return '' }
}

export async function risk(tool, args, {cwd, userText = '', existing = null} = {}) {
  // What a write replaces matters more than what it writes: say so plainly.
  const what = tool === 'run_command' ? `Shell command (zsh) in ${cwd}:\n${clip(args.command, 1500)}`
    : tool === 'write_file' ? `REPLACE the existing file ${args.path} (in ${cwd}${existing != null ? `, currently ${existing} lines` : ''}) with new contents:\n${clip(args.content, 800)}`
    : tool === 'edit_file' ? `Edit the existing file ${args.path} (in ${cwd}): replace exactly this text${args.replace_all ? ' (every occurrence)' : ' (once)'}:\n${clip(args.old_string, 500)}\nwith:\n${clip(args.new_string, 500)}\n(The rest of the file is unchanged.)`
    : `${tool} ${clip(JSON.stringify(args), 800)} (working folder ${cwd})`;
  const a = await ask(`The person asked: """${clip(userText, 600)}"""\nThe assistant wants to do this on their Mac:\n${what}`, [
    {type: 'predicate', name: 'destructive', instructions: 'Would this delete, overwrite or discard data or history that cannot easily be recovered (rm, overwriting files, git reset/clean/push --force, dropping tables, killing processes)? Creating new files or appending is not destructive.'},
    {type: 'predicate', name: 'external', instructions: 'Would this send data off this Mac or act on the outside world (network uploads, git push, sending messages or email, publishing, payments, posting, calling an API that changes something)? Reading a public web page or installing nothing is not external.'},
    {type: 'predicate', name: 'system', instructions: 'Would this change the system rather than the project: sudo, installing or removing software globally, changing settings, launch agents, or touching files outside the working folder?'},
  ]);
  if (!a || typeof a.destructive !== 'number') return null;
  return {destructive: a.destructive, external: a.external ?? 1, system: a.system ?? 1};
}

// ---- is a long turn still going somewhere ----
export const PROGRESS = {
  progressing: 'Making progress: each step learns or changes something new toward the request.',
  repeating: 'Going in circles: repeating the same failing approach, re-reading the same things, or undoing its own work.',
  finished: 'Already has what it needs: the request is done or answerable, and further tool use would add nothing.',
  blocked: 'Cannot continue without the person: a missing permission, a decision only they can make, or missing information.',
};
export async function progress(userText, steps) {
  const a = await ask(`The person asked: """${clip(userText, 800)}"""\nWhat the assistant has done so far, oldest first:\n${clip(steps, 3500)}`, [
    {type: 'choice', name: 'state', instructions: 'Which describes the assistant right now?', choices: Object.entries(PROGRESS).map(([value, description]) => ({value, description}))},
  ]);
  if (!a?.state) return null;
  return {state: a.state.choice, confidence: a.state.p[a.state.choice] ?? 0, p: a.state.p};
}
