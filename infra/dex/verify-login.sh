#!/usr/bin/env bash
#
# Drive a full authorization-code + PKCE sign-in against the local Dex and assert what comes
# back — the same flow apps/console runs, reduced to curl so it can be checked without a browser.
#
# This exists because the interesting part of infra/dex/config.yaml is not that Dex starts, it is
# that the *access token* the console seals into its session cookie carries an audience the
# gateway accepts and an email a seeded principal matches. Both are claims about a token, and a
# claim about a token is worth exactly as much as the assertion that reads it.
#
#   ./infra/dex/verify-login.sh                                  # priya (lead)
#   ./infra/dex/verify-login.sh daniel.tester@northwind.example daniel-local-dev-only
#   CROSS_CLIENT=0 ./infra/dex/verify-login.sh                   # the rejection, on purpose
#
# With CROSS_CLIENT=0 the cross-client scope is dropped and the token comes back with
# `aud: wispr-console`, which is what the console's fixed scope list produces today and what the
# gateway refuses. Requires the stack up (`make db-up`), curl and python3. Nothing here writes to
# the database, so it is safe to run while another track is using the shared Compose stack.
set -euo pipefail

EMAIL="${1:-priya.lead@northwind.example}"
PASSWORD="${2:-priya-local-dev-only}"

ISSUER="${OIDC_ISSUER_URL:-http://localhost:5556/dex}"
CLIENT_ID="${OIDC_CLIENT_ID:-wispr-console}"
AUDIENCE="${OIDC_AUDIENCE:-wispr-gateway}"
REDIRECT_URI="${OIDC_REDIRECT_URI:-http://localhost:3000/auth/callback}"

SCOPE='openid email profile'
if [ "${CROSS_CLIENT:-1}" != '0' ]; then
  # Dex's spelling of "mint this token for that other service". See the audience discussion in
  # config.yaml: the alternative is pointing the gateway's OIDC_AUDIENCE at the console's own
  # client id, which passes the check by emptying it.
  SCOPE="$SCOPE audience:server:client_id:$AUDIENCE"
fi

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
location() { grep -i '^location:' | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation: //'; }

# PKCE built the way apps/console/src/auth/oidc.ts builds it: S256, base64url, unpadded.
VERIFIER=$(openssl rand 32 | b64url)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | b64url)
STATE=$(openssl rand 16 | b64url)
NONCE=$(openssl rand 16 | b64url)

# 1. Authorization request. `audience` is sent because the console sends it — Auth0 reads it, Dex
#    ignores it — so this is the real request rather than a tidied one.
connector=$(curl -sS -i -c "$JAR" -b "$JAR" -G "$ISSUER/auth" \
  --data-urlencode 'response_type=code' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "scope=$SCOPE" \
  --data-urlencode "audience=$AUDIENCE" \
  --data-urlencode "state=$STATE" \
  --data-urlencode "nonce=$NONCE" \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode 'code_challenge_method=S256' | location)

# 2. Local connector, then its login form.
login=$(curl -sS -i -c "$JAR" -b "$JAR" "$ISSUER${connector#/dex}" | location)

# 3. Real credentials, checked against the bcrypt hash in config.yaml.
callback=$(curl -sS -i -c "$JAR" -b "$JAR" -X POST "$ISSUER${login#/dex}" \
  --data-urlencode "login=$EMAIL" --data-urlencode "password=$PASSWORD" | location)

case "$callback" in
  /dex/approval*) callback=$(curl -sS -i -c "$JAR" -b "$JAR" "$ISSUER${callback#/dex}" | location) ;;
esac

code=$(printf '%s' "$callback" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
returned_state=$(printf '%s' "$callback" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')

if [ -z "$code" ]; then
  echo "no authorization code — Dex sent the browser to: ${callback:-<nothing>}" >&2
  echo "(a 401 here means the password was refused; check .env.example for the fixture ones)" >&2
  exit 1
fi
[ "$returned_state" = "$STATE" ] || { echo "state mismatch: this is not our sign-in" >&2; exit 1; }

# 4. Token exchange. Public client: the PKCE verifier stands in for a client secret.
tokens=$(curl -sS -X POST "$ISSUER/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=$code" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$VERIFIER")

AUDIENCE="$AUDIENCE" EMAIL="$EMAIL" ISSUER="$ISSUER" python3 - "$tokens" <<'PY'
import base64, json, os, sys

tokens = json.loads(sys.argv[1])
if 'access_token' not in tokens:
    print('the token endpoint returned no access token:', json.dumps(tokens, indent=2))
    raise SystemExit(1)

def claims(jwt: str) -> dict:
    payload = jwt.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))

# The access token, not the ID token: apps/console/src/auth/session.ts seals `access_token` into
# the session cookie and that is the credential the gateway sees. Dex mints both through the same
# code path, so the audience and email land on this one too — but that is a property to check,
# not to assume, and providers differ.
access = claims(tokens['access_token'])
print(json.dumps(access, indent=2))

audience = os.environ['AUDIENCE']
aud = access.get('aud')
aud = aud if isinstance(aud, list) else [aud]

failures = []
if os.environ['ISSUER'] != access.get('iss'):
    failures.append(f'iss is {access.get("iss")!r}, not {os.environ["ISSUER"]!r}')
if audience not in aud:
    failures.append(f'aud is {aud!r} and does not contain {audience!r} — the gateway will reject it')
if access.get('email') != os.environ['EMAIL']:
    failures.append(f'email is {access.get("email")!r}, not {os.environ["EMAIL"]!r}')
if not access.get('sub'):
    failures.append('no sub')
if not access.get('exp'):
    failures.append('no exp — the gateway refuses a credential that never expires')

if failures:
    print('\nFAILED:')
    for failure in failures:
        print(f'  - {failure}')
    raise SystemExit(1)

print(f'\nOK: access token carries aud {aud}, email {access["email"]}, and expires.')
PY
