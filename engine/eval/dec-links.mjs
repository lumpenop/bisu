// Every item link on one list page, clicked through dec with no model: which clicks dec had to open again by their
// address (its audit's link-address-opened, with the first verdict and where the click had left the tab). A wrapped
// title once had its box centre between its lines, and three books in ten were reopened.
//   node engine/eval/dec-links.mjs [list url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dec from '../dec.mjs';

const AUDIT = path.join(os.homedir(), 'Library/Application Support/Dec Browser/ai-audit');
const url = process.argv[2] || 'https://books.toscrape.com/catalogue/category/books/humor_30/index.html';
const newest = () => fs.readdirSync(AUDIT).filter(f => f.endsWith('.jsonl')).map(f => [f, fs.statSync(path.join(AUDIT, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0];
const d = dec.directDriver();
let v = await d.open(url, [], 'open an item');
// An item: a link whose name is a line of the page with a price just under it.
const lines = v.body.split('\n').map(l => l.trim());
const items = [...new Set(v.cands.filter(c => c.kind === 'click').map(c => c.label))].filter(t => lines.some((l, i) => l === t && /[£$€₩]\s?\d/.test(lines.slice(i + 1, i + 4).join(' '))));
let reopened = 0;
for (const [i, t] of items.entries()) {
  if (i) v = await d.goto(url);
  const c = v.cands.find(x => x.kind === 'click' && x.label === t), t0 = Date.now(), w = await d.act([c]), ms = Date.now() - t0;
  const f = newest(), r = f ? fs.readFileSync(path.join(AUDIT, f), 'utf8').split('\n').filter(l => l.includes('link-address-opened')).map(l => JSON.parse(l)) : [];
  if (r.length) reopened++;
  console.log(String(i).padStart(2), r.length ? `REOPENED (${r[0].first}, left at ${r[0].clickLanded || '?'})` : 'ok', `${ms}ms`, t.slice(0, 40), '→', String(w.url).slice(-40));
}
console.log(`${reopened} of ${items.length} reopened`);
await d.end();
await dec.api('POST', `/v1/tabs/${d.tabId}/close`, {agent: 'bisu'}).catch(() => {});
