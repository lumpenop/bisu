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

The main assistant does small tasks itself and hands only large jobs to a specialist (subagents defined in [agents.json](agents.json)). Every handoff re-sends Claude Code's whole system prompt, so delegating small work costs more than it saves.

| Role | Default | Override |
|---|---|---|
| Main assistant: decides, does small tasks, checks results | `z-ai/glm-5.3` | `BISU_MODEL` |
| Large publishing (pages, many components) and large refactors | `qwen/qwen3.8-max-0902` | `BISU_CODE_MODEL` |
| Other large jobs: bulk reading, summarising, file chores | `deepseek/deepseek-v4.1-flash` | `BISU_FAST_MODEL` |

```sh
bisu                                          # all defaults
BISU_CODE_MODEL=qwen/qwen3-coder-next bisu    # any OpenRouter slug per role
```

These subagents exist only inside `bisu`; your normal `claude` never sees them.

## Lean and brief by default

- **Core tools only, no MCP:** `bisu` keeps what a coding sidekick needs and drops the rest, cutting every request from ~25k to ~6.8k input tokens (about a quarter of the cost; with DeepSeek flash the API time per request went from ~3.2 s to ~1.8 s).
  - Kept: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, and `Task` for the publisher / refactorer / helper subagents.
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

## Honest limits

- The cost Claude Code prints (`/cost`, `total_cost_usd`) is estimated at **Claude** prices and runs several times too high here. Check real spend on your OpenRouter dashboard. Claude Code still sends a large system prompt on every call, so a small task is a few cents; the Qwen role is the priciest.
- Claude Code is tuned for Claude. Non-Claude models are noticeably worse at its tool calls — give `bisu` mechanical work, not architecture.
- Subscription-only features (connectors, remote control, scheduled tasks) are off in `bisu` sessions.
- In use-only mode with an older `dec-secret-helper`, responses are buffered (no streaming) and a single request is capped at ~200 s. A helper with the `stream` command removes both; Settings in `bisu ui` shows which one you have.

## Why not open-codex?

[open-codex](https://github.com/ymichael/open-codex) proved the idea — swap the base URL, run any model — but it froze in May 2025 and takes your key as plain env. `bisu` does the same swap on today's officially supported path (`ANTHROPIC_BASE_URL`), and treats the key as something no process should ever hold.

## License

Apache-2.0
