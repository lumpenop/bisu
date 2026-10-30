# dec-intern — run Claude Code against OpenRouter (cheap models) without touching your Claude subscription.
# https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
#
# Two key modes, picked automatically:
#   1. use-only (preferred): a key for https://openrouter.ai saved in a secret manager that exposes `dec-secret run`;
#      the child process gets a one-time token, never the key itself.
#   2. plain env: OPENROUTER_API_KEY is already exported in your shell.
#
# Models (any OpenRouter slug), one per role. The assistant delegates on its own through agents.json and prompt.md:
#   DEC_INTERN_MODEL       assistant: talks, decides, delegates, checks results  (default: z-ai/glm-5.3)
#   DEC_INTERN_DEV_MODEL   development work (developer agent), background calls (default: deepseek/deepseek-v4.1-flash)
#   DEC_INTERN_CODE_MODEL  large publishing and refactoring jobs                (default: qwen/qwen3.8-max-0902)
# DEC_INTERN_FAST_MODEL is the old name of DEC_INTERN_DEV_MODEL and still works.

_dec_intern_dir="${${(%):-%x}:A:h}"

# Models saved by `dec-intern ui`: plain KEY=value lines, read without running anything. Exported DEC_INTERN_* win over these.
_dec_intern_config() {
  local file="${XDG_CONFIG_HOME:-$HOME/.config}/dec-intern/models" k v
  [ -r "$file" ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in DEC_INTERN_MODEL|DEC_INTERN_CODE_MODEL|DEC_INTERN_DEV_MODEL|DEC_INTERN_FAST_MODEL) [[ "$v" == [a-z0-9]*/[A-Za-z0-9]* ]] && print -r -- "$k=$v";; esac
  done < "$file"
}

