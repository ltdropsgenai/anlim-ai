#!/usr/bin/env bash
# Rebuild the local test database: Supabase stand-ins, every migration in order, the seed. @anlim
set -euo pipefail
S=${PGSOCK:?}; D=$(cd "$(dirname "$0")" && pwd)
A="psql -h $S -p 55432 -U postgres -qAt -v ON_ERROR_STOP=1"
$A -d postgres -c "drop database if exists studio_test" -c "create database studio_test"
$A -d studio_test -f $D/test_supabase_stubs.sql
for f in $D/migrations/*.sql; do $A -d studio_test -f "$f" > /dev/null || { echo "FAILED: $f"; exit 1; }; done
$A -d studio_test -f $D/test_seed.sql > /dev/null
echo "studio_test rebuilt: $(ls $D/migrations/*.sql | wc -l) migrations"
