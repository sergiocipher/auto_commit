#!/usr/bin/env bash
# Checks a built backend image for secrets (AGENT_PROMPT §11):
# layer history, image config (env, labels) and the filesystem.
#   scripts/check-image.sh [image] [env-file]
# With an env file, its secret values must not appear anywhere either.
set -euo pipefail

image="${1:-coding-submission-tracker:local}"
env_file="${2:-}"
PATTERN='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|APP_ENCRYPTION_KEY=[A-Za-z0-9+/_-]{16,})'
fail=0

meta=$(docker history --no-trunc "$image"; docker image inspect "$image")
if grep -Eq "$PATTERN" <<<"$meta"; then echo "FAIL: token-like string in image history/config"; fail=1; fi

if [[ -n "$env_file" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^(APP_ENCRYPTION_KEY|APP_ENCRYPTION_OLD_KEYS|POSTGRES_PASSWORD|GITHUB_CLIENT_SECRET)$ ]] || continue
    [[ -n "$value" ]] || continue
    if grep -qF -- "$value" <<<"$meta"; then echo "FAIL: value of $key found in image history/config"; fail=1; fi
  done < "$env_file"
fi

# System CA bundles (/etc/ssl*, public certificates) are expected; private
# keys anywhere are caught by the content scan below.
files=$(docker run --rm --entrypoint sh "$image" -c \
  'find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" \) \
     -not -path "/proc/*" -not -path "/etc/ssl*" -not -path "/usr/share/ca-certificates/*" \
     -not -name ".env.example" 2>/dev/null || true')

if docker run --rm --entrypoint sh "$image" -c \
  "grep -rlI -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' /app /home /root 2>/dev/null | head -3" | grep -q .; then
  echo "FAIL: private key in image"; fail=1
fi
if [[ -n "$files" ]]; then echo "FAIL: secret-looking files in image:"; echo "$files"; fail=1; fi

if docker run --rm --entrypoint sh "$image" -c "grep -rElI '$PATTERN' /app 2>/dev/null | head -5" | grep -q .; then
  echo "FAIL: token-like string in /app"; fail=1
fi

user=$(docker image inspect --format '{{.Config.User}}' "$image")
if [[ -z "$user" || "$user" == "root" || "$user" == "0" ]]; then echo "FAIL: image runs as root"; fail=1; fi

[[ $fail -eq 0 ]] && echo "check-image: no secrets found in $image (runs as $user)"
exit $fail
