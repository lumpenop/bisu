# bisu — run Claude Code against OpenRouter (cheap models) without touching your Claude subscription.
# https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
#
# Two key modes, picked automatically:
#   1. use-only (preferred): a key for https://openrouter.ai saved in a secret manager that exposes `dec-secret run`;
#      the child process gets a one-time token, never the key itself.
#   2. plain env: OPENROUTER_API_KEY is already exported in your shell.
#
# Models (any OpenRouter slug), one per role. The main assistant delegates on its own through agents.json:
#   BISU_MODEL       main assistant, decides and delegates   (default: z-ai/glm-5.3)
#   BISU_CODE_MODEL  large publishing and refactoring jobs   (default: qwen/qwen3.8-max-0902)
#   BISU_FAST_MODEL  other large jobs, plus background calls (default: deepseek/deepseek-v4.1-flash)
# Small tasks stay with the main assistant: each handoff re-sends Claude Code's whole system prompt.

_bisu_dir="${${(%):-%x}:A:h}"

# Runs in a fresh zsh: drops every inherited CLAUDE*/ANTHROPIC* variable (a host app's login token would
# otherwise win over ours), then points Claude Code at OpenRouter (or the dec-secret proxy for it).
# $1 main model, $2 code model, $3 fast model, $4 agents file; the rest goes to claude.
_bisu_launch='
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
  exec claude --agents "$agents" --append-system-prompt "Do small tasks yourself: quick edits, single-file changes, short lookups and answers. Delegating costs a full extra setup per call, so only hand off large jobs: big UI publishing to the publisher agent, big refactors to the refactorer agent, and other big jobs (bulk reading, summarising, file chores) to the helper agent. When you delegate, give one complete brief with the files, the goal and what done looks like. When a delegated job comes back, check it yourself (read the changed files, run a quick check) before telling the user it is done. Do the deciding and the final answer yourself." "$@"'

bisu() {
  local main="${BISU_MODEL:-z-ai/glm-5.3}" code="${BISU_CODE_MODEL:-qwen/qwen3.8-max-0902}"
  local fast="${BISU_FAST_MODEL:-deepseek/deepseek-v4.1-flash}" agents="$_bisu_dir/agents.json" ref=""
  command -v dec-secret >/dev/null 2>&1 &&
    ref="$(dec-secret list 2>/dev/null | awk '$2=="https://openrouter.ai"{print $1; exit}')"
  if [ -n "$ref" ]; then
    OPENROUTER_API_KEY="$ref" dec-secret run -- \
      zsh -fc "$_bisu_launch" zsh "$main" "$code" "$fast" "$agents" "$@"
  elif [ -n "$OPENROUTER_API_KEY" ]; then
    zsh -fc "$_bisu_launch" zsh "$main" "$code" "$fast" "$agents" "$@"
  else
    echo "bisu: no OpenRouter key found." >&2
    echo "  either save a use-only key for https://openrouter.ai in your secret manager (dec-secret)," >&2
    echo "  or export OPENROUTER_API_KEY in your shell." >&2
    return 1
  fi
}
