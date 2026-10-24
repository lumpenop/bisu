# bisu — run Claude Code against OpenRouter (cheap models) without touching your Claude subscription.
# https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
#
# Two key modes, picked automatically:
#   1. use-only (preferred): a key for https://openrouter.ai saved in a secret manager that exposes `dec-secret run`;
#      the child process gets a one-time token, never the key itself.
#   2. plain env: OPENROUTER_API_KEY is already exported in your shell.
#
# Models (any OpenRouter slug), one per role. The assistant delegates on its own through agents.json and prompt.md:
#   BISU_MODEL       assistant: talks, decides, delegates, checks results  (default: z-ai/glm-5.3)
#   BISU_DEV_MODEL   development work (developer agent), background calls (default: deepseek/deepseek-v4.1-flash)
#   BISU_CODE_MODEL  large publishing and refactoring jobs                (default: qwen/qwen3.8-max-0902)
# BISU_FAST_MODEL is the old name of BISU_DEV_MODEL and still works.

_bisu_dir="${${(%):-%x}:A:h}"

# Models saved by `bisu ui`: plain KEY=value lines, read without running anything. Exported BISU_* win over these.
_bisu_config() {
  local file="${XDG_CONFIG_HOME:-$HOME/.config}/bisu/models" k v
  [ -r "$file" ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in BISU_MODEL|BISU_CODE_MODEL|BISU_DEV_MODEL|BISU_FAST_MODEL) [[ "$v" == [a-z0-9]*/[A-Za-z0-9]* ]] && print -r -- "$k=$v";; esac
  done < "$file"
}

bisu() {
  local ref="" saved
  command -v dec-secret >/dev/null 2>&1 &&
    ref="$(dec-secret list 2>/dev/null | awk '$2=="https://openrouter.ai"{print $1; exit}')"
  # bisu ui: local page for models per role, real OpenRouter spend and past runs (same key, same use-only rules).
  if [ "$1" = ui ]; then
    shift
    command -v node >/dev/null 2>&1 || { echo "bisu ui needs node" >&2; return 1; }
    if [ -n "$ref" ]; then OPENROUTER_API_KEY="$ref" dec-secret run -- node "$_bisu_dir/ui/server.mjs" "$@"
    else node "$_bisu_dir/ui/server.mjs" "$@"; fi
    return
  fi
  # bisu app: the same bisu as a menu-bar app (⌥Space) with what you were looking at as context.
  #   bisu app          open the installed app (~/Applications/bisu.app), building it if missing
  #   bisu app install  rebuild the .app from this folder (after changing bisu)
  #   bisu app dev      run the working tree directly in Electron
  if [ "$1" = app ] || [ "$1" = desktop ]; then
    shift
    local appdir="$_bisu_dir/mac"
    local el="$appdir/node_modules/.bin/electron"
    local bundle="${BISU_APP_DIR:-$HOME/Applications}/bisu.app"
    if [ ! -x "$el" ]; then
      command -v npm >/dev/null 2>&1 || { echo "bisu app needs node and npm" >&2; return 1; }
      echo "bisu app: installing Electron (first run, ~120 MB)…" >&2
      ( cd "$appdir" && npm install --no-audit --no-fund ) || return 1
    fi
    if [ "$1" = dev ]; then
      shift
      ( cd "$appdir" && exec "$el" . "$@" )
    fi
    if [ "$1" = install ] || { [ "$1" != open ] && [ ! -d "$bundle" ]; }; then
      [ "$1" = install ] && shift
      "$appdir/install-app.sh" || return 1
      [ "$#" -gt 0 ] || return 0
    else
      [ "$1" = open ] && shift
    fi
    open -a "$bundle" --args "$@"
    return 0
  fi
  saved="$(_bisu_config)"
  local -A cfg
  local line; for line in ${(f)saved}; do cfg[${line%%=*}]="${line#*=}"; done
  local main="${BISU_MODEL:-${cfg[BISU_MODEL]:-z-ai/glm-5.3}}" code="${BISU_CODE_MODEL:-${cfg[BISU_CODE_MODEL]:-qwen/qwen3.8-max-0902}}"
  local dev="${BISU_DEV_MODEL:-${BISU_FAST_MODEL:-${cfg[BISU_DEV_MODEL]:-${cfg[BISU_FAST_MODEL]:-deepseek/deepseek-v4.1-flash}}}}" agents="$_bisu_dir/agents.json"
  if [ -n "$ref" ]; then
    OPENROUTER_API_KEY="$ref" dec-secret run -- \
      zsh -f "$_bisu_dir/launch.zsh" "$main" "$code" "$dev" "$agents" "$@"
  elif [ -n "$OPENROUTER_API_KEY" ]; then
    zsh -f "$_bisu_dir/launch.zsh" "$main" "$code" "$dev" "$agents" "$@"
  else
    echo "bisu: no OpenRouter key found." >&2
    echo "  either save a use-only key for https://openrouter.ai in your secret manager (dec-secret)," >&2
    echo "  or export OPENROUTER_API_KEY in your shell." >&2
    return 1
  fi
}
