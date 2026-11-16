#!/bin/sh
# QA Agent Framework - double-click launcher for macOS (opens in Terminal).
# Runs start-installer.sh through "sh", so it works even if the .sh file lost its executable flag.
cd "$(dirname "$0")" || exit 1
sh ./start-installer.sh "$@"
status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo " The setup wizard stopped with an error - see the message above."
  printf " Press Return to close this window... "
  read -r _
fi
exit $status
