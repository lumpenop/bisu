// dec, the person's own browser, through its local agent endpoint (127.0.0.1, found from the discovery file dec
// writes while the endpoint is on). bisu pairs once as the agent "bisu" and keeps its own key, the same place dec's
// SDK keeps every agent's (~/.config/dec-browser/pairings), so dec's settings list bisu by name.
//
// With dec's fast mode on, a whole web task is one call: bisu gives the goal and the texts it may type, and dec's
// own Decisions + GLM make every step — the same split bisu itself uses. Fast mode is dec's paid plan (always open on
// the owner's Mac); dec decides it, bisu only reads the switch. Risky steps (paying, sending, deleting) stay dec's to
// confirm with the person, in dec, with Touch ID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';

const DISCOVERY = process.env.BISU_DEC_ENDPOINT || path.join(os.homedir(), 'Library', 'Application Support', 'Dec Browser', 'agent-endpoint.json');
const PAIR_FILE = path.join(os.homedir(), '.config', 'dec-browser', 'pairings', 'bisu.key');
const BUNDLE = 'local.dec.browser';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DecError extends Error { constructor(code, status = 0) { super(code); this.code = code; this.status = status } }

function discovery() {
  try {
    const d = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'));
    return d?.host === '127.0.0.1' && Number.isInteger(d.port) && /^[0-9a-f]{64}$/.test(d.token || '') ? d : null;
  } catch { return null }
}

function raw(d, token, method, p, body, timeoutMs) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: d.port, path: p, method, timeout: timeoutMs,
      headers: {authorization: 'Bearer ' + token, ...(payload ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {})}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(new DecError('BAD_RESPONSE', res.statusCode)) }
        if (res.statusCode < 300 && j.ok) resolve(j);
        else reject(Object.assign(new DecError(typeof j.code === 'string' ? j.code : 'REQUEST_FAILED', res.statusCode), {retryAfter: j.retryAfter ?? j.details?.retryAfter}));
      });
    });
    req.on('timeout', () => req.destroy(new DecError('TIMEOUT')));
    req.on('error', e => reject(e instanceof DecError ? e : new DecError('DEC_UNREACHABLE')));
    if (payload) req.write(payload);
    req.end();
  });
}

let key = null;
async function pairKey(d, fresh) {
  if (fresh) { key = null; fs.rmSync(PAIR_FILE, {force: true}) }
  if (!key) { try { const k = fs.readFileSync(PAIR_FILE, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(k)) key = k } catch {} }
  if (!key) {
    const r = await raw(d, d.token, 'POST', '/v1/pair', {agent: 'bisu'}, 10_000);
    key = r.pairing.token;
    fs.mkdirSync(path.dirname(PAIR_FILE), {recursive: true, mode: 0o700});
    fs.writeFileSync(PAIR_FILE, key + '\n', {mode: 0o600});
  }
  return key;
}

// One request with bisu's own key: re-pairs once when dec no longer knows it, and waits out the 60-a-minute limit.
export async function api(method, p, body, {timeoutMs = 15_000} = {}) {
  const d = discovery();
  if (!d) throw new DecError('DEC_OFF');
  for (let i = 0; ; i++) {
    try { return await raw(d, await pairKey(d, false), method, p, body, timeoutMs) } catch (e) {
      if (e.code === 'UNAUTHORIZED' && i === 0) { await pairKey(d, true); continue }
      // dec says when its per-minute budget frees up again.
      if (e.code === 'RATE_LIMITED' && i < 4) { await sleep(Math.min(30, Math.max(1, Number(e.retryAfter) || 5)) * 1000); continue }
      throw e;
    }
  }
}

