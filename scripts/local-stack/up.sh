#!/usr/bin/env bash
# =============================================================================
# Local Supabase-compatible stack WITHOUT Docker – for sandboxes / CI where `supabase start` can't run.
# Same components Supabase uses: GoTrue (auth), PostgREST (REST), storage-api (files), on your PostgreSQL 15/16.
# The normal path on a dev machine is still `supabase start` + `supabase db reset` (same migrations + seed).
#
#   SB_BIN=/opt/sb  PGHOST=127.0.0.1 PGPORT=5499 PGUSER=postgres  npm run stack:up
#
#   SB_BIN must contain: gotrue, migrations/ (GoTrue's), postgrest, storage/ (built supabase/storage).
#   Optional: $SB_BIN/livekit/livekit-server (or LIVEKIT_BIN) → local LiveKit SFU on :7880 for real video calls;
#   without it the app falls back to Jitsi (demo).
#   Then `npm run dev` – Vite proxies /auth/v1, /rest/v1, /storage/v1 to the services (vite.config.ts).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
SB_BIN=${SB_BIN:-/opt/sb}
DB=${STACK_DB:-sunrise_local}
PGHOST=${PGHOST:-127.0.0.1}; PGPORT=${PGPORT:-5432}; PGUSER=${PGUSER:-postgres}
export PGHOST PGPORT PGUSER
STATE=.local-stack; mkdir -p "$STATE/storage"
# Well-known Supabase local-dev secret. NEVER use outside local development.
JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long
eval "$(node scripts/local-stack/keys.mjs "$JWT_SECRET")"
DB_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DB"
P="psql -X -q -v ON_ERROR_STOP=1"

bash scripts/local-stack/down.sh >/dev/null 2>&1 || true
for port in 9999 3000 5000 54321 7880; do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then echo "port $port is still in use – stop that process first"; exit 1; fi
done

echo "→ database $DB"
$P -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
$P -d "$DB" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin nologin; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth;
create schema if not exists storage;
create extension if not exists pgcrypto;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
-- what storage-api's DB_INSTALL_ROLES would grant (RLS policies still decide per row)
alter default privileges in schema storage grant all on tables to anon, authenticated, service_role;
alter default privileges in schema storage grant all on functions to anon, authenticated, service_role;
alter default privileges in schema storage grant all on sequences to anon, authenticated, service_role;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
SQL

echo "→ GoTrue migrations"
GOTRUE_ENV=(
  GOTRUE_DB_DRIVER=postgres "DATABASE_URL=$DB_URL?search_path=auth" GOTRUE_DB_NAMESPACE=auth
  GOTRUE_DB_MIGRATIONS_PATH="$SB_BIN/migrations"
  API_EXTERNAL_URL=http://localhost:5173/auth/v1 GOTRUE_API_HOST=127.0.0.1 PORT=9999
  GOTRUE_SITE_URL=http://localhost:5173 GOTRUE_URI_ALLOW_LIST='http://localhost:*'
  GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
  GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_DISABLE_SIGNUP=false
  GOTRUE_EXTERNAL_PHONE_ENABLED=true GOTRUE_SMS_AUTOCONFIRM=false GOTRUE_SMS_OTP_EXP=300 GOTRUE_SMS_OTP_LENGTH=6
  GOTRUE_SMS_MAX_FREQUENCY=1s GOTRUE_RATE_LIMIT_SMS_SENT=100 GOTRUE_PASSWORD_MIN_LENGTH=12
  # No SMS is ever sent locally: only numbers in the test map below can sign in (OTP 123456).
  GOTRUE_SMS_PROVIDER=twilio GOTRUE_SMS_TWILIO_ACCOUNT_SID=local GOTRUE_SMS_TWILIO_AUTH_TOKEN=local GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID=local
  "GOTRUE_SMS_TEST_OTP=$(node -e '
    const n = [];
    for (let i = 1; i <= 20; i++) n.push("9198470000" + String(i).padStart(2, "0"));   // seeded patients
    for (let i = 1; i <= 10; i++) n.push("9198471000" + String(i).padStart(2, "0"));   // seeded doctors
    for (let i = 0; i <= 19; i++) n.push("9198479990" + String(i).padStart(2, "0"));   // free numbers for new sign-ups
    for (let i = 0; i <= 99; i++) n.push("9198479991" + String(i).padStart(2, "0"));   // one fresh patient per run of e2e:journeys
    console.log(n.map((x) => x + ":123456").join(","));')"
  GOTRUE_LOG_LEVEL=warn
)
env "${GOTRUE_ENV[@]}" "$SB_BIN/gotrue" migrate > "$STATE/gotrue-migrate.log" 2>&1 || { cat "$STATE/gotrue-migrate.log"; exit 1; }

