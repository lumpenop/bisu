// bisu's memory: what the person should not have to say twice.
//
// A session forgets, so the durable things — how they want answers, their name, the folder a project
// lives in, a correction they made twice — live as one markdown file per memory in
// ~/.config/bisu/memory. That shape is deliberate:
//  * the assistant reads and writes them with the tools it already has (Read, Write, Edit, Bash), so
//    keeping something needs no new tool and no new process, and in `bisu ui` the write goes through
//    the ordinary approval card — the person sees the file before it exists;
//  * the person can open the folder in Finder and edit them by hand, or do it on the Memory tab;
//  * every new run gets them as a digest appended to its system prompt (launch.zsh), which is what
//    carries them across sessions and folders. There is no database and no background process.
//
//   node memory.mjs digest [chars]      # the block on its own
//   node memory.mjs prompt <prompt.md>  # prompt.md + that block, for --append-system-prompt-file
//   node memory.mjs                     # the folder and the digest, for a look by hand
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// The digest is on every request, so it is capped: memory is a few facts, not a diary. Pinned entries
// never fall off the end; the rest are taken newest first.
export const BUDGET = Number(process.env.BISU_MEMORY_CHARS) || 3000;
// Each bot keeps its own memory. The default bot ('bisu') owns the folder that existed before bots;
// another bot's lives in bots/<id>/memory (ui/bots.mjs). A run knows its bot from BISU_BOT; the page's
// server, which serves every bot, switches with inBot() around each call.
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
export function dirFor(bot) {
  return !bot || bot === 'bisu' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(bot) ? path.join(CONFIG_DIR, 'memory') : path.join(CONFIG_DIR, 'bots', bot, 'memory');
}
export let DIR = dirFor(process.env.BISU_BOT);
// Every function here is synchronous, so swapping the folder around one call cannot interleave with another.
export function inBot(bot, fn) {
  const was = DIR;
  DIR = dirFor(bot);
  try { return fn() } finally { DIR = was }
}

// One memory, from the file and its stat. The first non-empty line is the title (`# 제목` or plain),
// the rest is the fact; frontmatter carries `pin` and, when the memory belongs to a topic, `key`.
function parse(id, raw, st) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let pin = false, key = null;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'pin') pin = /^(true|yes|1)$/i.test(m[2].trim());
      if (m[1] === 'key') key = topicKey(m[2]) || null;
    }
  }
  const lines = (fm ? text.slice(fm[0].length) : text).split('\n');
  const at = lines.findIndex(l => l.trim());
  if (at < 0) return null;
  const title = lines[at].replace(/^#+\s*/, '').trim().slice(0, 100);
  const body = lines.slice(at + 1).join('\n').trim();
  return { id, title, text: body, pin, key, created: Math.round(st.birthtimeMs || st.mtimeMs), updated: Math.round(st.mtimeMs) };
}

