// Where the Claude desktop app's sessions stand, read from Claude Code's own transcripts
// (~/.claude/projects/<folder>/<session>.jsonl), for jobs that watch another app ("Claude 앱 작업이 멈추면
//알려줘, 끝나면 알려줘"). Read-only: it never writes there and never presses anything.
//
// The last line of a transcript is usually bookkeeping (api-request, cost-state, last-prompt), so a session is
// judged by its last real message:
//  * 멈춤 — the turn ended on an error the app gave up on (a usage limit, a refused request, a lost login), was
//    interrupted, or has not moved for STILL_MIN minutes in the middle of a turn (an approval waiting, or cut off);
//  * 진행 중 — mid-turn (a tool running, a reply coming, a retry in progress) and written to within STILL_MIN;
//  * 끝남 — the last message is the assistant's answer with nothing left to run.
//
//   node claude-watch.mjs                 # desktop-app sessions written to in the last 6 hours
//   node claude-watch.mjs --hours 24 --all --json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECTS = process.env.BISU_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const STILL_MIN = 10;
const TAIL = 512 * 1024;

// The app writes entrypoint claude-desktop on a session's first lines and sdk-cli after that, as bisu's own `claude -p`
// runs do throughout; only the app's sessions have titles (custom-title, agent-name).
function fromApp(file) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(64 * 1024), n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.toString('utf8', 0, n).includes('"entrypoint":"claude-desktop"') }
  finally { fs.closeSync(fd) }
}
// The last TAIL bytes, split into whole lines (a first, cut line is dropped).
function tail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(size, TAIL), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift();
    return lines.filter(Boolean);
  } finally { fs.closeSync(fd) }
}
const textOf = m => (Array.isArray(m?.content) ? m.content.map(b => b.type === 'text' ? b.text : '').join(' ') : String(m?.content || '')).replace(/\s+/g, ' ').trim();

// One transcript → {id, title, folder, desktop, state, why, last, at, minutes}, or null when it has no messages.
export function judge(file, now = Date.now()) {
  const st = fs.statSync(file);
  let last = null, title = '', prompt = '', desktop = false, cwd = '';
  for (const line of tail(file, st.size)) {
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'custom-title' && e.customTitle) { title = e.customTitle; desktop = true }
    else if (e.type === 'agent-name' && e.agentName) { title ||= e.agentName; desktop = true }
    else if (e.type === 'last-prompt' && e.lastPrompt) prompt = e.lastPrompt;
    if (e.entrypoint === 'claude-desktop') desktop = true;
    if (e.cwd) cwd = e.cwd;
    if (e.isSidechain || e.isMeta) continue;
    if (e.type === 'assistant' || e.type === 'user' || e.type === 'system' && e.subtype === 'api_error') last = e;
  }
  if (!last) return null;
  if (!desktop) desktop = fromApp(file);
  const minutes = Math.round((now - st.mtimeMs) / 60e3), still = minutes >= STILL_MIN;
  const m = last.message, text = textOf(m);
  let state, why;
  if (last.type === 'assistant' && last.isApiErrorMessage) {
    state = '멈춤';
    why = last.error === 'rate_limit' ? `한도: ${text}` : `오류: ${text}`;
  } else if (last.type === 'system') {
    // Claude Code retries a dropped connection by itself; it is stuck only when the retries stopped moving.
    state = still ? '멈춤' : '진행 중';
    why = `${last.error?.formatted || last.error?.message || '연결 오류'}${last.retryAttempt ? ` (다시 시도 ${last.retryAttempt}/${last.maxRetries})` : ''}`;
  } else if (last.type === 'user' && /^\[Request interrupted/.test(text)) {
    state = '멈춤'; why = '중간에 멈춰졌어요 (사용자가 중단)';
  } else if (last.type === 'assistant' && !(m?.content || []).some(b => b.type === 'tool_use')) {
    state = '끝남'; why = text.slice(0, 160);
  } else {
    const tool = last.type === 'assistant' ? (m.content || []).filter(b => b.type === 'tool_use').map(b => b.name).pop() : null;
    state = still ? '멈춤' : '진행 중';
    why = still ? `${minutes}분째 움직임 없음${tool ? ` (${tool} 승인을 기다리거나 끊긴 것 같아요)` : ''}` : tool ? `${tool} 실행 중` : '답을 쓰는 중';
  }
  return { id: path.basename(file, '.jsonl'), title: title || prompt.slice(0, 60) || '(제목 없음)', folder: cwd, desktop, state, why, at: st.mtimeMs, minutes };
}

// Recent sessions, newest first. Only the desktop app's unless all.
export function sessions({ hours = 6, all = false, limit = 20, now = Date.now() } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS) } catch { return [] }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS, d)).filter(n => n.endsWith('.jsonl')) } catch { continue }
    for (const n of names) {
      const f = path.join(PROJECTS, d, n);
      try {
        if (now - fs.statSync(f).mtimeMs > hours * 3600e3) continue;
        const s = judge(f, now);
        if (s && (all || s.desktop)) out.push(s);
      } catch {}
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export const line = s => `${s.state} · ${s.title} · ${s.minutes}분 전 · ${s.why}${s.folder ? ` · ${s.folder.replace(os.homedir(), '~')}` : ''} · ${s.id.slice(0, 8)}`;

export const WATCH_TOOLS = {
  claude_sessions: {
    description: 'Where the Claude desktop app\'s recent sessions stand, read-only: each as 멈춤 (a usage limit, an error, interrupted, or not moving mid-turn), 진행 중 or 끝남, with why, the title and the folder. For jobs that watch the Claude app ("멈추면 알려줘", "끝나면 알려줘"). It never retries or sends anything.',
    parameters: { type: 'object', properties: {
      hours: { type: 'number', description: 'sessions written to in the last N hours (default 6)' },
      title: { type: 'string', description: 'only sessions whose title or folder contains this' },
      all: { type: 'boolean', description: 'every Claude Code session, not only the desktop app\'s' },
    } },
    kind: 'read',
    async run(ctx, { hours = 6, title = '', all = false } = {}) {
      const want = String(title || '').toLowerCase();
      const list = sessions({ hours: Math.min(72, Math.max(0.1, Number(hours) || 6)), all: !!all })
        .filter(s => !want || s.title.toLowerCase().includes(want) || s.folder.toLowerCase().includes(want));
      return { text: list.length ? list.map(line).join('\n') : `No ${all ? '' : 'Claude desktop app '}session in the last ${hours} hours${want ? ` matching "${title}"` : ''}.` };
    },
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined };
  const list = sessions({ hours: Number(opt('--hours')) || 6, all: a.includes('--all') });
  process.stdout.write(a.includes('--json') ? JSON.stringify(list, null, 1) + '\n' : list.length ? list.map(line).join('\n') + '\n' : 'no sessions\n');
}
