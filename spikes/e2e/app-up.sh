#!/bin/bash
# Starts the app hidden with a test socket. Usage: app-up.sh <scratch folder>
cd /home/lea/projects/terminal-cowork
export COWORK_TEST=1 COWORK_SOCK=$1/app.sock COWORK_NODE=$(command -v node) COWORK_SHELL_COMMAND="${COWORK_SHELL_COMMAND:-printf 'last login: test\n'; exec bash --norc}"
[ -n "$COWORK_REAL" ] && unset COWORK_SHELL_COMMAND  # real Claude Code instead of a plain shell
exec npx electron app --no-sandbox --force-device-scale-factor=${COWORK_SCALE:-1.5} --user-data-dir=$1/appdata
