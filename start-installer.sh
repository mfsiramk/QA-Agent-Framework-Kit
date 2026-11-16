#!/usr/bin/env sh
# QA Agent Framework - setup launcher for macOS / Linux.  Run: ./start-installer.sh
cd "$(dirname "$0")" || exit 1

echo ""
echo " QA Agent Framework - Setup"
echo " =========================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo " Node.js is not installed - it is required to run the setup wizard and the agents."
  echo " Install the LTS version from https://nodejs.org/en/download (or: brew install node), then run this again."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo " Node.js $MAJOR is too old - version 18 or newer is required."
  echo " Install the LTS version from https://nodejs.org/en/download, then run this again."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo " [note] Git was not found. You need it if you have an automation repository: https://git-scm.com/downloads"
  echo ""
fi

echo " Starting the setup wizard in your browser... (Ctrl+C to stop)"
exec node installer/server.js "$@"
