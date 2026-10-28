// ego lite, driven by bisu itself: what bisu uses for the web when dec's fast mode is not there, and strong enough
// to need no dec at all. It follows the ego-browser skill: one task space per conversation, resumed by id on every
// call (each call is a new process); the action and the next look happen in the same script, the snapshot printed
// last, so a step is one ego call and one model call.
//
// Who picks the next step (BISU_WEB_PICKER, default rescue; engine/eval/web-bench.mjs compares them on the same
// pretend sites):
//   decisions — OpenAI Decisions picks one of the numbered actions read off the snapshot, like dec's fast mode.
//   glm       — GLM reads the snapshot the way the skill shows an agent and answers with a few actions at once.
//   pair      — Decisions picks; GLM looks again only where a wrong pick costs something: a risky step, a
//               low-confidence pick, a select-all, and "done" (dec's own combination, app/chromium/pair-decider.cjs).
//   rescue    — Decisions alone until one of three things: it slows down (back on a page it already left twice,
//               the same control again, a long run), it fails (no pick, a timeout, a step that errored), or its
//               answer looks wrong (done with no answer to a question, an unsure or page-dump answer). Then GLM
//               takes that one step.
// Clicks that pay, send, delete, book or submit are never made here: the run stops on them and says which one, and
// bisu asks the person first (browser_approve). Passwords and card numbers are never typed.
import {execFile} from 'node:child_process';
import * as judge from './judge.mjs';
import {complete} from './glm.mjs';

const EGO = process.env.BISU_EGO_BIN || 'ego-browser';
const GLM_MODEL = () => process.env.BISU_WEB_GLM || 'glm-5.3';
export const picker = () => ['decisions', 'glm', 'pair', 'rescue'].includes(process.env.BISU_WEB_PICKER) ? process.env.BISU_WEB_PICKER : 'rescue';

// The site a page belongs to (news.daum.net and m.daum.net are one site; so are a.co.kr and b.co.kr's parents).
export function siteOf(u) {
  try {
    const h = new URL(u).hostname, parts = h.split('.');
    if (/^[\d.]+$/.test(h) || parts.length <= 2) return h;
    return parts.slice(/^[a-z]{2}$/.test(parts.at(-1)) && /^(co|or|go|ac|ne|re|pe|com|net|org)$/.test(parts.at(-2)) ? -3 : -2).join('.');
  } catch { return '' }
}

