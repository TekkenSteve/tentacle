#!/usr/bin/env bash
# Tentacle e2e: install/compose/boot chain against a throwaway DSH_HOME.
# Zero user configuration: state roots default under $DSH_HOME/tentacle/,
# the admin account comes from the one-shot browser setup wizard.
# See tests/e2e/README.md. Usage: bash tests/e2e/e2e.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so a visual-check instance (tests/e2e/shot.mjs) can keep its own
# home while the suite runs: the suite wipes its DSH_HOME at step 0.
export DSH_HOME="${TENTACLE_E2E_HOME:-$REPO_ROOT/tests/.tmp/dsh-home}"
PROFILE="tentacle-e2e"
GATEWAY_PORT=18180
WEB_PORT=13080

# pnpm must not touch anything outside the workspace: sandboxed homes are
# read-only and pnpm 11's sqlite store index would fail with ERR_SQLITE_ERROR.
# Pin its home and content store under the repo's .tmp (same convention as the
# pnpm commands in HANDOFF §5).
export PNPM_HOME="$REPO_ROOT/.tmp/pnpm-home"
export npm_config_store_dir="$REPO_ROOT/.tmp/pnpm-store"
mkdir -p "$PNPM_HOME" "$npm_config_store_dir"

echo "== 0. clean =="
rm -rf "$DSH_HOME"
mkdir -p "$DSH_HOME"

echo "== 1. init profile from shipped web template =="
dsh --profile "$PROFILE" --from-default-profile web --dump-config > /dev/null

echo "== 2. install tentacle bundle (local paths) =="
# dsh-webhook's peer pin is EXACT per runtime release: align the local bundle
# copy to the runtime under test so an upgraded dsh does not fail the e2e for
# a shipped-version mismatch (publishing still pins a concrete version).
DSH_VERSION=$(dsh --version)
BUNDLE_PKG="$REPO_ROOT/packages/bundle/package.json"
cp "$BUNDLE_PKG" "$DSH_HOME/bundle.package.json.orig"
python3 - "$BUNDLE_PKG" "$DSH_VERSION" <<'PYEOF'
import json, sys
path, version = sys.argv[1], sys.argv[2]
data = json.load(open(path))
for key in list(data['dependencies']):
    if key.startswith('@deepseek-ai/'):
        data['dependencies'][key] = version
json.dump(data, open(path, 'w'), indent=2, ensure_ascii=False)
PYEOF
# Leaf plugins first (link: deps), then the bundle whose patch layer inserts
# their entries. This mirrors `dsh plugin add dsh-tentacle-bundle` against the
# npm registry; locally we use link: paths.
dsh plugin --profile "$PROFILE" add "$REPO_ROOT/packages/plugin-identity" "$REPO_ROOT/packages/plugin-gateway" "$REPO_ROOT/packages/plugin-tenancy" "$REPO_ROOT/packages/plugin-persona" "$REPO_ROOT/packages/plugin-teams" "$REPO_ROOT/packages/plugin-data" "$REPO_ROOT/packages/plugin-channels" 2>/dev/null
dsh plugin --profile "$PROFILE" add "$REPO_ROOT/packages/bundle" 2>/dev/null

echo "== 3. compose check: dump-config must contain tentacle entries under the bundle layer =="
DUMP=$(dsh --profile "$PROFILE" --dump-config)
echo "$DUMP" | grep -q "== @tentacle/bundle" || { echo "FAIL: bundle layer missing"; exit 1; }
echo "$DUMP" | grep -q "tentacle-identity" || { echo "FAIL: tentacle-identity missing from composed tree"; exit 1; }
echo "$DUMP" | grep -q "tentacle-gateway" || { echo "FAIL: tentacle-gateway missing from composed tree"; exit 1; }
echo "$DUMP" | grep -q "tentacle-tenancy" || { echo "FAIL: tentacle-tenancy missing from composed tree"; exit 1; }
echo "$DUMP" | grep -q "tentacle-persona" || { echo "FAIL: tentacle-persona missing from composed tree"; exit 1; }
echo "$DUMP" | grep -q "tentacle-teams" || { echo "FAIL: tentacle-teams missing from composed tree"; exit 1; }
echo "$DUMP" | grep -q "tentacle-channels" || { echo "FAIL: tentacle-channels missing from composed tree"; exit 1; }
echo "   composed tree OK"

echo "== 4. boot smoke: only ports are patched (zero tentacle config) =="
PATCH="$DSH_HOME/e2e.patch.yml"
cat > "$PATCH" <<YAML
# NOTE: patch config replaces the whole entry config — restate required fields.
- id: webserver
  config:
    host: 127.0.0.1
    port: $WEB_PORT
- id: tentacle-gateway
  config:
    listen: 127.0.0.1:$GATEWAY_PORT
    mode: passthrough
YAML

cd "$DSH_HOME"
dsh --profile "$PROFILE" --patch "$PATCH" > "$DSH_HOME/boot.log" 2>&1 &
DSH_PID=$!
trap 'kill $DSH_PID 2>/dev/null || true; cd "$REPO_ROOT"' EXIT

READY=0
for i in $(seq 1 60); do
  CODE_PROBE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$GATEWAY_PORT/" || true)
  if [ -n "$CODE_PROBE" ] && [ "$CODE_PROBE" != "000" ]; then READY=1; break; fi
  sleep 1
done
[ "$READY" = "1" ] || { echo "FAIL: gateway never came up; boot log:"; tail -20 "$DSH_HOME/boot.log"; exit 1; }

