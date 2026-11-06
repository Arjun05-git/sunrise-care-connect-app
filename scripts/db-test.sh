#!/usr/bin/env bash
# Builds a throwaway database from the migrations + seed on plain PostgreSQL (15/16) and runs the RLS matrix.
# Uses standard PG* env vars, e.g.:  PGHOST=localhost PGPORT=5432 PGUSER=postgres npm run db:test
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-sunrise_rls_test}
P="psql -X -q -v ON_ERROR_STOP=1"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB"
# the seed is demo data with known logins: declare the environment (unset = production). environment.sql checks both.
$P -d postgres -c "alter database $DB set app.environment = 'demo'"
$P -d "$DB" -c "create extension if not exists pgcrypto" -f supabase/tests/supabase_shim.sql 2>/dev/null
for f in supabase/migrations/*.sql; do echo "→ $(basename "$f")"; out=$($P -d "$DB" -f "$f" 2>&1) || { echo "$out"; echo "✗ migration failed: $f"; exit 1; }; echo "$out" | { grep -v "NOTICE\|wal_level\|HINT" || true; }; done
npx tsx scripts/generate-seed.ts
$P -d "$DB" -f supabase/seed/reference.sql > /dev/null
echo "→ reference seed loaded"
# the demo seed creates logins with known passwords: it must refuse to run unless the database is declared as demo,
# whatever the connection claims (a session setting stands in for a database that was never configured)
for e in "" production staging; do
  if out=$($P -d "$DB" -c "set app.environment = '$e'" -f supabase/seed/demo.sql 2>&1); then echo "✗ demo seed ran with app.environment='$e'"; exit 1; fi
  echo "$out" | grep -q "demo seed refused" || { echo "$out"; echo "✗ demo seed failed for another reason (app.environment='$e')"; exit 1; }
done
echo "→ demo seed refuses outside a demo environment"
$P -d "$DB" -f supabase/seed/demo.sql > /dev/null
echo "→ demo seed loaded"
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
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/environment.sql
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/authorization.sql

# a production-shaped database: migrations + reference seed only, environment NOT set
PDB=${DB}_prod
$P -d postgres -c "drop database if exists $PDB" -c "create database $PDB"
$P -d "$PDB" -c "create extension if not exists pgcrypto" -f supabase/tests/supabase_shim.sql 2>/dev/null
for f in supabase/migrations/*.sql; do $P -d "$PDB" -f "$f" > /dev/null 2>&1 || { echo "✗ migration failed on $PDB: $f"; exit 1; }; done
$P -d "$PDB" -f supabase/seed/reference.sql > /dev/null
psql -X -d "$PDB" -v ON_ERROR_STOP=1 -f supabase/tests/seed_reference_only.sql
$P -d postgres -c "drop database $PDB"
