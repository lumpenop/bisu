// bisu's computer use, as tools Claude Code can call: look at the window, pick one of the things on
// it, click or type, and check what happened.
//
// The split matters. Accessibility says what is actually on the window — every button with its real
// frame — so most steps need no pixels at all and no model guessing at coordinates. A decision model
// then chooses between those candidates and reports its confidence. Only when the window exposes
// nothing (a game, a canvas, a custom-drawn app) does a vision model look at a screenshot and guess.
//
// Anything destructive — delete, buy, send, quit, format, overwrite — is not executed on the spot.
// It is held and handed back as an approval request, and `cu_approve` (which the person sees, because
// it is deliberately not pre-allowed) is the only way to run it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as sessions from '../sessions.mjs';
import {CALENDAR_TOOLS} from '../../engine/calendar.mjs';
import {BISU_TOOLS, isDefaultBot} from '../../engine/bisu-tools.mjs';
import {BROWSER_TOOLS} from '../../engine/browser.mjs';
import {WATCH_TOOLS} from '../claude-watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'bisu');
const BIN = path.join(SUPPORT, 'bin', 'bisu-cu');
const SOURCE = path.join(here, '..', '..', 'mac', 'cu', 'bisu-cu.swift');
const SHOTS = path.join(SUPPORT, 'shots');
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'bisu', 'cu.log');

const OPENROUTER = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai').replace(/\/$/, '');
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OAI_KEY = process.env.OPENAI_API_KEY || '';
const VISION_MODEL = process.env.BISU_CU_VISION_MODEL || 'z-ai/glm-5.3-flash';
const DECISION_MODEL = process.env.BISU_CU_DECISION_MODEL || 'gpt-6-luna';
const APPROVE_TTL = 180_000;

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try { fs.mkdirSync(path.dirname(LOG), {recursive: true}); fs.appendFileSync(LOG, line) } catch {}
}

// ---- the helper binary ----

let building = null;
function build() {
  if (fs.existsSync(BIN)) return Promise.resolve(BIN);
  if (building) return building;
  // First run on a fresh install: the app ships the source, not a binary per architecture.
  building = new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(BIN), {recursive: true});
    const c = spawn('/usr/bin/swiftc', ['-O', '-o', BIN, SOURCE], {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    c.stderr.on('data', d => { err += d });
    c.on('close', code => {
      building = null;
      if (code === 0 && fs.existsSync(BIN)) resolve(BIN);
      else reject(Error(`bisu-cu build failed (${code}): ${err.slice(-400)}`));
    });
  });
  return building;
}

async function cu(args, {timeout = 20_000} = {}) {
  const bin = await build();
  return new Promise(resolve => {
    execFile(bin, args, {timeout, maxBuffer: 32 << 20, encoding: 'utf8'}, (e, stdout, stderr) => {
      let j = null;
      try { j = JSON.parse(stdout.trim()) } catch {}
      if (j) return resolve(j);
      resolve({ok: false, error: e ? String(e.message || e) : String(stderr || 'no output')});
    });
  });
}

// ---- snapshot bookkeeping ----
// Element ids are only meaningful for the snapshot they came from, so the last one is kept and used
// to resolve a click. A stale id is refused rather than guessed at.

let last = null; // {app, pid, window, elements, at}

async function snapshot(opts = {}) {
  const args = ['snapshot', '--max', String(opts.max ?? 250)];
  if (opts.all) args.push('--all');
  const s = await cu(args);
  if (!s.ok) return s;
  last = {ok: true, app: s.app, pid: s.pid, window: s.window, elements: s.elements || [], at: Date.now(), display: s.display};
  return s;
}

