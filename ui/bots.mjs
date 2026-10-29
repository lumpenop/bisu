// Bots: bisu for one job. Each bot has a name, one main job, how it works (instructions), a folder and a
// tone, and its own conversations, memory and scheduled jobs. The person teaches a bot by talking to it;
// there is no workflow builder.
//
// One markdown file per bot in ~/.config/bisu/bots/<id>.md, the same shape as a scheduled job:
//   ---
//   name: 리서치 봇
//   job: 매주 업계 뉴스를 찾아 요약해요
//   cwd: ~/Desktop/research
//   tone: 존댓말, 짧게
//   ---
//   (how it works, in the person's words)
//
// The default bot is 'bisu'. It owns everything that existed before bots: the memory folder
// (~/.config/bisu/memory), every scheduled job without a `bot:` line and every conversation without a
// bot, so nothing is moved and nothing can be lost. Other bots keep their memory in bots/<id>/memory and
// mark their jobs with `bot: <id>`.
//
// A run knows its bot from BISU_BOT (launch.zsh passes it on): the system prompt gets the bot's block,
// memory reads and writes its folder, and a job it schedules carries its id.
//
//   node bots.mjs prompt <prompt.md>   # prompt.md + the bot's block + its memory, for --append-system-prompt-file
//   node bots.mjs                      # the bots, for a look by hand
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as memory from './memory.mjs';
import * as profile from './profile.mjs';

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
export const DIR = path.join(CONFIG, 'bots');
export const DEFAULT = 'bisu';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELDS = ['name', 'job', 'cwd', 'tone'];
const home = p => String(p || '').replace(/^~(?=\/|$)/, os.homedir());
const short = p => String(p || '').replace(os.homedir(), '~');
const oneLine = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const validId = id => typeof id === 'string' && ID.test(id);
export const memoryDir = id => memory.dirFor(id);