// Words on a control that commit something the person cannot take back.
export const RISKY = /결제|구매|주문|구독|송금|이체|보내기|전송|제출|발행|게시하기|올리기|삭제|탈퇴|해지|예약\s*(확정|완료|하기)|확정|신청하기|가입하기|checkout|\bpay\b|purchase|\bbuy\b|place order|subscribe|\bsend\b|submit|publish|\bpost\b|delete|remove|unsubscribe|book now|confirm|transfer/i;
const SECRET_FIELD = /비밀\s*번호|암호|password|passcode|\bpin\b|카드\s*번호|card number|cvc|cvv|보안\s*코드|security code|주민\s*등록/i;
// A select-all puts every row under the next toolbar action: only a goal about the whole list may use one.
const BULK = /전체\s*(메일|선택)|모두\s*선택|select\s*all/i;
const WANTS_ALL = goal => /전체\s*(메일|선택)|모든\s*메일|메일함\s*(전체|비우)|select\s*all|everything/i.test(goal) && !/보낸\s*사람|발신|에게서|에서\s*온|관련|from\b|['"‘’“”「」]/i.test(goal);
// A goal that picks one item out of a list by comparing ("가장 비싼", "cheapest", "최신"): Decisions picks one option
// at a time and does not compare twenty prices; GLM, given the whole page, does.
const COMPARE = goal => /가장|제일|최저|최고|최신|최소|최대|비싼|저렴|cheapest|most|least|highest|lowest|best|latest|newest|oldest/i.test(goal);
// A page listing things to compare: five or more lines with a price, a count or a score on them.
const NUMBERED = /[£$€₩¥]\s?\d|\d[\d,.]*\s*(원|달러|개|명|점|%|권|건|회)/;
const listy = view => String(view.body || parse(view.snap).rows.join('\n')).split('\n').filter(l => NUMBERED.test(l)).length >= 5;
const WANTS_ANSWER = goal => /알려|보고|찾아|얼마|언제|몇|무엇|뭐|어디|확인해|report|tell|what|which|how many|price|title|list/i.test(goal);

// ---- talking to ego ----

function ego(script, timeoutMs = 90_000) {
  // The script goes in on stdin: when stdin is not a terminal, ego-browser reads its script from there even with
  // -e, so an -e script either waits forever on an open pipe or is replaced by an empty one.
  return new Promise(resolve => {
    const child = execFile(EGO, ['nodejs'], {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 << 20}, (e, out, err) => {
      if (process.env.BISU_EGO_DEBUG) process.stderr.write(`[ego] ${String(err || e?.message || '').slice(0, 2000)}\n${String(out).slice(0, 300)}\n`);
      // A script's console output arrives on stderr when ego-browser's stdout is not a terminal: read both.
      const line = (String(out) + '\n' + String(err)).split('\n').reverse().find(l => l.startsWith('@@BISU '));
      let data = null;
      try { data = line ? JSON.parse(line.slice(7)) : null } catch {}
      resolve({data, out: String(out), err: String(err || ''), code: e?.code ?? 0, notice: /\[ego-browser:notice\]/.test(out + err)});
    });
    child.stdin.end(script);
  });
}

// The look that ends every script: the snapshot, plus what a snapshot leaves out (a closed select's options).
const LOOK = `
const look = async () => {
  const info = await p.info().catch(() => ({}));
  if (info.dialog) return {snap: '', url: info.url, title: info.title, dialog: {type: info.dialog.type, message: String(info.dialog.message || '').slice(0, 300)}};
  // The whole page, off screen included (as Aside's snapshot is): the item a goal picks may be the eighth of twelve,
  // and a next link sits at the bottom. No scrolling to find things, and every item is a choice.
  const snap = await p.snapshot({scope: "full_page"});
  const extra = await p.evaluate(() => ({url: location.href, title: document.title, y: Math.round(scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    body: (document.body?.innerText || '').slice(0, 30000),
    selects: [...document.querySelectorAll('select')].map(s => ({name: s.name, label: s.getAttribute('aria-label') || s.labels?.[0]?.innerText?.trim() || s.name, options: [...s.options].map(o => o.text.trim()).slice(0, 30), value: s.selectedOptions[0]?.text?.trim() || ''})),
    // In document order, the ones shown: the same ones, in the same order, as the checkboxes in the (whole-page) snapshot.
    boxes: [...document.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(x => x.getBoundingClientRect().width > 0).map(x => x.checked)})).catch(() => ({}));
  return {snap, ...extra};
};`;
const quote = v => JSON.stringify(String(v));

// A page asking for the microphone, camera, location or notifications puts up a browser prompt that stops ego and
// hands the space to the person. bisu never needs any of them: pages in its space get a refusal instead of a prompt.
// Raw CDP retires the snapshot's refs, so after it the first action finds its element again (find(), below).
const GUARD = `(() => { const no = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  try { if (navigator.mediaDevices) { navigator.mediaDevices.getUserMedia = no; navigator.mediaDevices.getDisplayMedia = no } } catch {}
  try { if (window.Notification) Notification.requestPermission = () => Promise.resolve('denied') } catch {}
  try { if (navigator.geolocation) { const fail = (ok, err) => err && err({code: 1, message: 'denied'}); navigator.geolocation.getCurrentPosition = fail; navigator.geolocation.watchPosition = (ok, err) => (fail(ok, err), 0) } } catch {}
})()`;

// One ego script: open or resume the space, run the steps, look, print. `space` is a name the first time (it
// creates or resumes bisu's own space of that name) and the numeric id after.
async function step(space, body, {timeoutMs} = {}) {
  const r = await ego(`const t = await taskSpace(${typeof space === 'number' ? space : quote(space)});
const p = t.page("p1");${LOOK}${FIND}
const did = [];
try {
if (await p.cdp("Page.addScriptToEvaluateOnNewDocument", {source: ${quote(GUARD)}}).then(() => true, () => false)) acted = true;
${body}
} catch (e) { did.push('error: ' + String(e?.message || e).split('\\n')[0].slice(0, 200)) }
if (!(await p.info().catch(() => ({}))).dialog) await p.waitForLoadState("load", {timeout: 8000}).catch(() => {});
console.log('@@BISU ' + JSON.stringify({space: t.spaceId, did, ...(await look())}));`, timeoutMs);
  // A browser prompt got through anyway (a device chooser, a permission the guard does not cover): ego has handed the
  // space to the person, and only they can answer it.
  if (!r.data && /browser permission prompt|user now controls this task space/i.test(r.err + r.out)) {
    throw Object.assign(Error((r.err + r.out).split('\n').find(l => /prompt/i.test(l))?.trim() || 'a browser prompt'), {code: 'BROWSER_PROMPT', space});
  }
  if (!r.data) throw Error(r.err.split('\n').find(l => /Error\b/.test(l))?.trim() || `ego did not answer (exit ${r.code})`);
  return {...r.data, notice: r.notice};
}

// ---- reading a snapshot ----

const CLICKABLE = new Set(['anchor', 'link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'summary', 'switch']);
const CHECKABLE = new Set(['checkbox', 'radio']);
// Text fields, and the wrappers some sites put around one (Wikipedia's search is a "comboboxgrouping"): ego's fill()
// goes on to the one field inside.
const TYPABLE = {has: role => /^(textbox|searchbox|textarea|comboboxgrouping|textfield|search_?box|text_?field)$/i.test(role)};

export function parse(snap) {
  const lines = String(snap || '').split('\n');
  const els = [], texts = [], rowOf = new Map();
  const rows = lines.map(l => {
    const m = /^(\s*)(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[(.*)\])?\s*$/.exec(l);
    // Names keep the page's own line breaks as \n: read them as spaces, so "£52.29\n    \n  In stock" is one line;
    // zero-width characters and icon-font glyphs (private use area: a check mark that reads as a blank) are dropped.
    return m ? {depth: m[1].length, role: m[2], name: m[3] ? m[3].replace(/\\"/g, '"').replace(/\\[nt]/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff\ue000-\uf8ff]/g, '').replace(/\s+/g, ' ').trim() : '', attrs: m[4] || ''} : null;
  });
  rows.forEach((r, i) => {
    if (!r) return;
    if (r.role === 'text' && r.name.trim()) {
      texts.push(r.name);
      // The row a text belongs to: its nearest ancestor that is not a mere wrapper of this one text (a link's label
      // and the price next to it are one row: "UGREEN USB-C 허브 5포트 · 24,500원").
      let a = i - 1;
      while (a >= 0 && !(rows[a] && rows[a].depth < r.depth)) a--;
      while (a >= 0 && rows[a] && /^(anchor|link|button|text|paragraph|heading|cell|columnheader|rowheader|listitem|strong|emphasis)$/.test(rows[a].role) && rows[a].role !== 'text') {
        let b = a - 1; while (b >= 0 && !(rows[b] && rows[b].depth < rows[a].depth)) b--; if (b < 0) break; a = b;
      }
      if (!rowOf.has(a)) rowOf.set(a, []);
      rowOf.get(a).push(r.name);
    }
    const ref = /(?:^|,\s*)ref=([\w-]+)/.exec(r.attrs)?.[1];
    if (!ref) return;
    let name = r.name;
    // A control without a name of its own: the text inside it, else the text right after it (a radio's label).
    if (!name) {
      const kids = [];
      for (let j = i + 1; j < rows.length && rows[j] && rows[j].depth > r.depth; j++) if (rows[j].role === 'text') kids.push(rows[j].name);
      name = kids.join(' ');
      if (!name) for (let j = i + 1; j < rows.length && rows[j] && rows[j].depth === r.depth && j < i + 3; j++) if (rows[j].role === 'text') { name = rows[j].name; break }
      // An icon (a magnifier, a menu): what it links to, and the area it sits in.
      if (!name) {
        const href = /(?:url=|loc=href:)([^,\]\s]+)/.exec(r.attrs)?.[1];
        let where = '';
        for (let a = i - 1, d = r.depth; a >= 0; a--) if (rows[a] && rows[a].depth < d) { d = rows[a].depth; if (rows[a].name || /^(search|navigation|form|dialog|banner)$/.test(rows[a].role)) { where = rows[a].name || rows[a].role; break } }
        let path = '';
        if (href) try { path = decodeURIComponent(new URL(href, 'http://x').pathname.split('/').filter(Boolean).pop() || '') } catch {}
        name = [path ? `(icon) ${path}` : '(no label)', where && `in ${where}`].filter(Boolean).join(' — ');
      }
    }
    const own = r.name, nth = els.filter(e => e.role === r.role && e.own === own).length;
    els.push({ref: '@' + ref, role: r.role, own, nth, name: name.slice(0, 100), css: /loc=css:([^,\]]+(?:\][^,\]]*)?)/.exec(r.attrs)?.[1] || ''});
  });
  // One line per row, in page order; a row too long to be one fact stays as its separate texts.
  const rowsOut = [];
  for (const [, t] of [...rowOf].sort((x, y) => x[0] - y[0])) { const j = t.map(x => x.trim()).join(' · '); if (j.length <= 240) rowsOut.push(j); else rowsOut.push(...t) }
  return {els, texts, rows: rowsOut};
}

// ---- the numbered actions a picker chooses from ----

// Moving through a list: a page number, next, 다음, ›.
const PAGING = /^(next|다음|다음\s*(페이지|쪽)|›|»|>|\d{1,3}|page\s*\d+|\d+\s*(쪽|페이지))$/i;
function candidates(view, inputs, last, canBack = true, goal = '') {
  const {els} = parse(view.snap);
  let out = [];
  const add = (c, always) => out.push({...c, always});
  const boxes = els.filter(e => CHECKABLE.has(e.role));
  const checked = view.boxes?.length === boxes.length ? new Map(boxes.map((e, i) => [e.ref, view.boxes[i]])) : null;
  for (const e of els) {
    const at = {ref: e.ref, role: e.role, own: e.own, nth: e.nth, label: e.name};
    // A page's own "back" control is the browser's back: not from the page the run started on.
    if (!canBack && /^(뒤로\s*가기|이전\s*(페이지|화면)?|back|go back)$/i.test(e.name)) continue;
    if (CLICKABLE.has(e.role) && e.name) add({kind: 'click', ...at, name: `${e.role === 'anchor' ? 'link' : e.role}: ${e.name}`});
    else if (CHECKABLE.has(e.role)) add({kind: 'click', ...at, name: `${e.role}: ${e.name || '(no label)'}${checked ? (checked.get(e.ref) ? ' (checked now)' : ' (not checked)') : ''}`});
    else if (TYPABLE.has(e.role) && !SECRET_FIELD.test(e.name)) for (const [k, v] of inputs) add({kind: 'type', ...at, value: v, name: `type @${k} ("${v.slice(0, 40)}") into ${e.role} "${e.name}"`});
    else if (e.role === 'combobox') {
      const s = view.selects?.find(x => (e.css && e.css.includes(`name="${x.name}"`)) || x.label === e.name);
      if (s) for (const o of s.options.slice(0, 12)) add({kind: 'select', ...at, value: o, name: `select "${o}" in "${e.name}"${o === s.value ? ' (selected now)' : ''}`});
      else for (const [k, v] of inputs) add({kind: 'type', ...at, value: v, name: `type @${k} ("${v.slice(0, 40)}") into combobox "${e.name}"`});
    }
  }
  if (last?.kind === 'type') add({kind: 'key', ref: last.ref, role: last.role, own: last.own, nth: last.nth, key: 'Enter', name: 'press Enter (submit what was just typed)', label: 'Enter'}, true);
  if (view.y < view.maxY - 20) add({kind: 'scroll', dir: 'down', name: 'scroll down to see more of the page'}, true);
  if (view.y > 20) add({kind: 'scroll', dir: 'up', name: 'scroll up'}, true);
  // Back only to a page this run came from: from the first page it would leave the site.
  if (canBack) add({kind: 'back', name: 'go back to the previous page'}, true);
  add({kind: 'done', name: 'done: the goal is achieved on this page (or its answer is visible)'}, true);
  // Seventy controls at most. A page with more (a whole catalogue in one snapshot) keeps those the goal names, the
  // ones that move through the list, and what the task may type into, then the rest in page order; the moves that
  // are always there (Enter, scroll, back, done) always stay.
  const fixed = out.filter(c => c.always);
  // The same link twice (a book's cover and its title) is one choice.
  const seenLabel = new Set();
  const rest = out.filter(c => !c.always && !(c.kind === 'click' && c.label && (seenLabel.has(c.label) || !seenLabel.add(c.label))));
  if (rest.length > 70) {
    const words = goalWords(goal).map(w => w.toLowerCase());
    // Items of a list carry a number on the lines right after them (a price, a count): the things a goal picks among.
    const lines = String(view.body || '').split('\n').map(l => l.trim()).filter(Boolean);
    const items = lines.filter((l, i) => !NUMBERED.test(l) && lines.slice(i + 1, i + 4).some(x => NUMBERED.test(x))).map(l => l.slice(0, 24).toLowerCase());
    const isItem = c => items.some(t => String(c.label || '').toLowerCase().startsWith(t.slice(0, Math.min(24, String(c.label || '').length))) && String(c.label || '').length >= 4);
    const score = c => (PAGING.test(String(c.label || '').trim()) ? 3 : 0) + (c.kind !== 'click' ? 2 : 0) + (words.some(w => String(c.label || '').toLowerCase().includes(w)) ? 2 : 0) + (isItem(c) ? 2 : 0);
    const keep = new Set([...rest].sort((a, b) => score(b) - score(a)).slice(0, 70));
    out = [...rest.filter(c => keep.has(c)), ...fixed];
  }
  return out.map(({always, ...c}, index) => ({...c, index}));
}

// After an action changes the page, ego retires the snapshot's refs ("Stale ref"): the second and later actions of
// a batch find their element again in a fresh snapshot, by role, own name and position among its namesakes.
const FIND = `
const find = async (ref, role, own, nth) => {
  if (!acted) return ref;
  let k = 0;
  for (const l of (await p.snapshot({scope: "full_page"})).split('\\n')) {
    const m = /^\\s*(\\S+)(?:\\s+"((?:[^"\\\\]|\\\\.)*)")?\\s+\\[(?:.*,\\s*)?ref=(\\d+)/.exec(l);
    if (m && m[1] === role && (m[2] || '').replace(/\\\\"/g, '"') === own && k++ === nth) return '@' + m[3];
  }
  return ref;
};
let acted = false;`;

function code(c, approved = false) {
  const r = c.role ? `await find(${quote(c.ref || '')}, ${quote(c.role)}, ${quote(c.own ?? '')}, ${Number(c.nth) || 0})` : quote(c.ref || '');
  return code0(c, r, approved) + '\nacted = true;';
}
// A click or key that opens a confirm dialog: part of the step when the person approved that step, otherwise left
// open for the run to stop on (a dialog nobody approved is never accepted).
const settle = approved => `if (rc?.dialog) { ${approved ? `await p.acceptDialog(); did.push('confirmed: ' + rc.dialog.message);` : `did.push('dialog: ' + rc.dialog.message);`} }
if (!(await p.info().catch(() => ({}))).dialog) { await p.waitForTimeout(400); await p.waitForLoadState("load", {timeout: 8000}).catch(() => {}) }`;
function code0(c, r, approved) {
  if (c.kind === 'dialog') return `if (!(await p.info()).dialog) throw new Error('the dialog is gone'); await p.acceptDialog(); did.push(${quote('confirmed: ' + c.label)});
await p.waitForTimeout(400); await p.waitForLoadState("load", {timeout: 8000}).catch(() => {});`;
  if (c.kind === 'click') return `{ const rc = await p.click(${r}, {label: ${quote(String(c.label || '').slice(0, 40))}}); did.push(${quote('clicked ' + c.label)});
${settle(approved)} }`;
  if (c.kind === 'type') return `await p.fill(${r}, ${quote(c.value)}); did.push(${quote('typed into ' + c.label)});`;
  if (c.kind === 'select') return `await p.selectOption(${r}, {label: ${quote(c.value)}}); did.push(${quote(`chose ${c.value} in ${c.label}`)});`;
  if (c.kind === 'key') return `{ const rc = await p.press(${r}, ${quote(c.key || 'Enter')}); did.push('pressed ' + ${quote(c.key || 'Enter')});
${settle(approved)} }`;
  if (c.kind === 'scroll') return `await p.mouse.move(400, 300); await p.mouse.wheel(0, ${c.dir === 'up' ? -700 : 700}); did.push('scrolled ${c.dir}');`;
  if (c.kind === 'back') return `await p.evaluate(() => history.back()); await p.waitForTimeout(400); await p.waitForLoadState("load", {timeout: 8000}).catch(() => {}); did.push('went back');`;
  if (c.kind === 'goto') return `await p.goto(${quote(c.url)}); did.push(${quote('opened ' + c.url)});`;
  return '';
}

// What stops before it happens: a risky click, and a select-all the goal did not ask for.
function blocked(c, goal) {
  // dec says which of its actions are risky (anything not "safe"): that is the rule there.
  if (c.risk) return c.risk !== 'safe' && c.kind !== 'done' ? 'risky' : c.kind === 'check' && BULK.test(c.label || '') && !WANTS_ALL(goal) ? 'bulk' : null;
  // A link only goes to another page; what commits is a button (or Enter in a form).
  if (c.kind === 'click' && !['anchor', 'link', 'checkbox', 'radio'].includes(c.role) && RISKY.test(c.label || '')) return 'risky';
  if (c.kind === 'key' && RISKY.test(c.label || '')) return 'risky';
  if (c.kind === 'click' && BULK.test(c.label || '') && !WANTS_ALL(goal)) return 'bulk';
  return null;
}

// ---- pickers ----

// What earlier pages showed, so a goal that compares (the cheapest of three) does not reopen each page to remember it.
// A code copied from the page (a UPC, an order or tracking number) must be the page's own: a model retyping one can
// drop characters ("b0913e67d38d5ed5" came back as "b0913e67d5ed5"). A code the pages seen do not have is replaced by
// the one code there that starts and ends like it; with none or several, it stays as written.
const CODE = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{8,}\b/g;
export function verbatim(answer, text) {
  if (!answer || !text) return answer;
  const page = new Set(String(text).match(CODE) || []);
  return String(answer).replace(CODE, t => {
    if (page.has(t)) return t;
    const like = [...page].filter(p => p.slice(0, 4) === t.slice(0, 4) && p.slice(-3) === t.slice(-3));
    return like.length === 1 ? like[0] : t;
  });
}

const seenText = (seen, url) => [...seen].filter(([u]) => u !== url).slice(-5).map(([u, t]) => `- ${t}`).join('\n');
function pagePrompt(goal, view, hist, inputs, seen = new Map()) {
  const {rows} = parse(view.snap);
  const before = seenText(seen, view.url), more = related(view, goal, new Set(rows));
  return `You are choosing the next action for a browser agent.
Goal: ${goal}
${inputs.length ? `Texts the agent may type: ${inputs.map(([k, v]) => `@${k} = "${v}"`).join(', ')}\n` : ''}${hist.length ? `Actions already taken (most recent last):\n${hist.slice(-8).join('\n')}\n` : 'No actions taken yet.\n'}${before ? `Seen on pages visited before (do not reopen them to check again):\n${before}\n` : ''}Current page: ${view.title} (${view.url})
Visible page text:
${rows.slice(0, 90).map(t => t.slice(0, 240)).join('\n')}
${more.length ? `Elsewhere on this page (off screen), lines about the goal:\n${more.join('\n')}\n` : ''}Notes: to reach page N of a list ("2쪽", "page 2"), click its page number or next / 다음 — it is among the actions even when it sits at the bottom of the page, no scrolling needed;
a text the goal names with @ has to be typed into the box before a search button does anything; a search box may first need its magnifier icon or "검색" control to open. After typing, pressing Enter or the search button runs it.`.slice(0, 14000);
}
const noteOf = view => `${view.title}: ${parse(view.snap).rows.slice(0, 14).join(' / ')}`.slice(0, 500);

// A snapshot is what is on screen; the answer is often further down ("많이 본 뉴스" under the fold). Lines of the whole
// page that share a word with the goal come along, each with the few lines under it (a heading and its list).
const STOP = new Set(['알려줘', '알려', '주세요', '해줘', '찾아줘', '보여줘', '에서', '으로', '그리고', '무엇', '뭐야', '어떤', 'the', 'and', 'what', 'tell', 'report']);
const goalWords = goal => String(goal).replace(/@\w+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOP.has(w.toLowerCase())).map(w => w.replace(/(을|를|이|가|은|는|의|에|도|로|과|와)$/, '')).filter(w => w.length >= 2);
function related(view, goal, skip = new Set()) {
  const words = goalWords(goal);
  if (!words.length || !view.body) return [];
  const lines = view.body.split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length <= 240);
  const out = [];
  const add = x => { if (!skip.has(x) && !out.includes(x)) out.push(x) };
  lines.forEach((l, i) => {
    if (!words.some(w => l.includes(w))) return;
    // A fact a page spreads over short neighbouring lines ("£45.17" / "In stock (19 available)") is also offered
    // as one line, so a single pick can answer both halves of the goal.
    const near = lines.slice(i, i + 3).filter(x => x.length <= 80);
    if (near.length >= 2) add(near.join(' · '));
    for (const x of lines.slice(i, i + 5)) add(x);
  });
  return out.slice(0, 40);
}
function answerLines(view, goal) {
  const rows = parse(view.snap).rows;
  return [...new Set([view.title, ...rows, ...related(view, goal, new Set(rows))].filter(t => t && t.length > 1))].slice(0, 70);
}