const label = e => [e.title, e.desc, e.value, e.placeholder].filter(Boolean).join(' · ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 120);
const mid = f => [Math.round(f[0] + f[2] / 2), Math.round(f[1] + f[3] / 2)];
const clickable = e => Array.isArray(e.frame) && e.frame[2] > 0 && e.frame[3] > 0 && !e.disabled;
const pressable = e => (e.actions || []).some(a => /Press|Confirm|Open|ShowMenu/.test(a));

function line(e) {
  const bits = [`[${e.id}]`, e.role.replace(/^AX/, '')];
  const l = label(e);
  if (l) bits.push(JSON.stringify(l));
  if (e.frame) bits.push(`@${e.frame[0]},${e.frame[1]} ${e.frame[2]}x${e.frame[3]}`);
  // Some apps put multi-line debug text in an action name; keep one element on one line.
  if (e.actions?.length) bits.push(e.actions.join(',').replace(/[\r\n]+/g, ' ').slice(0, 60));
  if (e.disabled) bits.push('disabled');
  if (e.selected) bits.push('selected');
  return bits.join(' ');
}

function render(s, {max = 120, onlyClickable = false} = {}) {
  const list = (s.elements || []).filter(e => (onlyClickable ? pressable(e) && clickable(e) : true)).slice(0, max);
  const head = [`app: ${s.app}${s.window ? ` — window "${s.window}"` : ''}`];
  if (s.display) head.push(`display: ${s.display.width}x${s.display.height} @${s.display.scale}x`);
  if (s.focused) head.push(`focused: ${s.focused.role.replace(/^AX/, '')}${label(s.focused) ? ` ${JSON.stringify(label(s.focused))}` : ''}`);
  if (s.truncated) head.push(`(list truncated; ${s.elements.length} shown of the window's tree)`);
  return [...head, ...list.map(line)].join('\n');
}

// ---- screenshots ----

let shotCounter = 0;
// Screenshots are the most sensitive thing bisu writes to disk: a picture of whatever was on screen,
// including anything the person had open. They are kept only long enough for the model to read one,
// and the folder is not readable by other accounts.
const SHOT_TTL = 15 * 60_000;
function pruneShots() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(SHOTS)) {
      if (!name.endsWith('.png')) continue;
      const p = path.join(SHOTS, name);
      try {
        if (now - fs.statSync(p).mtimeMs > SHOT_TTL) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

async function screenshot({windowOnly = true} = {}) {
  fs.mkdirSync(SHOTS, {recursive: true, mode: 0o700});
  try { fs.chmodSync(SHOTS, 0o700) } catch {}
  pruneShots();
  const file = path.join(SHOTS, `cu-${Date.now()}-${shotCounter++}.png`);
  let region = null;
  if (windowOnly) {
    const w = await cu(['window']);
    if (w.ok && Array.isArray(w.frame)) {
      // Keep a margin so the window's shadow and menu popovers are not cut off.
      const [x, y, wd, ht] = w.frame;
      const x0 = Math.max(0, x - 40), y0 = Math.max(0, y - 40);
      region = {x: x0, y: y0, w: Math.min(wd + 80, 4000), h: Math.min(ht + 80, 4000), scale: w.scale || 2};
      await new Promise(res => execFile('/usr/sbin/screencapture', ['-x', '-o', `-R${region.x},${region.y},${region.w},${region.h}`, file], () => res()));
    }
  }
  if (!region) {
    await new Promise(res => execFile('/usr/sbin/screencapture', ['-x', '-o', file], () => res()));
    const d = last?.display || {width: 1440, height: 900, scale: 2};
    region = {x: 0, y: 0, w: d.width, h: d.height, scale: d.scale || 2};
  }
  if (!fs.existsSync(file)) return {ok: false, error: 'screencapture produced nothing (Screen Recording permission?)'};
  // A 2x screenshot is 2x the tokens for no extra judgement, so cap the long edge.
  await new Promise(res => execFile('/usr/bin/sips', ['-Z', '1400', file], () => res()));
  const data = fs.readFileSync(file).toString('base64');
  return {ok: true, file, region, base64: data};
}

// ---- the decision model ----

const DESTRUCTIVE = /(delete|삭제|지우|지워|휴지통|empty trash|비우|remove|제거|uninstall|buy|purchase|결제|구매|pay\b|send|보내|전송|submit|제출|confirm|확인|format|초기화|reset|overwrite|덮어쓰|erase|wipe|quit|종료|끝내|log ?out|sign ?out|로그아웃|shutdown|재시동|restart|disable|해제|grant|허용|allow)/i;

function candidates(s) {
  // Elements without a label still matter: the document body of an editor, a canvas, an image.
  // They are described by role and place instead of being dropped.
  const out = [];
  const seenFrames = new Set();
  for (const e of s.elements || []) {
    if (!clickable(e)) continue;
    const key = e.frame.join(',');
    if (seenFrames.has(key)) continue;
    seenFrames.add(key);
    out.push(e);
    if (out.length >= 60) break;
  }
  return out;
}

const describeElement = e => {
  const l = label(e);
  const role = e.role.replace(/^AX/, '');
  const where = e.frame ? `[${e.frame.join(',')}]` : '';
  return l ? `${role} ${JSON.stringify(l)} ${where}` : `${role} (no label — unlabeled area) ${where}`;
};

async function decide(goal, snapshotData, {vision = true} = {}) {
  const cands = candidates(snapshotData);
  if (!cands.length) return {ok: false, error: 'no elements with a frame on this window'};
  const shot = vision ? await screenshot() : null;
  const screenText = `${render({...snapshotData, elements: cands}, {max: 60})}`;
  const choices = cands.map(e => ({value: String(e.id), description: describeElement(e)}));
  choices.push({value: 'wait', description: 'nothing on this screen makes progress; wait or ask'});
  choices.push({value: 'done', description: 'the goal is already satisfied by this screen'});

  const instructions = `The person asked: "${goal}". Pick the single next action that makes progress. Prefer a control whose label names the goal. An element marked "no label" is a bare area such as a document body or canvas — choose it when the goal is to type or drop something there. Choose "done" only if the screen already shows it finished.`;

  if (OAI_KEY) {
    const t0 = Date.now();
    try {
      const input = [{type: 'message', role: 'user', content: [
        {type: 'input_text', text: `macOS window state:\n${screenText}`},
        ...(shot?.ok ? [{type: 'input_image', image_url: `data:image/png;base64,${shot.base64}`}] : []),
      ]}];
      const r = await fetch(`${OPENAI}/decisions`, {
        method: 'POST',
        headers: {authorization: `Bearer ${OAI_KEY}`, 'content-type': 'application/json'},
        body: JSON.stringify({model: DECISION_MODEL, input, questions: [{type: 'choice', name: 'action', instructions, choices}]}),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.answers?.[0]?.choice) {
        const a = j.answers[0];
        const el = cands.find(e => String(e.id) === a.choice);
        log(`decide ${Date.now() - t0}ms confidence=${a.confidence} choice=${a.choice}`);
        return {ok: true, via: 'decisions', choice: a.choice, confidence: a.confidence ?? null,
          probabilities: a.probabilities || [], element: el || null, ms: Date.now() - t0};
      }
      log(`decisions failed ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) { log('decisions error', String(e.message)) }
  }

  // No decision key, or the endpoint is unavailable: ask a small vision model to pick from the same list.
  if (!OR_KEY) return {ok: false, error: 'no decision model available (no OpenAI key and no OpenRouter key)'};
  const t0 = Date.now();
  try {
    const r = await fetch(`${OPENROUTER}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {authorization: `Bearer ${OR_KEY}`, 'content-type': 'application/json'},
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        messages: [{role: 'user', content: [
          {type: 'text', text: `macOS window state:\n${screenText}\n\n${instructions}\nAnswer with JSON only: {"choice":"<id|wait|done>","why":"<6 words>"}`},
          ...(shot?.ok ? [{type: 'image_url', image_url: {url: `data:image/png;base64,${shot.base64}`}}] : []),
        ]}],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const j = await r.json().catch(() => null);
    const text = j?.choices?.[0]?.message?.content || '';
    const m = /\{[\s\S]*\}/.exec(text);
    const pick = m ? JSON.parse(m[0]) : null;
    if (!pick?.choice) return {ok: false, error: `decision model gave no choice: ${text.slice(0, 160)}`};
    const el = cands.find(e => String(e.id) === String(pick.choice));
    log(`decide(glm) ${Date.now() - t0}ms choice=${pick.choice}`);
    return {ok: true, via: VISION_MODEL, choice: String(pick.choice), confidence: null,
      why: pick.why || null, element: el || null, ms: Date.now() - t0};
  } catch (e) {
    return {ok: false, error: String(e.message || e)};
  }
}

// Screenshot → point, for windows that expose nothing usable.
async function ground(target, {maxWidth = 1400} = {}) {
  if (!OR_KEY) return {ok: false, error: 'no OpenRouter key for the vision fallback'};
  const shot = await screenshot();
  if (!shot.ok) return shot;
  const t0 = Date.now();
  const r = await fetch(`${OPENROUTER}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {authorization: `Bearer ${OR_KEY}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 400,
      messages: [{role: 'user', content: [
        {type: 'text', text: `This is a macOS window screenshot. Find: "${target}".\nAnswer with JSON only, no prose:\n{"x":0-1000,"y":0-1000,"label":"what you are pointing at","found":true}\nx and y are the centre of the control, relative to the image (0,0 is its top-left). If it is not on screen, use {"found":false}.`},
        {type: 'image_url', image_url: {url: `data:image/png;base64,${shot.base64}`}},
      ]}],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await r.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return {ok: false, error: `vision gave no JSON: ${text.slice(0, 160)}`};
  let pick;
  try { pick = JSON.parse(m[0]) } catch { return {ok: false, error: `vision gave bad JSON: ${m[0].slice(0, 160)}`} }
  if (pick.found === false) return {ok: false, error: `"${target}" is not visible in this window`};
  const {x, y, w, h} = shot.region;
  const point = [Math.round(x + (pick.x / 1000) * w), Math.round(y + (pick.y / 1000) * h)];
  log(`ground ${Date.now() - t0}ms ${target} -> ${point}`);
  return {ok: true, point, label: pick.label || target, via: VISION_MODEL, file: shot.file, ms: Date.now() - t0};
}

// ---- approval for destructive steps ----

const pending = new Map();
let pendingSeq = 0;

function hold(tool, args, reason, detail) {
  for (const [id, p] of pending) if (Date.now() - p.at > APPROVE_TTL) pending.delete(id);
  const id = `cu${Date.now().toString(36)}${pendingSeq++}`;
  pending.set(id, {tool, args, reason, detail, at: Date.now()});
  return id;
}

function riskOf(what) {
  const text = String(what || '');
  const hit = DESTRUCTIVE.exec(text);
  return hit ? `"${hit[0]}" in ${JSON.stringify(text.slice(0, 80))}` : null;
}

// ---- tool implementations ----

const tools = {
  async cu_look({max = 120, clickable_only = false, all = false} = {}) {
    const s = await snapshot({all});
    if (!s.ok) return `could not read the window: ${s.error}`;
    return render(s, {max, onlyClickable: clickable_only});
  },

  async cu_decide({goal, vision = true}) {
    const s = last && Date.now() - last.at < 60_000 ? last : await snapshot();
    if (!s.ok) return `could not read the window: ${s.error}`;
    const d = await decide(goal, s, {vision});
    if (!d.ok) return `no decision: ${d.error}`;
    const conf = d.confidence == null ? '' : ` confidence=${(d.confidence * 100).toFixed(0)}%`;
    if (d.choice === 'wait') return `decision: wait${conf}${d.why ? ` (${d.why})` : ''} — nothing on this screen advances "${goal}"`;
    if (d.choice === 'done') return `decision: done${conf} — the screen already satisfies "${goal}"`;
    if (!d.element) return `decision: ${d.choice}${conf}, but that id is not in the current snapshot; call cu_look again`;
    return `decision: [${d.element.id}] ${d.element.role.replace(/^AX/, '')} ${JSON.stringify(label(d.element))} @${d.element.frame.join(',')}${conf}${d.why ? ` (${d.why})` : ''} — ${d.ms}ms via ${d.via}`;
  },

  async cu_click({id, x, y, button = 'left', count = 1, verify = true}) {
    let point = null, element = null, text = '';
    if (id != null) {
      if (!last || Date.now() - last.at > 120_000) return 'that element id is from an old snapshot — call cu_look again';
      // The window must be the one the ids came from, or a click lands in whatever replaced it.
      const w = await cu(['window']);
      if (!w.ok || (w.app && last.app && w.app !== last.app)) {
        return `the front window changed since that snapshot (it was "${last.app}", now "${w.app || 'unknown'}") — call cu_look again`;
      }
      element = last.elements.find(e => String(e.id) === String(id));
      if (!element) return `no element [${id}] in the current snapshot — call cu_look again`;
      if (!clickable(element)) return `[${id}] has no clickable frame (${element.frame || 'no frame'}); pick another element`;
      point = mid(element.frame);
      text = `${element.role.replace(/^AX/, '')} ${label(element)}`;
    } else if (x != null && y != null) {
      point = [Number(x), Number(y)];
      text = `point ${point.join(',')}`;
    } else {
      return 'give either id, or x and y';
    }
    const risk = riskOf(text);
    if (risk) {
      const pid = hold('cu_click', {point, button, count}, `this looks destructive (${risk})`, text);
      return `APPROVAL REQUIRED (${pid}): clicking ${text} looks destructive. Tell the person what it will do; if they agree, call cu_approve with id "${pid}".`;
    }
    const r = await cu(['click', '--x', String(point[0]), '--y', String(point[1]), '--button', button, '--count', String(count)]);
    if (!r.ok) return `click failed: ${r.error}`;
    if (!verify) return `clicked ${text} at ${point.join(',')}`;
    await new Promise(res => setTimeout(res, 450));
    const after = await snapshot({max: 200});
    if (!after.ok) return `clicked ${text} at ${point.join(',')} (could not re-read the window: ${after.error})`;
    const focus = after.focused ? `${after.focused.role.replace(/^AX/, '')} ${JSON.stringify(label(after.focused))}` : 'none';
    return `clicked ${text} at ${point.join(',')}\nnow: app ${after.app}${after.window ? ` — "${after.window}"` : ''}, focused ${focus}`;
  },

  async cu_type({text, submit = false, target_id = null}) {
    if (target_id != null) {
      const c = await tools.cu_click({id: target_id, verify: false});
      if (!/^clicked/.test(c)) return c;
      await new Promise(res => setTimeout(res, 150));
    }
    // Typing that ends in return sends whatever was typed (a mail, a message, a search that acts),
    // so it is the person's call, not the model's.
    if (submit) {
      const pid = hold('cu_type', {text, submit: true}, 'this types text and then submits it', text.slice(0, 80));
      return `APPROVAL REQUIRED (${pid}): this types text and then presses return. Tell the person what will be sent; if they agree, call cu_approve with id "${pid}".`;
    }
    const r = await cu(['type', '--text', text]);
    if (!r.ok) return `typing failed: ${r.error}`;
    if (submit) {
      await cu(['key', '--combo', 'return']);
      return `typed ${text.length} characters and pressed return`;
    }
    return `typed ${text.length} characters`;
  },

  async cu_key({combo}) {
    const risk = /cmd\+?(q|delete|backspace|option|shift\+delete)/i.test(String(combo)) ? `shortcut ${combo}` : null;
    if (risk) {
      const pid = hold('cu_key', {combo}, 'this shortcut quits, deletes or erases', combo);
      return `APPROVAL REQUIRED (${pid}): ${combo} can lose work. Call cu_approve with id "${pid}" if the person agrees.`;
    }
    const r = await cu(['key', '--combo', combo]);
    return r.ok ? `pressed ${combo}` : `key failed: ${r.error}`;
  },

  async cu_scroll({dy = 0, dx = 0, x, y}) {
    const args = ['scroll', '--dy', String(dy), '--dx', String(dx)];
    if (x != null && y != null) args.push('--x', String(x), '--y', String(y));
    const r = await cu(args);
    return r.ok ? `scrolled ${dx},${dy}` : `scroll failed: ${r.error}`;
  },

  async cu_wait({ms = 600}) {
    await new Promise(res => setTimeout(res, Math.min(Math.max(ms, 0), 10_000)));
    return `waited ${ms}ms`;
  },

  async cu_screenshot() {
    const shot = await screenshot();
    if (!shot.ok) return `screenshot failed: ${shot.error}`;
    return `saved ${shot.file} (window region ${shot.region.w}x${shot.region.h} points at ${shot.region.x},${shot.region.y}). Read it with the Read tool if you need to look yourself.`;
  },

  async cu_ground({target}) {
    const g = await ground(target);
    if (!g.ok) return `could not find it: ${g.error}`;
    return `vision points at ${JSON.stringify(g.label)} → click (${g.point[0]}, ${g.point[1]})${g.ms ? ` (${g.ms}ms)` : ''}. Use cu_click with those x,y.`;
  },

  async cu_approve({id}) {
    const p = pending.get(String(id));
    if (!p) return `no pending action "${id}" (it may have expired)`;
    if (Date.now() - p.at > APPROVE_TTL) { pending.delete(String(id)); return `"${id}" expired; ask again` }
    pending.delete(String(id));
    if (p.tool === 'cu_click') {
      const [x, y] = p.args.point;
      const r = await cu(['click', '--x', String(x), '--y', String(y), '--button', p.args.button, '--count', String(p.args.count)]);
      return r.ok ? `approved and clicked ${p.detail} at ${x},${y}` : `approved, but the click failed: ${r.error}`;
    }
    if (p.tool === 'cu_type') {
      const t = await cu(['type', '--text', p.args.text]);
      if (!t.ok) return `approved, but typing failed: ${t.error}`;
      if (p.args.submit) { await cu(['key', '--combo', 'return']); return `approved: typed and submitted ${p.args.text.length} characters` }
      return `approved: typed ${p.args.text.length} characters`;
    }
    if (p.tool === 'cu_key') {
      const r = await cu(['key', '--combo', p.args.combo]);
      return r.ok ? `approved: pressed ${p.args.combo}` : `approved, but the key failed: ${r.error}`;
    }
    return `unknown pending action type ${p.tool}`;
  },

  async cu_state() {
    const t = await cu(['trust']);
    // Accessibility is per-binary, so a helper spawned by bisu does not inherit bisu's grant. The
    // AppleScript route (System Events, which is already allowed) is the fallback that needs no
    // extra permission — this probe says which one is actually usable here.
    const se = await new Promise(resolve => {
      execFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to tell (first application process whose frontmost is true) to return (name of it) & "/" & (count of entire contents of window 1)'],
        {timeout: 10_000, encoding: 'utf8'}, (e, out, err) => resolve(e ? {ok: false, error: String((err || e.message || '').trim()).slice(0, 160)} : {ok: true, out: (out || '').trim()}));
    });
    const bits = [
      `accessibility (helper): ${t.accessible ? 'granted' : 'MISSING'}`,
      `screen recording (helper): ${t.screenRecording ? 'granted' : 'MISSING'}`,
      `system events (AppleScript): ${se.ok ? `ok — ${se.out}` : `denied — ${se.error}`}`,
      `decision model: ${OAI_KEY ? DECISION_MODEL : 'unavailable (no OpenAI key)'}`,
      `vision fallback: ${OR_KEY ? VISION_MODEL : 'unavailable (no OpenRouter key)'}`,
    ];
    if (last) bits.push(`last snapshot: ${last.app}${last.window ? ` — "${last.window}"` : ''}, ${last.elements.length} elements, ${Math.round((Date.now() - last.at) / 1000)}s ago`);
    return bits.join('\n');
  },
};

// ---- past sessions (ui/sessions.mjs) ----
// The index is brought up to date in a child process before a search, so a conversation that ended
// a minute ago is already findable; a refresh that fails still leaves the old index searchable.

tools.session_search = async ({query, days, project, bot, limit} = {}) => {
  const r = await sessions.refresh();
  return sessions.searchText(query, {days: Number(days) || 0, project: project ? String(project) : '', bot: bot ? String(bot).slice(0, 40) : '', limit: Math.max(1, Math.min(20, Number(limit) || 8))}, r?.error ? `index refresh failed: ${r.error}` : '');
};
tools.session_show = async ({id, offset, limit} = {}) => {
  await sessions.refresh();
  return sessions.show(id, {offset: Number(offset) || 0, limit: Number(limit) || 40});
};

const sessionDefinitions = [
  {
    name: 'session_search',
    description: 'Full-text search over every past bisu conversation: every bot\'s chats, scheduled-job and goal runs, and what the workers bisu delegated to reported and did (what the person and bisu said; not raw tool output). Use it when they refer to earlier work — "지난번에", "저번 주에 했던", "전에 얘기한" — or ask what was done or decided, by bisu, another bot, a worker or a scheduled job. Korean works with any word of two or more characters. Returns the best-matching sessions with the matching lines and an id for session_show.',
    inputSchema: {type: 'object', properties: {
      query: {type: 'string', description: 'a few words that would appear in the conversation, e.g. "결제 테스트"'},
      days: {type: 'number', description: 'only sessions from the last N days'},
      project: {type: 'string', description: 'only sessions whose folder path contains this, e.g. "PawOV"'},
      bot: {type: 'string', description: 'only one bot\'s conversations, by its id (the default bot is "bisu"); leave out to search every bot'},
      limit: {type: 'number', description: 'how many sessions to return (default 8, max 20)'},
    }, required: ['query']},
  },
  {
    name: 'session_show',
    description: 'Read one past session in order (person and bisu, with times), 40 messages a page. The 8-character id prefix from session_search is enough. Read before summarising what happened; do not paste the transcript back, say what it amounts to.',
    inputSchema: {type: 'object', properties: {
      id: {type: 'string', description: 'session id or its prefix'},
      offset: {type: 'number', description: 'skip this many messages (for the next page)'},
      limit: {type: 'number', description: 'messages per page (default 40, max 200)'},
    }, required: ['id']},
  },
];

// BISU_CU=0 keeps the session tools and drops computer use (no Accessibility prompt on a machine
// where bisu is only ever a terminal sidekick).
const cuDefinitions = [
  {
    name: 'cu_look',
    description: 'Read the frontmost window through the Accessibility API: every control with its real label and frame. This is the starting point for any "use this app" request — it is exact and needs no screenshot.',
    inputSchema: {type: 'object', properties: {
      max: {type: 'number', description: 'how many elements to show (default 120)'},
      clickable_only: {type: 'boolean', description: 'only controls that can be pressed'},
      all: {type: 'boolean', description: 'walk the whole app instead of the front window'},
    }},
  },
  {
    name: 'cu_decide',
    description: 'Ask the decision model which single control on the current window advances the goal. Returns one element id with a confidence, or "wait"/"done". Use it instead of guessing which element to press.',
    inputSchema: {type: 'object', properties: {
      goal: {type: 'string', description: 'what the person wants, in their words'},
      vision: {type: 'boolean', description: 'also send a screenshot (default true)'},
    }, required: ['goal']},
  },
  {
    name: 'cu_click',
    description: 'Click an element from the last cu_look/cu_decide snapshot (preferred, exact), or a point. Re-reads the window afterwards and reports what is now focused. Destructive targets are held for approval instead of clicked.',
    inputSchema: {type: 'object', properties: {
      id: {type: 'number', description: 'element id from the current snapshot'},
      x: {type: 'number'}, y: {type: 'number'},
      button: {type: 'string', enum: ['left', 'right']},
      count: {type: 'number', description: '1 = single, 2 = double click'},
      verify: {type: 'boolean', description: 're-read the window afterwards (default true)'},
    }},
  },
  {
    name: 'cu_type',
    description: 'Type text into the focused field (any script, Korean included). Set submit to press return afterwards — that combination is held for approval because it sends.',
    inputSchema: {type: 'object', properties: {
      text: {type: 'string'},
      submit: {type: 'boolean'},
      target_id: {type: 'number', description: 'click this element first, e.g. a search field'},
    }, required: ['text']},
  },
  {
    name: 'cu_key',
    description: 'Press a key or shortcut, e.g. "cmd shift l", "return", "escape", "down". Shortcuts that quit, delete or erase are held for approval.',
    inputSchema: {type: 'object', properties: {combo: {type: 'string'}}, required: ['combo']},
  },
  {
    name: 'cu_scroll',
    description: 'Scroll the window under the pointer (or at x,y). Positive dy scrolls down.',
    inputSchema: {type: 'object', properties: {dy: {type: 'number'}, dx: {type: 'number'}, x: {type: 'number'}, y: {type: 'number'}}},
  },
  {
    name: 'cu_wait',
    description: 'Wait for an animation, a load or a menu to open.',
    inputSchema: {type: 'object', properties: {ms: {type: 'number'}}},
  },
  {
    name: 'cu_screenshot',
    description: 'Save a PNG of the front window and return its path. Only needed when the Accessibility tree is empty or the person asked for a picture.',
    inputSchema: {type: 'object', properties: {}},
  },
  {
    name: 'cu_ground',
    description: 'Vision fallback for windows that expose nothing (games, canvases, custom-drawn apps): looks at a screenshot and returns a click point for a described target.',
    inputSchema: {type: 'object', properties: {target: {type: 'string', description: 'what to point at, e.g. "the play button"'}}, required: ['target']},
  },
  {
    name: 'cu_approve',
    description: 'Run a destructive action that is waiting for the person\'s approval, by the id cu_click/cu_type/cu_key returned. Never call this without telling the person first.',
    inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']},
  },
  {
    name: 'cu_state',
    description: 'Permissions and which models are wired up for computer use.',
    inputSchema: {type: 'object', properties: {}},
  },
];
// ---- the assistant's own tools: calendar and reminders, web search, goals, the browser, the Claude app's sessions ----
// The same tools bisu's own engine has (engine/calendar.mjs, engine/bisu-tools.mjs, engine/browser.mjs), so a
// Claude Code chat can do what a native one does. Short ids (e1, r2, h1) live in this process, which lasts as long
// as the chat. calendar_delete and browser_approve are not pre-allowed by launch.zsh: they go through the approval card.
const ASSISTANT = {...CALENDAR_TOOLS, web_search: BISU_TOOLS.web_search, goal_add: BISU_TOOLS.goal_add, goal_list: BISU_TOOLS.goal_list, goal_update: BISU_TOOLS.goal_update, bot_create: BISU_TOOLS.bot_create, bot_update: BISU_TOOLS.bot_update, routine_save: BISU_TOOLS.routine_save, bot_handoff: BISU_TOOLS.bot_handoff, memory_compact: BISU_TOOLS.memory_compact, profile_set: BISU_TOOLS.profile_set, secret_list: BISU_TOOLS.secret_list, ...(isDefaultBot() ? {bot_memory: BISU_TOOLS.bot_memory} : {}), ...BROWSER_TOOLS, ...WATCH_TOOLS};
const failed = new WeakSet();
for (const [name, t] of Object.entries(ASSISTANT)) tools[name] = async args => {
  const r = await t.run({cwd: process.cwd()}, args);
  const out = new String(r?.text ?? '');
  if (r?.error) failed.add(out);
  return out;
};
const assistantDefinitions = Object.entries(ASSISTANT).map(([name, t]) => ({name, description: t.description, inputSchema: t.parameters}));
const definitions = [...sessionDefinitions, ...assistantDefinitions, ...(process.env.BISU_CU === '0' ? [] : cuDefinitions)];
const allowed = new Set(definitions.map(d => d.name));

// ---- MCP plumbing ----

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function callTool(name, args) {
  const fn = allowed.has(name) ? tools[name] : null;
  if (!fn) throw Object.assign(Error(`unknown tool ${name}`), {code: -32602});
  const text = await fn(args || {});
  return {content: [{type: 'text', text: String(text)}], isError: failed.has(text) || /^(click failed|typing failed|key failed|scroll failed|screenshot failed|could not|no decision|that element id|no element|\[.*\] has no clickable)/.test(String(text))};
}

async function handle(msg) {
  const {id, method, params} = msg;
  const reply = result => send({jsonrpc: '2.0', id, result});
  const fail = (code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
  if (msg.id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'bisu', version: '0.2.0'},
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({tools: definitions});
    if (method === 'tools/call') {
      const out = await callTool(params?.name, params?.arguments);
      return reply(out);
    }
    if (method === 'resources/list') return reply({resources: []});
    if (method === 'prompts/list') return reply({prompts: []});
    return fail(-32601, `unknown method ${method}`);
  } catch (e) {
    log('error', String(e?.stack || e));
    return fail(e?.code || -32603, String(e?.message || e));
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
log('server up', process.argv.slice(2).join(' ') || '(stdio)');
