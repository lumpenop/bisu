// The tools that make bisu an assistant rather than a coding agent: the web, memory, and doing
// things later. They write through the same modules the page uses (ui/memory.mjs, ui/jobs.mjs), so
// what the model saves is exactly what the Memory and Settings tabs show.
import fs from 'node:fs';
import path from 'node:path';
import * as memory from '../ui/memory.mjs';
import {DIR as JOBS_DIR, parseCron, nextRun} from '../ui/jobs.mjs';
import * as goals from '../ui/goals.mjs';
import * as bots from '../ui/bots.mjs';
import * as routines from '../ui/routines.mjs';

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
  // Bots (ui/bots.mjs): bisu for one job. Writing a bot file always waits for the person: kind 'bot' is
  // never cleared by the judge, and in Claude Code these are not pre-allowed, so the call is the preview card.
  bot_create: {
    description: 'Create a new bisu bot once you know its name and main job (from the bot-making conversation). The person sees a preview card and nothing is written until they press 만들기.',
    parameters: {type: 'object', properties: {
      name: {type: 'string', description: 'the bot name, in their language'},
      job: {type: 'string', description: 'its one main job, one sentence'},
      cwd: {type: 'string', description: 'the folder it works in (default ~)'},
      instructions: {type: 'string', description: 'how it should work, in their words, as short lines'},
      tone: {type: 'string', description: 'how it talks, e.g. 존댓말, 짧게'},
    }, required: ['name', 'job']},
    kind: 'bot',
    run(ctx, {name, job, cwd = '~', instructions = '', tone = ''}) {
      try { const b = bots.create({name, job, cwd, instructions, tone}); return ok(`Created the bot "${b.name}" (id ${b.id}). They can pick it in the sidebar.`) }
      catch (e) { return err(e.message) }
    },
  },
  bot_update: {
    description: 'Change a bot the person already has (its name, job, folder, way of working or tone). Shows them a preview card first.',
    parameters: {type: 'object', properties: {
      id: {type: 'string', description: 'the bot id'},
      name: {type: 'string'}, job: {type: 'string'}, cwd: {type: 'string'}, instructions: {type: 'string'}, tone: {type: 'string'},
    }, required: ['id']},
    kind: 'bot',
    run(ctx, {id, ...patch}) {
      try { const b = bots.update(id, patch); return ok(`Updated the bot "${b.name}".`) }
      catch (e) { return err(e.message) }
    },
  },
  routine_save: {
    description: 'Save what was just done well as a routine of this bot, when the person asks ("루틴으로 저장해"): the steps that worked as short lines, the values that change each time as inputs (write them as {이름} inside the steps), and tools: read if it only looked, edit if it changed files, full if it ran commands. They see a preview card first.',
    parameters: {type: 'object', properties: {
      name: {type: 'string', description: 'the routine name, in their language'},
      steps: {type: 'array', items: {type: 'string'}, description: 'one short line per step, in order'},
      inputs: {type: 'array', items: {type: 'string'}, description: 'names of the values that change each run'},
      tools: {type: 'string', enum: ['read', 'edit', 'full']},
    }, required: ['name', 'steps']},
    kind: 'bot',
    run(ctx, {name, steps, inputs = [], tools = 'read'}) {
      try { const r = routines.save({name, steps, inputs, tools, bot: process.env.BISU_BOT || 'bisu'}); return ok(`Saved the routine "${r.name}" (${r.slug}). It is in 루틴, where it can be run, paused or scheduled.`) }
      catch (e) { return err(e.message) }
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
      // A bot's own job runs as that bot (BISU_BOT is set for its conversations).
      const bot = /^[a-z0-9][a-z0-9-]{0,39}$/.test(process.env.BISU_BOT || '') && process.env.BISU_BOT !== 'bisu' ? `bot: ${process.env.BISU_BOT}\n` : '';
      fs.writeFileSync(file, `---\nname: ${String(name).replace(/\n/g, ' ')}\n${cron ? `schedule: ${cron}` : `at: ${at}`}\ncwd: ${folder}\ntools: ${tools}\n${bot}---\n${String(request).trim()}\n`);
      const when = cron ? (() => { const t = nextRun(parseCron(cron)); return t ? new Date(t).toLocaleString('ko-KR', {dateStyle: 'medium', timeStyle: 'short'}) : '?' })() : at;
      return ok(`${existed ? 'Updated' : 'Created'} the job "${name}" (${s}). Next run: ${when}.${tools !== 'read' ? ' It can change things, so it waits until they approve it in Settings → 예약 작업.' : ''}`);
    },
  },
  // Goals (ui/goals.mjs): what they want done over days or weeks, worked on by bisu a little at a time.
  goal_add: {
    description: 'Take on something they want done over days or weeks ("이번 달 안에 …", "출장 준비 챙겨줘", "매주 블로그 한 편"): bisu then works on it by itself every few hours — plans it, does what can be done (research, notes, reminders, events), and asks them when it needs a decision. Not for one task to do now (do it) or a fixed repeating task (schedule_job).',
    parameters: {type: 'object', properties: {
      title: {type: 'string', description: 'the goal in one line, in their language'},
      detail: {type: 'string', description: 'what done looks like, and anything they said that matters'},
      due: {type: 'string', description: 'YYYY-MM-DD, if there is a deadline'},
      every_hours: {type: 'integer', description: 'how often to work on it, default 6'},
      cwd: {type: 'string', description: 'a folder it is about, if any (default: home)'},
    }, required: ['title']},
    kind: 'memory',
    run(ctx, {title, detail, due, every_hours, cwd}) {
      try {
        const g = goals.create({title, detail, due, every: every_hours, cwd: cwd ? path.resolve(ctx.cwd, String(cwd).replace(/^~(?=\/|$)/, process.env.HOME || '')) : ''});
        return ok(`Took on the goal "${g.title}" (${g.id}). The first session starts within a few minutes (outside quiet hours); it shows under 목표 with its plan, and asks them when it needs something.`);
      } catch (e) { return err(`Could not add the goal: ${e.message}`) }
    },
  },
  goal_list: {
    description: 'Their goals and where each stands: plan, what was done lately, any question waiting for them.',
    parameters: {type: 'object', properties: {}},
    kind: 'memory',
    run() {
      const list = goals.all();
      if (!list.length) return ok('No goals yet.');
      const S = {active: '진행 중', waiting: '답을 기다림', paused: '멈춤', done: '달성'};
      return ok(list.map(g => `${g.id} · ${S[g.status]} · ${g.title}${g.due ? ` · 기한 ${g.due}` : ''}\n계획 ${g.steps.filter(s => s.status === 'done').length}/${g.steps.length}: ${g.steps.map(s => `${s.status === 'done' ? '✓' : '·'} ${s.text}`).join(' / ') || '(아직 없음)'}${g.log.length ? `\n최근: ${g.log[g.log.length - 1].text}` : ''}${g.question ? `\n묻는 것: ${g.question.text}` : ''}`).join('\n\n'));
    },
  },
  goal_update: {
    description: 'Write down this session\'s work on the goal — id alone saves nothing. steps: the whole plan every time, one step per line with its state ("1. [x] 항공권 비교 — 피치 21만 원" / "[ ]" to do, "[~]" doing, "[!]" blocked), or an array of {text, status}. log: one line of what you did now. notes: the whole notes text (replaces the old). question: when only the person can unblock it. done: true when reached. next_hours: to look again sooner or later.',
    parameters: {type: 'object', properties: {
      id: {type: 'string'},
      steps: {type: 'string', description: 'the whole plan, one step per line: "1. [x] text — note"'},
      log: {type: 'string', description: 'one or two lines: what you did in this session'},
      notes: {type: 'string', description: 'what you found and keep for later: options, links, numbers, drafts'},
      question: {type: 'string', description: 'one question for the person; the goal waits until they answer'},
      done: {type: 'boolean'},
      next_hours: {type: 'number'},
    }, required: ['id']},
    kind: 'memory',
    run(ctx, args) {
      // A goal run may only write its own goal.
      if (process.env.BISU_GOAL_ID && args.id !== process.env.BISU_GOAL_ID) return err(`This session works on ${process.env.BISU_GOAL_ID}; it cannot change ${args.id}.`);
      try { return ok(`Saved: ${goals.applyUpdate(args.id, args).join(', ') || 'nothing changed'}.`) } catch (e) { return err(e.message) }
    },
  },
};
