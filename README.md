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

It deliberately does not touch `~/.claude/CLAUDE.md`, so your normal `claude` is unaffected, and it does not summarise past conversations — a memory exists because you said it, or because you added it.

## What was actually said: session search

Memory is what you asked bisu to keep. Everything else that was said is still in Claude Code's transcripts, and bisu can search them: "지난주에 결제 테스트 어떻게 됐지" is one tool call, not a guess.

- **Two tools, pre-allowed:** `session_search` finds the past sessions that mention a few words and shows the matching lines with a date, a folder and an id; `session_show` reads one of them in order, a page at a time. [prompt.md](prompt.md) tells the assistant to use them whenever you point at earlier work ("지난번에", "저번 주에 했던") and to answer with what it amounts to, never the transcript.
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

```sh
bisu ui        # opens http://127.0.0.1:7878 (BISU_UI_PORT to change)
```

One local page (Node, no dependencies, 127.0.0.1 only) for everything:

- **Chat:** pick a folder and talk to bisu. Each chat is a real headless Claude Code run with the same models and agents as `bisu`, so it reads, edits and runs things in that folder. Before it edits a file or runs a command that needs permission, the page shows exactly what it wants to do (the command, the diff, the new file) with **Allow**, **Allow for this chat** and **Deny**. Claude Code starts as soon as you open a chat and stays up between messages, so replies take about as long as the model itself (~1–1.5 s for a short answer); after 30 idle minutes it stops and picks the session back up on your next message (`BISU_UI_IDLE_MIN` to change). **Stop** interrupts the current answer. Work handed to the developer, publisher or refactorer runs in the background, shown in a bar above the input, so you can keep talking while it runs; bisu checks the result and reports when it finishes. Messages sent while bisu is mid-reply wait their turn instead of being refused. Read-only tools that Claude Code allows by itself run without asking.
- **History:** your `bisu` sessions from the last 60 days, from the terminal too (picked out of `~/.claude/projects` by their OpenRouter model names), with tokens and an estimated cost. **Continue** reopens one as a chat.
- **Memory:** what carries across sessions — how you like answers, names, the projects that are still going. One markdown file each in `~/.config/bisu/memory`, which the assistant adds to as you talk and every new run is given; see [Memory](#memory-what-a-session-should-not-forget).
- **Settings:** key status (use-only through Dec, or plain env; whether answers stream), real OpenRouter spend and limit, models per role from OpenRouter's list with prices and tool-calling support, and 먼저 찾아오기 — whether bisu suggests things on its own, how often, and when not to; see [Coming to you first](#coming-to-you-first). Model choices go to `~/.config/bisu/models`; exported `BISU_*` variables still win. The key itself is added or changed in Dec, never on this page.

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

- **⌥Space** opens a panel under the icon; clicking away or Escape puts it away.
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