echo "== 5. assertions =="
# 5a. identity auto-provisioned under the DEFAULT state root ($DSH_HOME/tentacle/identity)
IDENTITY_FILE="$DSH_HOME/tentacle/identity/identity.json"
[ -f "$IDENTITY_FILE" ] || { echo "FAIL: identity.json not provisioned at $IDENTITY_FILE"; exit 1; }
grep -q '"did:key:z' "$IDENTITY_FILE" || { echo "FAIL: subjectId is not a did:key"; exit 1; }
echo "   identity provisioned by default: $(grep -o '"did:key:z[^"]*"' "$IDENTITY_FILE" | head -c 44)..."

# 5b. gateway forwards to the real DSH web UI (index must be the SPA, not 401)
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/")
[ "$CODE" = "200" ] || { echo "FAIL: gateway / returned $CODE"; tail -20 "$DSH_HOME/boot.log"; exit 1; }
echo "   gateway → DSH web UI: HTTP $CODE"

# 5c. direct loopback web UI requires the launch token (fence still intact)
DIRECT=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")
echo "   direct loopback without token: HTTP $DIRECT (401 expected)"
[ "$DIRECT" = "401" ] || { echo "WARN: expected 401 on token-less direct access, got $DIRECT"; }

# 5d. the tenancy browser client is composed into the web boot graph and its
# closure-factory bundle is served through the gateway
BOOT=$(curl -s "http://127.0.0.1:$GATEWAY_PORT/")
echo "$BOOT" | grep -q '"id":"@tentacle/tenancy"' || { echo "FAIL: @tentacle/tenancy missing from __DSH_BOOT__ entries"; exit 1; }
echo "   __DSH_BOOT__ lists the @tentacle/tenancy client entry"
REV=$(echo "$BOOT" | grep -o '"@tentacle/tenancy","url":"plugins/??@tentacle/tenancy/client.js&rev=[a-f0-9]*"' | grep -o 'rev=[a-f0-9]*' | cut -d= -f2)
[ -n "$REV" ] || { echo "FAIL: could not extract the tenancy client revision"; exit 1; }
CODE=$(curl -s -o "$DSH_HOME/tenancy-client.js" -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/plugins/??@tentacle/tenancy/client.js&rev=$REV")
[ "$CODE" = "200" ] || { echo "FAIL: tenancy client bundle returned $CODE"; exit 1; }
grep -q '__ModuleLoader__.load' "$DSH_HOME/tenancy-client.js" || { echo "FAIL: client bundle is not a closure-factory module"; exit 1; }
echo "   /plugins/ tenancy client bundle served through the gateway (rev $REV)"

# 5d+. the persona browser client is composed the same way
echo "$BOOT" | grep -q '"id":"@tentacle/persona"' || { echo "FAIL: @tentacle/persona missing from __DSH_BOOT__ entries"; exit 1; }
echo "   __DSH_BOOT__ lists the @tentacle/persona client entry"
PREV=$(echo "$BOOT" | grep -o '"@tentacle/persona","url":"plugins/??@tentacle/persona/client.js&rev=[a-f0-9]*"' | grep -o 'rev=[a-f0-9]*' | cut -d= -f2)
[ -n "$PREV" ] || { echo "FAIL: could not extract the persona client revision"; exit 1; }
CODE=$(curl -s -o "$DSH_HOME/persona-client.js" -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/plugins/??@tentacle/persona/client.js&rev=$PREV")
[ "$CODE" = "200" ] || { echo "FAIL: persona client bundle returned $CODE"; exit 1; }
grep -q '__ModuleLoader__.load' "$DSH_HOME/persona-client.js" || { echo "FAIL: persona client bundle is not a closure-factory module"; exit 1; }
echo "   /plugins/ persona client bundle served through the gateway (rev $PREV)"

# 5d++. the channels browser client is composed the same way
echo "$BOOT" | grep -q '"id":"@tentacle/channels"' || { echo "FAIL: @tentacle/channels missing from __DSH_BOOT__ entries"; exit 1; }
echo "   __DSH_BOOT__ lists the @tentacle/channels client entry"
CREV=$(echo "$BOOT" | grep -o '"@tentacle/channels","url":"plugins/??@tentacle/channels/client.js&rev=[a-f0-9]*"' | grep -o 'rev=[a-f0-9]*' | cut -d= -f2)
[ -n "$CREV" ] || { echo "FAIL: could not extract the channels client revision"; exit 1; }
CODE=$(curl -s -o "$DSH_HOME/channels-client.js" -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/plugins/??@tentacle/channels/client.js&rev=$CREV")
[ "$CODE" = "200" ] || { echo "FAIL: channels client bundle returned $CODE"; exit 1; }
grep -q '__ModuleLoader__.load' "$DSH_HOME/channels-client.js" || { echo "FAIL: client bundle is not a closure-factory module"; exit 1; }
echo "   /plugins/ channels client bundle served through the gateway (rev $CREV)"

# 5d+++. the teams console is composed the same way — its absence would hide
# the whole 团队 panel from every admin browser.
echo "$BOOT" | grep -q '"id":"@tentacle/teams"' || { echo "FAIL: @tentacle/teams missing from __DSH_BOOT__ entries"; exit 1; }
echo "   __DSH_BOOT__ lists the @tentacle/teams client entry"
TREV=$(echo "$BOOT" | grep -o '"@tentacle/teams","url":"plugins/??@tentacle/teams/client.js&rev=[a-f0-9]*"' | grep -o 'rev=[a-f0-9]*' | cut -d= -f2)
[ -n "$TREV" ] || { echo "FAIL: could not extract the teams client revision"; exit 1; }
CODE=$(curl -s -o "$DSH_HOME/teams-client.js" -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/plugins/??@tentacle/teams/client.js&rev=$TREV")
[ "$CODE" = "200" ] || { echo "FAIL: teams client bundle returned $CODE"; exit 1; }
grep -q '__ModuleLoader__.load' "$DSH_HOME/teams-client.js" || { echo "FAIL: teams client bundle is not a closure-factory module"; exit 1; }
grep -q 'tentacle-team-dialog' "$DSH_HOME/teams-client.js" || { echo "FAIL: teams client bundle lacks the detail-dialog width class"; exit 1; }
echo "   /plugins/ teams client bundle served through the gateway (rev $TREV)"

# 5d+++. the data studio client is the newest global panel; verify its bundle
# is composed and its externals resolve against the shell table.
echo "$BOOT" | grep -q '"id":"@tentacle/data"' || { echo "FAIL: @tentacle/data missing from __DSH_BOOT__ entries"; exit 1; }
echo "   __DSH_BOOT__ lists the @tentacle/data client entry"
DREV=$(echo "$BOOT" | grep -o '"@tentacle/data","url":"plugins/??@tentacle/data/client.js&rev=[a-f0-9]*"' | grep -o 'rev=[a-f0-9]*' | cut -d= -f2)
[ -n "$DREV" ] || { echo "FAIL: could not extract the data client revision"; exit 1; }
CODE=$(curl -s -o "$DSH_HOME/data-client.js" -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/plugins/??@tentacle/data/client.js&rev=$DREV")
[ "$CODE" = "200" ] || { echo "FAIL: data client bundle returned $CODE"; exit 1; }
grep -q '__ModuleLoader__.load' "$DSH_HOME/data-client.js" || { echo "FAIL: data client bundle is not a closure-factory module"; exit 1; }
echo "   /plugins/ data client bundle served through the gateway (rev $DREV)"

# 5d+++. every module the bundle requires at load time must exist in the
# shell's frozen module table. The bundle is only SERVED here (the browser
# executes it), so this is the one server-side check that an externalized
# dependency the loader cannot answer would be caught before shipping.
for BUNDLE in tenancy persona channels teams data; do
  EXTERNALS=$(python3 - "$DSH_HOME/$BUNDLE-client.js" <<'PY'
import re, sys
source = open(sys.argv[1], encoding='utf8').read()
print(' '.join(sorted(set(re.findall(r'require\("([^"]+)"\)', source)))))
PY
)
  [ -n "$EXTERNALS" ] || { echo "FAIL: could not extract the $BUNDLE bundle's module requests"; exit 1; }
  for SPEC in $EXTERNALS; do
    case "$SPEC" in
      react|react/jsx-runtime|react-dom|react-dom/client|@deepseek-ai/cordis|@deepseek-ai/dsh-client-ui-slots|@deepseek-ai/dsh-client-ui-primitives) : ;;
      *) echo "FAIL: $BUNDLE bundle requires '$SPEC', which is not in the shell's module table"; exit 1 ;;
    esac
  done
  echo "   $BUNDLE bundle externals resolve against the shell table: $(echo $EXTERNALS | tr ' ' ',')"
done

# 5e. expert presets registered in the official preset roster (RPC probe:
# the typert envelope pins method == endpoint, payload carries one args object)
CODE=$(curl -s -o "$DSH_HOME/roster.json" -w '%{http_code}' -X POST "http://127.0.0.1:$GATEWAY_PORT/api/agentPresets/list" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"e2e-roster","method":"agentPresets/list","payload":{"args":{}}}')
[ "$CODE" = "200" ] || { echo "FAIL: agentPresets/list returned $CODE"; exit 1; }
grep -q '"ok":true' "$DSH_HOME/roster.json" || { echo "FAIL: roster RPC not ok: $(head -c 400 "$DSH_HOME/roster.json")"; exit 1; }
for ID in standard minimal ptc cordis; do
  grep -q "\"id\":\"$ID\"" "$DSH_HOME/roster.json" || { echo "FAIL: preset roster lacks official preset $ID"; exit 1; }
done
echo "   preset roster lists the official presets experts can select"

kill $DSH_PID 2>/dev/null || true
sleep 2

echo "== 6. multi-user chain: required mode + setup wizard (zero config) =="
ADMIN_PASSWORD="e2e-admin-secret"
TENANCY_PORT=18181
FAKE_BOT_PORT=18182
FAKE_BOT_DIR="$DSH_HOME/fake-bot"
FAKE_BOT_UPDATES="$FAKE_BOT_DIR/updates.json"
FAKE_BOT_OUT="$FAKE_BOT_DIR/sent.json"

# 6.0. fake Telegram Bot API (design 06 §7): the adapter's `apiBaseUrl` points
# at this server, so the channels leg exercises the real polling/sending code
# without a platform account and without touching the network.
rm -rf "$FAKE_BOT_DIR"
node "$REPO_ROOT"/tests/e2e/fake-bot-api.mjs \
  --port "$FAKE_BOT_PORT" --updates "$FAKE_BOT_UPDATES" --out "$FAKE_BOT_OUT" \
  > "$DSH_HOME/fake-bot.log" 2>&1 &
FAKE_BOT_PID=$!
FAKE_READY=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$FAKE_BOT_PORT/botx/getMe" 2>/dev/null; then FAKE_READY=1; break; fi
  sleep 0.25
done
[ "$FAKE_READY" = "1" ] || { echo "FAIL: fake Bot API never came up"; tail -20 "$DSH_HOME/fake-bot.log"; exit 1; }
echo "   fake Bot API listening on 127.0.0.1:$FAKE_BOT_PORT"

# 6.0b. fake feishu open-platform server: same role for the push-platform leg
# (the adapter's `apiBaseUrl` points here; the callback direction is exercised
# by posting a real event envelope to the gateway's public hook route).
FAKE_FEISHU_PORT=18183
FAKE_FEISHU_OUT="$DSH_HOME/fake-feishu/sent.json"
rm -rf "$DSH_HOME/fake-feishu"
node "$REPO_ROOT"/tests/e2e/fake-feishu-api.mjs --port "$FAKE_FEISHU_PORT" --out "$FAKE_FEISHU_OUT" \
  > "$DSH_HOME/fake-feishu.log" 2>&1 &
FAKE_FEISHU_PID=$!
FEISHU_READY=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$FAKE_FEISHU_PORT/open-apis/bot/v3/info" 2>/dev/null; then FEISHU_READY=1; break; fi
  sleep 0.25
done
[ "$FEISHU_READY" = "1" ] || { echo "FAIL: fake feishu API never came up"; cat "$DSH_HOME/fake-feishu.log"; exit 1; }
echo "   fake feishu API listening on 127.0.0.1:$FAKE_FEISHU_PORT"

# 6.0c. fake feishu DEVICE-REGISTRATION endpoint (HTTPS, RFC 8628): the real
# `@larksuiteoapi/node-sdk` registerApp will talk to it for the QR leg. A
# self-signed cert is generated and trusted via NODE_EXTRA_CA_CERTS (TLS
# verification stays ON; nothing like NODE_TLS_REJECT_UNAUTHORIZED=0 here).
TLS_DIR="$DSH_HOME/tls"
mkdir -p "$TLS_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
  -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" > /dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$TLS_DIR/cert.pem"
FEISHU_QR_PORT=18184
export TENTACLE_FEISHU_QR_DOMAIN="127.0.0.1:$FEISHU_QR_PORT"
export TENTACLE_DINGTALK_QR_API_BASE_URL="http://127.0.0.1:18185"
node "$REPO_ROOT"/tests/e2e/fake-feishu-registration.mjs --port "$FEISHU_QR_PORT" \
  --cert "$TLS_DIR/cert.pem" --key "$TLS_DIR/key.pem" --out "$DSH_HOME/fake-feishu-registration.json" \
  > "$DSH_HOME/fake-feishu-registration.log" 2>&1 &
FAKE_QR_PID=$!
QR_READY=0
for i in $(seq 1 40); do
  if curl -sk -o /dev/null "https://127.0.0.1:$FEISHU_QR_PORT/oauth/v1/app/registration" 2>/dev/null; then QR_READY=1; break; fi
  sleep 0.25
done
[ "$QR_READY" = "1" ] || { echo "FAIL: fake feishu registration endpoint never came up"; cat "$DSH_HOME/fake-feishu-registration.log"; exit 1; }
echo "   fake feishu registration (https) listening on 127.0.0.1:$FEISHU_QR_PORT"

cat > "$PATCH" <<YAML
- id: webserver
  config:
    host: 127.0.0.1
    port: $WEB_PORT
- id: tentacle-gateway
  config:
    listen: 127.0.0.1:$TENANCY_PORT
    mode: required
- id: tentacle-channels
  config:
    # This block is the DEPLOYMENT SEED (design 07 §8): it is materialized once
    # as instance telegram-legacy, and the direct token below is moved into
    # the official credential store at seed time (never into the instance row).
    # After the first boot the console is the source of truth.
    telegram:
      enabled: true
      apiBaseUrl: http://127.0.0.1:$FAKE_BOT_PORT
      token: e2e-not-a-real-token
      pollTimeoutSec: 5
YAML

dsh --profile "$PROFILE" --patch "$PATCH" > "$DSH_HOME/boot2.log" 2>&1 &
DSH_PID=$!
trap 'kill $DSH_PID $FAKE_BOT_PID $FAKE_FEISHU_PID $FAKE_QR_PID $FAKE_DT_PID 2>/dev/null || true; cp "$DSH_HOME/bundle.package.json.orig" "$REPO_ROOT/packages/bundle/package.json" 2>/dev/null || true; cd "$REPO_ROOT"' EXIT

READY=0
for i in $(seq 1 60); do
  CODE_PROBE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/setup-status" || true)
  if [ "$CODE_PROBE" = "200" ]; then READY=1; break; fi
  sleep 1
done
[ "$READY" = "1" ] || { echo "FAIL: gateway (required mode) never came up"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }

# 6a. setup wizard is open on a fresh install, one-shot
STATUS=$(curl -s "http://127.0.0.1:$TENANCY_PORT/tentacle/api/setup-status")
echo "$STATUS" | grep -q '"required":true' || { echo "FAIL: setup-status not required on fresh install: $STATUS"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/setup" \
  -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}")
[ "$CODE" = "201" ] || { echo "FAIL: setup returned $CODE, want 201"; exit 1; }
echo "   setup wizard: admin created (201)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/setup" \
  -H 'content-type: application/json' -d '{"username":"mallory","password":"another-password"}')
[ "$CODE" = "409" ] || { echo "FAIL: second setup returned $CODE, want 409 (setup-closed)"; exit 1; }
echo "   setup wizard closed after first use (409)"

# 6b. unauthenticated request is denied; wrong password 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/api/session.list" -X POST)
[ "$CODE" = "403" ] || { echo "FAIL: unauthenticated RPC returned $CODE, want 403"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"wrong"}')
[ "$CODE" = "401" ] || { echo "FAIL: wrong password returned $CODE, want 401"; exit 1; }
echo "   unauthenticated → 403, wrong password → 401"

# 6c. admin login → session cookie → forwarded 200
JAR="$DSH_HOME/cookies.txt"
curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | grep -q 200 \
  || { echo "FAIL: admin login failed"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/")
[ "$CODE" = "200" ] || { echo "FAIL: authenticated / returned $CODE"; exit 1; }
echo "   admin login → session → DSH web UI 200"

# 6d. logout revokes the session immediately
curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/logout"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/")
[ "$CODE" = "403" ] || { echo "FAIL: after logout / returned $CODE, want 403"; exit 1; }
echo "   logout → 403 (session revoked)"

# 6e. unauthenticated browser navigation gets the login page (not JSON)
BODY=$(curl -s -H 'accept: text/html,application/xhtml+xml' "http://127.0.0.1:$TENANCY_PORT/")
echo "$BODY" | grep -q "Sign in" || { echo "FAIL: browser navigation did not get the login page"; exit 1; }
echo "   browser navigation → login page (HTTP 200)"

echo "== 7. admin API chain =="
# 7a. admin logs in, creates a regular user
curl -s -c "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"alice","password":"alice-pw"}')
[ "$CODE" = "200" ] || { echo "FAIL: admin create user returned $CODE"; exit 1; }
echo "   admin created user alice"

# 7a+. /tentacle/api/me: the browser client's self-service identity endpoint
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me")
[ "$CODE" = "401" ] || { echo "FAIL: anonymous /tentacle/api/me returned $CODE, want 401"; exit 1; }
ME=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me")
echo "$ME" | grep -q '"handle":"admin"' || { echo "FAIL: admin /me did not return the admin identity: $ME"; exit 1; }
echo "   /tentacle/api/me: anonymous → 401, admin → identity"

# 7b. alice logs in; privileged RPC denied for her (403 deny-list), ordinary page allowed
AJAR="$DSH_HOME/cookies-alice.txt"
curl -s -c "$AJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"alice","password":"alice-pw"}'
CODE=$(curl -s -b "$AJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/commands/execute" \
  -H 'content-type: application/json' -d '{}')
[ "$CODE" = "403" ] || { echo "FAIL: alice privileged RPC returned $CODE, want 403"; exit 1; }
echo "   alice → /api/commands/execute → 403 (privileged surface denied)"
CODE=$(curl -s -b "$AJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/")
[ "$CODE" = "200" ] || { echo "FAIL: alice / returned $CODE"; exit 1; }

# 7c. admin still reaches the privileged surface (role bypass)
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/commands/execute" \
  -H 'content-type: application/json' -d '{}')
[ "$CODE" != "403" ] || { echo "FAIL: admin privileged RPC was denied"; exit 1; }
echo "   admin → /api/commands/execute → $CODE (forwarded)"

# 7c+. persona expert library: builtin seeds listed for admins, role-gated,
# builtin rows protected from deletion, user experts round-trip
EXPERTS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts")
COUNT=$(echo "$EXPERTS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
[ "$COUNT" -ge 4 ] || { echo "FAIL: expert library returned $COUNT rows, want >= 4: $EXPERTS"; exit 1; }
for ID in general-assistant ops-engineer code-reviewer translator; do
  echo "$EXPERTS" | grep -q "\"id\":\"$ID\"" || { echo "FAIL: builtin expert $ID missing from library"; exit 1; }
done
echo "$EXPERTS" | grep -q '"builtin":true' || { echo "FAIL: builtin flag missing from expert rows"; exit 1; }
# The console projection (preset id / default flag / workspace path).
echo "$EXPERTS" | grep -q '"agentPreset":"standard"' || { echo "FAIL: expert rows lack the selected preset: $EXPERTS"; exit 1; }
echo "$EXPERTS" | grep -q '"default":true' || { echo "FAIL: no default expert flagged: $EXPERTS"; exit 1; }
echo "$EXPERTS" | grep -q '"workspacePath"' || { echo "FAIL: expert rows lack the workspace projection: $EXPERTS"; exit 1; }
echo "   /admin/experts: $COUNT experts seeded (preset/default/workspace/skills projected)"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/default" \
  -H 'content-type: application/json' -d '{"id":"code-reviewer"}')
[ "$CODE" = "200" ] || { echo "FAIL: pinning the default expert returned $CODE"; exit 1; }
CODE=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
print('yes' if [r for r in rows if r.get('default')] == [r for r in rows if r['id']=='code-reviewer'] and any(r['id']=='code-reviewer' and r.get('default') for r in rows) else 'no')
")
[ "$CODE" = "yes" ] || { echo "FAIL: default expert was not pinned"; exit 1; }
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/default" \
  -H 'content-type: application/json' -d '{"id":"general-assistant"}'
echo "   default expert is operator-pinnable and projected"
TEMPLATES=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/templates")
TCOUNT=$(echo "$TEMPLATES" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
[ "$TCOUNT" -ge 4 ] || { echo "FAIL: template library returned $TCOUNT rows, want >= 4: $TEMPLATES"; exit 1; }
echo "$TEMPLATES" | grep -q '"installedExpertId":"general-assistant"' || { echo "FAIL: template library lacks the seeded-instance link: $TEMPLATES"; exit 1; }
echo "   /admin/experts/templates: $TCOUNT templates, seeded instance linked"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts" \
  -H 'content-type: application/json' -d '{"templateId":"ops-engineer","id":"e2e-template-copy"}')
[ "$CODE" = "200" ] || { echo "FAIL: cloning a template returned $CODE, want 200"; exit 1; }
COPY=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
row=next((r for r in rows if r['id']=='e2e-template-copy'), None)
print('yes' if row and row.get('templateId')=='ops-engineer' and row.get('builtin') is False else 'no')
")
[ "$COPY" = "yes" ] || { echo "FAIL: template clone is missing or has the wrong provenance"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/remove" \
  -H 'content-type: application/json' -d '{"id":"e2e-template-copy"}')
[ "$CODE" = "200" ] || { echo "FAIL: deleting the template clone returned $CODE, want 200"; exit 1; }
echo "   template clone round-trip OK"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts")
[ "$CODE" = "401" ] || { echo "FAIL: anonymous experts list returned $CODE, want 401"; exit 1; }
CODE=$(curl -s -b "$AJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts")
[ "$CODE" = "403" ] || { echo "FAIL: non-admin experts list returned $CODE, want 403"; exit 1; }
echo "   experts API: anonymous → 401, non-admin → 403"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/remove" \
  -H 'content-type: application/json' -d '{"id":"ops-engineer"}')
[ "$CODE" = "409" ] || { echo "FAIL: deleting builtin expert returned $CODE, want 409 (builtin-protected)"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/update" \
  -H 'content-type: application/json' -d '{"id":"ops-engineer","agentPreset":"standard"}')
[ "$CODE" = "200" ] || { echo "FAIL: editing builtin preset returned $CODE, want 200"; exit 1; }
echo "   builtin expert: preset editable (200), deletion refused (409)"
PRESETS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/presets")
echo "$PRESETS" | grep -q '"id":"standard"' || { echo "FAIL: preset roster endpoint lacks official presets: $PRESETS"; exit 1; }
echo "   /admin/experts/presets: selectable roster exposed"
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts" \
  -H 'content-type: application/json' -d '{"id":"e2e-expert","name":"E2E 专家","description":"端到端","agentPreset":"standard"}')
[ "$CODE" = "200" ] || { echo "FAIL: creating expert returned $CODE, want 200"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/remove" \
  -H 'content-type: application/json' -d '{"id":"e2e-expert"}')
[ "$CODE" = "200" ] || { echo "FAIL: deleting user expert returned $CODE, want 200"; exit 1; }
echo "   user expert create/delete round-trip OK"

# 7c++. Data Studio: workspace seed, dataset import, thread/chart round-trip
DATA_STATE=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data")
DATA_WS=$(echo "$DATA_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['workspaces'][0]['id'])")
[ -n "$DATA_WS" ] || { echo "FAIL: data studio has no default workspace: $DATA_STATE"; exit 1; }
DATASET=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/import" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E Sales\",\"format\":\"csv\",\"content\":\"month,revenue\\nJan,120\\nFeb,180\\n\"}")
DATA_DS=$(echo "$DATASET" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_DS" ] || { echo "FAIL: dataset import returned no id: $DATASET"; exit 1; }
THREAD=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/threads/create" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E Revenue\",\"datasetId\":\"$DATA_DS\"}")
DATA_TH=$(echo "$THREAD" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_TH" ] || { echo "FAIL: data thread create returned no id: $THREAD"; exit 1; }
CHART=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/cards/create" \
  -H 'content-type: application/json' \
  -d "{\"threadId\":\"$DATA_TH\",\"kind\":\"chart\",\"title\":\"Revenue by month\",\"datasetId\":\"$DATA_DS\",\"spec\":{\"chart\":\"bar\",\"x\":\"month\",\"y\":\"revenue\",\"aggregate\":\"sum\"}}")
DATA_CARD=$(echo "$CHART" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_CARD" ] || { echo "FAIL: data chart create returned no id: $CHART"; exit 1; }
SSE_ERROR=$(curl -s -N --max-time 5 -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/agent/stream" \
  -H 'content-type: application/json' -d '{"threadId":"missing-thread","prompt":"x"}')
echo "$SSE_ERROR" | grep -q '"type":"error"' || { echo "FAIL: agent SSE did not emit an error event: $SSE_ERROR"; exit 1; }
echo "$SSE_ERROR" | grep -q 'no-such-thread' || { echo "FAIL: agent SSE lost the error code: $SSE_ERROR"; exit 1; }
echo "   data studio: agent SSE emits typed error event OK"
THREAD_FILTERS=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/threads/filters" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$DATA_TH\",\"filters\":[{\"column\":\"month\",\"values\":[\"Jan\"]}],\"ranges\":[{\"column\":\"revenue\",\"min\":100}]}")
echo "$THREAD_FILTERS" | grep -q '"column":"month"' || { echo "FAIL: thread filters failed: $THREAD_FILTERS"; exit 1; }
echo "$THREAD_FILTERS" | grep -q '"ranges":\[{"column":"revenue","min":100}\]' || { echo "FAIL: thread ranges failed: $THREAD_FILTERS"; exit 1; }
DATA_REPORT=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/reports/create" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"threadId\":\"$DATA_TH\",\"title\":\"E2E Report\",\"markdown\":\"# Report\\n\\n{{chart:$DATA_CARD}}\"}")
DATA_RP=$(echo "$DATA_REPORT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_RP" ] || { echo "FAIL: data report create returned no id: $DATA_REPORT"; exit 1; }
DATA_RP_UPDATED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/reports/update" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$DATA_RP\",\"title\":\"E2E Report Updated\"}")
echo "$DATA_RP_UPDATED" | grep -q 'E2E Report Updated' || { echo "FAIL: report update failed: $DATA_RP_UPDATED"; exit 1; }
DERIVED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/derive" \
  -H 'content-type: application/json' \
  -d "{\"datasetId\":\"$DATA_DS\",\"name\":\"E2E By month\",\"operation\":{\"kind\":\"group\",\"groupBy\":[\"month\"],\"aggregates\":[{\"column\":\"revenue\",\"fn\":\"sum\"}]}}")
DATA_DERIVED=$(echo "$DERIVED" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_DERIVED" ] || { echo "FAIL: data derive returned no id: $DERIVED"; exit 1; }
# SQLite connector: upload a database, list tables, import one table.
python3 - "$DSH_HOME/e2e-sqlite.db" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE sales (month TEXT, revenue REAL)')
db.executemany('INSERT INTO sales VALUES (?, ?)', [('Jan', 10), ('Feb', 20)])
db.commit(); db.close()
PYEOF
SQLITE_B64=$(base64 -w0 "$DSH_HOME/e2e-sqlite.db")
python3 - "$SQLITE_B64" > "$DSH_HOME/sqlite-open.json" <<'PYEOF'
import json, sys
print(json.dumps({"contentBase64": sys.argv[1]}))
PYEOF
SQLITE_OPEN=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/sqlite/open" \
  -H 'content-type: application/json' --data-binary @"$DSH_HOME/sqlite-open.json")
SQLITE_ID=$(echo "$SQLITE_OPEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$SQLITE_OPEN" | grep -q '"sales"' || { echo "FAIL: sqlite open did not list sales: $SQLITE_OPEN"; exit 1; }
SQLITE_DATASET=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/sqlite/import" \
  -H 'content-type: application/json' \
  -d "{\"connectorId\":\"$SQLITE_ID\",\"table\":\"sales\",\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E SQLite\"}")
DATA_SQLITE=$(echo "$SQLITE_DATASET" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_SQLITE" ] || { echo "FAIL: sqlite import returned no id: $SQLITE_DATASET"; exit 1; }
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/sqlite/close" -H 'content-type: application/json' -d "{\"id\":\"$SQLITE_ID\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_SQLITE\"}" >/dev/null
echo "   data studio: SQLite connector → tables → import → close OK"

# DuckDB connector: create a real .duckdb file, upload it, list/import one table.
(cd "$REPO_ROOT/packages/plugin-data" && node --input-type=module - "$DSH_HOME/e2e.duckdb" <<'JSEOF'
import { DuckDBInstance } from '@duckdb/node-api'
const instance = await DuckDBInstance.create(process.argv[2])
const connection = await instance.connect()
await connection.run('CREATE TABLE sales (month VARCHAR, revenue DOUBLE)')
await connection.run("INSERT INTO sales VALUES ('Jan', 10), ('Feb', 20)")
connection.closeSync(); instance.closeSync()
JSEOF
)
python3 - "$DSH_HOME/e2e.duckdb" > "$DSH_HOME/duckdb-open.json" <<'PYEOF'
import base64, json, sys
with open(sys.argv[1], 'rb') as handle:
    payload = base64.b64encode(handle.read()).decode('ascii')
print(json.dumps({"contentBase64": payload}))
PYEOF
DUCK_OPEN=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/duckdb/open" \
  -H 'content-type: application/json' --data-binary @"$DSH_HOME/duckdb-open.json")
DUCK_ID=$(echo "$DUCK_OPEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$DUCK_OPEN" | grep -q '"sales"' || { echo "FAIL: duckdb open did not list sales: $DUCK_OPEN"; exit 1; }
DUCK_DATASET=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/duckdb/import" \
  -H 'content-type: application/json' \
  -d "{\"connectorId\":\"$DUCK_ID\",\"table\":\"sales\",\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E DuckDB\"}")
DATA_DUCK=$(echo "$DUCK_DATASET" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_DUCK" ] || { echo "FAIL: duckdb import returned no id: $DUCK_DATASET"; exit 1; }
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connectors/duckdb/close" -H 'content-type: application/json' -d "{\"id\":\"$DUCK_ID\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_DUCK\"}" >/dev/null
echo "   data studio: DuckDB connector → tables → import → close OK"

# URL connector: serve a CSV locally, import it through the server-side fetch.
printf 'team,points\nred,10\nblue,20\n' > "$DSH_HOME/e2e-url.csv"
(cd "$DSH_HOME" && python3 -m http.server 18099 --bind 127.0.0.1 > e2e-url-server.log 2>&1) &
URL_PID=$!
sleep 1
URL_DATASET=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/import-url" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E URL\",\"url\":\"http://127.0.0.1:18099/e2e-url.csv\"}")
DATA_URL=$(echo "$URL_DATASET" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_URL" ] || { echo "FAIL: URL import returned no id: $URL_DATASET"; kill "$URL_PID" 2>/dev/null || true; exit 1; }
URL_ROWS=$(echo "$URL_DATASET" | python3 -c "import json,sys; print(json.load(sys.stdin).get('rowCount'))")
[ "$URL_ROWS" = "2" ] || { echo "FAIL: URL import rowCount=$URL_ROWS, want 2: $URL_DATASET"; kill "$URL_PID" 2>/dev/null || true; exit 1; }
URL_REFRESH=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/refresh" \
  -H 'content-type: application/json' -d "{\"id\":\"$DATA_URL\"}")
echo "$URL_REFRESH" | grep -q '"rowCount":2' || { echo "FAIL: URL refresh failed: $URL_REFRESH"; kill "$URL_PID" 2>/dev/null || true; exit 1; }
URL_AUTO=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/auto-refresh" \
  -H 'content-type: application/json' -d "{\"id\":\"$DATA_URL\",\"seconds\":60}")
echo "$URL_AUTO" | grep -q '"autoRefreshSec":60' || { echo "FAIL: auto-refresh setup failed: $URL_AUTO"; kill "$URL_PID" 2>/dev/null || true; exit 1; }
kill "$URL_PID" 2>/dev/null || true
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_URL\"}" >/dev/null
echo "   data studio: URL connector → HTTP CSV → import → refresh OK"

REGION=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/import" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"name\":\"E2E Regions\",\"format\":\"csv\",\"content\":\"month,region\\nJan,north\\nFeb,south\\n\"}")
DATA_REGION=$(echo "$REGION" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_REGION" ] || { echo "FAIL: region import returned no id: $REGION"; exit 1; }
SUGGEST=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/relations/suggest?workspaceId=$DATA_WS")
echo "$SUGGEST" | grep -q '"leftColumn":"month"' || { echo "FAIL: relation suggestion missing month: $SUGGEST"; exit 1; }
RELATION=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/relations/create" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$DATA_WS\",\"leftDatasetId\":\"$DATA_DS\",\"leftColumn\":\"month\",\"rightDatasetId\":\"$DATA_REGION\",\"rightColumn\":\"month\"}")
DATA_REL=$(echo "$RELATION" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_REL" ] || { echo "FAIL: relation create returned no id: $RELATION"; exit 1; }
JOINED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/join" \
  -H 'content-type: application/json' \
  -d "{\"leftDatasetId\":\"$DATA_DS\",\"rightDatasetId\":\"$DATA_REGION\",\"leftColumn\":\"month\",\"rightColumn\":\"month\",\"how\":\"left\",\"name\":\"E2E Joined\"}")
DATA_JOINED=$(echo "$JOINED" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$DATA_JOINED" ] || { echo "FAIL: join returned no id: $JOINED"; exit 1; }
JOINED_ROWS=$(echo "$JOINED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('rowCount'))")
[ "$JOINED_ROWS" = "2" ] || { echo "FAIL: joined rowCount=$JOINED_ROWS, want 2: $JOINED"; exit 1; }
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/threads/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_TH\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_JOINED\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/relations/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_REL\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_DERIVED\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_DS\"}" >/dev/null
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/datasets/remove" -H 'content-type: application/json' -d "{\"id\":\"$DATA_REGION\"}" >/dev/null
echo "   data studio: workspace → import → thread → chart → report → derived dataset → relation/join round-trip OK"

# 7c+++. saved connection profiles keep secrets in the DSH credential store
CONN=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connections/create" \
  -H 'content-type: application/json' \
  -d '{"kind":"database","name":"E2E Saved","config":{"engine":"postgres","host":"example.invalid","port":5432,"database":"analytics","user":"reader"},"secret":"e2e-super-secret"}')
CONN_ID=$(echo "$CONN" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$CONN_ID" ] || { echo "FAIL: saved connection create failed: $CONN"; exit 1; }
echo "$CONN" | grep -q 'e2e-super-secret' && { echo "FAIL: saved connection leaked the secret"; exit 1; }
CONN_LIST=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connections")
echo "$CONN_LIST" | grep -q '"name":"E2E Saved"' || { echo "FAIL: saved connection missing from list: $CONN_LIST"; exit 1; }
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/data/connections/remove" -H 'content-type: application/json' -d "{\"id\":\"$CONN_ID\"}" >/dev/null
echo "   data studio: saved connection profile → credential store → list → remove OK"

# 7d. disable alice → her live session dies immediately
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/disable" \
  -H 'content-type: application/json' -d '{"username":"alice"}'
CODE=$(curl -s -b "$AJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/")
[ "$CODE" = "403" ] || { echo "FAIL: disabled alice still has access ($CODE)"; exit 1; }
echo "   disable alice → her session revoked → 403"

# 7d-. full user lifecycle: create → disable → enable → lock → unlock →
#      profile edit → self password change → batch delete
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"dave","password":"dave-pw"}'
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/disable" \
  -H 'content-type: application/json' -d '{"username":"dave"}')
[ "$CODE" = "200" ] || { echo "FAIL: disable dave returned $CODE"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/enable" \
  -H 'content-type: application/json' -d '{"username":"dave"}')
[ "$CODE" = "200" ] || { echo "FAIL: enable dave returned $CODE"; exit 1; }
# lock via failed logins, then unlock through the admin API
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
    -H 'content-type: application/json' -d '{"username":"dave","password":"wrong"}'
done
LOCKED=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" | python3 -c "import json,sys; u=[x for x in json.load(sys.stdin) if x['username']=='dave'][0]; print('yes' if u['loginLockedUntil']>0 else 'no')")
[ "$LOCKED" = "yes" ] || { echo "FAIL: dave was not locked after 5 failures"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/unlock-login" \
  -H 'content-type: application/json' -d '{"username":"dave"}')
[ "$CODE" = "200" ] || { echo "FAIL: unlock dave returned $CODE"; exit 1; }
# profile edit is reflected in the list
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/update-profile" \
  -H 'content-type: application/json' -d '{"username":"dave","displayName":"Dave D.","email":"dave@example.com"}'
curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" | grep -q '"displayName":"Dave D."' \
  || { echo "FAIL: profile edit not reflected"; exit 1; }
# self-service password change (old password required)
DJAR="$DSH_HOME/cookies-dave.txt"
curl -s -c "$DJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"dave","password":"dave-pw"}'
CODE=$(curl -s -b "$DJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me/change-password" \
  -H 'content-type: application/json' -d '{"oldPassword":"wrong","newPassword":"brand-new-pw"}')
[ "$CODE" = "400" ] || { echo "FAIL: wrong old password returned $CODE, want 400"; exit 1; }
CODE=$(curl -s -b "$DJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me/change-password" \
  -H 'content-type: application/json' -d '{"oldPassword":"dave-pw","newPassword":"brand-new-pw"}')
[ "$CODE" = "200" ] || { echo "FAIL: password change returned $CODE"; exit 1; }
curl -s -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" -H 'content-type: application/json' -d '{"username":"dave","password":"brand-new-pw"}' -w '%{http_code}' | grep -q 200 \
  || { echo "FAIL: login with the new password failed"; exit 1; }
# batch delete: one real row + one unknown row, per-item outcomes
BATCH=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users/batch" \
  -H 'content-type: application/json' -d '{"usernames":["dave","ghost"],"action":"delete"}')
echo "$BATCH" | grep -q '"username":"dave","ok":true' || { echo "FAIL: batch delete dave: $BATCH"; exit 1; }
echo "$BATCH" | grep -q '"username":"ghost","ok":false' || { echo "FAIL: batch per-item outcome missing: $BATCH"; exit 1; }
echo "   user lifecycle: disable/enable, lock/unlock, profile, self password change, batch delete"

# 7d+. sessions snapshot is visible to admins, token-free
SESSIONS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/sessions")
echo "$SESSIONS" | grep -q '"handle":"admin"' || { echo "FAIL: sessions snapshot missing admin: $SESSIONS"; exit 1; }
echo "$SESSIONS" | grep -q "token" && { echo "FAIL: sessions snapshot leaks token material"; exit 1; } || true
echo "   /admin/sessions: live snapshot, no token material"

# 7d++. role templates: catalog, custom role, permission-key enforcement
PERMS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/permissions")
echo "$PERMS" | grep -q '"key":"users"' || { echo "FAIL: permission catalog missing users key"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles" \
  -H 'content-type: application/json' -d '{"id":"invite-only","name":{"zh":"仅邀请","en":"Invite only"},"permissionKeys":["invites"]}')
[ "$CODE" = "200" ] || { echo "FAIL: create custom role returned $CODE"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles" \
  -H 'content-type: application/json' -d '{"id":"nope","name":{"zh":"x","en":"x"},"permissionKeys":["ghost"]}')
[ "$CODE" = "400" ] || { echo "FAIL: unknown permission key returned $CODE, want 400"; exit 1; }
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"ivy","password":"ivy-pw","role":"invite-only"}'
IJAR="$DSH_HOME/cookies-ivy.txt"
curl -s -c "$IJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"ivy","password":"ivy-pw"}'
# allowed: invites (her key)
CODE=$(curl -s -b "$IJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/invites" \
  -H 'content-type: application/json' -d '{"role":"user"}')
[ "$CODE" = "200" ] || { echo "FAIL: ivy (invites key) could not create an invite ($CODE)"; exit 1; }
# denied: user management, role management
CODE=$(curl -s -b "$IJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"mallory","password":"mallory-pw"}')
[ "$CODE" = "403" ] || { echo "FAIL: ivy created a user ($CODE), want 403"; exit 1; }
CODE=$(curl -s -b "$IJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles")
[ "$CODE" = "403" ] || { echo "FAIL: ivy read roles ($CODE), want 403"; exit 1; }
# denied: privileged RPC her key does not cover (settings.) even though authenticated
CODE=$(curl -s -b "$IJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/settings.write" \
  -H 'content-type: application/json' -d '{}')
[ "$CODE" = "403" ] || { echo "FAIL: ivy reached settings.write ($CODE), want 403"; exit 1; }
# but a role granted the settings key does reach it
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles" \
  -H 'content-type: application/json' -d '{"id":"settings-editor","name":{"zh":"设置编辑","en":"Settings editor"},"permissionKeys":["settings"]}'
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles/assign" \
  -H 'content-type: application/json' -d '{"username":"ivy","roleId":"settings-editor"}'
# re-login so the session carries the new effective permissions
curl -s -c "$IJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"ivy","password":"ivy-pw"}'
CODE=$(curl -s -b "$IJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/settings.write" \
  -H 'content-type: application/json' -d '{}')
[ "$CODE" != "403" ] || { echo "FAIL: settings key did not admit settings.write"; exit 1; }
# escalation paths stay admin-only even with a broad custom role
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/roles/assign" \
  -H 'content-type: application/json' -d '{"username":"ivy","roleId":"admin"}'
curl -s -c "$IJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"ivy","password":"ivy-pw"}'
echo "   role templates: catalog, custom role, per-key allow/deny, escalation stays admin-only"

# 7e. admin console page is served to admins, refused to others
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/admin")
[ "$CODE" = "200" ] || { echo "FAIL: admin page returned $CODE for admin"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/admin")
[ "$CODE" = "401" ] || { echo "FAIL: admin page returned $CODE for anonymous"; exit 1; }
echo "   /tentacle/admin console page: admin 200, anonymous 401"

echo "== 8. workspace fence (session.create cwd policy) =="
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"carol","password":"carol-pw"}'
CAROL_SID=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" | python3 -c "import json,sys; print([u['subjectId'] for u in json.load(sys.stdin) if u['username']=='carol'][0])")
ALLOWED_ROOT="$DSH_HOME/carol-workspace"
mkdir -p "$ALLOWED_ROOT"
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/policies" \
  -H 'content-type: application/json' -d "{\"subjectId\":\"$CAROL_SID\",\"name\":\"workspace_root_dir\",\"value\":\"$ALLOWED_ROOT\"}"

CJAR="$DSH_HOME/cookies-carol.txt"
curl -s -c "$CJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"carol","password":"carol-pw"}'

# /me surfaces carol's fence to the browser client (drives the sidebar shadow)
ME=$(curl -s -b "$CJAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me")
echo "$ME" | grep -q "\"workspaceRootDir\":\"$ALLOWED_ROOT\"" || { echo "FAIL: carol /me lacks the fence: $ME"; exit 1; }
echo "   carol /tentacle/api/me → workspaceRootDir=$ALLOWED_ROOT"

# cwd outside the fence → gateway 403 with our error vocabulary
CODE=$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/session.create" \
  -H 'content-type: application/json' -d '{"args":{"cwd":"/etc"}}')
[ "$CODE" = "403" ] || { echo "FAIL: carol session.create /etc returned $CODE, want 403"; exit 1; }
echo "   carol session.create /etc → 403 (fenced)"

# cwd inside the fence → forwarded upstream (any non-403 response proves admission)
CODE=$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/session.create" \
  -H 'content-type: application/json' -d "{\"args\":{\"cwd\":\"$ALLOWED_ROOT\"}}")
[ "$CODE" != "403" ] && [ "$CODE" != "000" ] || { echo "FAIL: carol session.create inside root returned $CODE"; exit 1; }
echo "   carol session.create inside root → $CODE (admitted, forwarded)"

echo "== 8b. quota enforcement (design 05 §2.4): max_agents + token_quota =="
set_policy() { # subjectId name value
  curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/policies" \
    -H 'content-type: application/json' -d "{\"subjectId\":\"$1\",\"name\":\"$2\",\"value\":\"$3\"}"
}

# max_agents = 0 → session.create refused at the gateway, before the upstream
set_policy "$CAROL_SID" max_agents 0
CREATE_BODY=$(curl -s -b "$CJAR" -w '\n%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/session.create" \
  -H 'content-type: application/json' -d "{\"args\":{\"cwd\":\"$ALLOWED_ROOT\"}}")
CODE=$(echo "$CREATE_BODY" | tail -1)
[ "$CODE" = "403" ] || { echo "FAIL: carol session.create under max_agents=0 returned $CODE, want 403"; echo "$CREATE_BODY"; exit 1; }
echo "$CREATE_BODY" | grep -q 'max_agents' || { echo "FAIL: the 403 does not name the quota: $CREATE_BODY"; exit 1; }
echo "   carol session.create under max_agents=0 → 403 (quota named in the body)"

# raising the limit admits the create again
set_policy "$CAROL_SID" max_agents 2
CODE=$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/session.create" \
  -H 'content-type: application/json' -d "{\"args\":{\"cwd\":\"$ALLOWED_ROOT\"}}")
[ "$CODE" != "403" ] && [ "$CODE" != "000" ] || { echo "FAIL: carol session.create under max_agents=2 returned $CODE"; exit 1; }
echo "   carol session.create under max_agents=2 → $CODE (admitted)"

# token_quota = 0 → the prompt entry refuses before the agent runs
set_policy "$CAROL_SID" token_quota 0
PROMPT_BODY=$(curl -s -b "$CJAR" -w '\n%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/prompt" \
  -H 'content-type: application/json' -d '{"sessionId":"whatever"}')
CODE=$(echo "$PROMPT_BODY" | tail -1)
[ "$CODE" = "403" ] || { echo "FAIL: carol prompt under token_quota=0 returned $CODE, want 403"; echo "$PROMPT_BODY"; exit 1; }
echo "$PROMPT_BODY" | grep -q 'token_quota' || { echo "FAIL: the 403 does not name the quota: $PROMPT_BODY"; exit 1; }
echo "   carol prompt under token_quota=0 → 403 (quota named in the body)"

# a budget of 1 token admits the prompt (spend is still 0)
QUOTA=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/quota?subjectId=$CAROL_SID")
echo "$QUOTA" | grep -q '"quota":0' || { echo "FAIL: admin /quota does not report the zero budget: $QUOTA"; exit 1; }
set_policy "$CAROL_SID" token_quota 1
CODE=$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/api/prompt" \
  -H 'content-type: application/json' -d '{"sessionId":"whatever"}')
[ "$CODE" != "403" ] && [ "$CODE" != "000" ] || { echo "FAIL: carol prompt under token_quota=1 returned $CODE"; exit 1; }
echo "   carol prompt under token_quota=1 → $CODE (admitted)"
QUOTA=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/quota?subjectId=$CAROL_SID")
echo "$QUOTA" | grep -q '"maxAgents":2' || { echo "FAIL: admin /quota does not report maxAgents: $QUOTA"; exit 1; }
echo "   admin /quota → $QUOTA"

echo "== 9. channels (design 06/07): Telegram adapter + runtime instance management =="
# Every channel routes to an expert (design 09 §3.3); the seeded instance was
# migrated onto the engine's guaranteed default expert.
DEFAULT_EXPERT="general-assistant"

# 9a. the deployment seed became one managed instance and its adapter is live
CHANNELS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
echo "$CHANNELS" | grep -q '"id":"telegram-legacy"' \
  || { echo "FAIL: the deployment seed did not become instance telegram-legacy: $CHANNELS"; tail -30 "$DSH_HOME/boot2.log"; exit 1; }
echo "$CHANNELS" | grep -q '"runtime":{"state":"connected"' \
  || { echo "FAIL: channels did not report the instance as connected: $CHANNELS"; tail -30 "$DSH_HOME/boot2.log"; exit 1; }
echo "$CHANNELS" | grep -q '"username":"tentacle_test_bot"' || { echo "FAIL: channels lacks the bot identity: $CHANNELS"; exit 1; }
echo "$CHANNELS" | grep -q '"tenant":"local"' || { echo "FAIL: the instance is not tenant-scoped: $CHANNELS"; exit 1; }
echo "$CHANNELS" | grep -q "\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"}" || { echo "FAIL: the seeded instance has no expert binding: $CHANNELS"; exit 1; }
echo "$CHANNELS" | grep -q "\"targetName\"" || { echo "FAIL: the overview does not project the target name: $CHANNELS"; exit 1; }
echo "   /admin/channels: instance telegram-legacy running (bot identity from the fake Bot API)"

# 9a2. the console's expert dropdown comes from this endpoint — it must list
# the seeded experts (the browser half renders an empty roster as "only All").
ROSTER=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/experts")
for ID in general-assistant ops-engineer code-reviewer translator; do
  echo "$ROSTER" | grep -q "\"id\":\"$ID\"" || { echo "FAIL: /channels/experts lacks $ID: $ROSTER"; exit 1; }
done
echo "$ROSTER" | grep -q '"agentPresetId":"standard"' || { echo "FAIL: /channels/experts roster lacks the selected Agent preset id: $ROSTER"; exit 1; }
echo "   /admin/channels/experts: $(echo "$ROSTER" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') experts for the console dropdown (selected preset id projected)"

# 9b. authorization matrix: anonymous → 401, no `channels` key → 403, admin → 200.
# A dedicated plain user is created here because §7 deliberately revokes the
# sessions of the users it exercises (alice is disabled, ivy is escalated).
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/users" \
  -H 'content-type: application/json' -d '{"username":"nina","password":"nina-pw"}'
NJAR="$DSH_HOME/cookies-nina.txt"
curl -s -c "$NJAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/login" \
  -H 'content-type: application/json' -d '{"username":"nina","password":"nina-pw"}'
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
[ "$CODE" = "401" ] || { echo "FAIL: anonymous channels API returned $CODE, want 401"; exit 1; }
CODE=$(curl -s -b "$NJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
[ "$CODE" = "403" ] || { echo "FAIL: non-admin channels API returned $CODE, want 403"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
[ "$CODE" = "200" ] || { echo "FAIL: admin channels API returned $CODE, want 200"; exit 1; }
echo "   channels API: anonymous → 401, nina (no channels key) → 403, admin → 200"

# 9c. an inbound message from an unbound platform identity is refused: no
# session is created, and the sender gets the guidance reply.
ADMIN_SUBJECT=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/me" | python3 -c "import json,sys; print(json.load(sys.stdin)['identity']['subjectId'])")
node "$REPO_ROOT"/tests/e2e/send-update.mjs --updates "$FAKE_BOT_UPDATES" --update-id 101 --user-id 900 --text 'who am I' > /dev/null
GUIDED=0
for i in $(seq 1 40); do
  if grep -q 'not linked to a Tentacle user' "$FAKE_BOT_OUT" 2>/dev/null; then GUIDED=1; break; fi
  sleep 0.25
done
[ "$GUIDED" = "1" ] || { echo "FAIL: unbound sender was not refused with guidance: $(cat "$FAKE_BOT_OUT" 2>/dev/null)"; exit 1; }
echo "   unbound sender (telegram user 900) → refused + guidance reply, no session"

# 9d. admin binds the identity to the admin user ON that instance
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d "{\"channelId\":\"telegram-legacy\",\"platformId\":\"900\",\"subjectId\":\"$ADMIN_SUBJECT\"}")
[ "$CODE" = "200" ] || { echo "FAIL: channels bind returned $CODE, want 200"; exit 1; }
# a second bind of the same identity is a conflict, not a silent re-point
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d "{\"channelId\":\"telegram-legacy\",\"platformId\":\"900\",\"subjectId\":\"$ADMIN_SUBJECT\"}")
[ "$CODE" = "409" ] || { echo "FAIL: duplicate bind returned $CODE, want 409"; exit 1; }
# binding a subject the directory does not know is refused
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d '{"channelId":"telegram-legacy","platformId":"901","subjectId":"did:key:zNobody"}')
[ "$CODE" = "404" ] || { echo "FAIL: binding an unknown subject returned $CODE, want 404"; exit 1; }
echo "   channels bind: 200, duplicate → 409, unknown subject → 404"

# 9d2. the management closure (design 07 §4/§7): schema, create, duplicate name,
# credential write, probe/test, rename, enable/disable of the seeded instance,
# and removal — all through the admin API the console uses.
SCHEMA=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/schema")
echo "$SCHEMA" | grep -q '"channelType":"telegram"' || { echo "FAIL: schema lacks telegram: $SCHEMA"; exit 1; }
echo "$SCHEMA" | grep -q '"name":"token"' || { echo "FAIL: schema lacks the credential field: $SCHEMA"; exit 1; }
echo "$SCHEMA" | grep -q '"name":"pollTimeoutSec"' || { echo "FAIL: schema lacks a config field: $SCHEMA"; exit 1; }
echo "   /schema: telegram form schema served (config fields + credential field)"

# create a SECOND instance, disabled, pointing at the same fake Bot API
CREATED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"telegram\",\"name\":\"bot-two\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"},\"enabled\":false,\"credentials\":{\"token\":\"e2e-second-token\"},\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_BOT_PORT\"}}")
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' -d "{\"channelType\":\"telegram\",\"name\":\"bot-two\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"}}")
[ "$CODE" = "409" ] || { echo "FAIL: duplicate instance name returned $CODE, want 409"; exit 1; }
BOT_TWO_ID=$(echo "$CREATED" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$CREATED" | grep -q '"state":"disabled"' || { echo "FAIL: a disabled instance is not reported disabled: $CREATED"; exit 1; }
echo "$CREATED" | grep -q '"writable":true' || { echo "FAIL: the stored credential is not reported writable: $CREATED"; exit 1; }
echo "$CREATED" | grep -q 'e2e-second-token' && { echo "FAIL: the API echoed a secret back"; exit 1; }
echo "   instance create: 201 + secret stored (never echoed), duplicate name → 409"

# test (saved) and probe (draft) both reach the fake Bot API
TESTED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/test" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOT_TWO_ID\"}")
echo "$TESTED" | grep -q '"ok":true' || { echo "FAIL: /test did not reach the platform: $TESTED"; exit 1; }
PROBED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/probe" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"telegram\",\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_BOT_PORT\"},\"credentials\":{\"token\":\"e2e-second-token\"}}")
echo "$PROBED" | grep -q '"ok":true' || { echo "FAIL: /probe did not reach the platform: $PROBED"; exit 1; }
echo "   /test (saved) and /probe (draft) both verified against the platform"

# rename through update (the gap this closes: names are editable)
RENAMED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/update" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOT_TWO_ID\",\"name\":\"bot-two-renamed\"}")
echo "$RENAMED" | grep -q '"name":"bot-two-renamed"' || { echo "FAIL: rename did not apply: $RENAMED"; exit 1; }
echo "   instance update: rename applied"

# disable/enable the SEEDED instance: disable stops it without deleting config
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/disable" \
  -H 'content-type: application/json' -d '{"id":"telegram-legacy"}')
[ "$CODE" = "200" ] || { echo "FAIL: disable returned $CODE, want 200"; exit 1; }
DISABLED=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
DISABLED_OK=$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
inst = next((row for row in data['instances'] if row['id'] == 'telegram-legacy'), None)
ok = (inst is not None
      and inst['enabled'] is False
      and inst['config'].get('pollTimeoutSec') == 5
      and inst['runtime']['state'] == 'disabled')
print('yes' if ok else 'no')
" "$DISABLED")
[ "$DISABLED_OK" = "yes" ] || { echo "FAIL: the disabled instance lost its config or kept running: $DISABLED"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/enable" \
  -H 'content-type: application/json' -d '{"id":"telegram-legacy"}')
[ "$CODE" = "200" ] || { echo "FAIL: enable returned $CODE, want 200"; exit 1; }
RESTARTED=0
for i in $(seq 1 40); do
  REENABLED=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$REENABLED" | grep -q '"runtime":{"state":"connected"'; then RESTARTED=1; break; fi
  sleep 0.25
done
[ "$RESTARTED" = "1" ] || { echo "FAIL: the re-enabled instance never reconnected: $REENABLED"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }
echo "   disable keeps the row (enabled:false) and stops the adapter; enable reconnects"

# remove the second instance: the row and its credential are gone
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/remove" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOT_TWO_ID\"}")
[ "$CODE" = "200" ] || { echo "FAIL: remove returned $CODE, want 200"; exit 1; }
AFTER=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
echo "$AFTER" | grep -q "$BOT_TWO_ID" && { echo "FAIL: the removed instance is still listed: $AFTER"; exit 1; }
echo "   instance remove: row gone"

# 9d3. the expert binding is mandatory on channels, and an expert still routed
# to by a channel cannot be deleted (design 09 §3.3/§3.4).
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' -d '{"channelType":"telegram","name":"expertless-bot"}')
[ "$CODE" = "400" ] || { echo "FAIL: creating a channel without an expert returned $CODE, want 400"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts" \
  -H 'content-type: application/json' -d '{"id":"e2e-channel-expert","name":"E2E Channel Expert","description":"bound","agentPreset":"standard"}')
[ "$CODE" = "200" ] || { echo "FAIL: creating the channel expert returned $CODE, want 200"; exit 1; }
BOUND_CHANNEL=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d '{"channelType":"telegram","name":"expert-bound-bot","target":{"kind":"expert","id":"e2e-channel-expert"},"enabled":false}')
BOUND_CHANNEL_ID=$(echo "$BOUND_CHANNEL" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$BOUND_CHANNEL" | grep -q '"target":{"kind":"expert","id":"e2e-channel-expert"}' || { echo "FAIL: the channel did not keep its expert binding: $BOUND_CHANNEL"; exit 1; }
# clearing the binding is not a representable update
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/update" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOUND_CHANNEL_ID\",\"target\":null}")
[ "$CODE" = "400" ] || { echo "FAIL: clearing a channel's expert returned $CODE, want 400"; exit 1; }
# a routed-to expert is refused, then deletable once the channel is rebound
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/remove" \
  -H 'content-type: application/json' -d '{"id":"e2e-channel-expert"}')
[ "$CODE" = "409" ] || { echo "FAIL: deleting a routed-to expert returned $CODE, want 409"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/update" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOUND_CHANNEL_ID\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"}}")
[ "$CODE" = "200" ] || { echo "FAIL: rebinding the channel returned $CODE, want 200"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/experts/remove" \
  -H 'content-type: application/json' -d '{"id":"e2e-channel-expert"}')
[ "$CODE" = "200" ] || { echo "FAIL: deleting the released expert returned $CODE, want 200"; exit 1; }
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/remove" \
  -H 'content-type: application/json' -d "{\"id\":\"$BOUND_CHANNEL_ID\"}"
echo "   expert binding: required on create, not clearable, deletion of a routed expert → 409, released → 200"

# 9e. every channel routes to an expert: its sessions run in that expert's
# shared workspace (design 09 §3.3), not in a per-user workspace fence.
EXPERT_WS="$DSH_HOME/tentacle/persona/agents/$DEFAULT_EXPERT/workspace"
[ -d "$EXPERT_WS" ] || { echo "FAIL: expert workspace $EXPERT_WS was not seeded"; exit 1; }

# 9f. a bound message creates a real DSH session in that workspace. The e2e has
# no LLM credentials, so what is asserted is session creation + workspace +
# attribution, never the agent's answer text.
node "$REPO_ROOT"/tests/e2e/send-update.mjs --updates "$FAKE_BOT_UPDATES" --update-id 102 --user-id 900 --text 'create the session please' > /dev/null
LINKED=0
for i in $(seq 1 80); do
  CONV=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$CONV" | grep -q '"conversation":"telegram:900"'; then LINKED=1; break; fi
  sleep 0.5
done
[ "$LINKED" = "1" ] || {
  echo "FAIL: no conversation→session link appeared for the bound message"
  echo "      channels: $CONV"
  echo "      sent: $(cat "$FAKE_BOT_OUT" 2>/dev/null)"
  tail -30 "$DSH_HOME/boot2.log"
  exit 1
}
SESSION_ID=$(echo "$CONV" | python3 -c "
import json,sys
data = json.load(sys.stdin)
print(next(c['sessionId'] for c in data['conversations'] if c['conversation'] == 'telegram:900'))")
echo "$SESSION_ID" | grep -q '^webhook-' || { echo "FAIL: channel session id is not a webhook session: $SESSION_ID"; exit 1; }
echo "$CONV" | grep -q "\"platformId\":\"900\"" || { echo "FAIL: bound identity missing from the binding list: $CONV"; exit 1; }
echo "   bound message → conversation telegram:900 → session $SESSION_ID"

# 9g. that session is a real, persisted DSH session whose cwd is the EXPERT's
# shared workspace: the expert binding decided the workspace, not the sender's
# own directory. Session persistence lays out one directory per canonical cwd,
# so the directory the session landed in IS the assertion (the log is zstd).
SESSION_FILE=$(find "$DSH_HOME/sessions" -maxdepth 3 -type d -name "$SESSION_ID" | head -1)
[ -n "$SESSION_FILE" ] || { echo "FAIL: channel session $SESSION_ID is not persisted under $DSH_HOME/sessions"; exit 1; }
SESSION_SLUG=$(basename "$(dirname "$SESSION_FILE")")
case "$SESSION_SLUG" in
  *persona-agents-general-assistant-workspace*) : ;;
  *) echo "FAIL: channel session landed under '$SESSION_SLUG', not the expert workspace"; exit 1 ;;
esac
[ -f "$SESSION_FILE/session.v4.jsonl.zstd" ] || { echo "FAIL: channel session log is missing in $SESSION_FILE"; exit 1; }
echo "   session persisted under the expert workspace ($SESSION_FILE)"

# 9g2. teams are first-class routing targets (design 10 §7): the bundle seeds
# four builtin teams from the templates, each owning ONE managed preset
# (`team-<id>`: persona prefix + the official agent-team runtime rows) and one
# shared workspace. A channel bound to a team runs its sessions there.
TEAMS=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/teams")
echo "$TEAMS" | grep -q '"id":"product-review"' || { echo "FAIL: builtin team product-review was not seeded: $TEAMS"; exit 1; }
echo "$TEAMS" | grep -q '"builtin":true' || { echo "FAIL: the seeded team is not marked builtin: $TEAMS"; exit 1; }
TEAM_WS="$DSH_HOME/tentacle/teams/agents/product-review/workspace"
[ -f "$TEAM_WS/.tentacle/manifest.json" ] || { echo "FAIL: team workspace manifest missing under $TEAM_WS"; exit 1; }
# a member's skills are materialized INTO the team workspace (design 10 §4):
# tech-review includes ops-engineer, the one builtin expert shipping a skill
DATA_TEAM_WS="$DSH_HOME/tentacle/teams/agents/data-analysis/workspace"
[ -d "$DATA_TEAM_WS/.dsh/skills/ops-engineer/k8s-triage" ] || { echo "FAIL: ops-engineer's skill was not materialized into the data-analysis team workspace"; exit 1; }
echo "   teams seeded: product-review (preset team-product-review) + member skills materialized into data-analysis"

# binding a channel to a team that does not exist is refused up front
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' -d "{\"channelType\":\"telegram\",\"name\":\"ghost-team-bot\",\"target\":{\"kind\":\"team\",\"id\":\"ghost\"},\"enabled\":false}")
[ "$CODE" = "400" ] || { echo "FAIL: binding to an unknown team returned $CODE, want 400"; exit 1; }
echo "   channel create: unknown team target refused (400)"

# a channel bound to the team, and an identity bound to it
TEAM_BOT=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"telegram\",\"name\":\"team-bot\",\"target\":{\"kind\":\"team\",\"id\":\"product-review\"},\"credentials\":{\"token\":\"e2e-team-token\"},\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_BOT_PORT\"}}")
TEAM_BOT_ID=$(echo "$TEAM_BOT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$TEAM_BOT" | grep -q '"state":"connected"' || { echo "FAIL: the team-bound channel did not start: $TEAM_BOT"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d "{\"channelId\":\"$TEAM_BOT_ID\",\"platformId\":\"901\",\"subjectId\":\"$ADMIN_SUBJECT\"}")
[ "$CODE" = "200" ] || { echo "FAIL: binding to the team channel returned $CODE, want 200"; exit 1; }

# 9g3. an inbound message on the team channel creates a real session composed
# from the TEAM preset in the TEAM workspace. This is the end-to-end proof that
# preset-scoped mounting works (design 10 §3): the webhook runtime resolves and
# mounts the preset's rows — persona prefix plus the official agent-team runtime
# and its model-facing tools — so a session that exists here proves the whole
# team composition loaded. An unresolvable target would dispatch-fail instead.
node "$REPO_ROOT"/tests/e2e/send-update.mjs --updates "$FAKE_BOT_UPDATES" --update-id 103 --user-id 901 --text 'review this release' > /dev/null
TEAM_LINK=0
for i in $(seq 1 80); do
  CONV=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$CONV" | grep -q '"conversation":"telegram:901"'; then TEAM_LINK=1; break; fi
  sleep 0.5
done
[ "$TEAM_LINK" = "1" ] || {
  echo "FAIL: no conversation→session link for the team-bound message"
  echo "      channels: $CONV"
  echo "      sent: $(cat "$FAKE_BOT_OUT" 2>/dev/null)"
  tail -30 "$DSH_HOME/boot2.log"
  exit 1
}
TEAM_SESSION_ID=$(echo "$CONV" | python3 -c "
import json,sys
data = json.load(sys.stdin)
print(next(c['sessionId'] for c in data['conversations'] if c['conversation'] == 'telegram:901'))")
echo "$TEAM_SESSION_ID" | grep -q '^webhook-' || { echo "FAIL: team session id is not a webhook session: $TEAM_SESSION_ID"; exit 1; }
TEAM_SESSION_FILE=$(find "$DSH_HOME/sessions" -maxdepth 3 -type d -name "$TEAM_SESSION_ID" | head -1)
[ -n "$TEAM_SESSION_FILE" ] || { echo "FAIL: team session $TEAM_SESSION_ID is not persisted under $DSH_HOME/sessions"; exit 1; }
TEAM_SLUG=$(basename "$(dirname "$TEAM_SESSION_FILE")")
case "$TEAM_SLUG" in
  *teams-agents-product-review-workspace*) : ;;
  *) echo "FAIL: team session landed under '$TEAM_SLUG', not the team workspace"; exit 1 ;;
esac
# the composed preset of that session is the team's managed preset (the durable
# projection cache carries it), never the deployment default
TEAM_CACHE="$DSH_HOME/storages/session_projcache/sessions/$TEAM_SESSION_ID.json"
for i in $(seq 1 40); do
  [ -f "$TEAM_CACHE" ] && break
  sleep 0.25
done
TEAM_PRESET_ROW=$(python3 - "$TEAM_CACHE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(data['record']['rows']['agentPreset']['val'])
PY
)
[ "$TEAM_PRESET_ROW" = "team-product-review" ] || { echo "FAIL: team session composed preset '$TEAM_PRESET_ROW', want team-product-review"; exit 1; }
echo "   team-bound message → session $TEAM_SESSION_ID in the team workspace, composed from team-product-review"

# 9h. the Telegram cursor advanced past the handled updates and is durable in
# the official storage domain (design 07 §2) — the layout is the backend's
# business, so the assertion searches the stored records for the instance key.
OFFSET=$(python3 - "$DSH_HOME/storages" <<'PY'
import glob, json, os, sys

def numbers_for(node, key, found):
    if isinstance(node, dict):
        for name, value in node.items():
            if name == key:
                if isinstance(value, int):
                    found.append(value)
                elif isinstance(value, dict):
                    found.extend(item for item in value.values() if isinstance(item, int))
            numbers_for(value, key, found)
    elif isinstance(node, list):
        for item in node:
            numbers_for(item, key, found)
    return found

values = []
for path in glob.glob(os.path.join(sys.argv[1], '**', '*'), recursive=True):
    if not os.path.isfile(path):
        continue
    try:
        data = json.load(open(path))
    except Exception:
        continue
    values.extend(numbers_for(data, 'telegram-legacy', []))
print(max(values, default=0))
PY
)
[ "$OFFSET" -ge 103 ] || { echo "FAIL: telegram cursor is $OFFSET, want >= 103"; exit 1; }
echo "   telegram cursor persisted at $OFFSET (no replay on restart)"

# 9i. unbinding stops the flow: the same sender is refused again
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/unbind" \
  -H 'content-type: application/json' -d '{"channelId":"telegram-legacy","platformId":"900"}')
[ "$CODE" = "200" ] || { echo "FAIL: channels unbind returned $CODE, want 200"; exit 1; }
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/unbind" \
  -H 'content-type: application/json' -d '{"channelId":"telegram-legacy","platformId":"900"}')
[ "$CODE" = "404" ] || { echo "FAIL: second unbind returned $CODE, want 404 (no-such-binding)"; exit 1; }
echo "   channels unbind: 200, repeat → 404"

# 9j. feishu (push platform): instance → public hook route → bound event → session
FEISHU_CREATED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"feishu\",\"name\":\"feishu-bot\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"},\"credentials\":{\"appId\":\"cli_e2e\",\"appSecret\":\"e2e-secret\",\"verificationToken\":\"e2e-vt\"},\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_FEISHU_PORT\"}}")
FEISHU_ID=$(echo "$FEISHU_CREATED" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "$FEISHU_CREATED" | grep -q 'e2e-secret' && { echo "FAIL: the API echoed a secret back"; exit 1; }
FEISHU_UP=0
for i in $(seq 1 40); do
  OVERVIEW=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$OVERVIEW" | python3 -c '
import json,sys
data=json.load(sys.stdin)
inst=next((i for i in data["instances"] if i["id"]==sys.argv[1]), None)
sys.exit(0 if inst is not None and inst["runtime"]["state"]=="connected" and inst["runtime"].get("identity",{}).get("username")=="tentacle_e2e_feishu" else 1)
' "$FEISHU_ID"; then FEISHU_UP=1; break; fi
  sleep 0.25
done
[ "$FEISHU_UP" = "1" ] || { echo "FAIL: feishu instance never connected: $OVERVIEW"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }
echo "   feishu instance connected (bot identity from the fake open platform)"

# the public hook refuses an event whose verification token does not match
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/hooks/feishu/$FEISHU_ID" \
  -H 'content-type: application/json' \
  -d '{"schema":"2.0","header":{"event_id":"evt-bad","event_type":"im.message.receive_v1","token":"wrong","app_id":"cli_e2e","tenant_key":"t"},"event":{"sender":{"sender_id":{"open_id":"ou_900"},"sender_type":"user"},"message":{"chat_id":"oc_1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"hi\"}"}}}')
[ "$CODE" = "403" ] || { echo "FAIL: a hook event with the wrong verification token returned $CODE, want 403"; exit 1; }
echo "   feishu hook: wrong verification token → 403"

# bind the platform identity, then a real event links a conversation to a session
CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d "{\"channelId\":\"$FEISHU_ID\",\"platformId\":\"ou_900\",\"subjectId\":\"$ADMIN_SUBJECT\"}")
[ "$CODE" = "200" ] || { echo "FAIL: feishu bind returned $CODE, want 200"; exit 1; }
curl -s -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/hooks/feishu/$FEISHU_ID" \
  -H 'content-type: application/json' \
  -d '{"schema":"2.0","header":{"event_id":"evt-1","event_type":"im.message.receive_v1","token":"e2e-vt","app_id":"cli_e2e","tenant_key":"t"},"event":{"sender":{"sender_id":{"open_id":"ou_900"},"sender_type":"user"},"message":{"message_id":"om_in_1","chat_id":"oc_1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"hello from feishu\"}"}}}'
FEISHU_LINKED=0
for i in $(seq 1 80); do
  OVERVIEW=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$OVERVIEW" | grep -q '"conversation":"feishu:oc_1"'; then FEISHU_LINKED=1; break; fi
  sleep 0.5
done
[ "$FEISHU_LINKED" = "1" ] || { echo "FAIL: no conversation link for the feishu event: $OVERVIEW"; tail -30 "$DSH_HOME/boot2.log"; exit 1; }
echo "   feishu event → conversation feishu:oc_1 → session linked"

# 9l. feishu quick setup: the REAL SDK registerApp against a fake HTTPS device
# endpoint (design 08) → instance created+enabled, then pointed at the fake
# open platform so it also connects.
QR_STARTED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/provision/start" \
  -H 'content-type: application/json' -d "{\"channelType\":\"feishu\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"}}")
echo "$QR_STARTED" | grep -q '"state":"waiting"' || { echo "FAIL: provision/start did not return waiting: $QR_STARTED"; exit 1; }
echo "$QR_STARTED" | grep -q 'device/verify' || { echo "FAIL: no QR url in start response: $QR_STARTED"; exit 1; }
QR_FLOW_ID=$(echo "$QR_STARTED" | python3 -c "import json,sys; print(json.load(sys.stdin)['flowId'])")
QR_DONE=0
for i in $(seq 1 60); do
  QR_POLLED=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/provision/poll?flowId=$QR_FLOW_ID")
  if echo "$QR_POLLED" | grep -q '"state":"success"'; then QR_DONE=1; break; fi
  if echo "$QR_POLLED" | grep -q '"state":"failed"'; then echo "FAIL: provision flow failed: $QR_POLLED"; exit 1; fi
  sleep 0.5
done
[ "$QR_DONE" = "1" ] || { echo "FAIL: provision flow never succeeded: $QR_POLLED"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }
echo "$QR_POLLED" | grep -q 'qr-e2e-secret' && { echo "FAIL: a provision response leaked the app secret"; exit 1; }
QR_INSTANCE_ID=$(echo "$QR_POLLED" | python3 -c "import json,sys; print(json.load(sys.stdin)['instance']['id'])")
grep -q 'begin' "$DSH_HOME/fake-feishu-registration.json" || { echo "FAIL: the SDK never called begin on the fake endpoint"; exit 1; }
echo "   feishu QR (real SDK against fake HTTPS endpoint) → instance $QR_INSTANCE_ID created+enabled, no secret in responses"

curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/update" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$QR_INSTANCE_ID\",\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_FEISHU_PORT\"}}" > /dev/null
QR_UP=0
for i in $(seq 1 60); do
  OVERVIEW=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$OVERVIEW" | python3 -c '
import json,sys
data=json.load(sys.stdin)
inst=next((i for i in data["instances"] if i["id"]==sys.argv[1]), None)
sys.exit(0 if inst is not None and inst["runtime"]["state"]=="connected" else 1)
' "$QR_INSTANCE_ID"; then QR_UP=1; break; fi
  sleep 0.5
done
[ "$QR_UP" = "1" ] || { echo "FAIL: scanned instance never connected: $OVERVIEW"; exit 1; }
echo "   scanned instance connected against the fake open platform"

# 9m. dingtalk: QR device flow + real Stream WS handshake + inbound frame → session
DINGTALK_PORT=18185
node "$REPO_ROOT"/tests/e2e/fake-dingtalk-e2e.mjs --port "$DINGTALK_PORT" --out "$DSH_HOME/fake-dingtalk.json" \
  > "$DSH_HOME/fake-dingtalk.log" 2>&1 &
FAKE_DT_PID=$!
sleep 0.5
DT_STARTED=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/provision/start" \
  -H 'content-type: application/json' -d "{\"channelType\":\"dingtalk\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"}}")
echo "$DT_STARTED" | grep -q '"state":"waiting"' || { echo "FAIL: dingtalk provision/start: $DT_STARTED"; exit 1; }
DT_FLOW_ID=$(echo "$DT_STARTED" | python3 -c "import json,sys; print(json.load(sys.stdin)['flowId'])")
DT_DONE=0
for i in $(seq 1 60); do
  DT_POLLED=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/provision/poll?flowId=$DT_FLOW_ID")
  if echo "$DT_POLLED" | grep -q '"state":"success"'; then DT_DONE=1; break; fi
  if echo "$DT_POLLED" | grep -q '"state":"failed"'; then echo "FAIL: dingtalk provision failed: $DT_POLLED"; exit 1; fi
  sleep 0.5
done
[ "$DT_DONE" = "1" ] || { echo "FAIL: dingtalk provision never succeeded: $DT_POLLED"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }
DT_INSTANCE_ID=$(echo "$DT_POLLED" | python3 -c "import json,sys; print(json.load(sys.stdin)['instance']['id'])")
echo "   dingtalk QR (init/begin/poll) → instance $DT_INSTANCE_ID created+enabled"

# the QR-created instance has no config: point it at the fake OpenAPI/Stream
curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/update" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$DT_INSTANCE_ID\",\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$DINGTALK_PORT\",\"streamUrl\":\"http://127.0.0.1:$DINGTALK_PORT\"}}" > /dev/null

DT_WS=0
for i in $(seq 1 60); do
  if grep -q 'ws-connected' "$DSH_HOME/fake-dingtalk.json" 2>/dev/null; then DT_WS=1; break; fi
  sleep 0.25
done
[ "$DT_WS" = "1" ] || { echo "FAIL: no Stream WS connection from the dingtalk adapter"; cat "$DSH_HOME/fake-dingtalk.log"; tail -20 "$DSH_HOME/boot2.log"; exit 1; }
echo "   dingtalk Stream WS connected (handshake from the fake)"

CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/bind" \
  -H 'content-type: application/json' -d "{\"channelId\":\"$DT_INSTANCE_ID\",\"platformId\":\"staff-7\",\"subjectId\":\"$ADMIN_SUBJECT\"}")
[ "$CODE" = "200" ] || { echo "FAIL: dingtalk bind returned $CODE, want 200"; exit 1; }
curl -s -X POST "http://127.0.0.1:$DINGTALK_PORT/__control/push" -H 'content-type: application/json' -d '{
  "frame": {
    "specVersion": "1.0",
    "type": "CALLBACK",
    "headers": { "messageId": "stream-e2e-1", "topic": "/v1.0/im/bot/messages/get", "contentType": "application/json", "time": "1700000000000" },
    "data": "{\"msgId\":\"msg-e2e-1\",\"msgtype\":\"text\",\"text\":{\"content\":\"hello from dingtalk\"},\"conversationId\":\"cid-e2e-dm\",\"conversationType\":\"1\",\"senderId\":\"encrypted-sender\",\"senderStaffId\":\"staff-7\",\"senderNick\":\"Ada\",\"senderCorpId\":\"corp-1\",\"chatbotUserId\":\"bot-user\",\"isInAtList\":false,\"createAt\":1700000000000,\"sessionWebhook\":\"\"}"
  }
}'
DT_LINKED=0
for i in $(seq 1 80); do
  OVERVIEW=$(curl -s -b "$JAR" "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels")
  if echo "$OVERVIEW" | grep -q '"conversation":"dingtalk:staff-7"'; then DT_LINKED=1; break; fi
  sleep 0.5
done
[ "$DT_LINKED" = "1" ] || { echo "FAIL: no conversation link for the dingtalk event: $OVERVIEW"; tail -30 "$DSH_HOME/boot2.log"; exit 1; }
echo "   dingtalk inbound frame → conversation dingtalk:staff-7 → session linked"

# 9n. unbound policies: guest = read-only guest workspace; owner = admin's workspace
GUEST_ID=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"telegram\",\"name\":\"guest-bot\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"},\"credentials\":{\"token\":\"e2e-guest-token\"},\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_BOT_PORT\",\"unboundPolicy\":\"guest\"}}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$GUEST_ID" ] || { echo "FAIL: could not create guest-bot"; exit 1; }
sleep 1
node "$REPO_ROOT"/tests/e2e/send-update.mjs --updates "$FAKE_BOT_UPDATES" --update-id 202 --user-id 902 --text "hello from a guest" > /dev/null
GUEST_SESSION=0
for i in $(seq 1 80); do
  GUEST_FILE=$(find "$DSH_HOME/sessions" -path "*tentacle-channels-guest-local*" -name 'session.v4.jsonl.zstd' 2>/dev/null | head -1)
  if [ -n "$GUEST_FILE" ]; then GUEST_SESSION=1; break; fi
  sleep 0.5
done
[ "$GUEST_SESSION" = "1" ] || { echo "FAIL: no guest session under the isolated guest workspace"; find "$DSH_HOME/sessions" -name 'session.v4.jsonl.zstd' | head -5; exit 1; }
GUEST_LOG="$DSH_HOME/guest-session.log"
zstd -dc "$GUEST_FILE" > "$GUEST_LOG"
grep -q '"preset":"read-only"' "$GUEST_LOG" || { echo "FAIL: guest session preset is not read-only: $(head -5 "$GUEST_LOG")"; exit 1; }
echo "   guest: unbound user 902 → session in isolated guest workspace with read-only preset"
curl -s -b "$JAR" -o /dev/null -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/disable" \
  -H 'content-type: application/json' -d "{\"id\":\"$GUEST_ID\"}"
sleep 1

OWNER_ID=$(curl -s -b "$JAR" -X POST "http://127.0.0.1:$TENANCY_PORT/tentacle/api/admin/channels/create" \
  -H 'content-type: application/json' \
  -d "{\"channelType\":\"telegram\",\"name\":\"owner-bot\",\"target\":{\"kind\":\"expert\",\"id\":\"$DEFAULT_EXPERT\"},\"credentials\":{\"token\":\"e2e-owner-token\"},\"config\":{\"apiBaseUrl\":\"http://127.0.0.1:$FAKE_BOT_PORT\",\"unboundPolicy\":\"owner\"}}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$OWNER_ID" ] || { echo "FAIL: could not create owner-bot"; exit 1; }
sleep 1
OWNER_MARKER="$DSH_HOME/owner-session-marker"
touch "$OWNER_MARKER"
node "$REPO_ROOT"/tests/e2e/send-update.mjs --updates "$FAKE_BOT_UPDATES" --update-id 203 --user-id 903 --text "hello from an owner" > /dev/null
OWNER_SESSION=0
for i in $(seq 1 80); do
  OWNER_FILE=$(find "$DSH_HOME/sessions" -path "*persona-agents-general-assistant-workspace*" -name 'session.v4.jsonl.zstd' -newer "$OWNER_MARKER" 2>/dev/null | head -1)
  if [ -n "$OWNER_FILE" ]; then OWNER_SESSION=1; break; fi
  sleep 0.5
done
[ "$OWNER_SESSION" = "1" ] || { echo "FAIL: no owner session under the expert workspace"; exit 1; }
OWNER_LOG="$DSH_HOME/owner-session.log"
zstd -dc "$OWNER_FILE" > "$OWNER_LOG"
grep -q '"preset":"workspace-write"' "$OWNER_LOG" || { echo "FAIL: owner session preset is not workspace-write: $(head -5 "$OWNER_LOG")"; exit 1; }
echo "   owner: unbound user 903 → session in the expert workspace with workspace-write preset"

echo "== PASS =="
