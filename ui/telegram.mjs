// bisu on Telegram: the person's own bot, long-polled from this Mac.
//
// The token never lives here. bisu's shell finds the key saved in dec for https://api.telegram.org and
// starts the engine with it the use-only way (a one-time token and TELEGRAM_BOT_BASE_URL); dec's helper
// puts the real token where the address says DEC_KEY. Run from a terminal with a plain
// TELEGRAM_BOT_TOKEN it calls api.telegram.org directly.
//
// One Telegram chat is trusted: the one that sent the pairing code shown in Settings. Everything else is
// ignored. Its messages go to one bisu chat (a fresh one after /new or six quiet hours) and the last thing
// bisu says in a turn goes back; approvals, from any chat, come as buttons; and, if they want them,
// suggestions, scheduled jobs' answers, the morning briefing and meetings about to start are sent too.
// Long polling needs nothing reachable from outside, but it only works while this Mac is awake and bisu
// is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt, randomBytes } from 'node:crypto';
import * as proactive from './proactive.mjs';
import { holdsSchedule } from './lock.mjs';

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu');
const FILE = path.join(CONFIG_DIR, 'telegram.json');
const CODE_MS = 30 * 60e3;          // how long a pairing code works
const FRESH_MS = 6 * 3600e3;        // a quiet bisu chat older than this is not continued
const NOTIFY_MS = 20e3;
const MAX_TEXT = 3800;              // Telegram takes 4096; leave room

const DEFAULTS = { enabled: true, chatId: null, user: null, pairedAt: 0, code: null, codeAt: 0, offset: 0, goalMsgs: [],
  notify: { approvals: true, suggestions: true, jobs: true, events: true }, cwd: '', bisuChat: null, chats: [], sent: [], bot: null, lastError: null };
function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch {}
  return { ...DEFAULTS, ...s, notify: { ...DEFAULTS.notify, ...(s.notify || {}) }, chats: Array.isArray(s.chats) ? s.chats : [], sent: Array.isArray(s.sent) ? s.sent : [], goalMsgs: Array.isArray(s.goalMsgs) ? s.goalMsgs : [] };
}
function save(patch) {
  const s = { ...load(), ...patch };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('bisu telegram: cannot save:', e.message) }
  return s;
}

// ---- the Bot API ----
export const hasToken = () => !!process.env.TELEGRAM_BOT_TOKEN;
function endpoint(method) {
  const tok = process.env.TELEGRAM_BOT_TOKEN || '', base = process.env.TELEGRAM_BOT_BASE_URL, standIn = process.env.BISU_TELEGRAM_API;
  if (standIn) return { url: `${standIn.replace(/\/$/, '')}/bot${tok}/${method}`, headers: {} };
  if (base) return { url: `${base.replace(/\/$/, '')}/botDEC_KEY/${method}`, headers: { authorization: `Bearer ${tok}` } };
  return { url: `https://api.telegram.org/bot${tok}/${method}`, headers: {} };
}
async function api(method, params = {}, { timeoutMs = 20e3, signal } = {}) {
  const { url, headers } = endpoint(method);
  const r = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(params),
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
  const j = await r.json().catch(() => null);
  // Never the address in an error: without dec it holds the token.
  if (!j?.ok) throw Object.assign(new Error(j?.description || `Telegram answered ${r.status}`), { status: r.status });
  return j.result;
}
// Plain text, in pieces Telegram accepts; the buttons go on the last piece.
async function send(text, { buttons, chatId = load().chatId } = {}) {
  if (!chatId) return null;
  // Plain text, so Markdown's marks would show as they are: bold and headings lose them.
  const t = String(text || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '').trim() || '…';
  const parts = [];
  for (let i = 0; i < t.length; i += MAX_TEXT) parts.push(t.slice(i, i + MAX_TEXT));
  let last = null;
  for (const [k, part] of parts.entries()) {
    last = await api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true,
      ...(buttons && k === parts.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  }
  return last;
}

// ---- what the page and the server see ----
let hooks = null;
export function attach(h) { hooks = h }

export function snapshot() {
  let s = load();
  // A code to pair with, made when the page asks for one and none is still valid.
  if (!s.chatId && (!s.code || Date.now() - s.codeAt > CODE_MS)) s = save({ code: String(randomInt(100000, 1000000)), codeAt: Date.now() });
  return {
    token: hasToken(), viaDec: !!process.env.TELEGRAM_BOT_BASE_URL, enabled: s.enabled, bot: s.bot,
    paired: !!s.chatId, user: s.user, pairedAt: s.pairedAt || null,
    code: s.chatId ? null : s.code, link: !s.chatId && s.bot?.username ? `https://t.me/${s.bot.username}?start=${s.code}` : null,
    notify: s.notify, cwd: s.cwd, polling: !!polling, lastError: s.lastError,
    restartable: process.env.BISU_UI_PARENT === 'stdin',
  };
}
export function configure(patch = {}) {
  const s = load(), next = {};
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.notify && typeof patch.notify === 'object') next.notify = { ...s.notify, ...Object.fromEntries(Object.entries(patch.notify).filter(([k, v]) => k in DEFAULTS.notify && typeof v === 'boolean')) };
  if (typeof patch.cwd === 'string') next.cwd = patch.cwd.trim().slice(0, 500);
  save(next);
  if (next.enabled === false) abort?.abort();
  return snapshot();
}
export function newCode() { save({ code: String(randomInt(100000, 1000000)), codeAt: Date.now() }); return snapshot() }
export async function unpair() {
  const s = load();
  if (s.chatId) await send('bisu와 연결을 끊었어요. 다시 쓰려면 bisu 설정 → 텔레그램에서 연결해 주세요.').catch(() => {});
  save({ chatId: null, user: null, pairedAt: 0, bisuChat: null, chats: [], code: null });
  return snapshot();
}
export async function test() {
  if (!load().chatId) throw Object.assign(Error('아직 연결되지 않았어요'), { status: 400 });
  await send('bisu예요 ✦ 연결이 잘 되어 있어요.');
  return snapshot();
}

