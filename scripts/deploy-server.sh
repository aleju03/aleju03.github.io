#!/usr/bin/env bash
# Deploy the chat/world server (server/) to the production VPS.
#
# The VPS keeps a clone of this repo at ~/apps/aleju03.github.io and its own
# ~/apps/redeploy-chat.sh, which pulls that clone, rsyncs server/ into
# /opt/portfolio-chat (data/ untouched), installs, restarts the
# portfolio-chat systemd unit and checks /health. This is the local half:
# it refuses to deploy anything the VPS could not pull (a dirty server/, or
# a main that is not on origin), runs the smoke test, runs the remote script
# over a terminal (its sudo asks for your password there), and then checks
# the VPS really ended up on the commit you have.
#
# The frontend deploys itself on push (GitHub Pages); the protocol has no
# version negotiation, so push first and run this straight after.
#
# Usage: npm run deploy:server            (or scripts/deploy-server.sh)
#        npm run deploy:server -- --skip-tests
set -euo pipefail

HOST=vps
REMOTE_REPO='~/apps/aleju03.github.io'
REMOTE_SCRIPT='~/apps/redeploy-chat.sh'

root=$(git rev-parse --show-toplevel)
cd "$root"

skip_tests=0
for a in "$@"; do
  case "$a" in
    --skip-tests) skip_tests=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != main ]; then
  echo "✗ on '$branch': the VPS pulls main" >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- server)" ]; then
  echo "✗ server/ has uncommitted changes; commit and push them first" >&2
  git status --short -- server >&2
  exit 1
fi

echo "==> Checking main is pushed"
git fetch -q origin main
local_head=$(git rev-parse HEAD)
if [ "$local_head" != "$(git rev-parse origin/main)" ]; then
  echo "✗ local main and origin/main differ; push (or pull) first" >&2
  git status -sb | head -1 >&2
  exit 1
fi

if [ "$skip_tests" = 0 ]; then
  echo "==> Server smoke test"
  (cd server && npm test)
fi

echo "==> Redeploying on $HOST (sudo will ask for your password)"
ssh -t "$HOST" "$REMOTE_SCRIPT"

remote_head=$(ssh "$HOST" "git -C $REMOTE_REPO rev-parse HEAD")
if [ "$remote_head" != "$local_head" ]; then
  echo "✗ the VPS is on ${remote_head:0:7}, not ${local_head:0:7}" >&2
  exit 1
fi
echo "✓ server deployed at ${local_head:0:7} ($(git log -1 --format=%s | cut -c1-60))"
