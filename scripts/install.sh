#!/bin/sh
# S.A.M. one-command install for a fresh clone:
#
#   git clone https://github.com/ReactionLabs/sam.git
#   cd sam
#   ./scripts/install.sh
#
# Checks the toolchain, installs dependencies, builds, and hands off
# to `sam setup`, which takes the model key (hidden input), verifies
# it with one real model call, and stores it in the workspace's
# sam.env. Any arguments are passed straight through to `sam setup`
# (for example: ./scripts/install.sh --workspace ~/sam-home
# --key-env MINIMAX_API_KEY).
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "S.A.M. needs Node.js 22 or newer. Install Node from https://nodejs.org and run this again." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "S.A.M. needs Node.js 22 or newer; this machine has $(node --version)." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found next to Node; reinstall Node from https://nodejs.org and run this again." >&2
  exit 1
fi

echo "Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

echo "Building..."
npm run build

echo "Dependencies installed and built. Continuing into guided setup..."
exec node dist/cli.js setup "$@"
