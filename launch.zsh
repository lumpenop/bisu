#!/bin/zsh -f
# Starts Claude Code against OpenRouter. Used by `dec-intern` and by `dec-intern ui`, always as: zsh -f launch.zsh MAIN CODE DEV AGENTS [claude args...]
# Runs in a fresh zsh: drops every inherited CLAUDE*/ANTHROPIC* variable (a host app's login token would otherwise win over
# ours), then points Claude Code at OpenRouter, or at the dec-secret proxy for it (OPENROUTER_BASE_URL + one-time token).
for v in ${(k)parameters[(I)(CLAUDE|ANTHROPIC)*]}; do unset $v; done
# `dec-secret` by name for Bash (the person's keys, use-only; engine/keys.mjs): Dec installs it in ~/.local/bin.
[ -x "$HOME/.local/bin/dec-secret" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"
export ANTHROPIC_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai}/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="$1"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$1"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$2"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$3"
root="${0:A:h}"
agents="$(<"$4")"
shift 4
# Tools: Claude Code's core set only. The full default set (plus any MCP servers from your Claude config, which dec-intern can't
# use anyway) is ~25k tokens of tool definitions sent with every request; the core set is ~6k. DEC_INTERN_TOOLS=default restores it.
# SendMessage, TaskStop and TaskOutput are the team: send a worker back with feedback (it carries on with
# everything it did), stop one, read where one is.
tools="${DEC_INTERN_TOOLS:-Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit,SendMessage,TaskStop,TaskOutput}"
extra=()
[ -n "$DEC_INTERN_EFFORT" ] && extra+=(--effort "$DEC_INTERN_EFFORT")

# System prompt: prompt.md, then the memory the person saved (ui/memory.mjs). Built once per run,
# because memory is what carries across sessions and Claude Code reads this file at startup only —
# a chat that is already open keeps the memory it began with.
# DEC_INTERN_PROMPT swaps the base file: the scheduled suggestion run is given prompt-suggest.md instead,
# with the same memory appended.
# Node is optional here: the terminal dec-intern should still start on a Mac without it, just with no memory.
# Dec Intern's own engine (DEC_INTERN_ENGINE=native) has its own base prompt; jobs and suggestions keep theirs.
if [ "${DEC_INTERN_ENGINE:-}" = native ] && [ -z "$DEC_INTERN_PROMPT" ]; then base="$root/engine/prompt.md"
else base="${DEC_INTERN_PROMPT:-$root/prompt.md}"; fi
# One file per base prompt: a suggestion run and a chat can be starting at the same moment, and they
# must not overwrite each other's system prompt.
if [ -n "$DEC_INTERN_PROMPT" ] || [ "${DEC_INTERN_ENGINE:-}" = native ]; then
  sysprompt="$HOME/Library/Application Support/dec-intern/system-prompt-${DEC_INTERN_ENGINE:-claude}-${base:t:r}.md"
else
  sysprompt="$HOME/Library/Application Support/dec-intern/system-prompt.md"
fi
# One file per bot (and for the bot-making conversation): two bots starting at once must not share one.
[ -n "$DEC_INTERN_BOT" ] && [ "$DEC_INTERN_BOT" != dec-intern ] && sysprompt="${sysprompt:r}-bot-${DEC_INTERN_BOT}.md"
[ "$DEC_INTERN_BOT_MAKER" = 1 ] && sysprompt="${sysprompt:r}-maker.md"
mkdir -p "${sysprompt:h}"
# Dec Intern's prompt, then the bot's block (its job, way of working, tone; ui/bots.mjs), then its memory.
if [ -f "$root/ui/bots.mjs" ] && command -v node >/dev/null 2>&1 &&
   node "$root/ui/bots.mjs" prompt "$base" > "$sysprompt.$$.tmp" 2>/dev/null; then
  mv -f "$sysprompt.$$.tmp" "$sysprompt"
elif [ -f "$root/ui/memory.mjs" ] && command -v node >/dev/null 2>&1 &&
   node "$root/ui/memory.mjs" prompt "$base" > "$sysprompt.$$.tmp" 2>/dev/null; then
  mv -f "$sysprompt.$$.tmp" "$sysprompt"
else
  rm -f "$sysprompt.$$.tmp"
  cp "$base" "$sysprompt"
fi