function parse(id, text) {
  const bot = { id, name: id, job: '', cwd: os.homedir(), tone: '', instructions: '', default: id === DEFAULT };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (kv && FIELDS.includes(kv[1])) bot[kv[1]] = kv[1] === 'cwd' ? home(kv[2].trim()) || os.homedir() : kv[2].trim();
    }
    bot.instructions = m[2].trim();
    if (bot.default && bot.name === 'bisu') bot.name = '덱 인턴';   // the old outward name, renamed 2026-10-29
  } else bot.instructions = String(text).trim();
  return bot;
}
function write(bot) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${bot.id}.md`), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `---\nname: ${oneLine(bot.name, 40)}\njob: ${oneLine(bot.job, 200)}\ncwd: ${short(bot.cwd)}\ntone: ${oneLine(bot.tone, 80)}\n---\n${String(bot.instructions || '').trim()}\n`);
  fs.renameSync(tmp, file);
}

// The default bot's file is written the first time bots are looked at; it describes the bisu that was
// there before, so ownership of the old memory, jobs and chats is the migration.
export function ensureDefault() {
  const file = path.join(DIR, `${DEFAULT}.md`);
  if (fs.existsSync(file)) return;
  write({ id: DEFAULT, name: '덱 인턴', job: '무엇이든 함께하는 비서', cwd: os.homedir(), tone: '', instructions: '' });
}

export function list() {
  ensureDefault();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIR) } catch {}
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const id = n.slice(0, -3);
    if (!validId(id)) continue;
    try { out.push(parse(id, fs.readFileSync(path.join(DIR, n), 'utf8'))) } catch {}
  }
  return out.sort((a, b) => (b.default - a.default) || a.name.localeCompare(b.name, 'ko'));
}
export function get(id) {
  if (!validId(id)) return null;
  try { return parse(id, fs.readFileSync(path.join(DIR, `${id}.md`), 'utf8')) } catch { return id === DEFAULT ? (ensureDefault(), get(DEFAULT)) : null }
}
// A bot that is gone (deleted, or a typo in a job file) runs as the default bot.
export const resolve = id => get(id) || get(DEFAULT);

function check(b) {
  if (!oneLine(b.name, 40)) throw Object.assign(Error('봇 이름이 필요해요.'), { status: 400 });
  const dir = path.resolve(home(b.cwd || '~'));
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(Error(`폴더가 없어요: ${short(dir)}`), { status: 400 });
  return dir;
}
function newId(name) {
  const base = String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  for (let i = 0; i < 20; i++) {
    const id = (base && base !== DEFAULT ? base : 'bot') + (i || !base ? '-' + randomBytes(2).toString('hex') : '');
    if (validId(id) && !fs.existsSync(path.join(DIR, `${id}.md`))) return id;
  }
  return 'bot-' + randomBytes(4).toString('hex');
}
export function create({ name, job = '', instructions = '', cwd = '~', tone = '' } = {}) {
  ensureDefault();
  const dir = check({ name, cwd });
  const bot = { id: newId(name), name: oneLine(name, 40), job: oneLine(job, 200), cwd: dir, tone: oneLine(tone, 80), instructions: String(instructions || '').slice(0, 8000) };
  write(bot);
  return get(bot.id);
}
export function update(id, patch = {}) {
  const bot = get(id);
  if (!bot) throw Object.assign(Error(`봇이 없어요: ${id}`), { status: 404 });
  const next = { ...bot };
  for (const k of FIELDS) if (typeof patch[k] === 'string') next[k] = patch[k];
  if (typeof patch.instructions === 'string') next.instructions = patch.instructions.slice(0, 8000);
  next.cwd = check(next);
  write(next);
  return get(id);
}
// Deleting a bot removes its file. Its memory folder stays where it is (bots/<id>/memory) and its jobs
// and conversations fall back to the default bot, so nothing the person wrote disappears with it.
export function remove(id) {
  if (id === DEFAULT) throw Object.assign(Error('기본 봇은 지울 수 없어요.'), { status: 400 });
  const bot = get(id);
  if (!bot) throw Object.assign(Error(`봇이 없어요: ${id}`), { status: 404 });
  fs.rmSync(path.join(DIR, `${id}.md`), { force: true });
  return { removed: id };
}

// What another bot has saved to remember, for the default bot only (engine/bisu-tools.mjs bot_memory):
// a bot is given its own memory in its prompt and nothing of the others', and a delegated worker has no
// memory tools at all. Reading only; nothing here writes into another bot's folder.
export function memoryOf(who) {
  const q = String(who || '').trim();
  const all = list();
  const bot = all.find(b => b.id === q || b.name === q) || (q ? all.find(b => b.name.includes(q) || q.includes(b.name)) : null);
  return bot ? { bot, entries: memory.inBot(bot.id, () => memory.list()) } : null;
}
export const memoryCount = id => memory.inBot(id, () => memory.list()).length;

// What a run of this bot is told, after bisu's own prompt.
export function block(id, { maker = false } = {}) {
  const bot = resolve(id);
  const parts = [];
  if (!bot.default || bot.instructions || bot.tone || bot.job !== '무엇이든 함께하는 비서') {
    parts.push(`## 이 봇 (${bot.name})`,
      `You are "${bot.name}", one of the person's bisu bots.${bot.job ? ` Your main job: ${bot.job}` : ''}`,
      bot.tone ? `Tone: ${bot.tone}` : '',
      `Your folder is ${short(bot.cwd)}.`,
      bot.instructions ? `How the person wants you to work:\n${bot.instructions}` : '');
    if (!bot.default) parts.push(`Your memory folder is ${short(memoryDir(bot.id))} — save and read memories there, not in ~/.config/bisu/memory. A scheduled job you create carries \`bot: ${bot.id}\` in its frontmatter so it runs as you.`);
  }
  // Who else there is, for handing work over (bot_handoff); "@이름" in a message means that bot.
  const others = list().filter(b => b.id !== bot.id);
  if (others.length && !maker) parts.push(`## 다른 봇 (handing work over)\nThe person's other bots: ${others.map(b => `${b.name} (${b.id})${b.job ? ' — ' + b.job : ''}`).join('; ')}.\nWhen the person writes @ and a bot's name, or a task plainly belongs to another bot's job, hand it over with bot_handoff (one complete brief), say in one line who is on it, and end your turn; its report comes back here as a message — check it and tell the person. Handing over is only the bot_handoff call: never say a bot has the task unless that call returned "Handed to".${bot.default ? '\nbot_memory with a bot\'s name shows what that bot has saved to remember (read only); the bots do not see yours or each other\'s.' : ''}`);
  if (maker) parts.push(MAKER);
  return parts.filter(Boolean).join('\n');
}
const MAKER = `## 봇 만들기
This conversation makes a new bot. A bot is bisu for one main job: a name, the job in one sentence, a folder, how it should work, and a tone.
- Ask what is still missing, one short question per message, at most four in all, in this order: its name; the one job it does; the folder it works in (default: home); how it should work and talk. Skip anything the person already said.
- Then call bot_create once with name, job, cwd, instructions (their way of working, in their words, tidied into short lines) and tone. That call shows the person a preview card ("이렇게 만들까요?") and writes nothing until they press 만들기.
- If they say to change something after it exists, use bot_update with its id.
- Afterwards, tell them in one line that they can pick the bot in the sidebar and talk to it there.`;

async function main(argv) {
  const [mode] = argv;
  if (mode === 'prompt') {
    const base = fs.readFileSync(argv[1], 'utf8').trimEnd();
    const id = validId(process.env.BISU_BOT) ? process.env.BISU_BOT : DEFAULT;
    const mine = block(id, { maker: process.env.BISU_BOT_MAKER === '1' });
    // The person is the same person for every bot. Their block comes last, after memory: it wins over
    // memory, and the end of the prompt is what the model weighs most. Memories about what the profile
    // now says (their name, their tone) are left out, so the two cannot disagree.
    const me = profile.get();
    const mem = memory.inBot(id, () => memory.digest(Number(argv[2]) || memory.BUDGET, profile.supersedes(me)));
    return process.stdout.write([base, mine, mem, profile.block(me)].filter(Boolean).join('\n\n') + '\n');
  }
  for (const b of list()) process.stdout.write(`${b.id}${b.default ? ' (default)' : ''}  ${b.name}  — ${b.job}  [${short(b.cwd)}]\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
