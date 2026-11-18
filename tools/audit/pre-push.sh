#!/usr/bin/env bash
# pre-push.sh: run what ci.yml runs, locally, before every push to main; nothing red is pushed.
#
# usage: tools/audit/pre-push.sh [<base>]   (default base: origin/main, fetched first)
# Runs node --test, the self-scan of the checked-out revision, the diff and commit-message
# audit for <base>...HEAD, the pinned actionlint, the action pin check, the permissions check and the data/ writer
# check (as a pull request from this clone's git user). Exit 0 only when every check passes.
#
# The audit here reads the repository (tracked files, diffs, commit messages), never a built site:
# tools/t3cp/scan-tree.mjs is the only scan of the built site (publish.yml, and the deploy's build job). Run over
# dist/, the public audit reports the configured Plausible pa- script URL in every page's head, by design, and its
# patterns hold no exception for dist/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
BASE=${1:-origin/main}
if [ "$BASE" = origin/main ]; then git fetch -q origin main; fi
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "pre-push: no commit $BASE" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "pre-push: uncommitted changes to tracked files; commit or stash them first (CI sees only commits)" >&2
  exit 1
fi

EVENT=$(mktemp "${TMPDIR:-/tmp}/t3cp-pre-push-event.XXXXXX")
trap 'rm -f "$EVENT"' EXIT
node -e 'const [base, head, login, out] = process.argv.slice(1);
  require("node:fs").writeFileSync(out, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, user: { login } } }));' \
  "$(git rev-parse "$BASE")" "$(git rev-parse HEAD)" "$(git config user.name || echo local)" "$EVENT"

step() { echo "== pre-push: $*"; "$@"; }

step node --test --test-timeout=1800000
step node tools/audit/audit-public-tree.mjs --rev HEAD
step node tools/audit/audit-public-tree.mjs --diff "$BASE...HEAD" --messages "$BASE..HEAD" --each "$BASE..HEAD"
step tools/audit/actionlint.sh
step node tools/audit/check-action-pins.mjs
step node tools/audit/check-permissions.mjs
step node tools/audit/check-data-writers.mjs --event "$EVENT" --event-name pull_request
echo "== pre-push: all checks passed against $BASE"
