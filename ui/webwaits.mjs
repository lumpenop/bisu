// dec runs a chat left waiting (the person had to confirm a step or sign in, or it simply ran long): engine/browser.mjs
// writes one file per run, this checks them every few seconds and hands each ended run to the page, which tells the
// chat that asked (so dec-intern reports the result, on Telegram too when that is where the chat lives).
import fs from 'node:fs';
import path from 'node:path';
import * as dec from '../engine/dec.mjs';
import {WAITS} from '../engine/browser.mjs';

const KEEP_MS = 3 * 3600_000;
let timer = null, busy = false;

async function tick(onEnd) {
  if (busy) return;
  busy = true;
  try {
    let files = [];
    try { files = fs.readdirSync(WAITS).filter(f => f.endsWith('.json')) } catch { return }
    for (const f of files) {
      const file = path.join(WAITS, f);
      let w;
      try { w = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fs.rmSync(file, {force: true}); continue }
      if (Date.now() - w.at > KEEP_MS) { fs.rmSync(file, {force: true}); continue }
      let v;
      try { v = await dec.state(w.runId) } catch (e) { if (e.code === 'RUN_NOT_FOUND') fs.rmSync(file, {force: true}); continue }
      if (!v.ended) continue;
      fs.rmSync(file, {force: true});
      const r = await dec.finish(v, w.tabId, path.join(path.dirname(WAITS), 'web')).catch(() => v);
      try { onEnd(w, r) } catch {}
    }
  } finally { busy = false }
}

export function start(onEnd, everyMs = 5000) {
  if (timer) return;
  timer = setInterval(() => { tick(onEnd) }, everyMs);
  timer.unref?.();
}
export function stop() { clearInterval(timer); timer = null }
