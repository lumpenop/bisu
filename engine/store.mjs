// Where bisu's own engine keeps conversations: one JSONL file per session.
//
// The records use the same outer shape as Claude Code's transcripts (type user/assistant, sessionId,
// timestamp, cwd, message with content blocks and usage), so bisu's history list and its full-text
// search read both kinds with the same code. Resuming rebuilds the OpenAI-format conversation the
// model needs from those records.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = process.env.BISU_SESSIONS_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'sessions');
const slug = cwd => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

export function fileFor(sessionId, cwd) {
  // A resumed session keeps writing where it started, even from another folder.
  const found = find(sessionId);
  if (found) return found;
  const dir = path.join(ROOT, slug(cwd));
  fs.mkdirSync(dir, {recursive: true});
  return path.join(dir, `${sessionId}.jsonl`);
}
export function find(sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId || '')) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, {withFileTypes: true}).filter(d => d.isDirectory()) } catch { return null }
  for (const d of dirs) { const p = path.join(ROOT, d.name, `${sessionId}.jsonl`); if (fs.existsSync(p)) return p }
  return null;
}

export class Transcript {
  constructor(sessionId, cwd) { this.sessionId = sessionId; this.cwd = cwd; this.file = fileFor(sessionId, cwd) }
  // Every line also names the bot that was talking (BISU_BOT), so session_search can say whose
  // conversation a hit is and filter by it.
  write(rec) { fs.appendFileSync(this.file, JSON.stringify({...rec, sessionId: this.sessionId, cwd: this.cwd, bot: process.env.BISU_BOT || undefined, timestamp: new Date().toISOString()}) + '\n') }
  user(text) { this.write({type: 'user', message: {role: 'user', content: text}}) }
  assistant({model, text, toolCalls, usage, id}) {
    const content = [];
    if (text) content.push({type: 'text', text});
    for (const c of toolCalls || []) { let input = {}; try { input = JSON.parse(c.arguments || '{}') } catch { input = {raw: c.arguments} } content.push({type: 'tool_use', id: c.id, name: c.name, input}) }
    this.write({type: 'assistant', message: {id, role: 'assistant', model, content, usage: usage && {input_tokens: (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || 0), cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0, output_tokens: usage.completion_tokens || 0}}});
  }
  summary(text) { this.write({type: 'summary', summary: text}) }
  toolResult(id, text, error) { this.write({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: id, content: text, is_error: !!error}]}}) }
}

// The conversation as the model needs it, from a transcript.
export function loadMessages(sessionId) {
  const file = find(sessionId);
  if (!file) return null;
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line) } catch { continue }
    const c = j.message?.content;
    if (j.type === 'user' && typeof c === 'string') out.push({role: 'user', content: c});
    else if (j.type === 'user' && Array.isArray(c)) for (const b of c) { if (b.type === 'tool_result') out.push({role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '')}) }
    else if (j.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = c.filter(b => b.type === 'tool_use').map(b => ({id: b.id, type: 'function', function: {name: b.name, arguments: JSON.stringify(b.input ?? {})}}));
      out.push({role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls} : {})});
    } else if (j.type === 'summary' && j.summary) { out.length = 0; out.push({role: 'user', content: `[이전 대화 요약]\n${j.summary}`}, {role: 'assistant', content: '알겠어, 이어서 할게.'}) }
  }
  // A transcript cut off mid-turn can end with tool calls that never got results; the API refuses that.
  const answered = new Set(out.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  for (const m of out) if (m.tool_calls) m.tool_calls = m.tool_calls.filter(t => answered.has(t.id));
  for (const m of out) if (m.tool_calls && !m.tool_calls.length) delete m.tool_calls;
  return out;
}
