#!/bin/sh
# Installs the bisu function into ~/.zshrc (idempotent).
set -e

command -v claude >/dev/null 2>&1 || {
  echo "bisu needs Claude Code. Install it first: https://code.claude.com" >&2
  exit 1
}

DIR="$(cd "$(dirname "$0")" && pwd)"
RC="$HOME/.zshrc"
LINE="source \"$DIR/bisu.zsh\""

if grep -qF "$LINE" "$RC" 2>/dev/null; then
  echo "already installed in $RC"
else
  printf '\n# bisu — Claude Code on OpenRouter\n%s\n' "$LINE" >> "$RC"
  echo "added to $RC — open a new terminal and run: bisu"
fi
