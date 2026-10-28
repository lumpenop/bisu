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
root="${0:A:h}"
agents="$(<"$4")"
shift 4
# Tools: Claude Code's core set only. The full default set (plus any MCP servers from your Claude config, which bisu can't
# use anyway) is ~25k tokens of tool definitions sent with every request; the core set is ~6k. BISU_TOOLS=default restores it.
# SendMessage, TaskStop and TaskOutput are the team: send a worker back with feedback (it carries on with
# everything it did), stop one, read where one is.
tools="${BISU_TOOLS:-Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit,SendMessage,TaskStop,TaskOutput}"
extra=()
[ -n "$BISU_EFFORT" ] && extra+=(--effort "$BISU_EFFORT")

# System prompt: prompt.md, then the memory the person saved (ui/memory.mjs). Built once per run,
# because memory is what carries across sessions and Claude Code reads this file at startup only —
# a chat that is already open keeps the memory it began with.
# BISU_PROMPT swaps the base file: the scheduled suggestion run is given prompt-suggest.md instead,
# with the same memory appended.
# Node is optional here: the terminal bisu should still start on a Mac without it, just with no memory.
# bisu's own engine (BISU_ENGINE=native) has its own base prompt; jobs and suggestions keep theirs.
if [ "${BISU_ENGINE:-}" = native ] && [ -z "$BISU_PROMPT" ]; then base="$root/engine/prompt.md"
else base="${BISU_PROMPT:-$root/prompt.md}"; fi
# One file per base prompt: a suggestion run and a chat can be starting at the same moment, and they
# must not overwrite each other's system prompt.
if [ -n "$BISU_PROMPT" ] || [ "${BISU_ENGINE:-}" = native ]; then
  sysprompt="$HOME/Library/Application Support/bisu/system-prompt-${BISU_ENGINE:-claude}-${base:t:r}.md"
else
  sysprompt="$HOME/Library/Application Support/bisu/system-prompt.md"
fi
# One file per bot (and for the bot-making conversation): two bots starting at once must not share one.
[ -n "$BISU_BOT" ] && [ "$BISU_BOT" != bisu ] && sysprompt="${sysprompt:r}-bot-${BISU_BOT}.md"
[ "$BISU_BOT_MAKER" = 1 ] && sysprompt="${sysprompt:r}-maker.md"
mkdir -p "${sysprompt:h}"
# bisu's prompt, then the bot's block (its job, way of working, tone; ui/bots.mjs), then its memory.
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

# bisu's own MCP server (ui/cu/server.mjs), two things in one process:
#  - past sessions: session_search / session_show over the FTS5 index of earlier conversations
#    (ui/sessions.mjs). Pre-allowed: they only read transcripts of bisu's own runs
#    (BISU_SEARCH_ALL=1 widens that to every Claude Code transcript on this Mac).
#  - computer use: a step on the Mac is one tool call with real coordinates instead of a shell
#    script that guesses. The read/look/act tools are pre-allowed because the person already asked
#    bisu to drive the Mac; cu_approve is deliberately absent, so running a destructive step goes
#    through the approval card like any other risky action. BISU_CU=0 leaves computer use out.
mcp=""
if [ -f "$root/ui/cu/server.mjs" ] && command -v node >/dev/null 2>&1; then
  # One file per variant, swapped in whole: chats (computer use on) and jobs or suggestions (off) start
  # at the same moment, and one must never read the other's half-written config.
  mcp="$HOME/Library/Application Support/bisu/mcp-cu${BISU_CU:-1}-all${BISU_SEARCH_ALL:-0}.json"
  mkdir -p "${mcp:h}"
  cat > "$mcp.$$.tmp" <<JSON
{"mcpServers":{"bisu":{"command":"$(command -v node)","args":["$root/ui/cu/server.mjs"],"env":{"BISU_CU":"${BISU_CU:-1}","BISU_SEARCH_ALL":"${BISU_SEARCH_ALL:-0}","BISU_CU_VISION_MODEL":"${BISU_CU_VISION_MODEL:-z-ai/glm-5.3-flash}","BISU_CU_DECISION_MODEL":"${BISU_CU_DECISION_MODEL:-gpt-6-luna}"}}}}
JSON
  mv -f "$mcp.$$.tmp" "$mcp"
  extra+=(--mcp-config "$mcp" --strict-mcp-config)
  # The calendar, web search, goals and the browser too, except deleting from the calendar and pressing a step the
  # browser held (paying, sending, booking), which ask.
  allowed="mcp__bisu__session_search,mcp__bisu__session_show,mcp__bisu__web_search,mcp__bisu__calendar_list,mcp__bisu__calendar_add,mcp__bisu__calendar_change,mcp__bisu__reminders_list,mcp__bisu__reminder_add,mcp__bisu__reminder_change,mcp__bisu__goal_add,mcp__bisu__goal_list,mcp__bisu__goal_update,mcp__bisu__browser_task,mcp__bisu__browser_check,mcp__bisu__browser_read,mcp__bisu__bot_handoff"
  # A goal session (ui/goals.mjs) may only look, add events and reminders, and write its own goal.
  [ -n "$BISU_GOAL_ID" ] && allowed="mcp__bisu__session_search,mcp__bisu__session_show,mcp__bisu__web_search,mcp__bisu__calendar_list,mcp__bisu__calendar_add,mcp__bisu__reminders_list,mcp__bisu__reminder_add,mcp__bisu__reminder_change,mcp__bisu__goal_update"
  [ "${BISU_CU:-1}" != "0" ] && allowed+=",mcp__bisu__cu_look,mcp__bisu__cu_state,mcp__bisu__cu_decide,mcp__bisu__cu_click,mcp__bisu__cu_type,mcp__bisu__cu_key,mcp__bisu__cu_scroll,mcp__bisu__cu_wait,mcp__bisu__cu_screenshot,mcp__bisu__cu_ground"
  extra+=(--allowedTools "$allowed")
fi

# bisu's own engine speaks the same flags and protocol for everything bisu uses, so it starts here
# with exactly the same arguments; Claude Code's MCP config, agents and settings are ignored by it.
if [ "${BISU_ENGINE:-}" = native ]; then
  exec node "$root/engine/cli.mjs" --tools "$tools" --append-system-prompt-file "$sysprompt" "${extra[@]}" "$@"
fi
exec claude --agents "$agents" --tools "$tools" --append-system-prompt-file "$sysprompt" "${extra[@]}" "$@"
