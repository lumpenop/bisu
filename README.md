# bisu (비서)

**"OpenClaude"-style setup: Claude Code, open to any model.**

Run **Claude Code** as a cheap autonomous sidekick on **OpenRouter** models (DeepSeek, Qwen, …) — while your real Claude subscription stays untouched for the work that deserves it.

`bisu` is one shell function. Your normal `claude` keeps using your Anthropic subscription; `bisu` opens the same CLI wired to OpenRouter, so it can grind through repetitive edits, formatting, and assistant chores for pennies.

```
claude   → your Anthropic subscription (design, hard problems)
bisu     → OpenRouter pay-per-token (grunt work, assistant duty)
```

## Install

```sh
git clone <this repo> && cd bisu && sh install.sh
```

Requires [Claude Code](https://code.claude.com) and zsh.

## Give it a key — two ways

**Plain (quick start):**

```sh
export OPENROUTER_API_KEY=sk-or-...   # in ~/.zshrc
bisu
```

**Use-only (recommended):** if your machine has a secret manager exposing the `dec-secret` CLI, save the key there with the site `https://openrouter.ai` (any name). `bisu` detects it automatically and the real key is **never placed in any process environment** — the CLI only ever sees a one-time token, and a signed helper injects the key when the request leaves for openrouter.ai. Nothing to leak in logs, env dumps, or the model's own context.

## Models: one per role, delegated automatically

The main model is the assistant: it talks with you, decides, delegates and checks results, but doesn't write code itself. Development goes to subagents defined in [agents.json](agents.json), with the rules in [prompt.md](prompt.md).

| Role | Agent | Default | Override |
|---|---|---|---|
| Assistant: conversation, decisions, delegation, checking results | main | `z-ai/glm-5.3` | `BISU_MODEL` |
| Development: writing, fixing and debugging code, tests, scripts, most hands-on work | `developer` | `deepseek/deepseek-v4.1-flash` | `BISU_DEV_MODEL` |
| Large publishing (pages, many components) and large refactors | `publisher`, `refactorer` | `qwen/qwen3.8-max-0902` | `BISU_CODE_MODEL` |

```sh
bisu                                          # all defaults
BISU_DEV_MODEL=qwen/qwen3-coder-next bisu     # any OpenRouter slug per role
```

`BISU_FAST_MODEL`, the old name of `BISU_DEV_MODEL`, still works. Each handoff starts a subagent (about 2 s before it acts) and the assistant then checks the result, so a delegated task takes a few seconds longer than doing it in one model.

These subagents exist only inside `bisu`; your normal `claude` never sees them.

## Lean and brief by default

- **Core tools only, no MCP:** `bisu` keeps what a coding sidekick needs and drops the rest, cutting every request from ~25k to ~6.8k input tokens (about a quarter of the cost; with DeepSeek flash the API time per request went from ~3.2 s to ~1.8 s).
  - Kept: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, and `Task` for the developer / publisher / refactorer subagents.
  - Plus bisu's own MCP server: `session_search` / `session_show` (below) and the `cu_*` computer-use tools (`bisu app`).
  - Dropped: scheduling and background work (`CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `Monitor`, `Workflow`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`), session and app features (`SendMessage`, `PushNotification`, `EnterWorktree`, `ExitWorktree`, `Skill`, `DesignSync`, `ReportFindings`, `ShareOnboardingGuide`), and every MCP server from your Claude config (`--strict-mcp-config`); the subscription-only ones never worked in `bisu` anyway.
  - `BISU_TOOLS=default bisu` brings back the full set, or pass your own comma-separated list.
- **Short answers:** [prompt.md](prompt.md) is appended to Claude Code's system prompt: answer in the user's language, result first, no narration, full detail only for errors or when asked. It also holds the delegation rules. Edit it to taste.
- **Reasoning effort:** `BISU_EFFORT=low|medium|high` passes `--effort` through. Off by default: in tests it made no measurable difference with GLM, whose reasoning can't be turned off.

## Memory: what a session should not forget

A chat forgets. The things you would otherwise say again — 한국어로 짧게, a name, where a project lives, a correction you had to make twice — are kept as one markdown file per memory in `~/.config/bisu/memory`, and appended to the system prompt of every new chat and every terminal `bisu` run, in whatever folder. That is the whole mechanism: no database, no background process, nothing sent anywhere.

- **The assistant keeps them itself.** [prompt.md](prompt.md) tells it to save what stays true beyond the conversation, to read the folder first so it updates a file instead of adding a near-duplicate, and to delete when you say to forget. It writes them with the `Write` tool it already has, so in `bisu ui` a memory is an approval like any other edit and you see the file before it exists.
- **A `key:` names the subject, not the wording.** `key: reply-style` in the frontmatter says what the memory is about; saving another memory with that key updates the same file, so rewording a preference can never leave two of them. Two files cannot share a key — that is refused with the name of the file that holds it.
- **Near-duplicates are shown, never merged.** Saving a new memory asks `/api/memory/check` first and, if something already looks like it (same key, same title, or ≥50% overlapping — character bigrams, which matters for Korean), shows it with the reasons and offers *edit that one* or *keep both*. The code does not decide: in Korean a contradiction ("답변은 한국어로" / "답변은 영어로") overlaps as much as a repetition does, so a merge rule would delete the wrong one.
- **You keep them on the Memory tab** of `bisu ui`: add, edit, pin, delete, and see the exact block the next run will be given. The tab reads and writes the same files, so the two never disagree.
- **Pinning** keeps an entry first however old it is; everything else is taken newest first until `BISU_MEMORY_CHARS` (3000 by default) is used up. A memory too long for the room left is **cut to fit** rather than dropped, and any that still does not fit is named in a closing note (`(2 more did not fit: … — read ~/.config/bisu/memory)`) so the assistant knows to read the folder instead of assuming it has seen everything. The tab shows the same list under "Left out", so the budget is never invisible. A single oversized memory used to blank the whole block; that is what the truncation is for.
- **A run reads it once, at start.** A chat that is already open keeps the memory it began with, and anything you save counts from the next chat on.
- **Each bot has its own; only the assistant reads them all.** A bot's memories live in `~/.config/bisu/bots/<id>/memory` and go only into that bot's prompt. The default bot alone has `bot_memory`, which shows what another bot has saved (read only, on request, not in the prompt); bots do not see each other's, and a delegated worker has no memory tools at all.

It deliberately does not touch `~/.claude/CLAUDE.md`, so your normal `claude` is unaffected, and it does not summarise past conversations — a memory exists because you said it, or because you added it.

## What was actually said: session search

Memory is what you asked bisu to keep. Everything else that was said is still in Claude Code's transcripts, and bisu can search them: "지난주에 결제 테스트 어떻게 됐지" is one tool call, not a guess.

- **Two tools, pre-allowed:** `session_search` finds the past sessions that mention a few words — every bot's conversations, scheduled-job and goal runs, and what delegated workers reported and did (their steps are written into the record with the report) — and shows the matching lines with a date, a folder, the bot and an id, with a `bot` filter to narrow it; `session_show` reads one of them in order, a page at a time. [prompt.md](prompt.md) tells the assistant to use them whenever you point at earlier work ("지난번에", "저번 주에 했던") and to answer with what it amounts to, never the transcript.
- **Korean works at two characters.** The index is SQLite FTS5 with the trigram tokenizer ([ui/sessions.mjs](ui/sessions.mjs)), so "결제" finds "실결제했는데" without a word boundary; one- and two-character terms fall back to a scan of the indexed text, which is small because only what you and bisu said is indexed, never tool calls or tool output.
- **Only bisu's own runs.** A transcript is indexed when its model is an OpenRouter name, so what you say to your normal `claude` never reaches an OpenRouter model through a search result. `BISU_SEARCH_ALL=1` indexes every Claude Code transcript on the Mac instead (the index is rebuilt when the setting changes).
- **Always current, costs nothing to keep.** The index lives in `~/Library/Application Support/bisu/sessions.sqlite` and is brought up to date in a short-lived process before each search: unchanged transcripts cost one `stat`, a changed one is re-read whole. A few hundred transcripts take about a second cold and a few milliseconds after that. No background process, nothing sent anywhere.
- The History tab of `bisu ui` has the same search, with *Continue* on each hit.

## Coming to you first

An assistant that only answers is a search box. The other half is noticing: on a slow cadence bisu starts **one short run of its own**, looks at what you have been doing, and leaves at most one thing worth your attention — a README that is still empty, a migration that stopped halfway, a loose end from yesterday. It waits above the message box, and the menu bar icon gets a dot while nobody has answered it.

- **It cannot act.** That run gets its own system prompt ([prompt-suggest.md](prompt-suggest.md)) and read-only tools — `Read`, `Glob`, `Grep`. No edits, no commands, no approvals to give. A bad suggestion costs a few cents and nothing else; saying yes is what starts real work, in a real chat, with the usual approval for every change.
- **Enough, not frequent.** Once a day by default (`intervalHours` 24), nothing between 23:00 and 08:00, never while another run is going, and no run at all while two suggestions are already waiting unread. A run that fails is retried in 30 minutes, not immediately. A dismissed suggestion is never brought up again, in any wording — that is what saying no has to mean.
- **An empty answer is a real answer.** The prompt says so, and the code allows it: no quota, no filler, nothing that begins with "고려해 보세요". What you get is concrete or nothing.
- **Take it or leave it.** The card shows the folder it is about and the exact request it would send. **해볼게** opens a chat in that folder with that request as the first message; **나중에** puts it away for good; ✕ puts the whole queue away.
- **When it looks:** while the app is running, and whenever it is time — so opening the panel after a day gives you one within a minute. **지금 제안 받기** (right-click the icon, or Settings → 먼저 찾아오기) asks for one now, clock and quiet hours included in what it ignores. From the terminal, `bisu suggest` does the same and prints the suggestion instead of showing it.
- **What it sees:** the last ten runs (folder, prompt), open chats, the memory above, and whatever it reads in those folders. It does not run `git`, does not fetch the web, and does not read `~/.claude` — if the answer needs more than a look at the folder, it will miss it.

Settings → 먼저 찾아오기 turns it off, changes the cadence and the quiet hours, and lists the last suggestions with what you did about each. `BISU_PROACTIVE=0` disables it for a single launch, `BISU_PROACTIVE_MODEL` picks the model it thinks with (the developer model by default, because this is a cheap mechanical job), and `BISU_SUGGEST_TIMEOUT` (150 s) caps how long a run may take. The state is one file, `~/.config/bisu/proactive.json` — delete it to forget every suggestion it has ever made.

### The morning briefing

Once a day — at 08:00 by default, or when the Mac wakes in the four hours after — the panel gets a card with today's events and the reminders that are due or overdue ([ui/briefing.mjs](ui/briefing.mjs)). No model writes it: the card is the calendar's own entries, read through the same helper as the calendar tools, so it costs nothing and cannot invent a meeting. It reads only once bisu already has access, so it never puts a permission prompt on the screen; an unopened card from yesterday is put away when today's comes. Settings → 아침 브리핑 turns it off, moves the hour and shows one now (**지금 받아 보기**); `node ui/briefing.mjs` prints what today's would say, and `BISU_BRIEFING=0` disables it for a launch.

## On the web, in your own browser

"쿠팡에서 USB-C 허브 제일 싼 거 찾아서 장바구니에 넣어줘" is one tool call: `browser_task`, with the goal in a sentence and the page to start on ([engine/browser.mjs](engine/browser.mjs)). It runs in a browser where you are already signed in, to the end, and comes back with the answer. Both engines have it.

- **dec first, bisu driving when fast mode is off.** Without fast mode (dec's paid plan), bisu drives dec itself, step by step, with the same loop it drives ego with (`engine/ego.mjs` `drive()`, `engine/dec.mjs` `directDriver()`): dec offers its numbered actions, bisu picks, dec carries it out in one tab the conversation keeps. dec marks which actions are risky; bisu holds those for the person (a click on dec's "Delete" waited, and after the yes was pressed in the same tab). [engine/aside.mjs](engine/aside.mjs) drives Aside the same way, through its REPL, for comparison.
- **dec's fast mode.** With dec's fast mode on, bisu hands the whole task over through dec's local agent endpoint ([engine/dec.mjs](engine/dec.mjs)): it pairs once as the agent "bisu", opens a background tab at the start page, and dec's own Decisions + GLM make every step — the same split bisu itself uses. Fast mode is dec's paid plan (always open on the owner's Mac); dec decides, bisu only reads the switch. A dec that is installed but not running is started behind whatever you are doing. A step dec wants confirmed (paying, sending) is confirmed in dec, with Touch ID: the chat says so and moves on, and when that run ends the page tells the chat, which reports the result ([ui/webwaits.mjs](ui/webwaits.mjs)) — on Telegram too.
- **ego lite otherwise, driven by bisu itself** ([engine/ego.mjs](engine/ego.mjs)), strong enough to need no dec. It works the way the ego-browser skill says: one task space per conversation, resumed by id on every call; a step is one ego call that acts and looks in the same script (the snapshot printed last) plus one model call; refs retired by a page change are found again by role, name and position. Rows of text are read as rows ("UGREEN USB-C 허브 5포트 · 24,500원"), and what earlier pages showed is kept, so a comparison does not reopen each page. What it may type comes from the request (`typing`, used as @name), never a password or a card number; a sign-in form hands the window to you and is taken back when you say you are done.
- **Nothing commits without you.** A button that pays, sends, deletes, books or submits — or a confirm dialog nobody approved — stops the run. bisu says what it will do and asks; `browser_approve`, with the button's words (which the approval card and Telegram show), presses exactly that button on exactly that page, and the confirm dialog that belongs to it. Links never stop a run: they only go somewhere. A select-all the goal did not ask for is refused.
- **Who picks the steps in ego, measured.** Decisions is fast and cheap, so it picks every step; GLM steps in only when one of three things happens: it **slows down** (back on a page it already left twice, the same control again, a run past eight steps), it **fails** (no pick, a timeout, a step that errored), or its **answer looks wrong** (done with no answer to a question, or an answer that a quick Decisions check says does not answer every part of the goal — "10.9 · °" for "기온과 날씨"). Risky steps need no second model: they wait for you anyway. `engine/eval/web-bench.mjs` runs nine tasks on pretend sites ([engine/eval/web-sites.mjs](engine/eval/web-sites.mjs): a shop search, the cheapest item in stock, a refurbished item listed above the new one, a bookshop by category, a book on page 2, a booking form, deleting one sender's mail, reading one mail, opening hours at the bottom of a long page), twice each, checked by what the run reported, where it stopped and what the site received:

  | picker | passed | median | per task | GLM looked |
  |---|---|---|---|---|
  | Decisions, GLM only when it slows, fails or answers oddly (default) | 18/18 | 4.0 s | $0.0004 | 2 times |
  | Decisions alone | 18/18 | 3.8 s | $0.0003 | — |
  | Decisions, GLM on every risky step, unsure pick and "done" (dec's own combination) | 18/18 | 7.9 s | $0.0017 | 30 times |
  | GLM alone, reading the snapshot and acting several steps at once (an earlier set of seven) | 11/14 | 7.0 s | $0.0035 | — |

  With Decisions unreachable, Decisions alone stopped on the first step of all three tasks tried; the default finished all three with GLM taking every step. GLM alone twice answered "예약 확정 완료" without pressing the button and once called a mail task done before doing anything, so it is never the one deciding a run alone. `BISU_WEB_PICKER` picks another (`decisions`, `pair`, `glm`).
- **Three browsers, one driver** (books.toscrape.com, each twice; every pick by the same loop): a price on the first page 1.4–1.6 s in dec, 1.6–1.9 s in ego, 2.3–2.8 s in Aside; category → book → price and stock 3.1–4.3 s in dec, 4.0–4.2 s in ego, 4.2–4.3 s in Aside; a deeper one (Mystery, page 2, the most expensive book, its title, price, stock and UPC) 4.3–4.5 s in dec, 7.6–9.0 s in ego, 5.3–11.7 s in Aside. The deep task once took 9–18 s with three GLM calls and is now done by Decisions alone: a link the goal names (「Mystery」) is the way there, not a choice to compare; a plain price superlative on a list page is read off the page text (each item followed by its price, nearer its own item than the next; a goal that narrows the choice first, a price-first layout or a tie still goes to GLM); and a goal asking for several things gets one Decisions question per thing, a cell that only names one (「UPC」) offered joined to its value. dec gives an agent on this Mac the whole page (every action and every line, where a remote model gets 80 actions and 20 lines around the viewport), so nothing below the fold is missing; bisu reads its full text only when comparing, which keeps a run of tasks under dec's 60 requests a minute. The browsers themselves take 0.5–0.8 s a step. A code in an answer (a UPC, an order number) must be one the pages had: GLM once dropped three characters of a UPC, which is now put back from the page.
- **Complex tasks, the same in every browser** (books.toscrape and quotes.toscrape, five tasks twice each): the cheapest book in each of three categories, the dearest across Fantasy's three pages, the gap between the dearest and cheapest on a page, a book's UPC, stock and reviews on page 2, a quote's author's birth date and place. First 4/10 in dec, 7/10 in ego and Aside; now 8/10, 10/10, 10/10 (dec's two misses are the quotes site moving to plain http, which dec refuses to drive; a chat falls back to ego there). What it took: a checklist for 「각각」 goals (the named links, ticked by page title, told what is left, answered from the notes when none is); notes of list pages that keep their cheapest and dearest item with its whole name (a list shortens titles; ego reads the link titles and picture texts for them); 「1쪽」 never followed by "next"; the gap worked out from the page (1.9 s in dec); a guess picked up on an earlier page never ends the run; lines that contain one another count as one answer (Aside repeats rows); parts answered one by one only on an item's own page, never across a list; dec telling bisu the page's path, and a new tab when the site changes (a tab is allowed only the site it was opened for).
- **Measured where nothing was tuned:** every round, its tasks, results and what it changed are in [docs/web-eval.md](docs/web-eval.md), run with `engine/eval/web-tasks.mjs` (raw lines in `engine/eval/results/`). On a second held-out set (web-scraping.dev, scrapingcourse, Oxylabs' sandbox; six tasks, twice, no code changes): dec driven by bisu 11/12, ego 10/12, dec's fast mode 10/12, Aside 6/12 (all six misses one parser fault, fixed since).
- **On real sites,** once each and read-only: Hacker News' top story (4 s), a GitHub repository's stars (2 s), python.org's latest release (2 s), Naver's Seoul weather (5 s), Korean Wikipedia's search to Busan's population (9 s: the magnifier, the box, Enter), Aladin's first search result and price (14 s) through ego; English Wikipedia (11 s) and Naver Finance's Samsung quote (45 s, from a chat) through dec. What real sites taught it: an icon with no text is named after what it links to; a search box wrapped in another element is still a search box; a page's own "뒤로 가기" is not offered on the first page, and a run that leaves the site (a new tab, another portal) is brought back; an answer is looked for in the whole page, not only what is on screen; pages asking for the microphone, camera, location or notifications get a refusal instead of a prompt (one such prompt hands the ego window to you and stops the run). Naver Map, where it pressed 검색 before typing, is not solved yet.
- **End to end:** a chat asked for a book's price on books.toscrape.com went to dec and answered in 15 s; a chat asked to book the pretend restaurant filled the form, asked before 「예약 확정」, and after the yes the site received exactly 홍길동 · 2026-11-02 · 2명 · 19:00 — on both engines. dec works on https pages only; pages on this Mac go to ego.

## On a schedule

"매일 아침 8시에 어제 커밋 요약해 줘" is a file, not a setting. bisu writes `~/.config/bisu/jobs/morning-summary.md` — with the same `Write` tool and the same approval as a memory, so you see it before it exists — and the engine does the rest:

```
---
name: 아침 요약
schedule: 0 8 * * 1-5        # cron, five fields, local time — or  at: 2026-10-28 09:00  for one time
cwd: /Users/you/the-project
tools: read                  # read (default) · edit: may change files in cwd · full: may also run commands
---
어제 커밋 로그와 열린 TODO를 보고 오늘 할 일 세 가지를 뽑아줘.
```

- **Each run is one short Claude Code run of its own** ([ui/jobs.mjs](ui/jobs.mjs)), in that folder, with its own system prompt ([prompt-job.md](prompt-job.md): nobody is watching, answer short, an empty answer is fine) and the memory and session search as usual. The answer lands as a card in the panel, with the dot on the menu bar; *이어서 대화* continues from that run's session, so "그럼 고쳐" has the whole context.
- **Read-only unless the file says otherwise.** `tools: edit` runs with Claude Code's `acceptEdits` (file edits in that folder go through, commands are refused); `tools: full` runs with `--dangerously-skip-permissions`. A job that can act is a choice you made, visible in the file, never the default — the unattended run has nobody to ask.
- **A job that can act waits for your approval, for that exact file.** Settings shows what it will do and a *승인* button; the approval is tied to the file's contents, so any change to the file — yours, or an agent's — needs approving again. It also needs a project folder of its own as `cwd`: not the home folder, and nothing that holds bisu's settings, so a job can never rewrite its own jobs or bisu's memory.
- **Enough, not frequent.** The engine looks once a minute, runs one job at a time, and a job missed while the Mac was asleep runs once when it wakes, not once per missed slot. A failed run leaves a card saying so and waits for its next slot; no retry loop.
- **One engine runs the schedule.** With the menu bar app and `bisu ui` open at once, the first engine to tick holds a lock (`~/Library/Application Support/bisu/scheduler.lock`) and the other skips its ticks until that one is gone, so nothing runs twice. Job answers keep their own 20 cards and never push suggestions out of the list that stops a dismissed one from coming back.
- **Settings tab:** every job with its next run, last result, *지금 실행*, *끄기/켜기* (flips `enabled:` in the file) and *삭제*. From the shell, `node ui/jobs.mjs` prints the same, `node ui/jobs.mjs run <slug>` runs one now, and `node ui/jobs.mjs next "0 8 * * 1-5"` says when a schedule fires.

## `bisu ui`

**How it looks.** bisu is a small character, and its face is the status: it blinks while it listens, looks around while it thinks, bobs while it works, rings when it needs you to approve something, and smiles when it is done. The machinery stays one layer down — a turn's file reads, commands and searches fold into one line ("한 일 3가지") that opens on a click, and model names, steps and cost appear only with 설정 → 보기 → 작업 세부 보기. The page is Korean throughout, and the assistant answers in your own speech level.

The first time, a card asks three things — what to call you, 반말 or 존댓말 (or follow yours), and how often bisu may come to you first — and keeps them as ordinary memories and settings. The History tab lists your conversations; what bisu ran on its own (suggestions, scheduled jobs) appears only when you tick the box for it. Page preferences such as the developer-detail switch are kept by the engine (`~/.config/bisu/ui.json`), because the menu bar app gets a new port, and so a new browser origin, every launch.


```sh
bisu ui        # opens http://127.0.0.1:7878 (BISU_UI_PORT to change)
```

One local page (Node, no dependencies, 127.0.0.1 only) for everything:

**Layout.** The full window is a sidebar with one screen per purpose — 대화, 목표, 예약 작업 (scheduled jobs, the morning briefing, suggestions), 기록, 기억, 연결 (Telegram, calendar, alerts) and 설정 (engine, models, keys and spend; the computer-use test under 고급). Each screen opens with one card for its number or state and at most one primary button; long explanations sit behind ⓘ. Anything that needs a macOS permission asks when you press it and opens System Settings. The menu bar panel's start reads like Control Center: state, the folder, three switches (선택한 텍스트 읽기, 먼저 찾아오기, 맥 깨어 있게), recent chats, then 전체 창 · 설정 · 종료; the right-click menu follows the same order.

- **Chat:** pick a folder and talk to bisu. Each chat is a real headless Claude Code run with the same models and agents as `bisu`, so it reads, edits and runs things in that folder. Before it edits a file or runs a command that needs permission, the page shows exactly what it wants to do (the command, the diff, the new file) with **Allow**, **Allow for this chat** and **Deny**. Claude Code starts as soon as you open a chat and stays up between messages, so replies take about as long as the model itself (~1–1.5 s for a short answer); after 30 idle minutes it stops and picks the session back up on your next message (`BISU_UI_IDLE_MIN` to change). **Stop** interrupts the current answer. Work handed to the developer, publisher or refactorer runs in the background, shown in a bar above the input, so you can keep talking while it runs; bisu checks the result and reports when it finishes. Messages sent while bisu is mid-reply wait their turn instead of being refused. Read-only tools that Claude Code allows by itself run without asking.
- **History:** your `bisu` sessions from the last 60 days, from the terminal too (picked out of `~/.claude/projects` by their OpenRouter model names), with tokens and an estimated cost. **Continue** reopens one as a chat.
- **Memory:** what carries across sessions — how you like answers, names, the projects that are still going. One markdown file each in `~/.config/bisu/memory`, which the assistant adds to as you talk and every new run is given; see [Memory](#memory-what-a-session-should-not-forget).
- **Settings:** for Claude Code, key status (use-only through Dec, or plain env; whether answers stream), real OpenRouter spend and limit, and models per role from OpenRouter's list with prices and tool-calling support; for bisu's own engine, whether its Z.ai and Decisions keys are connected, what it spent today, this week and this month (from its own transcripts, at Z.ai's prices), which model does what, and whether it may use the calendar and reminders, with a button that asks macOS. Then 먼저 찾아오기 — whether bisu suggests things on its own, how often, and when not to; see [Coming to you first](#coming-to-you-first). Model choices go to `~/.config/bisu/models`; exported `BISU_*` variables still win. The key itself is added or changed in Dec, never on this page.

- **모델 키 순서:** when more than one saved key can make a call — GLM through OpenRouter or straight to Z.AI, two OpenAI keys for Decisions, two OpenRouter keys — they are tried top first, and with 「키가 실패하면 다음 키로 넘어가기」 on (the default) a key that is out of money, refused, busy or down hands the same request to the next one; it then rests (ten minutes for money or a refusal, a minute otherwise), across chats too. ↑↓ change the order. It is dec's order: both apps read and write one file (`~/Library/Application Support/Dec Browser/model-routes.json`, key names only), so dec's own fast mode and chat follow it as well. The app passes every key it finds for those three sites ([engine/routes.mjs](engine/routes.mjs)); a Claude Code chat starts on the first OpenRouter key that is not resting and keeps it.

The page's API needs a token that only the page gets, and refuses other hosts and cross-site requests.

## `bisu app` — the same bisu in the menu bar

```sh
bisu app            # open it (~/Applications/bisu.app), building it on first run
bisu app install    # rebuild the app after changing bisu
bisu app electron   # run the working tree in the old Electron shell, for comparison
```

A real `.app` in `~/Applications`, so macOS calls it **bisu** in Accessibility and Automation prompts, System Settings and Activity Monitor. The menu bar icon opens a popover with ⌥Space; there is no Dock icon.

The shell is AppKit, not Electron: [mac/native/bisu.swift](mac/native/bisu.swift) is one process with a `WKWebView` showing the same page, and it is what starts the engine, owns the panel, and reads what you were looking at. That is ~63 MB for the shell and ~40 MB for WebKit, against ~430 MB of Chromium processes before — plus ~66 MB for the engine and ~40 MB for `dec-secret`, so an idle bisu went from ~470–520 MB to ~210 MB, in 4 processes instead of 6. `swiftc` is the only build requirement; there is no npm step and no 120 MB download.

Two things keep the engine small, both worth knowing before changing them. The history list is built by [ui/history.mjs](ui/history.mjs), a process that exits when it is done: a cold pass parses ~200 MB of Claude Code transcripts, and V8 does not hand those pages back, so doing it in the engine left that process ~100 MB fatter for the rest of the day — the engine now only holds the 56-row result and the newest transcript's mtime decides when to ask again. The other is that a chat's Claude Code process is stopped when the panel closes or after 30 idle minutes, so nothing expensive is left running for a window nobody is looking at.

Because the bundle is a snapshot, rebuild after editing (`bisu app install`) — or run the working tree directly with `bisu app electron` while you work. Same engine, same models, same approvals as `bisu ui`, but a menu-bar app instead of a browser tab. It starts its own engine on a **random loopback port**, so both can run at once and nothing else on the machine can find it. Problems go to `~/Library/Logs/bisu/bisu.log`.

- **⌥Space** opens a panel under the icon; clicking away or Escape puts it away. **＋** in the panel goes back to its start card, which lists the recent conversations to return to.
- **The icon says what bisu is doing** even while the panel is closed: a ring while it works, a filled dot when it needs you (an approval nobody has answered, or a card nobody has read).
- **Drag it by the header** and it stays where you left it — the next ⌥Space opens there instead of under the icon. Dragging it to another screen works too; the position is clamped so a corner can never end up offscreen.
- **Resize it from the grip** in the bottom-right corner, and it keeps that size. A frameless window has no resize border — dragging its edge moves it — so the panel draws its own handle and the shell applies the bounds.
- **Context you don't have to explain:** the panel carries over the app you were in and the text you had selected or copied, so "이거 요약해" is enough. The selection is read through the Accessibility API in bisu's own process — it never presses ⌘C and never touches the pasteboard, so nothing needs restoring. An app that doesn't expose its selection just reports nothing. The panel has a bar with "권한 주기" that opens the macOS dialog; it appears **once** — ✕ (or granting it) and it stays gone. The menu's "접근성 허용…" keeps the same action while it is still untrusted. Without it the panel still carries the frontmost app and the clipboard.
- **Approvals** look the same as in `bisu ui`, and a failing request says why instead of leaving a spinner.
- **The engine comes back.** If the engine exits on its own, the app starts it again (a little later each time) and reloads the panel and the full window; four exits within two minutes stops the loop with a message instead. A chat whose folder was deleted says so in the chat rather than taking the engine down.
- **The menu** (right-click the icon) has the full window for History, Memory and Settings, **지금 제안 받기**, today's OpenRouter spend, "선택한 텍스트 읽기", "접근성 허용…" while it is untrusted, and Quit. A dot in the corner of the icon means a suggestion is waiting that you have not read yet; it goes away when the panel has shown it.
- **Launched from Finder** the app has almost no `PATH`, so it composes one and finds `node` in Homebrew, `~/.local/bin`, fnm, nvm, mise, asdf or Volta without asking a shell (which can hang).

Two permissions are per-app and worth knowing about:

- **Accessibility** — selection capture, and the computer-use helper (which inherits bisu's grant because bisu is the responsible app). Only bisu needs it; grant it to the app, not to a helper binary.
- **Files and Folders** — the first chat in `~/Desktop`, `~/Documents` or `~/Downloads` makes macOS ask whether bisu may read that folder. If the dialog is not answered the chat waits, so the engine now says so after 15 s with what to allow. The app is signed with a stable local certificate when one exists (`BISU_SIGN_ID`, or any "…Local Code Signing" identity), which is what keeps both grants across rebuilds — an ad-hoc signature changes on every build and macOS forgets them.
- `build.sh` also copies `dec-secret`'s three self-contained files into the app's support folder: the originals live under `~/Desktop`, and macOS refuses to let a Finder-launched app read there, so the app would otherwise wait forever on that `open()`.

The security model is unchanged and now a little tighter: the engine listens on **127.0.0.1 only** (a LAN address refuses the connection), rejects a foreign `Host`/`Origin` (DNS rebinding), and requires a per-launch token — including for the page itself, which previously handed the token to any local process that asked. Computer-use screenshots expire after 15 minutes and live in a 700 folder. Chat transcripts are Claude Code's own files under `~/.claude`, in plain text, like any other Claude Code session.

The old shell is still in [mac/](mac): Electron main, a preload that only exposes shell chrome, the context capture, and `install-app.sh`. It is kept for comparison and adds nothing to the engine except an optional `BISU_UI_TOKEN` and a `?panel=1` layout.

## bisu's own engine (beta): GLM talks and works, Decisions judges

`engine/` is a second engine that does not use Claude Code at all, for the version of bisu that can be sold. Settings → 엔진 switches between it and Claude Code; `BISU_ENGINE=native bisu` does the same in a terminal. It speaks the same command-line protocol bisu already used (stream-json in and out, approvals over stdio, interrupt, queued messages, `--resume`, `-p --output-format json`), so `launch.zsh` starts it in Claude Code's place and the chat page, scheduled jobs and suggestions work unchanged.

- **Models.** Z.ai GLM over its own API (`GLM_API_KEY`, a Standard key; a Coding Plan key may not be used from an app), two models with separate jobs, and the judge (below) choosing between them for each message:
  - *GLM-5.3 is the assistant:* conversation, memory, schedules, calendar and reminders, the web, past conversations, the Mac, anything the judge could not place, and the splitting of work that is several jobs at once (a line naming the parts, one worker per part, the reports checked when they come back). It reasons fully whenever it uses tools. At low effort it answered "서울 사는 사람 몇 명이야?" next to a `users.csv` with Seoul's population three times out of three, even when told to look at the files; with full reasoning it read the file and said 2.
  - *GLM-5.3-Flash does the work in the folder,* small or large, and every background worker. It reasons only for a build or what the judge calls hard: without reasoning it read the file and said 2 every time, at a tenth of GLM-5.3's cost.

  `BISU_NATIVE_MODEL` and `BISU_NATIVE_WORK_MODEL` change either one, and `BISU_THINKING=on|off` forces reasoning everywhere. Measured on 2026-10-27:

  | Request | Answered by | Time | Cost |
  |---|---|---|---|
  | "고마워, 덕분에 살았다" | GLM-5.3 | 2 s | $0.001 |
  | "내 이름은 민준이야. 앞으로 기억해둬" | GLM-5.3 | 20 s | $0.005 |
  | "매일 아침 9시에 이 폴더 users.csv 요약해줘" | GLM-5.3 | 42 s | $0.007 |
  | "오늘 비트코인 시세 얼마야?" | GLM-5.3 | 33 s | $0.008 |
  | "서울 사는 사람 몇 명이야?" | Flash | 24 s | $0.001 |
  | The 15 benchmark tasks, twice each | Flash for 28, GLM-5.3 for the 2 chats | median 19 s | $0.0006 a task |

  The benchmark passed 29 of 30; the miss was Flash finding one of the two files that mention VAT. Times vary from run to run with Z.ai's load. A model that starts repeating itself is cut off within a few hundred characters and asked once for a fresh answer: before that check existed, GLM-5.3 with no tools once wrote "done done done…" for 19 minutes and 65k tokens.
- **Judgments.** OpenAI's Decisions API (`OPENAI_API_KEY`, `gpt-6-luna`) answers probability questions instead of writing text, at $0.10 per million input tokens and about 0.4 s a call. It decides four things:
  - *what kind of request this is* (chat, work, build, past, mac, schedule, calendar, remember, web), and whether it is hard. The judge also sees the folder's top-level names, so "서울 사는 사용자는 몇 명이야?" next to `data/` reads as a question about the data, not about Seoul. Chat gets no tools; work and build go to Flash; work that bundles several independent jobs (the judge's third answer, *split*) goes to GLM-5.3 instead, to name the parts in a line and hand each to a worker, so the extra GLM-5.3 call is only paid where there is something to split (at 0.7: 8 of 8 two- or three-part requests caught, 0 of 10 single jobs split, however big); the rest get a one-line hint about how to go about it. 63 of 66 labeled requests routed right (among them what another bot or a scheduled job did, which is a question about the record), and none was sent to chat by mistake. Calendar and schedule are kept apart: "저녁 7시에 엄마한테 전화하라고 알려줘" is a reminder for them, "매일 아침 8시에 오늘 일정 요약해서 보여줘" is work bisu does later. Of the three misses, "내일 오전 9시에 배포 체크리스트 알려줘" read as a reminder rather than a job, and two read as chat with too little confidence to take the tools away.
  - *whether an action may run without asking* (destructive, external, system). With the default "위험해 보이는 것만 묻기", changes and commands inside the folder that every probability puts under 0.15 just run — 19 of 20 harmless commands, 0 of 20 risky ones. Deletes, moves, pushes, installs, `sudo`, `curl` and similar are on a fixed list that always asks, whatever the judge says, and a new file inside the folder needs no judgment at all. "매번 묻기" asks for everything.
  - *whether a long turn is still going somewhere* (progressing, repeating, finished, blocked), from the fifth step and every third step after; the judge sees each call and the start of what came back. Going in circles (≥ 0.75) gets a note to change approach and is stopped the third time, finished (≥ 0.85) is told to answer, blocked (≥ 0.7) is told to ask. On 26 labeled turns it judged all 26 right, acted on 18 of the 20 stuck ones and interrupted none of the 6 moving ones; shown only the first line of each result (for a failed command, "exit 1"), as it was before, it got 22. In the benchmark it changed nothing on the 15 everyday tasks, and in the long build it sent one note, to answer, at the end. Where a test needed an address only the person has, it passed 5 of 7 runs against 3 of 7 without it, in about half the time; every run it marked blocked was told to ask, and did. The runs that still failed were ones it read as progressing while the model wrote a mock server to make the test pass, as most runs without the check did. Blocked was at 0.8 at first: the 3 runs marked 0.71–0.76 then got no note and rewrote the test, so it is 0.7 now, which no other task came near. A check costs about a second and $0.0001. `BISU_PROGRESS=0` turns it off.
  - *whether the answer did what it says.* GLM once answered "두부를 장보기 목록에 추가했어" after only looking at the list. Now an answer that could be saying something was done (a Korean past tense, a "~할게" promise) is read against every call of the turn and whether it succeeded; a change no successful call made sends it back once, to do it or to say it was not done, and the page dims the first answer and says it is being checked. On 28 labeled answers it caught all 13 that claimed a change nothing made and sent back none of the other 15. In the benchmark it judged 62 answers and sent back one, which said an event was added when the calendar had refused access (0.97); bisu then said it could not add it. None of the other 61 went back (the highest was 0.38, the cut-off 0.5). A trial run caught the same claim once more (0.69), with the same correction. A judged answer takes about half a second more and $0.0001. Such claims are rare: the one that started this did not come back in 14 runs. `BISU_CLAIMS=0` turns it off.
- **Tools.** Files (read before edit, exact-text edits), search, the shell (with an environment that never contains API tokens), the web (Z.ai search, fetch), memory (`remember`, `forget`, writing the same files as the Memory tab), scheduled jobs (`schedule_job`), the calendar and reminders (below), past sessions and computer use through bisu's own MCP server, and `delegate`: a worker that does a big job in the background while bisu keeps talking, its report coming back as a message.
- **Calendar and reminders.** Seven tools over EventKit, through a small helper (`mac/cal/bisu-cal.swift`, built by `mac/native/build.sh` next to the computer-use one): list, add, change and delete events; list, add and change reminders. A reminder with a time is how bisu does "~에 알려줘": it notifies on every device, where a scheduled job only puts a card in bisu. The model sees short ids (e3, r2) instead of EventKit's, every date with its weekday, and what an addition overlaps or duplicates; deleting needs the title as well as the id and always asks, with the event in words on the approval card. The system prompt lists today, this week, next week and the next fourteen days, so "다음 주 화요일" is a lookup. macOS asks for access the first time (시스템 설정 → 개인정보 보호 및 보안 → 캘린더, 미리 알림). Measured on a pretend calendar, 16 tasks three times each — today's events, adding on a weekday or next week, finding a free two hours, moving, a repeating event, being reminded at a time versus a job, checking off, deleting, an ambiguous request, an overlap, the busiest day, overdue to-dos: GLM-5.3 passed 48 of 48, median 13 s, $0.005 a task; Flash also passed 48 of 48 at $0.0006 a task, but with a median of 19 s. Read jobs (a morning summary) can read the calendar too. The Claude Code engine does not have these tools.
- **Conversations** are JSONL files in `~/Library/Application Support/bisu/sessions`, in the same outer shape as Claude Code's transcripts, so History and the full-text search show both. A conversation past ~200k characters is summarized by Flash and continues from the summary.
- **Measured, not assumed.** `engine/eval/bench.mjs` runs 35 tasks (15 everyday ones; 4 that tend to go long: a deploy without its token, a function that does not exist, a test that needs an address, a module built from scratch; and 16 on a pretend calendar) in a sandbox (files only in a temp folder, no network, a short allowlist of commands) and checks each result by looking at the files; `--progress on,off` runs each with and without the progress check. `engine/eval/judge-bench.mjs` runs the judgments on labeled examples to pick the thresholds. Both are how any model or prompt change should be checked.
- **Computer use has a benchmark, not yet a score.** `engine/eval/cu-bench.mjs` gives the model only the `cu_*` tools and twelve tasks in TextEdit, Finder, Notes, Calculator and System Settings (add a line and save, read a number, rename, count, open an app through Spotlight, a move to the Trash that must wait for approval), checked by the files, the notes or the answer. It drives the real screen, so it runs when nobody is at the Mac, from Settings → 컴퓨터 조작 시험: 권한 확인 and 준비만 해 보기 first, while someone is there to answer macOS's permission prompts, then 시험 시작 (30 seconds to step away, 멈추기 puts the task in progress back), with the results by app on the same page. Each step may act only while one of the task's apps is in front, approvals are refused, and only what the bench made is cleaned up.

## Honest limits

- The cost Claude Code prints (`/cost`, `total_cost_usd`) is estimated at **Claude** prices and runs several times too high here. Check real spend on your OpenRouter dashboard. Claude Code still sends a large system prompt on every call, so a small task is a few cents; the Qwen role is the priciest.
- Claude Code is tuned for Claude. Non-Claude models are noticeably worse at its tool calls — give `bisu` mechanical work, not architecture.
- Subscription-only features (connectors, remote control, scheduled tasks) are off in `bisu` sessions.
- Memory is text in the system prompt: every request pays for it, and a wrong entry is followed until you delete it. The Memory tab exists to show exactly what is there — that is the point of it.
- A suggestion is a guess from the outside. It reads the folder and your recent runs, not the conversation in your head, so it will sometimes propose the thing you already decided against (and sometimes miss the obvious). That is why it is read-only, why an empty answer is allowed, and why nothing happens until you say 해볼게.
- In use-only mode with an older `dec-secret-helper`, responses are buffered (no streaming) and a single request is capped at ~200 s. A helper with the `stream` command removes both; Settings in `bisu ui` shows which one you have.

## Why not open-codex?

[open-codex](https://github.com/ymichael/open-codex) proved the idea — swap the base URL, run any model — but it froze in May 2025 and takes your key as plain env. `bisu` does the same swap on today's officially supported path (`ANTHROPIC_BASE_URL`), and treats the key as something no process should ever hold.

## License

Apache-2.0
