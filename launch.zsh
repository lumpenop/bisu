#!/bin/zsh -f
# Starts Claude Code against OpenRouter. Used by `bisu` and by `bisu ui`, always as: zsh -f launch.zsh MAIN CODE FAST AGENTS [claude args...]
# Runs in a fresh zsh: drops every inherited CLAUDE*/ANTHROPIC* variable (a host app's login token would otherwise win over
# ours), then points Claude Code at OpenRouter, or at the dec-secret proxy for it (OPENROUTER_BASE_URL + one-time token).
for v in ${(k)parameters[(I)(CLAUDE|ANTHROPIC)*]}; do unset $v; done
export ANTHROPIC_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai}/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="$1"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$1"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$2"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$3"
agents="$(<"$4")"
shift 4
exec claude --agents "$agents" --append-system-prompt "Do small tasks yourself: quick edits, single-file changes, short lookups and answers. Delegating costs a full extra setup per call, so only hand off large jobs: big UI publishing to the publisher agent, big refactors to the refactorer agent, and other big jobs (bulk reading, summarising, file chores) to the helper agent. When you delegate, give one complete brief with the files, the goal and what done looks like. When a delegated job comes back, check it yourself (read the changed files, run a quick check) before telling the user it is done. Do the deciding and the final answer yourself." "$@"