// ---- messages in ----
const approvals = new Map();   // short key → {chat, request_id, message_id}
const turns = new Map();       // bisu chat id → the last thing said this turn
const trusted = (s, chatId) => s.chatId && String(chatId) === String(s.chatId);
const isOurs = id => { const s = load(); return s.bisuChat === id || s.chats.includes(id) };
export const owns = isOurs;
function remember(chatId) { const s = load(); save({ bisuChat: chatId, chats: [chatId, ...s.chats.filter(x => x !== chatId)].slice(0, 20) }) }

async function ensureChat() {
  const s = load();
  let c = s.bisuChat && hooks.getChat(s.bisuChat);
  if (!c || Date.now() - (c.lastAt || 0) > FRESH_MS) { c = await hooks.newChat({ cwd: s.cwd || undefined }); remember(c.id) }
  return c;
}

async function onMessage(m) {
  const s = load(), text = String(m.text || '').trim();
  if (!s.chatId) {
    const code = /^(?:\/start\s+)?(\d{6})$/.exec(text)?.[1];
    if (code && s.code === code && Date.now() - s.codeAt < CODE_MS) {
      const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || '';
      save({ chatId: m.chat.id, user: { name, username: m.from?.username || null }, pairedAt: Date.now(), code: null });
      await send('bisu와 연결됐어요 ✦\n이제 여기서 말 걸면 돼요. 승인이 필요하면 버튼으로 물어볼게요.\n\n/new 새 대화로  ·  /stop 하던 일 멈추기', { chatId: m.chat.id });
    } else if (/^\/start\b/.test(text) || code) {
      await send('연결 코드가 맞지 않아요. 맥의 bisu → 설정 → 텔레그램에서 「텔레그램에서 연결하기」를 눌러 주세요.', { chatId: m.chat.id });
    }
    return;
  }
  if (!trusted(s, m.chat?.id)) return;
  if (text === '/new') { save({ bisuChat: null }); return void await send('새 대화로 시작할게요. 하고 싶은 말을 보내 주세요.') }
  if (text === '/stop') { const c = s.bisuChat && hooks.getChat(s.bisuChat); if (c) hooks.stop(c); return void await send(c ? '멈췄어요.' : '하고 있는 일이 없어요.') }
  if (/^\/start\b/.test(text)) return void await send('이미 연결되어 있어요. 그냥 말 걸면 돼요.');
  if (!text) return void await send('아직 글자만 받을 수 있어요.');
  const goal = m.reply_to_message && s.goalMsgs.find(x => x.message === m.reply_to_message.message_id);
  if (goal && hooks.answerGoal) {
    try { const g = hooks.answerGoal(goal.goal, text); return void await send(`「${g.title}」에 전했어요. 곧 이어서 할게요.`) }
    catch (e) { return void await send(`전하지 못했어요: ${e.message}`) }
  }
  const c = await ensureChat();
  hooks.say(c, text);
  api('sendChatAction', { chat_id: s.chatId, action: 'typing' }).catch(() => {});
}

