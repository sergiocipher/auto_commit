#!/usr/bin/env bash
# Fails if the staged diff (or, with --all, the tracked tree) contains
# token-like strings. Used by the pre-commit hook; see AGENT_PROMPT §15.1.
set -euo pipefail

PATTERN='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|APP_ENCRYPTION_KEY=[A-Za-z0-9+/_-]{16,}=*)'

if [[ "${1:-}" == "--all" ]]; then
  content=$(git grep -nE "$PATTERN" -- . ':!scripts/check-secrets.sh' || true)
else
  content=$(git diff --cached -U0 --no-color -- . ':!scripts/check-secrets.sh' | grep -E '^\+' | grep -E "$PATTERN" || true)
fi

if [[ -n "$content" ]]; then
  echo "check-secrets: possible secret detected; refusing to continue:" >&2
  echo "$content" | sed -E 's/(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]{4}[A-Za-z0-9_]*/\1****[redacted]/g' >&2
  exit 1
fi
