// What was said in past runs, searchable.
//
// Claude Code keeps every conversation as a transcript under ~/.claude/projects. bisu's memory is
// only what the person asked to keep; this is the other half: a full-text index over the transcripts
// themselves, so "지난주에 결제 테스트 어떻게 됐지" is one tool call instead of a guess.
//
// SQLite FTS5 with the trigram tokenizer, because Korean does not put spaces where a word tokenizer
// expects them: "결제" has to find "실결제했는데", and a trigram index does that for any run of three
// or more characters. Shorter terms fall back to LIKE, which is a scan, but a small one: only the
// visible text is indexed, never tool calls or tool output, which is most of a transcript's bytes.
//
// Indexing runs in its own short-lived process, for the same reason as history.mjs: a cold pass over
// a few hundred megabytes grows V8 and it keeps the pages. Searching opens the index in-process.
//
//   node sessions.mjs index  [projects]              → {files, sessions, messages, ms} as JSON
//   node sessions.mjs search [projects] <query>      → printed the way the tool shows it
//   node sessions.mjs show   [projects] <session id>
//
// Only bisu's own runs are indexed (a transcript whose model is an OpenRouter slug), so what the
// person says to their normal `claude` never reaches an OpenRouter model through a search result.
// BISU_SEARCH_ALL=1 indexes every Claude Code transcript instead; changing it rebuilds the index.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

// Claude Code's transcripts and those of bisu's own engine (engine/store.mjs), joined with ':'.
export const PROJECTS = [path.join(os.homedir(), '.claude', 'projects'), process.env.BISU_SESSIONS_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'sessions')].join(':');
const DB = process.env.BISU_SESSIONS_DB || path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'sessions.sqlite');
const ALL = process.env.BISU_SEARCH_ALL === '1';
const OPENROUTER_MODEL = /"model":"[a-z0-9][a-z0-9._-]*\//; // provider/model: only OpenRouter names look like this
const MAX_TEXT = 6000;     // per message in the index
const SHOW_BUDGET = 16000; // per session_show answer
const WHO = ALL ? 'assistant' : 'bisu'; // who answered, in the printed lines

// ---- the database ----