echo "→ storage-api (runs its own migrations)"
STORAGE_ENV=(
  "DATABASE_URL=$DB_URL" DB_INSTALL_ROLES=false DB_SUPER_USER="$PGUSER" IS_MULTITENANT=false
  TENANT_ID=local REGION=local GLOBAL_S3_BUCKET=local SERVER_PORT=5000 SERVER_ADMIN_PORT=5001 SERVER_HOST=127.0.0.1
  "AUTH_JWT_SECRET=$JWT_SECRET" AUTH_JWT_ALGORITHM=HS256 "ANON_KEY=$ANON_KEY" "SERVICE_KEY=$SERVICE_KEY"
  STORAGE_BACKEND=file "STORAGE_FILE_BACKEND_PATH=$PWD/$STATE/storage" FILE_SIZE_LIMIT=52428800 UPLOAD_FILE_SIZE_LIMIT=52428800
  IMAGE_TRANSFORMATION_ENABLED=false PG_QUEUE_ENABLE=false LOG_LEVEL=warn
)
(cd "$SB_BIN/storage" || exit 1; setsid nohup env "${STORAGE_ENV[@]}" node "$SB_BIN/storage/dist/start/server.js" > "$OLDPWD/$STATE/storage.log" 2>&1 < /dev/null & echo $! > "$OLDPWD/$STATE/storage.pid")
for i in $(seq 1 60); do curl -sf http://127.0.0.1:5000/status >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:5000/status >/dev/null || { tail -30 "$STATE/storage.log"; exit 1; }