// A topic id, so "Reply Style", "reply style" and "reply_style" are the same thing. Names the
// subject a memory is about; a second memory about that subject updates the file instead of sitting
// next to it. Matching topics is exact and cheap, which is the point — see check() below for why
// similarity is not used for this.
export function topicKey(v) {
  return String(v ?? '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// Character bigrams, not words. Korean preference sentences are short and their meaning turns on one
// word ("한국어로" / "영어로"), so this is deliberately only ever used to *show* a near miss, never to
// merge or delete anything.
const grams = s => {
  const t = String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
function overlap(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let c = 0;
  for (const x of A) if (B.has(x)) c++;
  return (2 * c) / (A.size + B.size);
}

// Pinned first, then whichever was touched last — the order the digest spends its budget in.
export function list() {
  let names = [];
  try { names = fs.readdirSync(DIR) } catch { return [] }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(DIR, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const e = parse(name.slice(0, -3), fs.readFileSync(file, 'utf8'), st);
      if (e && (e.title || e.text)) out.push(e);
    } catch {}
  }
  return out.sort((a, b) => (b.pin - a.pin) || (b.updated - a.updated));
}

// What a new run is given. Empty when there is nothing saved, so a first install pays nothing for it.
// A memory longer than the room left is cut down rather than dropped: the one failure this must not
// have is a long pinned memory making the block vanish, which leaves the model certain there is no
// memory at all. Anything that still does not fit is named in the trailing note, so the model knows
// to read the folder instead of assuming it has seen everything.
const MIN_CUT = 120; // a cut shorter than this says nothing worth the characters
const TRUNC = '…(cut to fit)';

function compose(budget, skip) {
  const all = list().filter(e => !(skip && e.key && skip.has(e.key)));
  const blocks = [], cut = [];
  let used = 0;
  for (const e of all) {
    const head = `### ${e.title}\n`;
    const text = e.text || '(no detail)';
    const block = head + text + '\n';
    if (used + block.length <= budget) { used += block.length; blocks.push(block); continue }
    const room = budget - used - head.length - TRUNC.length - 1;
    if (room >= MIN_CUT) {
      const part = head + text.slice(0, room).trimEnd() + TRUNC + '\n';
      if (used + part.length <= budget) { used += part.length; blocks.push(part); continue }
    }
    cut.push(e.title);
  }
  return { all, blocks, cut, used };
}

// Titles, shortened, for the trailing note. Capped by characters rather than by count so the note
// cannot grow into the thing it is describing.
function brief(titles, cap = 240) {
  let names = '', shown = 0;
  for (const t of titles) {
    const name = t.length > 30 ? t.slice(0, 30) + '…' : t;
    if (shown && names.length + name.length > cap) break;
    names += (shown++ ? ', ' : '') + name;
  }
  return names + (shown < titles.length ? ', …' : '');
}

// `skip`: topic keys to leave out — the ones the person's profile (ui/profile.mjs) now answers for, so
// an old memory about the same thing cannot contradict it.
export function digest(budget = BUDGET, skip = null) {
  const { blocks, cut, used } = compose(budget, skip);
  if (!blocks.length) {
    // Nothing fitted at all, which with a sane budget means every memory is huge; still say that memory
    // exists, because saying nothing is the one answer that is certainly wrong.
    if (!cut.length) return '';
    return `## Memory (기억)\n` +
      `Facts the person asked you to keep from earlier sessions. None fit in ${budget} characters: ` +
      `${brief(cut, used ? 240 : 240)} — read ${DIR} before answering.\n`;
  }
  const more = cut.length
    ? `\n(${cut.length} more did not fit: ${brief(cut)} — read ${DIR} when they might matter.)\n`
    : '';
  return `## Memory (기억)\n` +
    `Facts the person asked you to keep from earlier sessions, newest first. Keep to them; do not repeat them back.\n\n` +
    blocks.join('\n') + more;
}

export function snapshot() {
  const { all, cut, used } = compose(BUDGET);
  return {
    dir: DIR,
    budget: BUDGET,
    // Counted the way the budget is spent, so "3,000 of 3,000" means nothing else fits.
    used,
    cut,
    entries: all,
    digest: digest(),
  };
}

// A readable file name, in the person's own script: "답변 방식" stays "답변-방식.md". Anything that is
// awkward in a path becomes a dash; the id is never taken from a request, only from readdir.
function slug(title) {
  return String(title).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'memo';
}
function uniqueId(title) {
  const base = slug(title);
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(DIR, id + '.md'))) id = `${base}-${n++}`;
  return id;
}
function write(id, title, text, pin, key) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, id + '.md');
  const tmp = file + '.' + process.pid + '.tmp';
  const fm = `---\npin: ${pin}\n${key ? `key: ${key}\n` : ''}---\n`;
  fs.writeFileSync(tmp, `${fm}# ${title}\n${text ? '\n' + text + '\n' : ''}`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// What already looks like this, so the page can say so before writing. Every reason is stated, and
// none of them is acted on here: a merge or a delete needs the person, because in Korean a
// contradiction ("답변은 한국어로" / "답변은 영어로") overlaps as much as a duplicate does.
export function check({ id, title, key, body } = {}) {
  const k = topicKey(key);
  const t = String(title ?? '').normalize('NFC').trim().toLowerCase();
  const probe = `${title ?? ''} ${body ?? ''}`;
  const out = [];
  for (const e of list()) {
    if (id && e.id === id) continue;
    const reasons = [];
    if (k && e.key === k) reasons.push('key');
    if (t && e.title.normalize('NFC').trim().toLowerCase() === t) reasons.push('title');
    const score = Math.round(overlap(probe, `${e.title} ${e.text || ''}`) * 100) / 100;
    if (score >= 0.5) reasons.push('similar');
    if (reasons.length) out.push({ id: e.id, title: e.title, key: e.key, pin: e.pin, updated: e.updated, reasons, score });
  }
  // Same topic first, then the strongest overlap: that is the order worth reading.
  return out.sort((a, b) => (b.reasons.includes('key') - a.reasons.includes('key')) || b.score - a.score);
}

// Create, edit, or re-pin. Anything left out of the request keeps its saved value, which is what lets
// the page flip `pin` without sending the text back.
export function save({ id, title, body, pin, key } = {}) {
  let old = id ? list().find(e => e.id === id) : null;
  if (id && !old) throw Object.assign(Error('no such memory: ' + id), { status: 404 });
  const k = key === undefined ? (old?.key ?? null) : (topicKey(key) || null);
  // A key names a subject, so a second memory about it updates the file: no near-duplicate can be
  // created by wording something differently. Only for a new memory — an explicit id wins.
  let inPlace = null;
  if (!old && k) {
    inPlace = list().find(e => e.key === k) || null;
    if (inPlace) old = inPlace;
  }
  // Two files can never claim one topic: that would make "the file for this subject" ambiguous, and
  // the digest would send both. Refused with the name of the holder so the page can offer to edit it.
  if (k) {
    const holder = list().find(e => e.key === k && e.id !== old?.id);
    if (holder) throw Object.assign(Error(`key “${k}” is already used by “${holder.title}”`), { status: 409, holder: holder.id });
  }
  let t = String(title ?? old?.title ?? '').trim().slice(0, 100);
  let text = String(body ?? old?.text ?? '').trim();
  if (!t && !text) throw Object.assign(Error('a memory needs a title or some text'), { status: 400 });
  if (!t) {
    // No title given: the first line is the title, and it is removed from the body so it is not stored twice.
    const lines = text.split('\n');
    const at = lines.findIndex(l => l.trim());
    t = lines[at].replace(/^#+\s*/, '').trim().slice(0, 100) || 'memo';
    text = lines.filter((_, i) => i !== at).join('\n').trim();
  }
  const pinned = pin === undefined ? !!old?.pin : !!pin;
  write(old ? old.id : uniqueId(t), t, text, pinned, k);
  return { ...snapshot(), updatedInPlace: inPlace ? { id: inPlace.id, title: inPlace.title } : null };
}

export function remove(id) {
  const e = list().find(x => x.id === id);
  if (!e) throw Object.assign(Error('no such memory'), { status: 404 });
  fs.unlinkSync(path.join(DIR, e.id + '.md'));
  return snapshot();
}

// Fewer, fuller memories. The assistant says which memories are about one thing (memory_compact in
// engine/bisu-tools.mjs), the person approves on the card, and this applies it: each merge writes one
// new memory and retires the ones it was made from; drop retires memories that are simply out of date.
// Retired files are moved to .compacted/<time>/ under the folder, not deleted, so a wrong merge can be
// put back by hand. A pinned memory is never retired: pinning is the person saying "keep this as it is".
// Memories are named by id or, since the digest shows titles, by exact title.
const bad = (msg, status = 400) => Object.assign(Error(msg), { status });
export function compact({ merge = [], drop = [] } = {}) {
  const all = list();
  const find = ref => {
    const r = String(ref ?? '').trim();
    const hits = all.filter(e => e.id === r);
    if (!hits.length) hits.push(...all.filter(e => e.title.normalize('NFC').trim() === r.normalize('NFC')));
    if (!hits.length) throw bad(`no such memory: ${r}`, 404);
    if (hits.length > 1) throw bad(`“${r}” names ${hits.length} memories; use the id`);
    return hits[0];
  };
  const retire = new Map();
  const take = ref => {
    const e = find(ref);
    if (e.pin) throw bad(`“${e.title}” is pinned, so it stays as it is`);
    if (retire.has(e.id)) throw bad(`“${e.title}” is named twice`);
    retire.set(e.id, e);
    return e;
  };
  const plans = [];
  for (const m of Array.isArray(merge) ? merge : []) {
    const from = (Array.isArray(m?.from) ? m.from : []).map(take);
    if (!from.length) throw bad('a merge needs the memories it is made from');
    const into = m.into || {};
    const title = String(into.title ?? '').trim().slice(0, 100);
    const text = String(into.text ?? into.body ?? '').trim();
    if (!title) throw bad('a merged memory needs a title');
    const key = topicKey(into.key ?? from.find(e => e.key)?.key ?? '') || null;
    plans.push({ title, text, key, from });
  }
  for (const ref of Array.isArray(drop) ? drop : []) take(ref);
  if (!retire.size) throw bad('nothing to compact');
  // A key still names one memory: a merge may take a key over only from a memory it retires.
  const keys = new Set();
  for (const p of plans) {
    if (!p.key) continue;
    if (keys.has(p.key)) throw bad(`two merged memories claim key “${p.key}”`);
    keys.add(p.key);
    const holder = all.find(e => e.key === p.key && !retire.has(e.id));
    if (holder) throw bad(`key “${p.key}” is already used by “${holder.title}”`, 409);
  }
  const backup = path.join(DIR, '.compacted', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const id of retire.keys()) fs.renameSync(path.join(DIR, id + '.md'), path.join(backup, id + '.md'));
  const wrote = [];
  for (const p of plans) { const id = uniqueId(p.title); write(id, p.title, p.text, false, p.key); wrote.push(id) }
  return { ...snapshot(), compacted: { wrote, retired: [...retire.keys()], backup } };
}

// ---- command line, for launch.zsh ----
function main(argv) {
  const mode = argv[0];
  if (mode === 'digest') return process.stdout.write(digest(Number(argv[1]) || BUDGET));
  if (mode === 'prompt') {
    const base = fs.readFileSync(argv[1], 'utf8').trimEnd();
    const more = digest(Number(argv[2]) || BUDGET);
    return process.stdout.write(base + '\n' + (more ? '\n' + more : ''));
  }
  process.stdout.write(`${DIR}\n\n${digest() || '(nothing saved yet)\n'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