async function decisionsPick(goal, view, cands, hist, inputs, seen) {
  const wants = WANTS_ANSWER(goal), lines = wants ? answerLines(view, goal) : [];
  const a = await judge.ask(pagePrompt(goal, view, hist, inputs, seen), [
    ...(lines.length ? [{type: 'choice', name: 'answer', instructions: 'Which visible text best states the answer the goal asks to report (if the goal is already met on this page)?',
      choices: [...lines.map((t, i) => ({value: 't' + i, description: t.slice(0, 300)})), {value: 'none', description: 'The answer is not visible on this page yet'}]}] : []),
    {type: 'choice', name: 'next', instructions: 'Which single action should the agent take next to make progress on the goal? Prefer the action whose label most directly matches the goal. Do not repeat an action that was already taken successfully. Choose "done" only if the goal is fully achieved on the current page.',
      choices: cands.map(c => ({value: String(c.index), description: `${c.kind}: ${c.name}`.slice(0, 300)}))},
  ], {timeoutMs: 12_000});
  if (!a?.next) return null;
  const k = /^t(\d+)$/.exec(String(a.answer?.choice ?? ''));
  const ac = Number(a.answer?.confidence) || 0;
  return {index: Number(a.next.choice), confidence: Number(a.next.confidence) || 0,
    answer: k && lines[+k[1]] && ac >= 0.5 ? lines[+k[1]] : null, answerConfidence: ac};
}

