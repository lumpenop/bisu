#!/bin/sh
# Installs the dec-intern function into ~/.zshrc (idempotent).
set -e

command -v claude >/dev/null 2>&1 || {
  echo "dec-intern needs Claude Code. Install it first: https://code.claude.com" >&2
  exit 1
}

DIR="$(cd "$(dirname "$0")" && pwd)"
RC="$HOME/.zshrc"
LINE="source \"$DIR/dec-intern.zsh\""

# A ~/.zshrc that still sources bisu.zsh (the name until 2026-10-30) is pointed at the new file.
if grep -qF "$DIR/bisu.zsh" "$RC" 2>/dev/null; then
  sed -i '' -e "s|^# bisu — Claude Code on OpenRouter|# dec-intern — Claude Code on OpenRouter|" -e "s|source \"$DIR/bisu.zsh\"|$LINE|" "$RC"
  echo "updated $RC: bisu.zsh → dec-intern.zsh — open a new terminal and run: dec-intern"
elif grep -qF "$LINE" "$RC" 2>/dev/null; then
  echo "already installed in $RC"
else
  printf '\n# dec-intern — Claude Code on OpenRouter\n%s\n' "$LINE" >> "$RC"
  echo "added to $RC — open a new terminal and run: dec-intern"
fi
