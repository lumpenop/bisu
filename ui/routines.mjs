// Routines: a job a bot did well once, kept so it can do it again — by asking, on a schedule, or from what
// the person showed it on the Mac (ui/teach.mjs). A routine is the steps in short lines, the inputs it needs
// each time, and how much it may do (read, edit or full, the same grades as scheduled jobs).
//
// One markdown file per routine in ~/.config/bisu/routines/<slug>.md:
//   ---
//   name: 주간 뉴스 요약
//   bot: bot-83d1
//   inputs: 주제, 기간
//   tools: read
//   paused: false
//   ---
//   1. {주제} 관련 뉴스를 {기간} 동안 찾는다
//   2. 출처와 함께 다섯 줄로 요약한다
//
// Running one is an ordinary conversation of its bot that starts with the steps (approvals as usual).
// Scheduling one writes a scheduled job with `routine: <slug>`; the job's approval hash covers the routine's
// text too (ui/jobs.mjs), so an edit/full routine changed after approval waits to be approved again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
export const DIR = path.join(CONFIG, 'routines');
const SLUG = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const BOT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GRADES = ['read', 'edit', 'full'];
const one = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const validSlug = s => typeof s === 'string' && SLUG.test(s);

function parse(slug, text) {
  const r = { slug, name: slug, bot: 'bisu', inputs: [], tools: 'read', paused: false, steps: '', source: '' };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const [, k, v] = kv;
      if (k === 'name' && v) r.name = one(v, 80);
      else if (k === 'bot' && BOT.test(v.trim())) r.bot = v.trim();
      else if (k === 'inputs') r.inputs = v.split(',').map(x => one(x, 30)).filter(Boolean).slice(0, 8);
      else if (k === 'tools' && GRADES.includes(v.trim())) r.tools = v.trim();
      else if (k === 'paused') r.paused = /^(true|yes|1)$/i.test(v.trim());
      else if (k === 'source') r.source = one(v, 20);
    }
    r.steps = m[2].trim();
  } else r.steps = String(text).trim();
  return r;
}
function file(slug) { return path.join(DIR, `${slug}.md`) }
function write(r) {
  fs.mkdirSync(DIR, { recursive: true });
  const f = file(r.slug), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `---\nname: ${one(r.name, 80)}\nbot: ${r.bot}\ninputs: ${r.inputs.join(', ')}\ntools: ${r.tools}\npaused: ${r.paused ? 'true' : 'false'}\n${r.source ? `source: ${r.source}\n` : ''}---\n${String(r.steps).trim()}\n`);
  fs.renameSync(tmp, f);
}
export function read(slug) {
  if (!validSlug(slug)) return null;
  try { return parse(slug, fs.readFileSync(file(slug), 'utf8')) } catch { return null }
}
// The raw file, for the job approval hash.
export function raw(slug) { try { return validSlug(slug) ? fs.readFileSync(file(slug), 'utf8') : null } catch { return null } }
export function list(bot) {
  let names = [];
  try { names = fs.readdirSync(DIR) } catch {}
  return names.filter(n => n.endsWith('.md')).map(n => read(n.slice(0, -3))).filter(Boolean)
    .filter(r => !bot || r.bot === bot).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
function slugFor(name) {
  const base = String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'routine';
  for (let i = 0; i < 50; i++) { const s = i ? `${base}-${i + 1}` : base; if (SLUG.test(s) && !fs.existsSync(file(s))) return s }
  return `routine-${Date.now().toString(36)}`;
}
const stepsText = steps => Array.isArray(steps) ? steps.map((s, i) => `${i + 1}. ${one(s, 300)}`).join('\n') : String(steps || '').trim();
const inputsOf = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => one(x, 30)).filter(Boolean).slice(0, 8);
export function save({ name, bot = 'bisu', steps, inputs = [], tools = 'read', source = '' } = {}) {
  if (!one(name, 80)) throw Object.assign(Error('루틴 이름이 필요해요.'), { status: 400 });
  const text = stepsText(steps);
  if (!text) throw Object.assign(Error('단계가 비어 있어요.'), { status: 400 });
  const r = { slug: slugFor(name), name: one(name, 80), bot: BOT.test(bot) ? bot : 'bisu', inputs: inputsOf(inputs), tools: GRADES.includes(tools) ? tools : 'read', paused: false, steps: text, source: one(source, 20) };
  write(r);
  return read(r.slug);
}
export function update(slug, patch = {}) {
  const r = read(slug);
  if (!r) throw Object.assign(Error(`루틴이 없어요: ${slug}`), { status: 404 });
  if (typeof patch.name === 'string' && one(patch.name, 80)) r.name = one(patch.name, 80);
  if (patch.steps !== undefined) { const t = stepsText(patch.steps); if (t) r.steps = t }
  if (patch.inputs !== undefined) r.inputs = inputsOf(patch.inputs);
  if (GRADES.includes(patch.tools)) r.tools = patch.tools;
  if (typeof patch.paused === 'boolean') r.paused = patch.paused;
  write(r);
  return read(slug);
}
export function remove(slug) {
  if (!read(slug)) throw Object.assign(Error(`루틴이 없어요: ${slug}`), { status: 404 });
  fs.rmSync(file(slug), { force: true });
  return { removed: slug };
}
// What a run of the routine is asked to do. Inputs given now replace {이름}; ones not given are left for the
// bot to ask about (in a chat) or to work out (in a job).
export function prompt(r, values = {}) {
  const steps = r.steps.replace(/\{([^{}]{1,30})\}/g, (all, k) => values[k.trim()] != null && String(values[k.trim()]).trim() ? String(values[k.trim()]).trim() : all);
  const given = r.inputs.filter(k => values[k] != null && String(values[k]).trim()).map(k => `${k}: ${String(values[k]).trim()}`);
  return `루틴 「${r.name}」을 실행해 줘.${given.length ? `\n입력 — ${given.join(', ')}` : ''}\n\n${steps}\n\n${r.inputs.some(k => !values[k]) ? '빠진 입력이 있으면 먼저 한 번에 물어봐 줘. ' : ''}끝나면 무엇을 했는지 짧게 알려 줘.`;
}