dec-intern() {
  # bisu's data (the name until 2026-10-30) moves to dec-intern's once, before anything here reads it (ui/migrate.mjs).
  if [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/bisu" ] && [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/dec-intern" ] && command -v node >/dev/null 2>&1; then
    node "$_dec_intern_dir/ui/migrate.mjs"
  fi
  local ref="" glm="" oai="" saved list=""
  local -a keys
  # Use-only keys from Dec, found by site: OpenRouter for the Claude Code engine, Z.ai (GLM) and
  # OpenAI (Decisions) for Dec Intern's own engine. Each one present is passed as a dec:// reference.
  command -v dec-secret >/dev/null 2>&1 && list="$(dec-secret list 2>/dev/null)"
  ref="$(print -r -- "$list" | awk '$2=="https://openrouter.ai"{print $1; exit}')"
  glm="$(print -r -- "$list" | awk '$2=="https://api.z.ai"{print $1; exit}')"
  oai="$(print -r -- "$list" | awk '$2=="https://api.openai.com"{print $1; exit}')"
  [ -n "$ref" ] && keys+=("OPENROUTER_API_KEY=$ref")
  [ -n "$glm" ] && keys+=("GLM_API_KEY=$glm")
  [ -n "$oai" ] && keys+=("OPENAI_API_KEY=$oai")
  # Every key saved for the model sites, for the engine's key order (engine/routes.mjs; the order is dec's
  # model-routes.json): DEC_INTERN_RK<n>_API_KEY each, listed in DEC_INTERN_ROUTE_KEYS as "n|name|site".
  local rk="" n=0 line r s
  for line in ${(f)list}; do
    r="${${(z)line}[1]}"; s="${${(z)line}[2]}"
    [[ "$r" == dec://* && "$r" != dec://env/* ]] || continue
    [[ "$s" == https://openrouter.ai || "$s" == https://api.z.ai || "$s" == https://api.openai.com ]] || continue
    (( n++ < 12 )) || break
    keys+=("DEC_INTERN_RK${n}_API_KEY=$r"); rk+="${rk:+;}$n|${r#dec://}|$s"
  done
  [ -n "$rk" ] && keys+=("DEC_INTERN_ROUTE_KEYS=$rk")
  # dec-intern ui: local page for models per role, real OpenRouter spend and past runs (same key, same use-only rules).
  if [ "$1" = ui ]; then
    shift
    command -v node >/dev/null 2>&1 || { echo "dec-intern ui needs node" >&2; return 1; }
    if (( ${#keys} )); then env "${keys[@]}" dec-secret run -- node "$_dec_intern_dir/ui/server.mjs" "$@"
    else node "$_dec_intern_dir/ui/server.mjs" "$@"; fi
    return
  fi
  # dec-intern suggest: what the menu-bar app brings on its own, once, printed here. Same state file, so it
  # also counts as the one suggestion of the day for the app.
  if [ "$1" = suggest ]; then
    shift
    command -v node >/dev/null 2>&1 || { echo "dec-intern suggest needs node" >&2; return 1; }
    if (( ${#keys} )); then
      env "${keys[@]}" dec-secret run -- node "$_dec_intern_dir/ui/proactive.mjs" run
    else
      node "$_dec_intern_dir/ui/proactive.mjs" run
    fi
    return
  fi
  # dec-intern app: the same dec-intern as a menu-bar app (⌥Space) with what you were looking at as context.
  #   dec-intern app           open the installed app (~/Applications/Dec Intern.app), building it if missing
  #   dec-intern app install   rebuild the .app from this folder (after changing dec-intern)
  #   dec-intern app electron  run the working tree in the old Electron shell, for comparison
  if [ "$1" = app ] || [ "$1" = desktop ]; then
    shift
    local appdir="$_dec_intern_dir/mac"
    local bundle="${DEC_INTERN_APP_DIR:-$HOME/Applications}/Dec Intern.app"
    # `dec-intern app electron` still runs the old Electron shell from the working tree, for comparison.
    # Everything else builds the native one: one AppKit process and a WebKit view instead of four
    # Chromium processes, and no 120 MB Electron download on first run.
    if [ "$1" = electron ] || [ "$1" = dev ]; then
      shift
      local el="$appdir/node_modules/.bin/electron"
      if [ ! -x "$el" ]; then
        command -v npm >/dev/null 2>&1 || { echo "dec-intern app electron needs node and npm" >&2; return 1; }
        echo "dec-intern app: installing Electron (~120 MB)…" >&2
        ( cd "$appdir" && npm install --no-audit --no-fund ) || return 1
      fi
      ( cd "$appdir" && exec "$el" . "$@" )
    fi
    if [ "$1" = install ] || { [ "$1" != open ] && [ ! -d "$bundle" ]; }; then
      [ "$1" = install ] && shift
      "$appdir/native/build.sh" || return 1
      [ "$#" -gt 0 ] || return 0
    else
      [ "$1" = open ] && shift
    fi
    open -a "$bundle" --args "$@"
    return 0
  fi
  saved="$(_dec_intern_config)"
  local -A cfg
  local line; for line in ${(f)saved}; do cfg[${line%%=*}]="${line#*=}"; done
  local main="${DEC_INTERN_MODEL:-${cfg[DEC_INTERN_MODEL]:-z-ai/glm-5.3}}" code="${DEC_INTERN_CODE_MODEL:-${cfg[DEC_INTERN_CODE_MODEL]:-qwen/qwen3.8-max-0902}}"
  local dev="${DEC_INTERN_DEV_MODEL:-${DEC_INTERN_FAST_MODEL:-${cfg[DEC_INTERN_DEV_MODEL]:-${cfg[DEC_INTERN_FAST_MODEL]:-deepseek/deepseek-v4.1-flash}}}}" agents="$_dec_intern_dir/agents.json"
  if [ -n "$ref" ] || { [ "$DEC_INTERN_ENGINE" = native ] && [ -n "$glm" ]; }; then
    env "${keys[@]}" dec-secret run -- \
      zsh -f "$_dec_intern_dir/launch.zsh" "$main" "$code" "$dev" "$agents" "$@"
  elif [ -n "$OPENROUTER_API_KEY" ] || [ -n "$GLM_API_KEY" ]; then
    zsh -f "$_dec_intern_dir/launch.zsh" "$main" "$code" "$dev" "$agents" "$@"
  else
    echo "dec-intern: no OpenRouter key found." >&2
    echo "  either save a use-only key for https://openrouter.ai in your secret manager (dec-secret)," >&2
    echo "  or export OPENROUTER_API_KEY in your shell." >&2
    return 1
  fi
}
