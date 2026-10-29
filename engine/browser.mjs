// Doing things on the web for the person, in a browser where they are already signed in (both engines, and the
// Claude Code chats through ui/cu/server.mjs). dec first: with its fast mode on (a paid plan), the whole task is
// handed over in one call (engine/dec.mjs task()); with it off, bisu drives dec itself, step by step, with the same
// loop it drives ego with (engine/ego.mjs drive(), engine/dec.mjs directDriver()). Without dec, ego lite. One tab or
// task space per conversation, reused task after task. The person approves what pays, sends, deletes or books: in
// fast mode dec asks in dec with Touch ID; when bisu drives, the run stops on it and browser_approve goes through
// bisu's approval card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dec from './dec.mjs';
import * as ego from './ego.mjs';

const DATA = path.join(os.homedir(), 'Library', 'Application Support', 'bisu');
const SHOTS = path.join(DATA, 'web');
// dec runs still going when a call returned; the bisu page watches them and tells the chat when they end.
export const WAITS = path.join(DATA, 'web-waits');

const ok = text => ({text});
const err = text => ({text, error: true});
const chat = () => process.env.BISU_CHAT_ID || `p${process.pid}`;
const SPACE = () => `bisu-${chat().slice(0, 40)}`;

// What this conversation did last, so browser_read and browser_approve know where to look.
const state = {space: null, decTab: null, held: new Map(), last: null, handedOff: false};
let heldNo = 0;

