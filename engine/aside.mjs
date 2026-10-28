// Aside driven by bisu itself, through the REPL its CLI opens (`aside repl`: Playwright-style JavaScript in the
// person's Aside, signed in as they are). One REPL per task keeps its refs between steps; a step is the action and
// a fresh snapshot in one round trip. Aside's snapshot already covers the whole page, off screen included, so
// nothing scrolls. The snapshot (Playwright's aria tree) is rewritten into ego's format for the shared loop
// (engine/ego.mjs drive()), which picks the steps with Decisions and GLM on trouble, and holds risky ones.
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BIN = () => process.env.BISU_ASIDE_BIN || path.join(os.homedir(), '.local', 'bin', 'aside');
const quote = v => JSON.stringify(String(v));

// "- link "Travel" [ref=e4]:" → "  link "Travel" [ref=e4]"; "- text: "…"" → "  text "…""; "- paragraph: "…"" → the role
// with the text under it. Also returns what ego's snapshot leaves to page scripts: checkbox states and select options.
export function toEgo(tree) {
  const out = [], boxes = [], selects = [];
  let sel = null;
  for (const raw of String(tree || '').split('\n')) {
    const m = /^(\s*)- (.*?):?\s*$/.exec(raw);
    if (!m) continue;
    const ind = m[1], body = m[2];
    if (/^\/url:|^\/placeholder:/.test(body)) continue;
    const t = /^text: (".*")$/.exec(body);
    if (t) { out.push(`${ind}text ${t[1]}`); continue }
    const r = /^([a-z_]+)(?: (".*?(?<!\\)"))?((?: \[[^\]]*\])*)(?:: (".*"|[^"].*))?$/i.exec(body);
    if (!r) continue;
    const [, role, name = '', attrsRaw = '', inline] = r;
    const attrs = [...attrsRaw.matchAll(/\[([^\]]*)\]/g)].map(a => a[1]);
    const ref = attrs.find(a => /^ref=/.test(a));
    out.push(`${ind}${role}${name ? ' ' + name : ''}${ref ? ` [${ref}]` : ''}`);
    if (inline) out.push(`${ind}  text ${/^"/.test(inline) ? inline : quote(inline)}`);
    if (role === 'checkbox' || role === 'radio') boxes.push(attrs.includes('checked') || attrs.includes('checked=true'));
    if (role === 'combobox') { sel = {name: '', label: name ? JSON.parse(name) : '', options: [], value: '', depth: ind.length}; selects.push(sel) }
    else if (role === 'option' && sel && ind.length > sel.depth) { const o = name ? JSON.parse(name) : ''; sel.options.push(o); if (attrs.includes('selected')) sel.value = o }
    else if (sel && ind.length <= sel.depth) sel = null;
  }
  return {snap: out.join('\n'), boxes, selects};
}

// One REPL session: code in, everything it printed out, a marker telling where a call ends.
function repl() {
  const c = spawn(BIN(), ['repl'], {stdio: ['pipe', 'pipe', 'pipe'], env: process.env});
  let buf = '', n = 0, dead = null;
  c.stdout.on('data', d => { buf += d }); c.stderr.on('data', d => { buf += d });
  c.on('exit', code => { dead = `aside repl ended (${code})` });
  return {
    async run(code, timeoutMs = 120_000) {
      if (dead) throw Error(dead);
      const mark = `@@END${++n}@@`;
      // The REPL reads a line per call.
      c.stdin.write(`${code.replace(/\n/g, ' ')}; console.log(${quote(mark)})\n`);
      for (const end = Date.now() + timeoutMs; !buf.includes(mark); await new Promise(r => setTimeout(r, 25))) {
        if (dead) throw Error(dead);
        if (Date.now() > end) throw Error('aside repl timed out');
      }
      const i = buf.indexOf(mark), out = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '');
      if (process.env.BISU_ASIDE_DEBUG) process.stderr.write(`[aside] ${out.slice(-1500)}\n`);
      buf = buf.slice(i + mark.length);
      return out;
    },
    close() { try { c.stdin.end(); c.kill() } catch {} },
  };
}

// The look at the end of every call: url, title and the whole tree, as one JSON line.
// (and the page's own text: a long page's tree can stop short of what the goal asks — the 250th country)
const LOOK = `const sn = await snapshot(page); const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 30000)).catch(() => ''); console.log('@@BISU ' + JSON.stringify({url: page.url(), title: await page.title(), tree: sn.tree, text, did}))`;

function viewOf(out) {
  // The REPL prints its prompt ("repl > ") in front of what the next call prints.
  const line = out.split('\n').reverse().find(l => l.includes('@@BISU '));
  if (!line) throw Error(out.split('\n').find(l => /error|Error/.test(l))?.trim() || 'aside did not answer');
  const v = JSON.parse(line.slice(line.indexOf('@@BISU ') + 7));
  const e = toEgo(v.tree);
  // The tree is the whole page, so it is also the text the loop searches for answers off screen.
  const body = v.text || [...v.tree.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return {...e, url: v.url, title: v.title, did: v.did || [], y: 0, maxY: 0, body};
}

function step(c) {
  const at = `page.locator(${quote(String(c.ref || '').replace(/^@/, ''))})`;
  if (c.kind === 'click') return `await ${at}.click(); did.push(${quote('clicked ' + c.label)});`;
  if (c.kind === 'type') return `await ${at}.fill(${quote(c.value)}); did.push(${quote('typed into ' + c.label)});`;
  if (c.kind === 'select') return `await ${at}.selectOption({label: ${quote(c.value)}}); did.push(${quote(`chose ${c.value} in ${c.label}`)});`;
  if (c.kind === 'key') return `await ${at}.press(${quote(c.key || 'Enter')}); did.push('pressed Enter');`;
  if (c.kind === 'back') return `await page.goBack(); did.push('went back');`;
  if (c.kind === 'goto') return `await page.goto(${quote(c.url)}); did.push(${quote('opened ' + c.url)});`;
  return '';
}

export function driver() {
  const r = repl();
  let tab = null;
  const call = async body => viewOf(await r.run(`await (async () => { const did = []; try { ${body} } catch (e) { did.push('error: ' + String(e?.message || e).split('\\n')[0].slice(0, 200)) } ${LOOK} })()`));
  return {
    get id() { return tab },
    async open(url) { const v = await call(`await openTab(${quote(url)}); did.push(${quote('opened ' + url)});`); tab = v.url; return v },
    act: cs => call(cs.map(step).join(' ')),
    goto: url => call(step({kind: 'goto', url})),
    acceptAlert: () => call(''),
    wait: () => call('await page.waitForTimeout(1500);'),
    async end() { try { await r.run('await closeTab(page)', 15_000) } catch {} r.close() },
  };
}
