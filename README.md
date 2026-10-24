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

## Pick a model

```sh
bisu                                  # deepseek/deepseek-chat (default)
BISU_MODEL=qwen/qwen3-coder bisu      # any OpenRouter slug
```

## Honest limits

- Claude Code is tuned for Claude. Non-Claude models are noticeably worse at its tool calls — give `bisu` mechanical work, not architecture.
- Subscription-only features (connectors, remote control, scheduled tasks) are off in `bisu` sessions.
- In use-only mode, responses are buffered (no streaming) and a single request is capped at ~200 s.

## Why not open-codex?

[open-codex](https://github.com/ymichael/open-codex) proved the idea — swap the base URL, run any model — but it froze in May 2025 and takes your key as plain env. `bisu` does the same swap on today's officially supported path (`ANTHROPIC_BASE_URL`), and treats the key as something no process should ever hold.

## License

Apache-2.0