function open() {
  fs.mkdirSync(path.dirname(DB), {recursive: true});
  const db = new DatabaseSync(DB);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime REAL, size INTEGER, indexed INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, file TEXT, start REAL, end REAL, cwd TEXT, title TEXT, prompt TEXT, turns INTEGER);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, session TEXT, file TEXT, ts REAL, role TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS messages_file ON messages(file);
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session, ts);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;`);
  // Which bot the conversation belonged to (bisu's own engine writes it on every line; Claude Code
  // transcripts have none). Added to indexes made before it existed.
  try { db.exec('ALTER TABLE sessions ADD COLUMN bot TEXT') } catch {}
  return db;
}

// ---- reading transcripts ----

function* jsonlFiles(dir, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3 && e.name !== 'memory') yield* jsonlFiles(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// A message's text, ignoring tool calls, tool output and thinking.
const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

// The main thread of every session in one transcript file: who said what, when.
function parse(text) {
  const sessions = new Map();
  const messages = [];
  let streaming = null; // a streamed reply is one line per content block with the same message id
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"ai-title"')) continue;
    if (line.includes('"tool_result"')) continue;
    let j = null;
    try { j = JSON.parse(line) } catch { continue }
    if (!j || typeof j !== 'object' || !j.sessionId) continue;
    let s = sessions.get(j.sessionId);
    if (!s) sessions.set(j.sessionId, s = {id: j.sessionId, start: null, end: null, cwd: null, title: null, prompt: null, turns: 0, bot: null});
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    if (ts) { if (!s.start || ts < s.start) s.start = ts; if (!s.end || ts > s.end) s.end = ts }
    if (j.cwd && !s.cwd) s.cwd = j.cwd;
    if (j.bot && !s.bot) s.bot = String(j.bot).slice(0, 40);
    if (j.type === 'ai-title') { if (j.aiTitle) s.title = j.aiTitle; continue }
    if (j.isSidechain) continue;
    let t = textOf(j.message?.content).trim();
    if (!t) continue;
    if (j.type === 'user') {
      // Lines that start with a tag are the harness talking (command output, reminders), not the person.
      if (t.startsWith('<') || t.startsWith('[Request interrupted')) continue;
      const ctx = t.indexOf('<bisu-context>');
      if (ctx > 0) t = t.slice(0, ctx).trim();
      // A worker's report reaches bisu as a message too (engine/cli.mjs): the team's, not the person's.
      const team = t.startsWith('(bisu: 맡긴 일');
      if (!team) { if (!s.prompt) s.prompt = t.slice(0, 300); s.turns++ }
      streaming = null;
      messages.push({session: s.id, ts, role: team ? 'team' : 'user', text: t.slice(0, MAX_TEXT)});
    } else {
      const mid = j.message?.id;
      if (mid && streaming?.mid === mid) { streaming.row.text = `${streaming.row.text}\n${t}`.slice(0, MAX_TEXT); continue }
      const row = {session: s.id, ts, role: 'assistant', text: t.slice(0, MAX_TEXT)};
      streaming = mid ? {mid, row} : null;
      messages.push(row);
    }
  }
  return {sessions: [...sessions.values()], messages};
}

// ---- indexing ----

// Brings the index up to date with the transcripts: unchanged files (same mtime and size) cost one
// stat, a changed file is re-read and replaced whole, a deleted file is dropped. Returns counts.
export function index(projects = PROJECTS) {
  const t0 = Date.now();
  const db = open();
  const scope = ALL ? 'all' : 'bisu';
  const prev = db.prepare(`SELECT v FROM meta WHERE k = 'scope'`).get()?.v;
  if (prev !== scope) {
    db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM files');
    db.prepare(`INSERT OR REPLACE INTO meta(k, v) VALUES ('scope', ?)`).run(scope);
  }
  const known = new Map(db.prepare('SELECT path, mtime, size FROM files').all().map(r => [r.path, r]));
  const seen = new Set();
  const putFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, size, indexed) VALUES (?, ?, ?, ?)');
  const dropFile = db.prepare('DELETE FROM files WHERE path = ?');
  const dropMessages = db.prepare('DELETE FROM messages WHERE file = ?');
  const dropSessions = db.prepare('DELETE FROM sessions WHERE file = ?');
  const putMessage = db.prepare('INSERT INTO messages(session, file, ts, role, text) VALUES (?, ?, ?, ?, ?)');
  const putSession = db.prepare('INSERT OR REPLACE INTO sessions(id, file, start, end, cwd, title, prompt, turns, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let files = 0, sessions = 0, messages = 0;
  for (const p of String(projects).split(':').filter(Boolean).flatMap(d => [...jsonlFiles(d)])) {
    seen.add(p);
    let st = null;
    try { st = fs.statSync(p) } catch { continue }
    const k = known.get(p);
    if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }
    const wanted = ALL || OPENROUTER_MODEL.test(text);
    db.exec('BEGIN');
    try {
      dropMessages.run(p);
      dropSessions.run(p);
      if (wanted) {
        const r = parse(text);
        const withText = new Set(r.messages.map(m => m.session));
        for (const m of r.messages) putMessage.run(m.session, p, m.ts, m.role, m.text);
        for (const s of r.sessions) if (withText.has(s.id)) { putSession.run(s.id, p, s.start, s.end, s.cwd, s.title, s.prompt, s.turns, s.bot); sessions++ }
        messages += r.messages.length;
      }
      putFile.run(p, st.mtimeMs, st.size, wanted ? 1 : 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e }
    files++;
  }
  for (const p of known.keys()) if (!seen.has(p)) { dropMessages.run(p); dropSessions.run(p); dropFile.run(p) }
  const total = db.prepare('SELECT count(*) AS n FROM sessions').get().n;
  db.close();
  return {files, sessions, messages, total, ms: Date.now() - t0};
}

// The index step as a child process (see the header). Throttled: a search right after another one
// does not re-stat four hundred files. Resolves to the counts, or {error} — a failed refresh still
// leaves the previous index searchable.
let refreshedAt = 0, refreshing = null;
export function refresh(projects = PROJECTS, {maxAge = 20_000} = {}) {
  if (Date.now() - refreshedAt < maxAge) return Promise.resolve(null);
  if (refreshing) return refreshing;
  refreshing = new Promise(resolve => {
    const env = {PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir()};
    for (const k of ['BISU_SESSIONS_DB', 'BISU_SEARCH_ALL']) if (process.env[k]) env[k] = process.env[k];
    execFile(process.execPath, [fileURLToPath(import.meta.url), 'index', projects], {env, timeout: 180_000, maxBuffer: 1 << 20, encoding: 'utf8'}, (e, out, err) => {
      refreshing = null;
      refreshedAt = Date.now();
      if (e) return resolve({error: (err || e.message).trim().split('\n').pop()});
      try { resolve(JSON.parse(out)) } catch { resolve({error: 'index printed no json'}) }
    });
  });
  return refreshing;
}

// ---- searching ----

const chars = s => [...s].length;
const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);
const terms = q => String(q || '').split(/\s+/).map(t => t.replace(/^["']+|["']+$/g, '')).filter(Boolean).slice(0, 8);
const home = os.homedir();
const short = p => p ? (p.startsWith(home) ? '~' + p.slice(home.length) : p) : '(no folder)';
const botTag = s => s.bot && s.bot !== 'bisu' ? ` · 봇 ${s.bot}` : ''; // the default bot is just bisu
const who = role => role === 'user' ? 'person' : role === 'team' ? 'team' : WHO;
const day = ts => ts ? new Date(ts).toLocaleDateString('ko-KR', {year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'}).replace(/\. /g, '-').replace(/\.$/, '').replace(/-\(/, ' (') : '?';
const clock = ts => ts ? new Date(ts).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false}) : '';
const oneLine = s => s.replace(/\s+/g, ' ').trim();

// A short-term hit has no FTS snippet; cut one around the first term found.
function excerpt(text, words) {
  const t = oneLine(text);
  const lower = t.toLowerCase();
  let at = -1, w = '';
  for (const x of words) { const i = lower.indexOf(x.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) { at = i; w = x } }
  if (at < 0) return t.slice(0, 120);
  const from = Math.max(0, at - 50), to = Math.min(t.length, at + w.length + 60);
  return `${from > 0 ? '…' : ''}${t.slice(from, at)}**${t.slice(at, at + w.length)}**${t.slice(at + w.length, to)}${to < t.length ? '…' : ''}`;
}

// Sessions that mention every term, best first, with up to `perSession` matching lines each.
// Terms of three or more characters go through the trigram index; one- and two-character terms are
// a LIKE filter on top. When nothing matches all the terms, the same search with any of them.
export function search(query, {days = 0, project = '', bot = '', limit = 8, perSession = 3} = {}) {
  const words = terms(query);
  if (!words.length) return {query, words, mode: 'and', sessions: [], total: 0};
  const db = open();
  try {
  const total = db.prepare('SELECT count(*) AS n FROM sessions').get().n;
  const long = words.filter(t => chars(t) >= 3), brief = words.filter(t => chars(t) < 3);
  const filters = [], args = [];
  if (days > 0) { filters.push('m.ts >= ?'); args.push(Date.now() - days * 864e5) }
  if (project) { filters.push(`s.cwd LIKE ? ESCAPE '\\'`); args.push(`%${likeEscape(project)}%`) }
  if (bot) { filters.push('s.bot = ?'); args.push(bot) }
  for (const t of brief) { filters.push(`m.text LIKE ? ESCAPE '\\'`); args.push(`%${likeEscape(t)}%`) }
  const phrase = t => `"${t.replace(/"/g, '""')}"`;
  const run = (joiner) => {
    if (long.length) {
      return db.prepare(`SELECT m.session, m.ts, m.role, snippet(fts, 0, '**', '**', '…', 64) AS snip, bm25(fts) AS rank
        FROM fts JOIN messages m ON m.id = fts.rowid JOIN sessions s ON s.id = m.session
        WHERE fts MATCH ? ${filters.map(f => `AND ${f}`).join(' ')} ORDER BY rank LIMIT 300`).all(long.map(phrase).join(` ${joiner} `), ...args);
    }
    const rows = db.prepare(`SELECT m.session, m.ts, m.role, m.text AS snip FROM messages m JOIN sessions s ON s.id = m.session
      WHERE ${filters.join(' AND ') || '1'} ORDER BY m.ts DESC LIMIT 300`).all(...args);
    for (const r of rows) r.snip = excerpt(r.snip, brief);
    return rows;
  };
  let mode = 'and', rows = run('AND');
  if (!rows.length && long.length > 1) { mode = 'or'; rows = run('OR') }
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.session);
    if (!g) { if (groups.size >= limit) continue; groups.set(r.session, g = {id: r.session, lines: []}) }
    const snip = oneLine(r.snip);
    if (g.lines.length < perSession && !g.lines.some(l => l.snip === snip)) g.lines.push({ts: r.ts, role: r.role, snip});
  }
  const meta = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const sessions = [...groups.values()].map(g => ({...meta.get(g.id), lines: g.lines.sort((a, b) => (a.ts || 0) - (b.ts || 0))}));
  return {query, words, mode, sessions, total};
  } finally { db.close() } // a search that throws must not leave a handle open in the engine
}

