#!/bin/zsh -f
# Starts Claude Code against OpenRouter. Used by `bisu` and by `bisu ui`, always as: zsh -f launch.zsh MAIN CODE DEV AGENTS [claude args...]
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
# Tools: Claude Code's core set only. The full default set (plus any MCP servers from your Claude config, which bisu can't
# use anyway) is ~25k tokens of tool definitions sent with every request; the core set is ~6k. BISU_TOOLS=default restores it.
tools="${BISU_TOOLS:-Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit}"
extra=()
[ -n "$BISU_EFFORT" ] && extra+=(--effort "$BISU_EFFORT")
exec claude --agents "$agents" --tools "$tools" --strict-mcp-config --append-system-prompt-file "${0:A:h}/prompt.md" "${extra[@]}" "$@"
