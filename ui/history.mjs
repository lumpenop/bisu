// Reads Claude Code's transcripts. This runs in its own short-lived process on purpose.
//
// A cold pass parses a few hundred megabytes of JSON, and V8 does not hand those pages back once it
// has grown for them: doing this work inside the engine left that process at its high-water mark for
// the rest of the day. Here the memory disappears with the process, and the engine only ever holds
// the small result.
//
//   node history.mjs runs    <projects> <days> <slug>
//   node history.mjs session <projects> <days> <sessionId>
import fs from 'node:fs';
import path from 'node:path';

const [mode, projectsDir, daysArg, extra] = process.argv.slice(2);
const SINCE = Date.now() - (Number(daysArg) || 60) * 864e5;

function* jsonlFiles(dir, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3 && e.name !== 'memory') yield* jsonlFiles(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// A message's text, ignoring tool calls and tool output (which is most of a transcript's bytes).
const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join(' ') : '';

// Calls visit(text) for every transcript modified inside the window.
function eachRecent(visit) {
  for (const p of jsonlFiles(projectsDir)) {
    let st = null;
    try { st = fs.statSync(p) } catch { continue }
    if (st.mtimeMs < SINCE) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }
    visit(text);
  }
}

function runs(slugSource) {
  const slug = new RegExp(slugSource);
  const sessions = new Map();
  eachRecent(text => {
    // Same gate as before: a file with no priced model in it is not a session worth listing.
    if (!/"model":"[a-z0-9][a-z0-9._-]*\//.test(text)) return;
    for (const line of text.split('\n')) {
      if (!line) continue;
      // Skipping before the parse is what keeps 200MB of history from costing 200MB of objects.
      if (!line.includes('"model":"') && !line.includes('"type":"user"') && !line.includes('"ai-title"')) continue;
      if (line.includes('"tool_result"')) continue;
      let j = null;
      try { j = JSON.parse(line) } catch { continue }
      if (!j || typeof j !== 'object' || !j.sessionId) continue;

      let s = sessions.get(j.sessionId);
      if (!s) sessions.set(j.sessionId, s = { id: j.sessionId, start: null, end: null, cwd: null, title: null, prompt: null, turns: 0, seen: new Set(), usage: {} });
      if (j.timestamp) { const t = Date.parse(j.timestamp); if (!s.start || t < s.start) s.start = t; if (!s.end || t > s.end) s.end = t }
      if (j.cwd && !s.cwd) s.cwd = j.cwd;
      if (j.type === 'ai-title' && j.aiTitle) s.title = j.aiTitle;
      if (j.type === 'user' && !j.isSidechain && !s.prompt) {
        const t = textOf(j.message?.content).trim();
        if (t && !t.startsWith('<')) s.prompt = t.replace(/<bisu-context>[\s\S]*?(<\/bisu-context>|$)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      }
      const m = j.message;
      if (j.type === 'assistant' && m?.model && m.usage) {
        const id = m.id || j.uuid;
        // A streamed reply is written once per content block with the same message id, so the usage
        // would be counted several times without this.
        if (s.seen.has(id)) continue;
        s.seen.add(id);
        if (!j.isSidechain) s.turns++;
        const u = s.usage[m.model] ??= { input: 0, cacheRead: 0, output: 0 };
        u.input += (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
        u.cacheRead += m.usage.cache_read_input_tokens || 0;
        u.output += m.usage.output_tokens || 0;
      }
    }
  });
  return [...sessions.values()]
    .filter(s => Object.keys(s.usage).some(k => slug.test(k)))
    // Runs bisu started on its own: a suggestion look-around begins with "지금: ", a scheduled job
    // with "[예약 작업 ". The page keeps them out of the conversation list unless asked.
    .map(({ seen, ...rest }) => ({ ...rest, kind: /^지금: /.test(rest.prompt || '') ? 'suggest' : /^\[예약 작업 /.test(rest.prompt || '') ? 'job' : 'chat' }))
    .sort((a, b) => (b.start || 0) - (a.start || 0))
    .slice(0, 100);
}

// The visible conversation of a past session (main thread only), for showing it again when resumed.
function session(sessionId) {
  const out = [];
  eachRecent(text => {
    if (!text.includes(sessionId)) return;
    for (const line of text.split('\n')) {
      if (!line || !line.includes(sessionId)) continue;
      let j = null;
      try { j = JSON.parse(line) } catch { continue }
      if (!j || j.sessionId !== sessionId || j.isSidechain) continue;
      if (j.type === 'user') {
        const t = textOf(j.message?.content).trim();
        if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) out.push({ kind: 'user', text: t, ts: j.timestamp });
      } else if (j.type === 'assistant') {
        const t = textOf(j.message?.content).trim();
        if (t) out.push({ kind: 'text', text: t, ts: j.timestamp });
      }
    }
  });
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-60);
}

const result = mode === 'session' ? { messages: session(extra) } : { sessions: runs(extra) };
process.stdout.write(JSON.stringify(result));
