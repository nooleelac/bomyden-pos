#!/usr/bin/env bash
# Runs every supabase/tests/*_test.sql on a fresh database: Supabase stand-ins, then all migrations in order
# (each in one transaction), then the test file. Plain Postgres 16 with pgcrypto; never a real Supabase project.
#
#   PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres supabase/tests/run.sh            # all files
#   supabase/tests/run.sh 0006_staff_auth_test.sql                                           # one file
#
# PG_BIN (default /usr/lib/postgresql/16/bin) and TEST_DB (default bmd_test) can be set too.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
db="${TEST_DB:-bmd_test}"
psql=("$bin/psql" -X -q -v ON_ERROR_STOP=1 -d "$db")
files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  mapfile -t files < <(cd "$here" && ls *_test.sql)
fi
pass=0
for f in "${files[@]}"; do
  f="$(basename "$f")"
  "$bin/dropdb" --if-exists "$db"
  "$bin/createdb" "$db"
  "${psql[@]}" -f "$here/_supabase_stubs.sql" >/dev/null
  for m in "$here"/../migrations/*.sql; do
    "${psql[@]}" --single-transaction -f "$m" >/dev/null
  done
  if out="$("${psql[@]}" -f "$here/$f" 2>&1)"; then
    echo "PASS $f ($(grep -c '^ *ok - ' <<<"$out") checks)"
    pass=$((pass + 1))
  else
    echo "FAIL $f"
    tail -n 20 <<<"$out"
    exit 1
  fi
done
"$bin/dropdb" --if-exists "$db"
echo "$pass/${#files[@]} SQL test files passed"
