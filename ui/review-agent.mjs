#!/usr/bin/env node
// SubagentStop hook for bisu ui chats: before a worker's report reaches bisu, the judge reads it against
// the brief and against what the worker actually did (engine/judge.mjs reviewReport). If something
// asked for looks missing, failed or unbacked, the worker is sent on once with that note — Claude Code
// lets a stop hook block the stop, and stop_hook_active keeps it to one round. A report that ends in a
// question for the person (질문: …) goes through: that is bisu's to answer.
//
// Each judgment is appended to ~/Library/Application Support/bisu/reviews.jsonl, so the threshold can
// be checked against real reports later.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as judge from '../engine/judge.mjs';

const LOG = path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'reviews.jsonl');
const text = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

// The brief (first message), any feedback sent with SendMessage since (the last other message from
// bisu), and every call with its result, from the worker's own transcript.
export function readTranscript(file) {
  const asks = [], actions = [], calls = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line) } catch { continue }
    const content = j.message?.content;
    if (j.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_use') calls.set(b.id, b);
    } else if (j.type === 'user') {
      const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : [];
      for (const r of results) {
        const c = calls.get(r.tool_use_id);
        actions.push({name: c?.name || '?', args: JSON.stringify(c?.input ?? {}).slice(0, 200), ok: !r.is_error,
          result: (typeof r.content === 'string' ? r.content : text(r.content)).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 240)});
      }
      if (!results.length && text(content).trim()) asks.push(text(content).trim());
    }
  }
  return {brief: asks[0] || '', feedback: asks.length > 1 ? asks[asks.length - 1] : '', actions};
}

export function reason(p) {
  if (p >= judge.REVIEW.short) return '검토(bisu): 보고와 실제로 한 일을 맞춰 보면, 맡긴 일 중 빠졌거나 실패했거나 확인되지 않은 게 있어 보여. 맡긴 일을 항목마다 다시 확인해서 빠진 건 마저 하고, 할 수 없는 건 왜 못 했는지 보고에 적어. 그다음 다시 짧게 보고해.';
  if (p >= judge.REVIEW.unsure) return '검토(bisu): 맡긴 일 중 일부가 빠졌을 수 있어. 항목마다 결과를 직접 확인하고, 보고에 항목별로 됐는지 적어서 다시 짧게 보고해.';
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  let s = '';
  process.stdin.on('data', d => s += d).on('end', async () => {
    let j; try { j = JSON.parse(s) } catch { return }
    const report = String(j.last_assistant_message || '');
    if (j.stop_hook_active || !j.agent_transcript_path || /(^|\n)\s*질문\s*:/.test(report) || !judge.available()) return;
    let t; try { t = readTranscript(j.agent_transcript_path) } catch { return }
    if (!t.brief) return;
    const p = await judge.reviewReport(t.brief, t.actions, report, {feedback: t.feedback});
    try { fs.appendFileSync(LOG, JSON.stringify({at: Date.now(), agent: j.agent_type, id: j.agent_id, p, calls: t.actions.length, brief: t.brief.slice(0, 200), report: report.slice(0, 300)}) + '\n') } catch {}
    const why = p == null ? null : reason(p);
    if (why) process.stdout.write(JSON.stringify({decision: 'block', reason: why}));
  });
}