// Does this answer give everything the goal asks for, readably? (one Decisions predicate; unsure counts as no)
async function answers(goal, answer) {
  const a = await judge.ask(`Goal of a web task: ${goal}\nAnswer it reported: ${answer}`, [{type: 'predicate', name: 'complete',
    instructions: 'Does the answer state, in readable words, every piece of information the goal asks for (for example both the temperature and the weather if both are asked)? A fragment, a symbol, a whole unrelated row of page text or a missing part is no.'}], {timeoutMs: 6000});
  return typeof a?.complete === 'number' ? a.complete >= 0.6 : true;
}

const json = text => { const s = String(text || ''); try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) } catch { return null } };
const glmUse = {usd: 0, calls: 0};
async function glm(content, maxTokens = 3000) {
  const r = await complete({model: GLM_MODEL(), thinking: false, temperature: 0, maxTokens, messages: [
    {role: 'system', content: 'You drive or review a browser agent. Reply with one JSON object and nothing else.'}, {role: 'user', content}]});
  glmUse.calls++; glmUse.usd += r.cost || 0;
  return json(r.text);
}

// GLM's second look (pair mode): agree, overrule with its own pick, or reject a "done" that is not done.
async function review(goal, view, cands, hist, inputs, pick, why, seen) {
  const wants = WANTS_ANSWER(goal);
  const c = pick ? cands[pick.index] : null;
  pick ??= {index: -1, confidence: 0, answer: null};
  // Comparing: the whole page instead of the screen's lines (not both: a big prompt made GLM take 20 s), and only the
  // options that open something, since the point is to pick the item that wins.
  const comparing = why === 'compare' && view.body;
  const shown = comparing ? cands.filter(x => x.kind === 'click') : cands;
  const r = await glm(`${comparing ? `You are choosing the next action for a browser agent.\nGoal: ${goal}\nCurrent page: ${view.title} (${view.url})\nThe whole page, to compare every item (prices, dates, counts):\n${view.body.slice(0, 6000)}` : pagePrompt(goal, view, hist, inputs, seen)}

Options:
${shown.map(x => `${x.index}. ${x.kind}: ${x.name}`).join('\n')}

A fast model proposes: ${c ? `${c.index}. ${c.kind}: ${c.name}` : 'none'} (confidence ${pick.confidence.toFixed(2)})${pick.answer ? `, with the answer "${pick.answer}"` : ''}. You are the careful second opinion (reason: ${why}).
- If the proposal is "done": decide from the visible text whether the goal is really achieved. If not, pick the action that makes progress.
- Never pick a select-all checkbox unless the goal asks for everything in the list.
- If the goal picks one item by comparing (the most expensive, the cheapest, the newest), compare every item listed on the page and pick the option that opens the one that wins.
${wants ? '- The goal asks to report something: if the visible text (or what was seen on earlier pages) states it, put the full answer in "answer" — every part the goal asks for, only from those pages — and set goal_met true.\n' : ''}Reply: {"choice":"<option number>","goal_met":true|false${wants ? ',"answer":"<from the page or empty>"' : ''}}`, 1500);
  if (!r) return pick;
  const i = Number(r.choice);
  // A comparison is answered by opening the winner, not by ending here: its details are on its own page.
  if (comparing && Number.isInteger(i) && cands[i]) return {index: i, confidence: i === pick.index ? 0.9 : 0.8, answer: null};
  if (r.goal_met && (r.answer || !wants)) return {index: cands.findIndex(x => x.kind === 'done'), done: true, confidence: 0.9, answer: r.answer || pick.answer};
  if (Number.isInteger(i) && cands[i]) return {index: i, confidence: i === pick.index ? 0.9 : 0.8, answer: null};
  return pick;
}