function inputsOf(typing) {
  const out = {};
  let n = 0;
  for (const line of String(typing || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = /^([^:=]{1,24}?)\s*[:=]\s*(.+)$/.exec(line);
    out[m ? m[1].trim() : `text${++n}`] = (m ? m[2] : line).trim().slice(0, 500);
  }
  return out;
}

function remember(r) {
  fs.mkdirSync(WAITS, {recursive: true});
  fs.writeFileSync(path.join(WAITS, `${r.runId}.json`), JSON.stringify({runId: r.runId, tabId: r.tabId, goal: r.goal, chat: process.env.BISU_CHAT_ID || null, at: Date.now()}));
}

const lines = (...xs) => xs.filter(Boolean).join('\n');

async function viaDec({goal, url, inputs, lookOnly}) {
  const r = await dec.task({goal, url, inputs: Object.entries(inputs).slice(0, 8).map(([name, value]) => ({name, value})), readOnly: lookOnly, dir: SHOTS});
  state.last = {via: 'dec', tabId: r.tabId, runId: r.runId};
  if (r.waitingFor || r.status === 'running') {
    remember({...r, goal});
    const what = r.waitingFor === 'confirm' ? `dec is asking the person to confirm a step in dec (Touch ID): ${r.confirm || 'a risky action'}.`
      : r.waitingFor === 'handoff' ? `dec handed the tab to the person: ${r.handoff || 'they need to sign in or solve something'} — they finish it in dec and press 계속.`
      : r.waitingFor === 'control' ? 'the person took over the tab in dec.'
      : 'dec is still working on it.';
    return ok(lines(`Not finished yet (dec run ${r.runId}): ${what}`,
      'Tell the person in a sentence what is needed, if anything. dec carries on by itself once they do, and bisu tells this chat the result when the run ends; browser_check shows where it is.'));
  }
  return ok(lines(`Done in dec (${r.status}, ${r.steps ?? '?'} steps).`, r.answer && `Answer: ${r.answer}`, r.url && `Ended on: ${r.url}`,
    r.reason && /failed|stopped/.test(r.status) && `Why: ${r.reason}`,
    r.status === 'failed' && 'It did not get there: say so plainly, with what dec reported.'));
}

// dec with its fast mode off: bisu picks every step, dec carries it out in the conversation's tab.
async function viaDecDirect({goal, url, inputs, budget}) {
  const driver = dec.directDriver({tab: state.decTab});
  const r = await ego.drive({goal, url, inputs, driver, budget});
  state.decTab = driver.tabId;
  state.last = {via: 'dec', tabId: driver.tabId};
  const head = `${r.status === 'done' ? 'Done' : 'Stopped'} in dec, bisu driving (${r.status}, ${r.steps} steps, ${(r.ms / 1000).toFixed(0)} s). Page: ${r.title || ''} — ${r.url || ''}`;
  const did = r.history.length ? `What was done: ${r.history.slice(-8).join(' → ')}` : '';
  if (r.status === 'needs-approval') {
    const id = `h${++heldNo}`;
    state.held.set(id, {dec: true, tabId: driver.tabId, held: r.held, at: Date.now()});
    return ok(lines(head, did, `Waiting for the person: the next step is "${r.held.label}", which dec marks as one that commits something.`,
      `Tell them exactly what it will do and ask; when they say yes, call browser_approve with id "${id}" and step "${r.held.label}".`));
  }
  if (r.status === 'needs-login' || r.status === 'needs-person')
    return ok(lines(head, did, `dec is waiting for the person in the dec window (${r.held?.label || 'sign in or confirm'}). Ask them to do it there, then call browser_task again. Never ask for their password.`));
  return ok(lines(head, r.answer && `Answer (from the page): ${r.answer}`, did,
    r.status !== 'done' && 'It did not finish. Try browser_task once more at most (a closer start url, a simpler goal); after that, tell the person what was reached and what is left. Report only what a browser tool returned — never fill in an answer it did not give.'));
}

async function viaEgo({goal, url, inputs, budget}) {
  if (state.handedOff && state.space != null) { await ego.takeBack(state.space).catch(() => {}); state.handedOff = false }
  const r = await ego.run({goal, url, inputs, space: state.space ?? SPACE(), budget});
  state.space = r.space;
  state.last = {via: 'ego', space: r.space};
  const head = `${r.status === 'done' ? 'Done' : 'Stopped'} in ego (${r.status}, ${r.steps} steps, ${(r.ms / 1000).toFixed(0)} s). Page: ${r.title} — ${r.url}`;
  const did = r.history.length ? `What was done: ${r.history.slice(-8).join(' → ')}` : '';
  const upgrade = r.notice ? 'ego lite has an update: mention it to the person once (they update it from ego itself).' : '';
  if (r.status === 'needs-approval') {
    const id = `h${++heldNo}`;
    state.held.set(id, {space: r.space, held: r.held, at: Date.now()});
    return ok(lines(head, did, r.held.kind === 'dialog' ? `Waiting for the person: the site asks "${r.held.label}" — confirming it commits something.` : `Waiting for the person: the next step is pressing "${r.held.label}", which commits something.`,
      `Tell them exactly what it will do and ask; when they say yes, call browser_approve with id "${id}" and step "${r.held.label}".`, upgrade));
  }
  if (r.status === 'needs-login') {
    await ego.handOff(r.space).catch(() => {});
    state.handedOff = true;
    return ok(lines(head, 'The site wants them signed in. The ego window is theirs now: ask them to sign in there and tell you when done, then call browser_task again — it takes the window back and carries on. Never ask for their password.', upgrade));
  }
  return ok(lines(head, r.answer && `Answer (from the page): ${r.answer}`, did,
    r.status !== 'done' && 'It did not finish. Try browser_task once more at most (a closer start url, a simpler goal); after that, tell the person what was reached and what is left. Report only what a browser tool returned — never fill in an answer it did not give.', upgrade));
}

export const BROWSER_TOOLS = {
  browser_task: {
    description: 'Do something on a website for the person, in their own browser where they are already signed in: look something up, compare, fill in a form, book, order, check mail. Give the goal in one sentence and the page to start on. It runs to the end and returns what it found. Steps that pay, send, delete, book or submit always wait for the person. Use it instead of web_fetch when the page needs their login, has to be clicked through, or the task changes something; for plain reading of a public page web_fetch is faster.',
    parameters: {type: 'object', properties: {
      goal: {type: 'string', description: 'what to do and what to report, in one sentence, e.g. "쿠팡에서 @item 를 검색해서 가장 싼 로켓배송 상품의 가격을 알려줘"'},
      url: {type: 'string', description: 'the page to start on (full address). If you do not know the site, a search page: https://search.naver.com/search.naver?query=...'},
      typing: {type: 'string', description: 'texts it may type, one per line as name: value, referred to as @name in the goal (search words, a name, a date). Never passwords or card numbers.'},
      look_only: {type: 'boolean', description: 'only look and read, never click anything that changes something'},
      browser: {type: 'string', enum: ['auto', 'dec', 'ego'], description: 'auto (default): dec (fast mode hands it the whole task; without it bisu drives dec), else ego'},
    }, required: ['goal', 'url']},
    kind: 'net',
    async run(ctx, {goal, url, typing, look_only, browser = 'auto'}) {
      // A blank page is not a task: showing dec is browser_show.
      if (/^\s*(about:blank|about:newtab|chrome:\/\/newtab\/?)?\s*$/i.test(String(url || ''))) return err('No page given. To show dec or open a new tab with nothing to do there, use browser_show; for a task, give the real address.');
      if (!/^https?:\/\//i.test(String(url || ''))) url = 'https://' + String(url || '').replace(/^\/+/, '');
      const inputs = inputsOf(typing);
      let note = '';
      // dec works on the open web only (https); a page on this Mac is ego's.
      if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(url)) browser = 'ego';
      if (browser !== 'ego') {
        try {
          const st = await dec.up();
          if (st?.fastMode?.enabled) return await viaDec({goal, url, inputs, lookOnly: !!look_only});
          if (st) return await viaDecDirect({goal: look_only ? `${goal} (only look and read; do not change anything)` : goal, url, inputs});
          if (browser === 'dec') return err('dec is not available (not installed, or its agent connection is off).');
        } catch (e) {
          if (browser === 'dec') return err(`dec failed: ${e.code || e.message}`);
          note = `dec failed (${e.code || e.message}), so ego did this. `;
        }
      }
      try {
        const r = await viaEgo({goal: look_only ? `${goal} (only look and read; do not change anything)` : goal, url, inputs});
        return note ? {...r, text: note + r.text} : r;
      } catch (e) {
        if (e.code === 'BROWSER_PROMPT') {
          state.space ??= SPACE();
          state.handedOff = true;
          return err(`${note}The page put up a browser prompt in ego (${e.message}), and ego handed the window to the person. Ask them to close it in ego (차단 / 허용 안 함), then call browser_task again.`);
        }
        return err(`${note}The browser failed: ${e.message}`);
      }
    },
  },
  browser_approve: {
    description: 'Press the step browser_task held for the person (paying, sending, deleting, booking), by the id it gave — only after they said yes to exactly that.',
    parameters: {type: 'object', properties: {id: {type: 'string'}, step: {type: 'string', description: 'the words on the button, exactly as browser_task gave them (the person sees them when approving)'}}, required: ['id', 'step']},
    kind: 'act',
    async run(ctx, {id, step}) {
      const h = state.held.get(String(id));
      if (!h) return err(`No held step "${id}" (each id works once, in the chat that made it).`);
      // What the person approved is what is pressed: the words they saw must be the held button's.
      if (String(step || '').trim() !== h.held.label) return err(`Step "${id}" is pressing "${h.held.label}", not "${step}": ask again with the right words.`);
      state.held.delete(String(id));
      if (Date.now() - h.at > 30 * 60_000) return err('That step was held more than 30 minutes ago: run browser_task again so the page is current.');
      try {
        if (h.dec) {
          const r = await dec.directDriver({tab: h.tabId}).approve(h.held);
          if (!r.ok) return err(`Not pressed: ${r.error}. Run browser_task again from the current page.`);
          return ok(lines(`Pressed "${h.held.label}" in dec. Now on: ${r.title || ''} — ${r.url || ''}`, `Page says: ${r.text.replace(/\s+/g, ' ').slice(0, 1500)}`));
        }
        const r = await ego.approve(h);
        if (!r.ok) return err(`Not pressed: ${r.error}. Run browser_task again from the current page.`);
        return ok(lines(`Pressed "${h.held.label}". Now on: ${r.title} — ${r.url}`, `Page says: ${r.texts.slice(0, 25).join(' / ').slice(0, 1500)}`));
      } catch (e) { return err(`Pressing it failed: ${e.code || e.message}`) }
    },
  },
  browser_show: {
    description: 'Show the person their browser (dec): bring it to the front, started if it is closed. new_tab opens a tab at dec\'s own home page. For "덱 열어줘", "브라우저 띄워줘", "새 탭/새 창" with no site to visit or task to do. browser_task works in a tab in the background and never opens a window, so use this to show dec.',
    parameters: {type: 'object', properties: {new_tab: {type: 'boolean', description: 'also open a new tab at dec\'s home page'}}},
    kind: 'net',
    async run(ctx, {new_tab = false}) {
      try {
        const r = await dec.show({newTab: !!new_tab});
        if (!r) return err('dec is not available (not installed, or its agent connection is off).');
        return ok(lines(r.front ? 'dec is in front now.' : 'dec is open, but it could not be brought to the front.', r.tab && 'A new tab at dec\'s home page is open.'));
      } catch (e) { return err(`dec failed: ${e.code || e.message}`) }
    },
  },
  browser_check: {
    description: 'Where a web task that was still running (or waiting for the person in dec) stands now, and its result once it ended.',
    parameters: {type: 'object', properties: {run: {type: 'string', description: 'the dec run id browser_task gave'}}, required: ['run']},
    kind: 'net',
    async run(ctx, {run}) {
      try {
        const v = await dec.state(String(run));
        if (!v.ended) return ok(v.waitingFor ? `Still waiting for the person in dec (${v.waitingFor}${v.confirm ? `: ${v.confirm}` : ''}).` : `Still running (step ${v.steps ?? '?'}).`);
        const w = (() => { try { return JSON.parse(fs.readFileSync(path.join(WAITS, `${run}.json`), 'utf8')) } catch { return null } })();
        const f = await dec.finish(v, w?.tabId, SHOTS);
        fs.rmSync(path.join(WAITS, `${run}.json`), {force: true});
        return ok(lines(`Ended (${f.status}, ${f.steps ?? '?'} steps).`, f.answer && `Answer: ${f.answer}`, f.url && `Ended on: ${f.url}`));
      } catch (e) { return err(`Could not read that run: ${e.code || e.message}`) }
    },
  },
  browser_read: {
    description: 'Read the text of the page the last web task ended on, to answer from it or check details (paged: offset in characters).',
    parameters: {type: 'object', properties: {offset: {type: 'integer'}}},
    kind: 'net',
    async run(ctx, {offset = 0}) {
      const l = state.last;
      if (!l) return err('No web task in this chat yet: run browser_task first.');
      try {
        if (l.via === 'dec') {
          const r = await dec.api('POST', `/v1/tabs/${l.tabId}/content`, {limit: 8000, offset: Math.max(0, offset | 0)});
          return ok(lines(`${r.title || ''} — ${r.url || ''}`, String(r.text || '').slice(0, 8000), r.next != null && `(more: offset ${r.next})`));
        }
        const r = await ego.read({space: l.space, offset});
        const next = offset + r.text.length;
        return ok(lines(`${r.title} — ${r.url}`, r.text, next < r.total && `(more: offset ${next} of ${r.total})`));
      } catch (e) { return err(`Could not read the page: ${e.code || e.message}`) }
    },
  },
};
