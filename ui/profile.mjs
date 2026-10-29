// Who the person is: the few facts that hold whatever the conversation and whichever bot — how to
// address them, how they want to be spoken to, what they do, and whatever they wrote down about
// themselves. One file, ~/.config/bisu/profile.md, shared by every bot (the person is the same person),
// given to every run as its own block ahead of memory, and never cut or compacted: memory is for what
// comes up along the way, this is for what is simply true of them. They write it on the 기억 tab
// (나에 대해), or the assistant saves what they say with profile_set (engine/bisu-tools.mjs).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
export const FILE = path.join(CONFIG_DIR, 'profile.md');
// The one-line fields, in the order they are shown and sent. `about` is the free text under them.
export const FIELDS = [['name', '부르는 이름'], ['tone', '말투'], ['job', '하는 일']];
// How each field is put to the model: as an instruction, not a label. "말투: 존댓말" reads as a fact about
// them and the model keeps mirroring their own speech level; "speak to them in 존댓말" does not.
const PUT = {
  name: v => `Call them "${v}".`,
  tone: v => `Speak to them in ${v}: their choice, which wins over mirroring their own speech level and over anything in memory.`,
  job: v => `What they do: ${v}.`,
};
// The block is on every request, so the free text is capped: a profile is a few lines, not a diary.
export const LIMIT = Number(process.env.BISU_PROFILE_CHARS) || 1500;

const oneLine = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function get() {
  const p = { name: '', tone: '', job: '', about: '', updated: 0 };
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); p.updated = Math.round(fs.statSync(FILE).mtimeMs) } catch { return p }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) { p.about = text.trim(); return p }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv && FIELDS.some(([k]) => k === kv[1])) p[kv[1]] = oneLine(kv[2], 120);
  }
  p.about = m[2].trim();
  return p;
}

// Change some of it; what is left out keeps its value. `add` appends a line to the free text, which is
// what the assistant uses, so it never has to resend the whole text to keep it.
export function set({ name, tone, job, about, add } = {}) {
  const p = get();
  if (name !== undefined) p.name = oneLine(name, 120);
  if (tone !== undefined) p.tone = oneLine(tone, 120);
  if (job !== undefined) p.job = oneLine(job, 120);
  if (about !== undefined) p.about = String(about ?? '').trim();
  if (add) p.about = (p.about ? p.about + '\n' : '') + String(add).replace(/\s+/g, ' ').trim();
  p.about = p.about.slice(0, 4000);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `---\n${FIELDS.map(([k]) => `${k}: ${p[k]}`).join('\n')}\n---\n${p.about ? p.about + '\n' : ''}`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return get();
}

export const isEmpty = p => !FIELDS.some(([k]) => p[k]) && !p.about;

// Memory topic keys this profile answers for (the first-run card used to write them as memories), so the
// digest leaves those memories out and nothing in memory can contradict the profile.
export function supersedes(p = get()) {
  const keys = [];
  if (p.name) keys.push('user-name');
  if (p.tone) keys.push('reply-style');
  return new Set(keys);
}

// One line for a tool's answer or a log: "부르는 이름 승원 · 말투 반말 · …".
export function summary(p = get()) {
  const parts = FIELDS.filter(([k]) => p[k]).map(([k, ko]) => `${ko} ${p[k]}`);
  if (p.about) parts.push(p.about.replace(/\s+/g, ' ').slice(0, 80) + (p.about.length > 80 ? '…' : ''));
  return parts.join(' · ') || '(비어 있음)';
}

// What every run is given. Empty when nothing is written, so a first install pays nothing for it.
export function block(p = get()) {
  if (isEmpty(p)) return '';
  const lines = FIELDS.filter(([k]) => p[k]).map(([k]) => `- ${PUT[k](p[k])}`);
  let about = p.about;
  const room = LIMIT - lines.join('\n').length;
  if (about.length > room) about = about.slice(0, Math.max(0, room - 20)).trimEnd() + '…(cut to fit)';
  return `## 이 사람 (About the person)\n` +
    `Who they are, in their own words, and how to treat them. It holds in every conversation and over anything in memory; keep to it without repeating it back.\n` +
    lines.join('\n') + (about ? '\n' + about : '') + '\n';
}