export function searchText(query, opts = {}, note = '') {
  const r = search(query, opts);
  const scope = ALL ? 'every Claude Code transcript' : 'bisu runs only';
  const head = [];
  if (!r.words.length) return 'session_search needs a query: a few words that would appear in the conversation.';
  if (!r.sessions.length) head.push(`No past session mentions ${r.words.map(w => `"${w}"`).join(' ')}${opts.days ? ` in the last ${opts.days} days` : ''}${opts.project ? ` under "${opts.project}"` : ''}${opts.bot ? ` for bot "${opts.bot}"` : ''}. (index: ${r.total} sessions, ${scope}${note ? `; ${note}` : ''})`);
  else {
    head.push(`${r.sessions.length} session${r.sessions.length > 1 ? 's' : ''} mention ${r.mode === 'or' ? 'some of ' : ''}${r.words.map(w => `"${w}"`).join(' ')} (index: ${r.total} sessions, ${scope}${note ? `; ${note}` : ''}):`);
    r.sessions.forEach((s, i) => {
      head.push('', `${i + 1}. ${day(s.start)} ${clock(s.start)} · ${short(s.cwd)}${botTag(s)} · ${oneLine(s.title || s.prompt || '(untitled)').slice(0, 80)} · id ${s.id.slice(0, 8)}`);
      for (const l of s.lines) head.push(`   ${clock(l.ts)} ${who(l.role)}: ${l.snip.slice(0, 260)}`);
    });
    head.push('', 'session_show <id> reads one of them in order.');
  }
  return head.join('\n');
}