const boxLine = view => {
  const boxes = parse(view.snap).els.filter(e => CHECKABLE.has(e.role));
  return view.boxes?.length === boxes.length && boxes.length ? `Checkboxes and radios in view: ${boxes.map((e, i) => `${e.ref} ${e.name || e.role} ${view.boxes[i] ? '[checked]' : '[ ]'}`).join(', ')}\n` : '';
};

// GLM alone, the way the skill has an agent work: read the snapshot, act a few steps at once.
async function glmPlan(goal, view, hist, inputs, seen) {
  const sel = (view.selects || []).map(s => `select "${s.label}": options ${s.options.join(' | ')} (now ${s.value})`).join('\n');
  const r = await glm(`You operate a web page for this goal: ${goal}
${inputs.length ? `Texts you may type: ${inputs.map(([k, v]) => `@${k} = "${v}"`).join(', ')}\n` : ''}${hist.length ? `Done so far:\n${hist.slice(-10).join('\n')}\n` : ''}${seenText(seen, view.url) ? `Seen on pages visited before:\n${seenText(seen, view.url)}\n` : ''}Page: ${view.title} (${view.url}), scrolled ${view.y}/${view.maxY}px
Snapshot (accessibility tree; [ref=N] marks what you can act on, written @N):
${String(view.snap).slice(0, 12000)}
${sel ? sel + '\n' : ''}${boxLine(view)}
Plan the next 1-4 actions you can take on THIS page before it changes (stop the list after any click that opens another page).
Actions: {"do":"click","ref":"@N"} · {"do":"fill","ref":"@N","text":"..."} · {"do":"select","ref":"@N","option":"..."} · {"do":"press","ref":"@N","key":"Enter"} · {"do":"scroll","dir":"down"|"up"} · {"do":"back"}
Rules: type only the texts given above or plain words from the goal; never passwords or card numbers. Never click a select-all unless the goal asks for everything. If the goal is achieved (or its answer is on the page), return no actions and done true.
Reply: {"actions":[...],"done":true|false,"answer":"<what the goal asks to report, from the page, or empty>"}`);
  return r;
}

