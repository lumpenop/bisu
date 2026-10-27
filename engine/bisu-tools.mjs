// The tools that make bisu an assistant rather than a coding agent: the web, memory, and doing
// things later. They write through the same modules the page uses (ui/memory.mjs, ui/jobs.mjs), so
// what the model saves is exactly what the Memory and Settings tabs show.
import fs from 'node:fs';
import path from 'node:path';
import * as memory from '../ui/memory.mjs';
import {DIR as JOBS_DIR, parseCron, nextRun} from '../ui/jobs.mjs';

const ok = text => ({text});
const err = text => ({text, error: true});

export const BISU_TOOLS = {
  web_search: {
    description: 'Search the web for current information. Returns titles, links, dates and snippets; read a promising page with web_fetch.',
    parameters: {type: 'object', properties: {query: {type: 'string'}, count: {type: 'integer', description: 'results, default 6, at most 10'}}, required: ['query']},
    kind: 'net',
    async run(ctx, {query, count = 6}) {
      const base = (process.env.GLM_BASE_URL || 'https://api.z.ai').replace(/\/$/, '') + '/api/paas/v4';
      const r = await fetch(base + '/web_search', {
        method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(ctx.signal ? [ctx.signal] : [])]),
        headers: {authorization: 'Bearer ' + (process.env.GLM_API_KEY || ''), 'content-type': 'application/json'},
        body: JSON.stringify({search_engine: 'search-prime', search_query: String(query).slice(0, 300), count: Math.min(10, Math.max(1, count | 0 || 6))}),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return err(`Search failed (${r.status}): ${j?.error?.message || ''}`);
      const items = j?.search_result || [];
      if (!items.length) return ok(`No results for "${query}".`);
      return ok(items.map((x, i) => `${i + 1}. ${x.title || '(untitled)'}${x.publish_date ? ` · ${x.publish_date}` : ''}\n   ${x.link}\n   ${String(x.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n'));
    },
  },
  remember: {
    description: 'Save something to remember in every future conversation: how they want answers, their name, a project, a correction. Give a stable key for a subject you might update later (e.g. "reply-style"); saving the same key again replaces it.',
    parameters: {type: 'object', properties: {
      title: {type: 'string', description: 'short title in their language'},
      text: {type: 'string', description: 'the fact, one or two sentences in their language'},
      key: {type: 'string', description: 'stable subject key, e.g. reply-style, user-name'},
    }, required: ['title', 'text']},
    kind: 'memory',
    run(ctx, {title, text, key}) {
      try {
        const r = memory.save({title, body: text, ...(key ? {key} : {})});
        return ok(r.updatedInPlace ? `Updated the memory "${r.updatedInPlace.title}". It applies from the next conversation.` : `Saved "${title}". It applies from the next conversation.`);
      } catch (e) {
        if (e.holder) {
          const h = memory.list().find(x => x.id === e.holder);
          const r = memory.save({id: e.holder, title, body: text});
          return ok(`Updated the memory "${h?.title || title}" (same subject). It applies from the next conversation.${r ? '' : ''}`);
        }
        return err(`Could not save: ${e.message}`);
      }
    },
  },
  forget: {
    description: 'Delete a saved memory, found by its key or title, when they ask you to forget it.',
    parameters: {type: 'object', properties: {key: {type: 'string'}, title: {type: 'string'}}},
    kind: 'memory',
    run(ctx, {key, title}) {
      const all = memory.list();
      const hit = all.find(e => key && e.key === key) || all.find(e => title && e.title === title) || all.find(e => title && e.title.includes(title));
      if (!hit) return err(`No memory matches ${key ? `key "${key}"` : `"${title}"`}. Saved: ${all.map(e => e.title).join(', ') || 'none'}.`);
      memory.remove(hit.id);
      return ok(`Forgot "${hit.title}".`);
    },
  },
  schedule_job: {
    description: 'Do something later or on a schedule, as a scheduled job whose answer appears as a card. Use cron (five fields, local time) for repeating, or at for once. tools: read (default) only looks; edit may change files in cwd; full may also run commands — edit/full wait for the person to approve the job in Settings.',
    parameters: {type: 'object', properties: {
      slug: {type: 'string', description: 'short ascii file name, e.g. morning-summary'},
      name: {type: 'string', description: 'title in their language'},
      cron: {type: 'string', description: 'e.g. "0 8 * * 1-5" for weekdays at 8:00'},
      at: {type: 'string', description: 'one time, "2026-10-28 09:00"'},
      cwd: {type: 'string', description: 'the folder it is about (default: the current folder)'},
      tools: {type: 'string', enum: ['read', 'edit', 'full']},
      request: {type: 'string', description: 'what to do then, written for a future run that knows nothing about this conversation'},
    }, required: ['slug', 'name', 'request']},
    kind: 'memory',
    run(ctx, {slug, name, cron, at, cwd, tools = 'read', request}) {
      const s = String(slug || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      if (!s) return err('slug must be a short ascii name.');
      if (!cron && !at) return err('Give cron (repeating) or at (once).');
      if (cron) { try { const t = nextRun(parseCron(cron)); if (!t) return err('That schedule never fires.') } catch (e) { return err(`cron: ${e.message}`) } }
      const folder = cwd ? path.resolve(ctx.cwd, cwd.replace(/^~(?=\/|$)/, process.env.HOME || '')) : ctx.cwd;
      const file = path.join(JOBS_DIR, `${s}.md`);
      const existed = fs.existsSync(file);
      fs.mkdirSync(JOBS_DIR, {recursive: true});
      fs.writeFileSync(file, `---\nname: ${String(name).replace(/\n/g, ' ')}\n${cron ? `schedule: ${cron}` : `at: ${at}`}\ncwd: ${folder}\ntools: ${tools}\n---\n${String(request).trim()}\n`);
      const when = cron ? (() => { const t = nextRun(parseCron(cron)); return t ? new Date(t).toLocaleString('ko-KR', {dateStyle: 'medium', timeStyle: 'short'}) : '?' })() : at;
      return ok(`${existed ? 'Updated' : 'Created'} the job "${name}" (${s}). Next run: ${when}.${tools !== 'read' ? ' It can change things, so it waits until they approve it in Settings → 예약 작업.' : ''}`);
    },
  },
};
