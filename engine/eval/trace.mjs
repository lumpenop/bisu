// One web task in one browser, with where the seconds went: every driver call timed, the loop's own log, and for
// dec its run timing (observe, settle, clicks, why a step-start read was not reused).
//   OPENAI_API_KEY=dec://OPENAI_API_KEY OPENROUTER_API_KEY=dec://OPENROUTER_API_KEY dec-secret run -- \
//     node engine/eval/trace.mjs <dec|ego|aside> <start url> <goal…>
// LOGW=1500 shows more of each log line (the notes a review got, for one).
import * as ego from '../ego.mjs';
import * as dec from '../dec.mjs';
import * as aside from '../aside.mjs';

const [mode, url, ...words] = process.argv.slice(2), goal = words.join(' ');
if (!['dec', 'ego', 'aside'].includes(mode) || !url || !goal) { console.error('usage: trace.mjs <dec|ego|aside> <url> <goal…>'); process.exit(2) }
const W = Number(process.env.LOGW || 160), T = [], t0 = Date.now();
const TIMED = ['open', 'act', 'goto', 'wait', 'readPage', 'end', 'acceptAlert'];
const timed = d => new Proxy(d, {get(o, k) {
  const f = o[k];
  if (typeof f !== 'function') return f;
  if (!TIMED.includes(k)) return f.bind(o);
  return async (...a) => { const t = Date.now(); try { return await f.apply(o, a) } finally { T.push(`${k}${k === 'act' ? `(${a[0].map(c => `${c.kind} ${String(c.label || '').slice(0, 24)}`).join(', ')})` : ''} ${Date.now() - t}ms`) } };
}});
const drv = mode === 'dec' ? dec.directDriver() : mode === 'aside' ? aside.driver() : ego.egoDriver(`bisu-trace-${Date.now() % 1e5}`);
const r = await ego.drive({goal, url, driver: timed(drv), budget: 20, log: x => T.push(`log ${JSON.stringify(x).slice(0, W)} @${Date.now() - t0}ms`)});
console.log(JSON.stringify({mode, s: (Date.now() - t0) / 1000, status: r.status, steps: r.steps, glm: r.reviews, answer: String(r.answer ?? '').slice(0, 200)}));
for (const l of T) console.log('  ' + l);
if (mode === 'dec') {
  try { const run = (await dec.api('GET', '/v1/runs/' + drv.id)).run; console.log('  dec timing ' + JSON.stringify(run.result?.timing ?? null)) } catch {}
  if (drv.tabId) await dec.api('POST', `/v1/tabs/${drv.tabId}/close`, {agent: 'bisu'}).catch(() => {});
}
if (mode === 'ego') await ego.close(drv.id).catch(() => {});
