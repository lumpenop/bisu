// The tools that make bisu an assistant rather than a coding agent: the web, memory, and doing
// things later. They write through the same modules the page uses (ui/memory.mjs, ui/jobs.mjs), so
// what the model saves is exactly what the Memory and Settings tabs show.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import * as memory from '../ui/memory.mjs';
import {DIR as JOBS_DIR, parseCron, nextRun} from '../ui/jobs.mjs';
import * as goals from '../ui/goals.mjs';
import * as bots from '../ui/bots.mjs';
import * as routines from '../ui/routines.mjs';

const ok = text => ({text});
const err = text => ({text, error: true});
export const isDefaultBot = () => !process.env.BISU_BOT || process.env.BISU_BOT === bots.DEFAULT;

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
  // Fewer, fuller memories. The assistant reads the whole folder and says which memories are about one
  // thing; kind 'bot' means the card always asks, so the person sees the result before anything is
  // written. ui/memory.mjs compact() keeps the old files under .compacted/ and never touches a pinned one.
  memory_compact: {
    description: 'Tidy memory when it has grown or when they ask (기억 정리): merge the memories that are about one subject into one each, and drop those that are out of date. Read every memory first (the Memory block, and the folder when some did not fit). Each merge: from (the titles or ids of the memories it replaces) and into {title, text, key?} holding every fact from them that still holds, in their language, no longer than needed. drop: titles or ids that are plainly superseded. Pinned memories stay as they are. The person sees the result on a card and decides.',
    parameters: {type: 'object', properties: {
      merge: {type: 'array', items: {type: 'object', properties: {
        from: {type: 'array', items: {type: 'string'}, description: 'titles or ids of the memories this one replaces'},
        into: {type: 'object', properties: {title: {type: 'string'}, text: {type: 'string'}, key: {type: 'string'}}, required: ['title', 'text']},
      }, required: ['from', 'into']}},
      drop: {type: 'array', items: {type: 'string'}, description: 'titles or ids of memories that are out of date'},
    }},
    kind: 'bot',
    run(ctx, {merge = [], drop = []} = {}) {
      try {
        const r = memory.compact({merge, drop});
        return ok(`Compacted: ${r.compacted.retired.length} memories became ${r.compacted.wrote.length} (${r.entries.length} in all, ${r.used} of ${r.budget} characters sent). The old files are kept in ${r.compacted.backup.replace(process.env.HOME || '', '~')}. It applies from the next conversation.`);
      } catch (e) { return err(`Could not compact: ${e.message}`) }
    },
  },
  // Only the default bot (the assistant) is given this (engine/cli.mjs, ui/cu/server.mjs): the other bots
  // see their own memory in their prompt and nothing of each other's, and workers have no memory tools.
  bot_memory: {
    description: 'What another of the person\'s bots has saved to remember (its memory): read it when they ask about that bot or when what it knows bears on the task. Give the bot\'s name or id; with none, lists the bots and how much each has saved. Read only.',
    parameters: {type: 'object', properties: {bot: {type: 'string', description: 'the bot\'s name or id; omit for the list'}}},
    kind: 'memory',
    run(ctx, {bot} = {}) {
      if (!isDefaultBot()) return err('Only the default bot reads other bots\' memories.');
      const others = () => bots.list().filter(b => !b.default);
      if (!bot) {
        const rows = others().map(b => { const n = bots.memoryCount(b.id); return `${b.name} (${b.id}) · ${n ? `${n} saved` : 'nothing saved'}` });
        return ok(rows.length ? rows.join('\n') : 'The person has no other bots.');
      }
      const r = bots.memoryOf(bot);
      if (!r) return err(`No bot named "${bot}". Bots: ${others().map(b => `${b.name} (${b.id})`).join(', ') || 'none'}.`);
      if (r.bot.default) return err('That is this bot: its memory is the "Memory (기억)" block in your prompt.');
      if (!r.entries.length) return ok(`${r.bot.name} has saved nothing to remember.`);
      let text = `${r.bot.name} (${r.bot.id}) remembers, pinned first then newest:\n\n`;
      for (const e of r.entries) {
        const block = `### ${e.title}\n${e.text || '(no detail)'}\n\n`;
        if (text.length + block.length > 4000) { text += `(${r.entries.length} in all; the rest are in ${memory.dirFor(r.bot.id).replace(process.env.HOME || '', '~')})`; break }
        text += block;
      }
      return ok(text.trimEnd());
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
  // Another bot does it with its own instructions, folder and memory; its answer comes back to this chat as a
  // message, and its approvals show here. Only in a bisu ui chat (the server holds the chats).
  bot_handoff: {
    description: 'Hand a task to another of the person\'s bots ("@리서치 봇 …", or when another bot\'s job fits better). Give one complete brief. It works in its own chat; its result comes back to this conversation as a message, so end your turn after handing off.',
    parameters: {type: 'object', properties: {
      bot: {type: 'string', description: 'the other bot\'s name or id'},
      task: {type: 'string', description: 'the whole brief: what to do, the files or facts it needs, and what done looks like'},
    }, required: ['bot', 'task']},
    kind: 'delegate',
    async run(ctx, {bot, task}) {
      const key = process.env.BISU_HANDOFF_KEY, chat = process.env.BISU_CHAT_ID;
      if (!key || !chat) return err('Handing work to another bot works only in a bisu ui conversation.');
      const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'bisu', 'handoff');
      const id = randomUUID(), file = path.join(dir, `${id}.json`), res = path.join(dir, `${id}.res.json`);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(file, JSON.stringify({key, chat, bot, task, at: Date.now()}), {mode: 0o600});
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        let a = null; try { a = JSON.parse(fs.readFileSync(res, 'utf8')) } catch { continue }
        fs.rmSync(res, {force: true});
        return a.ok ? ok(`Handed to ${a.bot}. Its answer will come back to this conversation as a message; tell the person in one line who is on it, then end your turn.`) : err(a.error);
      }
      fs.rmSync(file, {force: true});
      return err('bisu did not pick up the handoff (is the bisu window running?).');
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
      try { const r = routines.save({name, steps, inputs, tools, bot: process.env.BISU_BOT || 'bisu', source: process.env.BISU_TEACH === '1' ? 'teach' : ''}); return ok(`Saved the routine "${r.name}" (${r.slug}). It is in 루틴, where it can be run, paused or scheduled.`) }
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