// One session's conversation in order, for reading what actually happened before answering.
export function show(id, {offset = 0, limit = 40} = {}) {
  const key = String(id || '').trim();
  if (!key) return 'session_show needs a session id (the 8-character prefix from session_search is enough).';
  const db = open();
  let found, s, n, rows;
  try {
  found = db.prepare(`SELECT * FROM sessions WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY start DESC LIMIT 3`).all(key, `${likeEscape(key)}%`);
  if (!found.length) return `No indexed session starts with "${key}".`;
  if (found.length > 1 && found[0].id !== key) return `"${key}" is ambiguous:\n${found.map(s => `- ${s.id} · ${day(s.start)} · ${short(s.cwd)}${botTag(s)} · ${oneLine(s.title || s.prompt || '')}`).join('\n')}`;
  s = found[0];
  n = db.prepare('SELECT count(*) AS n FROM messages WHERE session = ?').get(s.id).n;
  rows = db.prepare('SELECT ts, role, text FROM messages WHERE session = ? ORDER BY ts, id LIMIT ? OFFSET ?').all(s.id, Math.max(1, Math.min(200, limit | 0)), Math.max(0, offset | 0));
  } finally { db.close() }
  const out = [`${day(s.start)} ${clock(s.start)}${s.end && s.end - s.start > 60e3 ? `–${clock(s.end)}` : ''} · ${short(s.cwd)}${botTag(s)} · ${oneLine(s.title || s.prompt || '(untitled)')} · id ${s.id}`, `messages ${offset + 1}–${offset + rows.length} of ${n}`, ''];
  let used = 0;
  for (const [i, m] of rows.entries()) {
    const text = m.text.length > 1200 ? `${m.text.slice(0, 1200)}… (${m.text.length - 1200} more chars)` : m.text;
    if (used + text.length > SHOW_BUDGET && i > 0) { out.push(`… ${rows.length - i} more in this page; continue with offset ${offset + i}.`); break }
    used += text.length;
    out.push(`[${clock(m.ts)}] ${who(m.role)}: ${text}`);
  }
  if (offset + rows.length < n) out.push('', `(${n - offset - rows.length} later messages; continue with offset ${offset + rows.length})`);
  return out.join('\n');
}

// ---- command line ----

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const projects = rest[0] && (rest[0].startsWith('/') || rest[0].startsWith('~')) ? rest.shift().replace(/^~/, home) : PROJECTS;
  if (mode === 'index') process.stdout.write(JSON.stringify(index(projects)));
  else if (mode === 'search') { index(projects); process.stdout.write(searchText(rest.join(' ')) + '\n') }
  else if (mode === 'show') { index(projects); process.stdout.write(show(rest[0]) + '\n') }
  else { process.stderr.write('usage: sessions.mjs index|search|show [projects] [query|id]\n'); process.exit(2) }
}