# Dec Intern's own MCP server (ui/cu/server.mjs), two things in one process:
#  - past sessions: session_search / session_show over the FTS5 index of earlier conversations
#    (ui/sessions.mjs). Pre-allowed: they only read transcripts of Dec Intern's own runs
#    (DEC_INTERN_SEARCH_ALL=1 widens that to every Claude Code transcript on this Mac).
#  - computer use: a step on the Mac is one tool call with real coordinates instead of a shell
#    script that guesses. The read/look/act tools are pre-allowed because the person already asked
#    dec-intern to drive the Mac; cu_approve is deliberately absent, so running a destructive step goes
#    through the approval card like any other risky action. DEC_INTERN_CU=0 leaves computer use out.
mcp=""
if [ -f "$root/ui/cu/server.mjs" ] && command -v node >/dev/null 2>&1; then
  # One file per variant, swapped in whole: chats (computer use on) and jobs or suggestions (off) start
  # at the same moment, and one must never read the other's half-written config.
  mcp="$HOME/Library/Application Support/dec-intern/mcp-cu${DEC_INTERN_CU:-1}-all${DEC_INTERN_SEARCH_ALL:-0}.json"
  mkdir -p "${mcp:h}"
  cat > "$mcp.$$.tmp" <<JSON
{"mcpServers":{"dec-intern":{"command":"$(command -v node)","args":["$root/ui/cu/server.mjs"],"env":{"DEC_INTERN_CU":"${DEC_INTERN_CU:-1}","DEC_INTERN_SEARCH_ALL":"${DEC_INTERN_SEARCH_ALL:-0}","DEC_INTERN_CU_VISION_MODEL":"${DEC_INTERN_CU_VISION_MODEL:-z-ai/glm-5.3-flash}","DEC_INTERN_CU_DECISION_MODEL":"${DEC_INTERN_CU_DECISION_MODEL:-gpt-6-luna}"}}}}
JSON
  mv -f "$mcp.$$.tmp" "$mcp"
  extra+=(--mcp-config "$mcp" --strict-mcp-config)
  # The calendar, web search, goals and the browser too, except deleting from the calendar and pressing a step the
  # browser held (paying, sending, booking), which ask.
  allowed="mcp__dec-intern__session_search,mcp__dec-intern__session_show,mcp__dec-intern__web_search,mcp__dec-intern__calendar_list,mcp__dec-intern__calendar_add,mcp__dec-intern__calendar_change,mcp__dec-intern__reminders_list,mcp__dec-intern__reminder_add,mcp__dec-intern__reminder_change,mcp__dec-intern__goal_add,mcp__dec-intern__goal_list,mcp__dec-intern__goal_update,mcp__dec-intern__browser_task,mcp__dec-intern__browser_check,mcp__dec-intern__browser_read,mcp__dec-intern__browser_tabs,mcp__dec-intern__browser_routine,mcp__dec-intern__browser_show,mcp__dec-intern__secret_list,mcp__dec-intern__bot_handoff,mcp__dec-intern__bot_memory,mcp__dec-intern__profile_set,mcp__dec-intern__claude_sessions"
  # A goal session (ui/goals.mjs) may only look, add events and reminders, and write its own goal.
  [ -n "$DEC_INTERN_GOAL_ID" ] && allowed="mcp__dec-intern__session_search,mcp__dec-intern__session_show,mcp__dec-intern__web_search,mcp__dec-intern__calendar_list,mcp__dec-intern__calendar_add,mcp__dec-intern__reminders_list,mcp__dec-intern__reminder_add,mcp__dec-intern__reminder_change,mcp__dec-intern__goal_update"
  [ "${DEC_INTERN_CU:-1}" != "0" ] && allowed+=",mcp__dec-intern__cu_look,mcp__dec-intern__cu_state,mcp__dec-intern__cu_decide,mcp__dec-intern__cu_click,mcp__dec-intern__cu_type,mcp__dec-intern__cu_key,mcp__dec-intern__cu_scroll,mcp__dec-intern__cu_wait,mcp__dec-intern__cu_screenshot,mcp__dec-intern__cu_ground"
  extra+=(--allowedTools "$allowed")
fi

# Dec Intern's own engine speaks the same flags and protocol for everything dec-intern uses, so it starts here
# with exactly the same arguments; Claude Code's MCP config, agents and settings are ignored by it.
if [ "${DEC_INTERN_ENGINE:-}" = native ]; then
  exec node "$root/engine/cli.mjs" --tools "$tools" --append-system-prompt-file "$sysprompt" "${extra[@]}" "$@"
fi
exec claude --agents "$agents" --tools "$tools" --append-system-prompt-file "$sysprompt" "${extra[@]}" "$@"