// The app itself, not a script run with its Electron as node (dec's dec-browser command does that): flags only after it.
const running = () => new Promise(r => execFile('/usr/bin/pgrep', ['-f', 'Dec Browser\\.app/Contents/MacOS/Electron( -[^ ]*)*$'], e => r(!e)));
// Which Dec Browser.app to open. Old development copies share dec's bundle id, so a path: BISU_DEC_APP, the usual
// places, then the app dec's own dec-browser command runs (~/.local/bin/dec-browser names its Electron).
export function decApp(home = os.homedir()) {
  const shim = (() => { try { return /exec "([^"]*\/Dec Browser\.app)\/Contents\/MacOS\//.exec(fs.readFileSync(path.join(home, '.local', 'bin', 'dec-browser'), 'utf8'))?.[1] } catch { return null } })();
  return [process.env.BISU_DEC_APP, '/Applications/Dec Browser.app', path.join(home, 'Applications', 'Dec Browser.app'), shim].find(a => a && fs.existsSync(a)) ?? null;
}

// dec's status, starting dec in the background first when it is installed but not running. Null when there is no
// dec to use: not installed, or running with its agent endpoint switched off.
export async function up({start = true, waitMs = 25_000, front = false} = {}) {
  if (process.env.BISU_DEC === '0') return null;
  try { return await api('GET', '/v1/status') } catch (e) { if (!['DEC_OFF', 'DEC_UNREACHABLE'].includes(e.code)) throw e }
  if (!start || await running()) return null;
  // -g: dec comes up behind whatever the person is doing. --agent-connect: dec turns its agent connection on unless the
  // person once turned it off. (open hands its environment to the app: no ELECTRON_RUN_AS_NODE.)
  const app = decApp(), env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
  const g = front ? [] : ['-g'];
  const opened = await new Promise(r => execFile('/usr/bin/open', app ? [...g, app, '--args', '--agent-connect'] : [...g, '-b', BUNDLE, '--args', '--agent-connect'], {env}, e => r(!e)));
  if (!opened) return null;
  // The endpoint is up before the tabs are back: wait until dec says they are (tabsReady), so the run finds its tab.
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await sleep(500);
    try { const st = await api('GET', '/v1/status'); if (st?.tabsReady !== false) return st } catch {}
  }
  return null;
}