// ---- a whole task ----

// ego as a driver of the loop below: open a page, run steps, go to a page, close an alert. Other browsers bisu
// drives itself (Aside through its REPL, dec with its fast mode off) bring their own: engine/aside.mjs, engine/dec.mjs.
function egoDriver(space) {
  return {
    get id() { return space },
    async open(url) { const v = await step(space, url ? `await p.goto(${quote(url)}); did.push(${quote('opened ' + url)});` : ''); space = v.space; return v },
    act: (cs, approved = false) => step(space, cs.map(c => code(c, approved)).join('\n')),
    goto: url => step(space, code({kind: 'goto', url})),
    acceptAlert: msg => step(space, `await p.acceptDialog(); did.push(${quote('closed alert: ' + msg)});`),
  };
}

// Runs a task in ego to the end, to a held risky step, or to the step budget. `space` is the conversation's task
// space (name or id); the result says which id to resume with.
export const run = ({space, ...o}) => drive({...o, driver: egoDriver(space)});

// The loop itself, for any driver: a view is {snap (ego's snapshot format), url, title, did, dialog?, ...}. A driver
// may offer its own candidates (dec numbers its own actions) and confirm risky steps itself (dec asks the person).
export async function drive({goal, url, inputs = {}, driver, budget = 15, mode = picker(), log = () => {}}) {
  const ins = Object.entries(inputs).filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => [k, String(v)]);
  const t0 = Date.now(), hist = [], spent0 = {...glmUse}, judge0 = judge.usage.usd;
  // Whatever happens, the driver gets to clean up (an Aside REPL, a dec tab).
  try { return await loop() } catch (e) { await driver.end?.('error').catch?.(() => {}); throw e }
  async function loop() {
  let view = await driver.open(url, ins, goal);
  let last = null, answer = null, held = null, status = 'budget', steps = 0, repeats = 0, prevSig = '';
  const seen = new Map(), visits = new Map(), tried = new Set(), compared = new Set(), reviews = {n: 0, changed: 0, why: {}};
  // The same control, not the same words: three "LinkedIn 메일 선택" boxes are three different steps.
  const sigOf = c => `${c.kind}|${c.role || ''}|${c.own ?? c.label ?? ''}|${c.nth ?? ''}|${c.value || ''}|${c.dir || ''}`;
  // Where the page stands: the same action again is a repeat only if nothing moved since (scrolling on is not).
  const pageSig = v => { const r = parse(v.snap).rows; return `${v.url}|${v.y ?? ''}|${r.slice(0, 3).join('/')}|${r.slice(-3).join('/')}` };
  let prevUrl = null;
  const finish = s => ({status: s, answer: verbatim(answer, [view.body, view.snap, ...seen.values()].join('\n')), held, space: driver.id, url: view.url, title: view.title, steps, ms: Date.now() - t0, mode, reviews,
    cost: +(glmUse.usd - spent0.usd + judge.usage.usd - judge0).toFixed(4), history: hist, notice: view.notice});
  let failed = false;
  // The site the task is about: a run that wanders off it (a new-tab page, another site the goal never named) is
  // brought back to the last page it had there.
  const home = siteOf(url || view.url), names = String(goal);
  let lastOnSite = view.url, strays = 0;
  for (; steps < budget; steps++) {
    // The browser ended the run itself (dec finishing or failing it), or wants the person (a login, its own check).
    if (view.ended) { status = view.status || 'ended'; if (view.answer && !answer) answer = view.answer; break }
    if (view.waiting) { status = view.waiting === 'handoff' ? 'needs-login' : 'needs-person'; held = {kind: 'person', label: view.why || view.waiting, url: view.url}; break }
    // A sign-in form: bisu never types a password, so the person signs in themselves (browser.mjs hands ego over).
    if (parse(view.snap).els.some(e => TYPABLE.has(e.role) && /비밀\s*번호|password|암호/i.test(e.name))) { status = 'needs-login'; break }
    let todo = [];
    if (view.snap) { seen.delete(view.url); seen.set(view.url, noteOf(view)) }
    // Arrivals, not looks: filling a form is many steps on one page, coming back to a page is the loop.
    if (view.url !== prevUrl) visits.set(view.url, (visits.get(view.url) || 0) + 1);
    prevUrl = view.url;
    if (mode === 'glm') {
      const plan = await glmPlan(goal, view, hist, ins, seen);
      if (!plan) { status = 'no-pick'; break }
      if (plan.answer) answer = plan.answer;
      if (plan.done || !plan.actions?.length) { status = 'done'; break }
      const els = parse(view.snap).els;
      for (const a of plan.actions.slice(0, 4)) {
        const e = els.find(x => x.ref === a.ref);
        const label = e?.name || a.ref;
        const at = e ? {ref: e.ref, role: e.role, own: e.own, nth: e.nth, label} : {ref: a.ref, label};
        if (a.do === 'click') todo.push({kind: 'click', ...at});
        else if (a.do === 'fill' && !SECRET_FIELD.test(label)) todo.push({kind: 'type', ...at, value: String(a.text ?? '')});
        else if (a.do === 'select') todo.push({kind: 'select', ...at, value: String(a.option ?? '')});
        else if (a.do === 'press') todo.push({kind: 'key', ...at, key: a.key || 'Enter', label: a.key || 'Enter'});
        else if (a.do === 'scroll') todo.push({kind: 'scroll', dir: a.dir === 'up' ? 'up' : 'down'});
        else if (a.do === 'back') todo.push({kind: 'back'});
      }
    } else {
      const cands = driver.candidates ? driver.candidates(view) : candidates(view, ins, last, visits.size > 1, goal);
      if (process.env.BISU_EGO_DEBUG) log({url: view.url, cands: cands.map(c => `${c.index}. ${c.kind}: ${c.name}`)});
      let pick = await decisionsPick(goal, view, cands, hist, ins, seen);
      if (!pick || !cands[pick.index]) pick = null;
      if (!pick && mode !== 'rescue') { status = 'no-pick'; break }
      const c0 = pick && cands[pick.index];
      let why = null;
      if (mode === 'pair') why = c0.kind === 'done' ? 'done' : blocked(c0, goal) ? 'risky' : BULK.test(c0.label || '') ? 'bulk-select' : pick.confidence < 0.6 ? 'low-confidence' : pick.answer ? 'answer' : null;
      // Risky steps need no second model here: they wait for the person anyway.
      else if (mode === 'rescue') why =
        // it failed
        !pick ? 'no-pick' : failed ? 'step-failed'
        // its answer looks wrong
        : c0.kind === 'done' && WANTS_ANSWER(goal) && !pick.answer && !answer ? 'done-without-answer'
        // (only when it would end on that answer: a guess offered on the way is checked when the run ends)
        : c0.kind === 'done' && pick.answer && (pick.answerConfidence < 0.6 || pick.answer.length > 160) ? 'odd-answer'
        // it would choose among compared items on a list page: GLM compares, once per page, with the whole page
        : COMPARE(goal) && c0.kind === 'click' && !PAGING.test(String(c0.label || '').trim()) && listy(view) && !compared.has(pageSig(view)) ? (compared.add(pageSig(view)), 'compare')
        : pick.confidence < 0.4 ? 'unsure'
        // it slowed down
        : c0.kind !== 'done' && tried.has(pageSig(view) + '#' + sigOf(c0)) ? 'repeat' : visits.get(view.url) >= 3 ? 'loop' : steps >= 8 && steps % 3 === 2 ? 'long' : null;
      if (why) {
        const r = await review(goal, view, cands, hist, ins, pick, why, seen);
        reviews.n++; reviews.why[why] = (reviews.why[why] || 0) + 1; if (r.index !== pick?.index) reviews.changed++;
        log({review: why, from: c0?.name, to: cands[r.index]?.name});
        pick = r;
      }
      if (pick?.done) { if (pick.answer) answer = pick.answer; status = 'done'; break }
      if (!pick || !cands[pick.index]) { status = 'no-pick'; break }
      if (pick.answer) answer = pick.answer;
      const c = cands[pick.index];
      if (c.kind === 'done') {
        // 6) An answer that does not answer: Decisions checks it in a fraction of a second; GLM writes it from the
        // page only when it falls short.
        if (mode === 'rescue' && WANTS_ANSWER(goal) && answer && !(await answers(goal, answer))) {
          const r = await review(goal, view, cands, hist, ins, {...pick, answer}, 'odd-answer', seen);
          reviews.n++; reviews.why['odd-answer'] = (reviews.why['odd-answer'] || 0) + 1;
          if (r.answer && r.answer !== answer) { reviews.changed++; answer = r.answer }
          else if (!r.done && cands[r.index] && cands[r.index].kind !== 'done') { reviews.changed++; todo = [cands[r.index]]; answer = null }
          if (!todo.length) { status = 'done'; break }
        } else { status = 'done'; break }
      } else todo = [c];
    }
    // Run up to the first step that must wait for the person.
    let stop = null;
    const now = [];
    for (const c of todo) { const b = blocked(c, goal); if (b && !(b === 'risky' && driver.confirmsRisk)) { stop = {c, b}; break } now.push(c) }
    if (now.length) {
      const sig = pageSig(view) + '#' + now.map(c => `${c.kind}${c.ref}${c.value || ''}${c.dir || ''}`).join('|');
      repeats = sig === prevSig ? repeats + 1 : 0; prevSig = sig;
      if (repeats >= 2) { status = 'stuck'; break }
      for (const c of now) tried.add(pageSig(view) + '#' + sigOf(c));
      view = await driver.act(now);
      hist.push(...view.did);
      failed = view.did.some(d => d.startsWith('error: '));
      const there = siteOf(view.url);
      if (home && there !== home && !(there && names.includes(there.split('.')[0]))) {
        if (++strays > 2) { status = 'stuck'; break }
        hist.push(`(left ${home} for ${/^https?:/.test(view.url) ? there : 'a browser page'}; went back — stay on ${home})`);
        view = await driver.goto(lastOnSite);
      } else lastOnSite = view.url;
      last = now.at(-1);
      log({step: steps + 1, did: view.did, url: view.url});
      // A plain alert only informs: close it and go on. A confirm or prompt asks for a decision: the person's.
      if (view.dialog?.type === 'alert') view = await driver.acceptAlert(view.dialog.message);
      if (view.dialog) { held = {kind: 'dialog', label: view.dialog.message, url: view.url}; status = 'needs-approval'; break }
    }
    if (stop) {
      if (stop.b === 'bulk') { hist.push(`(refused: "${stop.c.label}" would select every row; act only on the items the goal names)`); continue }
      const {kind, ref, role, own, nth, label, key, value} = stop.c;
      held = {kind, ref, role, own, nth, label, key, value, url: view.url};
      status = 'needs-approval';
      break;
    }
  }
  await driver.end?.(status);
  return finish(status);
  }
}

