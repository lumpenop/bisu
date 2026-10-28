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
      if (e.code === 'RATE_LIMITED' && i < 3) { await sleep(Math.min(10, Number(e.retryAfter) || 5) * 1000); continue }
      throw e;
    }
  }
}

const running = () => new Promise(r => execFile('/usr/bin/pgrep', ['-f', 'Dec Browser.app/Contents/MacOS/'], e => r(!e)));

// dec's status, starting dec in the background first when it is installed but not running. Null when there is no
// dec to use: not installed, or running with its agent endpoint switched off.
export async function up({start = true, waitMs = 25_000} = {}) {
  if (process.env.BISU_DEC === '0') return null;
  try { return await api('GET', '/v1/status') } catch (e) { if (!['DEC_OFF', 'DEC_UNREACHABLE'].includes(e.code)) throw e }
  if (!start || await running()) return null;
  // -g: dec comes up behind whatever the person is doing.
  const opened = await new Promise(r => execFile('/usr/bin/open', ['-g', '-b', BUNDLE], e => r(!e)));
  if (!opened) return null;
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await sleep(1000);
    try { return await api('GET', '/v1/status') } catch {}
  }
  return null;
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
  for (let i = 0; i < 50; i++) { const t = tabsOf(await api('GET', '/v1/tabs')).find(x => x.id === tabId); if (t && t.loading === false) break; await sleep(200) }
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