echo "→ app migrations + seed"
for f in supabase/migrations/*.sql; do out=$($P -d "$DB" -f "$f" 2>&1) || { echo "$out"; echo "✗ migration failed: $f"; exit 1; }; echo "$out" | { grep -v "NOTICE\|wal_level\|HINT" || true; }; done
npx tsx scripts/generate-seed.ts > /dev/null
$P -d "$DB" -f supabase/seed.sql > /dev/null
$P -d "$DB" -f scripts/local-stack/realtime.sql > /dev/null   # local Realtime emulator feed
$P -d "$DB" -c "notify pgrst, 'reload schema'"

echo "→ GoTrue"
setsid nohup env "${GOTRUE_ENV[@]}" "$SB_BIN/gotrue" serve > "$STATE/gotrue.log" 2>&1 < /dev/null & echo $! > "$STATE/gotrue.pid"

echo "→ PostgREST"
cat > "$STATE/postgrest.conf" <<CONF
db-uri = "postgres://authenticator@$PGHOST:$PGPORT/$DB"
db-schemas = "public"
db-anon-role = "anon"
db-pool = 10
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = 3000
log-level = "warn"
CONF
setsid nohup "$SB_BIN/postgrest" "$STATE/postgrest.conf" > "$STATE/postgrest.log" 2>&1 < /dev/null & echo $! > "$STATE/postgrest.pid"

# Video: a local LiveKit SFU when the binary is available (dev keys only), else the Jitsi demo fallback.
LIVEKIT_BIN=${LIVEKIT_BIN:-$SB_BIN/livekit/livekit-server}
LK_KEY=devkey; LK_SECRET=local-livekit-secret-at-least-32-characters
if [ -x "$LIVEKIT_BIN" ]; then
  echo "→ LiveKit (:7880, recording not configured)"
  cat > "$STATE/livekit.yaml" <<YAML
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  $LK_KEY: $LK_SECRET
room:
  empty_timeout: 300
  max_participants: 2
webhook:
  api_key: $LK_KEY
  urls: ["http://127.0.0.1:54321/functions/v1/video-webhook"]
logging:
  level: warn
YAML
  setsid nohup "$LIVEKIT_BIN" --config "$STATE/livekit.yaml" > "$STATE/livekit.log" 2>&1 < /dev/null & echo $! > "$STATE/livekit.pid"
  VIDEO_ENV=(VIDEO_PROVIDER=livekit LIVEKIT_URL=ws://127.0.0.1:7880 "LIVEKIT_PUBLIC_URL=${LIVEKIT_PUBLIC_URL:-ws://localhost:7880}" "LIVEKIT_API_KEY=$LK_KEY" "LIVEKIT_API_SECRET=$LK_SECRET")
else
  echo "→ no LiveKit binary – video uses the Jitsi demo fallback"
  VIDEO_ENV=(VIDEO_PROVIDER=jitsi "JITSI_DOMAIN=${JITSI_DOMAIN:-meet.jit.si}")
fi

# Web Push VAPID key pair: generated once per machine, kept in the state dir (public half goes to the client)
if [ ! -f "$STATE/vapid.env" ]; then
  node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ec",{namedCurve:"P-256"});const j=k.privateKey.export({format:"jwk"});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]).toString("base64url");console.log("VAPID_PUBLIC_KEY="+pub+"\nVAPID_PRIVATE_KEY="+j.d)' > "$STATE/vapid.env"
fi
# shellcheck disable=SC1091
. "$STATE/vapid.env"
# Send SMS hook secret (Standard Webhooks format). Local GoTrue keeps its own test-OTP path, so the hook is only
# exercised directly (npm run e2e:security); hosted projects point Auth → Hooks → Send SMS at the function.
[ -f "$STATE/sms-hook.secret" ] || node -e 'console.log("v1,whsec_"+require("crypto").randomBytes(32).toString("base64"))' > "$STATE/sms-hook.secret"
SEND_SMS_HOOK_SECRET=$(cat "$STATE/sms-hook.secret")

echo "→ gateway + edge functions (:54321)"
# Payments: the mock test gateway unless Razorpay TEST keys are exported (RAZORPAY_KEY_ID / _SECRET / _WEBHOOK_SECRET).
GATEWAY_ENV=(
  SUPABASE_URL=http://127.0.0.1:54321 "SUPABASE_ANON_KEY=$ANON_KEY" "SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY"
  PUBLIC_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 "PUBLIC_APP_URL=${PUBLIC_APP_URL:-http://localhost:5173}"
  "DATABASE_URL=$DB_URL" "LOCAL_JWT_SECRET=$JWT_SECRET"
  NOTIFY_PROVIDER=mock INTEGRATIONS_PROVIDER=mock STAFF_INVITE_MODE=link "SEND_SMS_HOOK_SECRET=$SEND_SMS_HOOK_SECRET" "VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY" "VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY" PAYMENTS_ALLOW_MOCK=true MOCK_GATEWAY_SECRET=local-mock-gateway-secret MOCK_WEBHOOK_SECRET=local-mock-webhook-secret MOCK_SEND_WEBHOOKS=true
  "${VIDEO_ENV[@]}"
)
if [ -n "${RAZORPAY_KEY_ID:-}" ]; then
  GATEWAY_ENV+=(PAYMENTS_PROVIDER=razorpay "RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID" "RAZORPAY_KEY_SECRET=${RAZORPAY_KEY_SECRET:?}" "RAZORPAY_WEBHOOK_SECRET=${RAZORPAY_WEBHOOK_SECRET:-}")
fi
setsid nohup env "${GATEWAY_ENV[@]}" node --import tsx scripts/local-stack/gateway.ts > "$STATE/gateway.log" 2>&1 < /dev/null & echo $! > "$STATE/gateway.pid"
printf 'SERVICE_KEY=%s\nANON_KEY=%s\nMOCK_WEBHOOK_SECRET=local-mock-webhook-secret\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$SERVICE_KEY" "$ANON_KEY" "$LK_KEY" "$LK_SECRET" > "$STATE/keys.env"

for i in $(seq 1 30); do curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null && curl -sf http://127.0.0.1:9999/health >/dev/null && curl -sf http://127.0.0.1:3000/ -H "apikey: $ANON_KEY" >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:9999/health >/dev/null || { tail -20 "$STATE/gotrue.log"; exit 1; }

cat > .env.local <<ENV
# written by scripts/local-stack/up.sh – local development keys only
VITE_APP_ENV=demo
VITE_APP_MODE=supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=$ANON_KEY
VITE_DEMO_HINTS=true
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
ENV
echo "✓ stack up: gateway :54321 (auth, rest, storage, functions) · video ${VIDEO_ENV[0]#VIDEO_PROVIDER=} · db $DB   (.env.local written; run npm run dev)"
