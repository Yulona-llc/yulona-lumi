#!/bin/sh
# Runs once on first database init (docker-entrypoint-initdb.d). Creates the runtime role used by api/worker.
# yulona_app: LOGIN, NOBYPASSRLS, not superuser. Table grants are applied by migrations (run as yulona_owner).
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE yulona_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yulona_app')
\gexec
CREATE EXTENSION IF NOT EXISTS vector;
SQL
