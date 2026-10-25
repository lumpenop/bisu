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
  - Dropped: scheduling and background work (`CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `Monitor`, `Workflow`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`), session and app features (`SendMessage`, `PushNotification`, `EnterWorktree`, `ExitWorktree`, `Skill`, `DesignSync`, `ReportFindings`, `ShareOnboardingGuide`), and every MCP server from your Claude config (`--strict-mcp-config`); the subscription-only ones never worked in `bisu` anyway.
  - `BISU_TOOLS=default bisu` brings back the full set, or pass your own comma-separated list.
- **Short answers:** [prompt.md](prompt.md) is appended to Claude Code's system prompt: answer in the user's language, result first, no narration, full detail only for errors or when asked. It also holds the delegation rules. Edit it to taste.
- **Reasoning effort:** `BISU_EFFORT=low|medium|high` passes `--effort` through. Off by default: in tests it made no measurable difference with GLM, whose reasoning can't be turned off.

## `bisu ui`

```sh
bisu ui        # opens http://127.0.0.1:7878 (BISU_UI_PORT to change)
```

One local page (Node, no dependencies, 127.0.0.1 only) for everything:

- **Chat:** pick a folder and talk to bisu. Each chat is a real headless Claude Code run with the same models and agents as `bisu`, so it reads, edits and runs things in that folder. Before it edits a file or runs a command that needs permission, the page shows exactly what it wants to do (the command, the diff, the new file) with **Allow**, **Allow for this chat** and **Deny**. Claude Code starts as soon as you open a chat and stays up between messages, so replies take about as long as the model itself (~1–1.5 s for a short answer); after 30 idle minutes it stops and picks the session back up on your next message (`BISU_UI_IDLE_MIN` to change). **Stop** interrupts the current answer. Read-only tools that Claude Code allows by itself run without asking.
- **History:** your `bisu` sessions from the last 60 days, from the terminal too (picked out of `~/.claude/projects` by their OpenRouter model names), with tokens and an estimated cost. **Continue** reopens one as a chat.
- **Settings:** key status (use-only through Dec, or plain env; whether answers stream), real OpenRouter spend and limit, and models per role from OpenRouter's list with prices and tool-calling support. Model choices go to `~/.config/bisu/models`; exported `BISU_*` variables still win. The key itself is added or changed in Dec, never on this page.

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
- **The menu** (right-click the icon) has the full window for History and Settings, today's OpenRouter spend, "선택한 텍스트 읽기", "접근성 허용…" while it is untrusted, and Quit.
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
- In use-only mode with an older `dec-secret-helper`, responses are buffered (no streaming) and a single request is capped at ~200 s. A helper with the `stream` command removes both; Settings in `bisu ui` shows which one you have.

## Why not open-codex?

[open-codex](https://github.com/ymichael/open-codex) proved the idea — swap the base URL, run any model — but it froze in May 2025 and takes your key as plain env. `bisu` does the same swap on today's officially supported path (`ANTHROPIC_BASE_URL`), and treats the key as something no process should ever hold.

## License

Apache-2.0