async function onCallback(q) {
  const s = load();
  const done = note => api('answerCallbackQuery', { callback_query_id: q.id, ...(note ? { text: note } : {}) }).catch(() => {});
  if (!trusted(s, q.message?.chat?.id)) return done();
  const [kind, key, choice] = String(q.data || '').split(':');
  if (kind === 'a') {
    const a = approvals.get(key), c = a && hooks.getChat(a.chat);
    if (!a || !c) return done('이미 끝났거나 bisu가 다시 시작돼서 답할 수 없어요');
    try { hooks.decide(c, { request_id: a.request_id, allow: choice !== 'n', always: choice === 'a', message: 'The person declined this on Telegram.' }) }
    catch { return done('이미 답한 요청이에요') }
    return done(choice === 'n' ? '거부했어요' : '허용했어요');
  }
  if (kind === 's') {
    const item = proactive.get(key);
    if (!item || item.status !== 'new') return done('이미 정리된 제안이에요');
    if (choice === 'later') { proactive.resolve(item.id, 'dismissed'); await editButtons(q.message, '→ 나중에'); return done() }
    const c = await hooks.accept(item);
    if (c) { remember(c.id); await editButtons(q.message, '→ 시작했어요. 답은 여기로 올게요') }
    return done();
  }
  return done();
}
async function editButtons(message, note) {
  if (!message) return;
  await api('editMessageText', { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text || ''}\n\n${note}`, disable_web_page_preview: true }).catch(() => {});
}

// ---- what happens in bisu, out ----
const summarize = (tool, input = {}) => /browser_approve$/.test(tool) && input.step ? `웹에서 누르기: 「${String(input.step).slice(0, 120)}」`
  : input.command ? `$ ${String(input.command).slice(0, 300)}`
  : input.file_path || input.path ? `${tool} · ${input.file_path || input.path}` : tool;
// Called by the server for every event of every chat.
export function onEvent(c, ev) {
  const s = load();
  if (!s.chatId || !s.enabled || ev.past) return;
  if (ev.kind === 'approval' && s.notify.approvals) {
    const key = randomBytes(4).toString('hex');
    approvals.set(key, { chat: c.id, request_id: ev.request_id });
    const where = isOurs(c.id) ? '' : `\n(${c.title || '대화'} · 맥에서 하던 대화)`;
    send(`허락이 필요해요\n${ev.description || summarize(ev.tool, ev.input)}${where}`,
      { buttons: [[{ text: '허용', callback_data: `a:${key}:y` }, { text: '이 대화 동안 허용', callback_data: `a:${key}:a` }], [{ text: '거부', callback_data: `a:${key}:n` }]] })
      .then(m => { const a = approvals.get(key); if (a && m) a.message = m }).catch(e => noteError(e));
    return;
  }
  if (ev.kind === 'approval_done') {
    for (const [key, a] of approvals) if (a.request_id === ev.request_id) {
      approvals.delete(key);
      if (a.message) editButtons(a.message, ev.allow ? (ev.always ? '→ 이 대화 동안 허용했어요' : '→ 허용했어요') : '→ 거부했어요');
    }
    return;
  }
  if (!isOurs(c.id)) return;
  if (ev.kind === 'user') turns.set(c.id, null);
  else if (ev.kind === 'text' && !ev.parent) turns.set(c.id, ev.text);
  else if (ev.kind === 'error') send(`문제가 생겼어요: ${String(ev.message || '').slice(0, 300)}`).catch(e => noteError(e));
  else if (ev.kind === 'result') {
    const said = turns.get(c.id); turns.delete(c.id);
    if (said) send(said).catch(e => noteError(e));
    else if (ev.error) send('끝까지 하지 못했어요. 맥의 bisu에서 자세히 볼 수 있어요.').catch(e => noteError(e));
  }
}

// Suggestions, job answers and the briefing: each card once, from the moment they paired.
async function notify() {
  const s = load();
  if (!s.chatId || !s.enabled || !hasToken() || !holdsSchedule()) return;
  const sent = new Set(s.sent);
  for (const it of [...proactive.snapshot().items].reverse()) {
    if (it.status !== 'new' || sent.has(it.id) || (it.at || 0) < s.pairedAt) continue;
    const job = it.kind === 'job';
    if (job ? !s.notify.jobs : !s.notify.suggestions) continue;
    sent.add(it.id);
    save({ sent: [...sent].slice(-200) });
    const head = job ? (it.job === 'briefing' ? '☀️ 아침 브리핑' : it.job === 'goal' ? (it.ask ? '🎯 목표 · 물어볼 게 있어요' : '🎯 목표') : '⏰ 예약 작업') : '✦ bisu가 하나 찾았어요';
    const text = `${head} · ${it.title}\n\n${it.body || ''}${!job && it.action ? `\n\n「해볼게」를 누르면 이렇게 부탁해요: ${it.action}` : ''}${it.goal && it.ask ? '\n\n이 메시지에 답장하면 bisu가 이어서 해요.' : ''}`;
    const buttons = job ? (it.sessionId ? [[{ text: '이어서 대화', callback_data: `s:${it.id}:do` }]] : null)
      : [[{ text: '해볼게', callback_data: `s:${it.id}:do` }, { text: '나중에', callback_data: `s:${it.id}:later` }]];
    const m = await send(text, { buttons }).catch(e => noteError(e));
    // A reply to a goal's question is its answer.
    if (m && it.goal && it.ask) save({ goalMsgs: [{ message: m.message_id, goal: it.goal }, ...load().goalMsgs].slice(0, 20) });
  }
}

// A meeting about to start (ui/alerts.mjs), if they want those here too.
export function onNotice(n) {
  const s = load();
  if (n.kind !== 'event' || !s.chatId || !s.enabled || !s.notify.events || !hasToken()) return;
  send(`📅 ${n.title}${n.body ? `\n${n.body}` : ''}`).catch(e => noteError(e));
}

// ---- the loop ----
let polling = null, abort = null, timer = null, notifyTimer = null, retryAt = 0;
function noteError(e) { save({ lastError: String(e?.message || e).slice(0, 200) }) }
async function poll() {
  if (polling || Date.now() < retryAt || !hasToken() || !holdsSchedule()) return;
  const s0 = load();
  if (!s0.enabled) return;
  polling = (async () => {
    abort = new AbortController();
    try {
      if (!s0.bot) {
        const me = await api('getMe');
        save({ bot: { username: me.username, name: me.first_name }, lastError: null });
        api('setMyCommands', { commands: [{ command: 'new', description: '새 대화로 시작' }, { command: 'stop', description: '하던 일 멈추기' }] }).catch(() => {});
      }
      for (;;) {
        const s = load();
        if (!s.enabled || !hasToken() || abort.signal.aborted) break;
        const updates = await api('getUpdates', { offset: s.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 40e3, signal: abort.signal });
        if (s.lastError) save({ lastError: null });
        for (const u of updates) {
          save({ offset: u.update_id + 1 });
          try { if (u.message) await onMessage(u.message); else if (u.callback_query) await onCallback(u.callback_query) } catch (e) { noteError(e) }
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) { noteError(e); retryAt = Date.now() + (e.status === 401 || e.status === 404 ? 5 * 60e3 : 15e3) }
    } finally { polling = null }
  })();
}
export function start() {
  if (timer || process.env.BISU_TELEGRAM === '0') return;
  timer = setInterval(poll, 3e3); timer.unref?.();
  notifyTimer = setInterval(() => notify().catch(() => {}), NOTIFY_MS); notifyTimer.unref?.();
  setTimeout(poll, 1500).unref?.();
}
export function shutdown() { clearInterval(timer); clearInterval(notifyTimer); timer = notifyTimer = null; abort?.abort() }
