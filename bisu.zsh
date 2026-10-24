# bisu — run Claude Code against OpenRouter (cheap models) without touching your Claude subscription.
# https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
#
# Two key modes, picked automatically:
#   1. use-only (preferred): the key lives in a secret manager that exposes `dec-secret run`;
#      the child process gets a one-time token, never the key itself.
#   2. plain env: OPENROUTER_API_KEY is already exported in your shell.
#
# Model: set BISU_MODEL to any OpenRouter slug (default: deepseek/deepseek-chat).

bisu() {
  local model="${BISU_MODEL:-deepseek/deepseek-chat}"
  if command -v dec-secret >/dev/null 2>&1 && dec-secret list 2>/dev/null | grep -qi 'openrouter'; then
    OPENROUTER_API_KEY=dec://OpenRouter \
    dec-secret run -- zsh -c '
      export ANTHROPIC_BASE_URL="$OPENROUTER_BASE_URL/api"
      export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
      export ANTHROPIC_API_KEY=""
      export ANTHROPIC_MODEL="$1"
      export ANTHROPIC_DEFAULT_HAIKU_MODEL="$1"
      export ANTHROPIC_DEFAULT_SONNET_MODEL="$1"
      export ANTHROPIC_DEFAULT_OPUS_MODEL="$1"
      shift
      exec claude "$@"' zsh "$model" "$@"
  elif [ -n "$OPENROUTER_API_KEY" ]; then
    ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
    ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" \
    ANTHROPIC_API_KEY="" \
    ANTHROPIC_MODEL="$model" \
    ANTHROPIC_DEFAULT_HAIKU_MODEL="$model" \
    ANTHROPIC_DEFAULT_SONNET_MODEL="$model" \
    ANTHROPIC_DEFAULT_OPUS_MODEL="$model" \
    claude "$@"
  else
    echo "bisu: no OpenRouter key found." >&2
    echo "  either save a use-only key named 'OpenRouter' in your secret manager (dec-secret)," >&2
    echo "  or export OPENROUTER_API_KEY in your shell." >&2
    return 1
  fi
}