// The Dec Browser.app that is running (from the pid in its discovery file), so bringing it forward never starts
// another copy: old development copies share its bundle id.
function runningApp() {
  const pid = discovery()?.pid;
  if (!Number.isInteger(pid)) return Promise.resolve(null);
  return new Promise(r => execFile('/bin/ps', ['-o', 'comm=', '-p', String(pid)], (e, out) => r(e ? null : /^(.*\.app)\/Contents\/MacOS\//.exec(String(out).trim())?.[1] ?? null)));
}

// dec in front of the person, for "open dec" / "a new tab": started when it is closed (it comes back with its own
// tabs, or its home page when it has none); newTab adds a tab at dec's own home page. Null when there is no dec.
export async function show({newTab = false} = {}) {
  const st = await up({front: true});
  if (!st) return null;
  let tab = null;
  if (newTab) tab = (await api('POST', '/v1/tabs', {home: true, agent: 'bisu'})).tab ?? null;
  return {tab, front: await front()};
}

// Brings dec forward: the running copy when there is one, else the app decApp finds (opened when closed).
export async function front() {
  const app = await runningApp() ?? decApp(), env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
  return new Promise(r => execFile('/usr/bin/open', app ? [app] : ['-b', BUNDLE], {env}, e => r(!e)));
}

const tabsOf = r => Array.isArray(r) ? r : r?.tabs ?? [];
const NEEDS_PERSON = {'user-confirmation': 'confirm', 'user-handoff': 'handoff', 'user-control': 'control'};

// What a run says now, in the shape bisu reports.
export function view(run) {
  const r = run?.run ?? run ?? {};
  const res = r.result ?? null;
  return {
    runId: r.id, status: res?.status ?? r.status ?? 'running', ended: !!(r.end || res),
    waitingFor: res ? null : NEEDS_PERSON[r.awaiting] ?? null,
    confirm: r.pendingConfirmation?.summary ?? null, handoff: r.handoff?.reason ?? null,
    answer: res?.answer ?? null, reason: res?.reason ?? null, steps: res?.steps ?? r.progress?.step ?? null,
  };
}

export async function state(runId) { return view(await api('GET', `/v1/runs/${runId}`)) }

// The final page and dec's proof screenshot, once a run has ended.
export async function finish(v, tabId, dir) {
  let url = null, shot = null;
  try { url = tabsOf(await api('GET', '/v1/tabs')).find(t => t.id === tabId)?.url ?? null } catch {}
  try {
    const r = await api('GET', `/v1/runs/${v.runId}/screenshot`);
    if (r?.dataBase64 && dir) { fs.mkdirSync(dir, {recursive: true}); shot = path.join(dir, `dec-${v.runId}.png`); fs.writeFileSync(shot, Buffer.from(r.dataBase64, 'base64'), {mode: 0o600}) }
  } catch {}
  return {...v, url, screenshot: shot};
}

// A whole task in fast mode: a tab of its own at the start page, then dec does the rest. Returns when the run ends,
// when dec needs the person (a risky step to confirm, a login), or after waitMs — still running then, check later.
export async function task({goal, url, inputs = [], readOnly = false, budget, waitMs = 240_000, dir, onWait}) {
  const o = await api('POST', '/v1/tabs', {url, background: true, agent: 'bisu'});
  const tabId = o.tab?.id;
  if (!tabId) throw new DecError('TAB_NOT_OPENED');
  for (let i = 0; i < 50; i++) { let t = null; try { t = (await api('GET', `/v1/tabs/${tabId}`)).tab } catch {} if (t && t.loading === false) break; await sleep(200) }
  let started;
  // One run at a time in dec: wait a while for another task to end rather than failing at once.
  for (const end = Date.now() + 90_000; ;) {
    try { started = await api('POST', '/v1/runs', {tabId, goal, ...(inputs.length ? {inputs} : {}), ...(readOnly ? {readOnly: true} : {}), ...(budget ? {budget} : {})}); break } catch (e) {
      if (e.code !== 'RUN_ACTIVE' || Date.now() > end) throw e;
      await sleep(2000);
    }
  }
  const runId = started.runId ?? started.id;
  let v = {runId};
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    try { await api('POST', `/v1/runs/${runId}/wait`, {timeoutSec: 20}, {timeoutMs: 30_000}) } catch { await sleep(500) }
    v = await state(runId);
    if (v.ended) return {...await finish(v, tabId, dir), tabId};
    if (v.waitingFor) { onWait?.(v); return {...v, tabId} }
  }
  return {...v, tabId, status: 'running'};
}

// ---- dec with its fast mode off: bisu makes every pick ----

// dec offers numbered actions each step (pendingDecision) and carries out the one bisu sends back; its own
// confirmation of risky steps stays with the person, in dec. The view handed to the shared loop (engine/ego.mjs
// drive()) is the page's visible text in ego's snapshot format plus dec's own candidates; the tab's whole text,
// read through the endpoint, is what the loop searches for answers off screen.
const esc = t => JSON.stringify(String(t ?? ''));
const origin = u => { try { return new URL(u).origin } catch { return '' } };
export function directDriver({readText = true, tab = null} = {}) {
  let tabId = tab, runId = null, lastReq = null, viewNow = null, lastIns = [], lastGoal = '';
  // Stop at the person: a login handed to them, a step dec wants them to confirm, the tab taken over.
  const pending = async (waitMs = 120_000) => {
    const t0 = Date.now();
    for (const end = Date.now() + waitMs; Date.now() < end;) {
      if (process.env.BISU_DEC_DEBUG && Date.now() - t0 > 3000 && (Date.now() - t0) % 5000 < 100) { const r = (await api('GET', `/v1/runs/${runId}`)).run; process.stderr.write(`[dec wait ${((Date.now() - t0) / 1000).toFixed(0)}s] awaiting=${r.awaiting} status=${r.status} progress=${JSON.stringify(r.progress)}\n`) }
      const r = (await api('GET', `/v1/runs/${runId}`)).run;
      if (r.end || r.result) return {ended: true, run: r};
      if (NEEDS_PERSON[r.awaiting]) return {waiting: NEEDS_PERSON[r.awaiting], run: r};
      const p = r.pendingDecision;
      if (r.awaiting === 'agent-decision' && p && p.requestId !== lastReq) return {p, run: r};
      // (a state poll is free of dec's per-minute budget, and small while dec is busy: ask often)
      await sleep(25);
    }
    throw new DecError('TIMEOUT');
  };
  const look = async (did = []) => {
    const w = await pending();
    if (w.ended) return {ended: true, status: w.run.result?.status ?? 'ended', answer: w.run.result?.answer ?? null, snap: '', url: '', title: '', did};
    if (w.waiting) return {waiting: w.waiting, why: w.run.pendingConfirmation?.summary ?? w.run.handoff?.reason ?? null, snap: '', url: viewNow?.url ?? '', title: viewNow?.title ?? '', did};
    const q = w.p.request, page = q.observation?.page ?? {};
    // dec sends this agent every line of the page with each request; a dec that sends only the lines around the
    // viewport (20 of them) is read in full instead. Every call outside run polls counts against dec's per-minute budget.
    const lines = (page.texts || []).map(t => typeof t === 'string' ? t : t.text);
    let body = lines.join('\n');
    if (readText && lines.length === 20) { try { body = String((await api('POST', `/v1/tabs/${tabId}/content`, {limit: 12000})).text || '') } catch {} }
    // dec rates each action's risk itself: what is not "safe" is a step bisu holds for the person.
    const cands = (q.candidates || []).map((c, i) => ({index: i, decIndex: c.index, requestId: w.p.requestId, kind: c.kind, name: c.name || c.kind, label: c.name || '', risk: c.risk ?? 'safe'}));
    viewNow = {snap: lines.map(t => `text ${esc(t)}`).join('\n'), url: page.url || q.url || q.origin || '', title: page.title || '', did, cands, body, y: 0, maxY: 0};
    return viewNow;
  };
  const start = async (goal, ins = []) => {
    // bisu counts its own steps; dec's run must not end first (its default is 12).
    const s = await api('POST', '/v1/runs', {tabId, goal: String(goal || 'bisu drives this tab').slice(0, 500), decider: 'agent', budget: 40, ...(ins.length ? {inputs: ins.slice(0, 8).map(([name, value]) => ({name, value}))} : {})});
    runId = s.runId ?? s.id; lastReq = null;
  };
  // Loaded at the address asked for: a tab sent to another site still shows the old page for a moment, and a run
  // started then is allowed for the old site only (AI_TASK_CONSENT_REQUIRED on the new one).
  // (one tab's state is a state poll, outside dec's per-minute budget; the whole tab list is not)
  const tabNow = async () => { try { return (await api('GET', `/v1/tabs/${tabId}`)).tab ?? null } catch { return null } };
  const loaded = async url => { for (let i = 0; i < 50; i++) { const t = await tabNow(); if (t && t.loading === false && (!url || origin(t.url) === origin(url))) return true; await sleep(40) } return false };
  const stop = async () => { try { await api('POST', `/v1/runs/${runId}/stop`, {}) } catch {} for (let i = 0; i < 150; i++) { try { if ((await api('GET', `/v1/runs/${runId}`)).run.end) break } catch { break } await sleep(20) } };
  return {
    get id() { return runId },
    get tabId() { return tabId },
    candidates: v => v.cands,
    // The page's text in full, every line where it stands: dec sends this agent every line, repeats included, so the
    // view already is that (a separate read only when it is not there; each read counts against dec's per-minute budget).
    readPage: async () => viewNow?.body || String((await api('POST', `/v1/tabs/${tabId}/content`, {limit: 20000})).text || ''),
    // One tab per conversation: the last task's tab goes to the new page; a new tab only when there is none.
    async open(url, ins = [], goal = '') {
      lastIns = ins; lastGoal = goal;
      // dec lets a run work only on the sites its tab was opened for: another site gets a tab of its own, and the
      // last one is closed so they do not pile up.
      let moved = false;
      if (tabId) {
        const was = await tabNow();
        if (was && origin(was.url) === origin(url)) { await api('POST', `/v1/tabs/${tabId}/navigate`, {url, agent: 'bisu'}); moved = true }
        else if (was) await api('POST', `/v1/tabs/${tabId}/close`, {agent: 'bisu'}).catch(() => {});
      }
      if (!moved) tabId = (await api('POST', '/v1/tabs', {url, background: true, agent: 'bisu'})).tab.id;
      await loaded(url);
      await start(goal, ins);
      return look([`opened ${url}`]);
    },
    async act(cs) {
      const did = [];
      for (const c of cs) {
        lastReq = c.requestId;
        // The page moved on while the step was being picked (a shop's script redrawing it): dec has dropped that request
        // and asks again on the page as it is now, which is the next look.
        try { await api('POST', `/v1/runs/${runId}/decision`, {requestId: c.requestId, candidateIndex: c.decIndex}) } catch (e) {
          if (e.code === 'STALE_REQUEST' || e.code === 'NO_PENDING_DECISION') { did.push('(the page changed before this step; looked again)'); break }
          throw e;
        }
        did.push(`${c.kind} ${c.label}`.trim());
      }
      return look(did);
    },
    // A click that filled the page in later (a table loaded by script): dec offers 「wait」 after a step that changed
    // nothing; take it, and look again.
    async wait() {
      const w = viewNow?.cands?.find(x => x.kind === 'wait');
      if (w) return this.act([w]);
      // No wait offered (the click only changed the address's #): give the page a moment and read its text again. The
      // actions stay the ones dec offered; the lines are the page as it is now.
      await sleep(1500);
      let text = '';
      try { text = String((await api('POST', `/v1/tabs/${tabId}/content`, {limit: 20000})).text || '') } catch { return viewNow }
      if (!text || text === viewNow.body) return viewNow;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      viewNow = {...viewNow, body: text, snap: lines.map(t => `text ${esc(t)}`).join('\n'), did: ['(waited for the page to fill in)']};
      return viewNow;
    },
    // Another page of the site: the tab goes there and dec is asked again (a run is for the page it started on).
    async goto(url) { if (url && /^https?:/.test(url)) { await stop(); return this.open(url, lastIns, lastGoal) } const c = viewNow?.cands.find(x => x.kind === 'back'); return c ? this.act([c]) : viewNow },
    acceptAlert: () => viewNow,
    // The loop is done: end dec's run and keep the tab, for reading it and for the next task.
    async end(status) {
      if (status === 'done') try { const d = viewNow?.cands.find(x => x.kind === 'done'); if (d) { lastReq = d.requestId; await api('POST', `/v1/runs/${runId}/decision`, {requestId: d.requestId, candidateIndex: d.decIndex}) } } catch {}
      await stop();
    },
    // The step held for the person, once they said yes: a fresh run on the same tab, the same action found again by
    // what it does and says, and only that one step.
    async approve(held) {
      await start('bisu: the person approved this step');
      let v = await look();
      const c = v.cands?.find(x => x.kind === held.kind && x.label === held.label) ?? v.cands?.find(x => x.kind === held.kind && x.label.includes(held.label));
      if (!c) { await stop(); return {ok: false, error: `"${held.label}" is not on the page any more`} }
      v = await this.act([c]);
      // dec may still ask the person itself (its own confirmation): give them a minute.
      for (let i = 0; v.waiting === 'confirm' && i < 60; i++) { await sleep(1000); v = await look(v.did) }
      await stop();
      let page = {};
      try { page = await api('POST', `/v1/tabs/${tabId}/content`, {limit: 4000}) } catch {}
      return {ok: true, did: v.did, url: page.url ?? v.url, title: page.title ?? v.title, text: String(page.text ?? '')};
    },
  };
}
