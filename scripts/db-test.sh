#!/usr/bin/env bash
# Builds a throwaway database from the migrations + seed on plain PostgreSQL (15/16) and runs the RLS matrix.
# Uses standard PG* env vars, e.g.:  PGHOST=localhost PGPORT=5432 PGUSER=postgres npm run db:test
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-sunrise_rls_test}
P="psql -X -q -v ON_ERROR_STOP=1"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB"
$P -d "$DB" -c "create extension if not exists pgcrypto" -f supabase/tests/supabase_shim.sql 2>/dev/null
for f in supabase/migrations/*.sql; do echo "→ $(basename "$f")"; out=$($P -d "$DB" -f "$f" 2>&1) || { echo "$out"; echo "✗ migration failed: $f"; exit 1; }; echo "$out" | { grep -v "NOTICE\|wal_level\|HINT" || true; }; done
npx tsx scripts/generate-seed.ts
$P -d "$DB" -f supabase/seed.sql > /dev/null
echo "→ seed loaded"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/rls_matrix.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/booking_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/payments_rules.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/doctor_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/video_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/prescription_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/notifications_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/admin_console.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/integrations_flow.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/security_hardening.sql
