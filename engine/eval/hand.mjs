// bisu's browser drivers with someone else choosing every step (a person, or Claude in a session) instead of
// Decisions and GLM: what the decider adds, on the same pages, controls and browsers. One server per browser keeps
// the tab between steps; every command, what it chose and what came back is a JSON line in the log.
//   node engine/eval/hand.mjs serve <dec|ego|aside> --port 7801 --log results/<day>/hand-<browser>.jsonl
//   node engine/eval/hand.mjs <port> start <task> <url> | do <n> | goto <url> | wait | text [from] | answer <text> | end
// "do n" runs the n-th of the actions listed with each look (the same list the loop picks from). Dec's fast mode must
// be off. Browsers are opened in the background; one that comes to the front is sent back.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as ego from '../ego.mjs';
import * as dec from '../dec.mjs';
import * as aside from '../aside.mjs';

const BROWSERS = /^(local\.dec\.browser|com\.citrolabs\.ego\.lite|at\.studio\.AsideBrowser.*)$/;
const front = () => { try { return execFileSync('lsappinfo', ['info', '-only', 'bundleid', execFileSync('lsappinfo', ['front']).toString().trim()]).toString().split('=').pop().replace(/"/g, '').trim() } catch { return '' } };
const refocus = was => { const now = front(); if (was && now !== was && BROWSERS.test(now) && !BROWSERS.test(was)) try { execFileSync('osascript', ['-e', `tell application id "${was}" to activate`]) } catch {} };

function serve(kind, port, logFile) {
  fs.mkdirSync(path.dirname(logFile), {recursive: true});
  const log = o => fs.appendFileSync(logFile, JSON.stringify({at: new Date().toISOString(), browser: kind, ...o}) + '\n');
  let driver = null, view = null, cands = [], task = null, t0 = 0, steps = 0, space = null, chose = null;
  const make = name => kind === 'dec' ? dec.directDriver() : kind === 'aside' ? aside.driver() : ego.egoDriver(space = `bisu-hand-${name}-${Date.now() % 1e5}`);
  const listOf = v => kind === 'dec' ? (v.cands || []).map((c, i) => ({...c, name: c.name || c.kind, n: i})) : ego._candidates(v, task?.goal || '').map((c, i) => ({...c, n: i}));
  const finish = async () => {
    if (!driver) return;
    try { await driver.end?.('done') } catch {}
    if (kind === 'dec' && driver.tabId) await dec.api('POST', `/v1/tabs/${driver.tabId}/close`, {agent: 'bisu'}).catch(() => {});
    if (kind === 'ego' && space) await ego.close(space).catch(() => {});
    driver = null; view = null; cands = [];
  };
  const show = (v, extra = '') => {
    if (v.ended) return `RUN ENDED (${v.status})${extra}`;
    if (v.waiting) return `WAITING FOR THE PERSON: ${v.waiting} ${v.why || ''}`;
    cands = listOf(v);
    const text = String(v.body || '').trim();
    return [`URL: ${v.url}`, `TITLE: ${v.title}`, `DID: ${(v.did || []).join(' / ') || '-'}`, '', 'ACTIONS:',
      ...cands.map(c => `[${c.n}] ${c.kind}: ${String(c.name).slice(0, 140)}`), '',
      `PAGE TEXT (${text.length} chars${text.length > 6000 ? ', first 6000 — "text 6000" for more' : ''}):`, text.slice(0, 6000)].join('\n') + extra;
  };
  const run = async (cmd, arg) => {
    if (cmd === 'start') {
      await finish();
      const [name, url, ...goal] = arg.split(' ');
      task = {name, url, goal: goal.join(' ')}; t0 = Date.now(); steps = 0;
      driver = make(name);
      view = await driver.open(url, [], task.goal);
      return show(view);
    }
    if (!driver && cmd !== 'end') return 'no task: start <task> <url> first';
    if (cmd === 'do') {
      const c = cands[Number(arg)];
      if (!c) return `no action [${arg}]`;
      steps++; chose = `${c.kind}: ${c.name}`;
      if (c.kind === 'done') return 'done is not a step here: say what you found with "answer <text>"';
      view = await driver.act([c]);
      return show(view);
    }
    if (cmd === 'goto') { steps++; view = await driver.goto(arg); return show(view) }
    if (cmd === 'wait') { view = await driver.wait(); return show(view) }
    if (cmd === 'text') {
      const all = kind === 'dec' ? await driver.readPage().catch(() => view.body) : String(view.body || '');
      const from = Number(arg) || 0;
      return `PAGE TEXT ${from}–${Math.min(all.length, from + 12000)} of ${all.length}:\n` + all.slice(from, from + 12000);
    }
    if (cmd === 'answer') { const r = {task: task.name, answer: arg, steps, ms: Date.now() - t0}; log({kind: 'answer', ...r}); await finish(); return `logged: ${JSON.stringify(r)}` }
    if (cmd === 'end') { await finish(); return 'ended' }
    return `unknown command ${cmd}`;
  };
  let busy = Promise.resolve();
  http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d });
    req.on('end', () => {
      busy = busy.then(async () => {
        const {cmd, arg = ''} = JSON.parse(body || '{}');
        const was = front(), t = Date.now();
        chose = null;
        let out, err = null;
        try { out = await run(cmd, arg) } catch (e) { err = String(e?.message || e).slice(0, 300); out = `ERROR: ${err}` }
        refocus(was);
        log({kind: 'step', task: task?.name, cmd, arg, chose, ms: Date.now() - t, url: view?.url, title: view?.title, did: view?.did, err, actions: cands.length});
        res.end(out);
      });
    });
  }).listen(port, '127.0.0.1', () => console.log(`hand ${kind} on ${port}, log ${logFile}`));
}

const [a0, ...rest] = process.argv.slice(2);
if (a0 === 'serve') {
  const flag = k => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : null };
  serve(rest[0], Number(flag('port') || 7801), flag('log') || `engine/eval/results/hand-${rest[0]}.jsonl`);
} else {
  const [cmd, ...arg] = rest;
  const r = await fetch(`http://127.0.0.1:${a0}/`, {method: 'POST', body: JSON.stringify({cmd, arg: arg.join(' ')})});
  console.log(await r.text());
}