// The held step, once the person said yes: the page must still be the one it was held on.
export async function approve({space, held}) {
  const v = await step(space, `if ((await p.url()) !== ${quote(held.url)}) throw new Error('the page changed since this step was held');
${code(held, true)}`);
  const error = v.did.find(d => d.startsWith('error: '));
  return {ok: !error, error: error?.slice(7), did: v.did, url: v.url, title: v.title, texts: parse(v.snap).texts.slice(0, 40), space: v.space};
}

// The text of the page the space is on, for answering from it (paged: offset in characters).
export async function read({space, offset = 0, limit = 8000}) {
  const v = await step(space, `const all = await p.evaluate(() => document.body?.innerText || ''); did.push(JSON.stringify({total: all.length, text: all.slice(${Number(offset) | 0}, ${(Number(offset) | 0) + Math.min(20000, Number(limit) || 8000)})}));`);
  let page = {total: 0, text: ''};
  try { page = JSON.parse(v.did[0]) } catch {}
  return {...page, url: v.url, title: v.title, space: v.space};
}

// Close the space: the agent's pages go, the person's own tabs stay.
export async function close(space, keep = false) {
  return ego(`const t = await taskSpace(${typeof space === 'number' ? space : quote(space)}); await t.finish({keep: ${keep ? '["p1"]' : '[]'}}); console.log('@@BISU {}');`, 30_000);
}

// The person has to do something in ego (sign in, a puzzle): give them the space, and take it back later.
export async function handOff(space) {
  return ego(`const t = await taskSpace(${typeof space === 'number' ? space : quote(space)}); await t.handOff(); console.log('@@BISU {}');`, 30_000);
}
export async function takeBack(space) {
  // By id, or by name when the space was handed over before its first look gave the id.
  const id = typeof space === 'number' ? String(space) : `(await listTaskSpaces()).find(x => x.name === ${quote(space)})?.id`;
  return ego(`const id = ${id}; if (id != null) { const t = await takeOverTaskSpace(id); const u = t.userPage(); if (u && !u.label) await t.adopt(u, {as: "p1"}).catch(() => {}) } console.log('@@BISU {}');`, 30_000);
}

export const usage = () => ({glm: {...glmUse}, decisions: judge.usage.usd});
