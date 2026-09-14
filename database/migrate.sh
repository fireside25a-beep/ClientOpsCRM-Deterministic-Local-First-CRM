#!/bin/sh
set -eu

: "${PGPASSWORD:?PGPASSWORD is required}"
: "${CLIENTOPS_TIMEZONE:?CLIENTOPS_TIMEZONE is required}"

psql --set ON_ERROR_STOP=1 --host postgres --username postgres --dbname postgres \
    --set business_timezone="$CLIENTOPS_TIMEZONE" <<'SQL'
SELECT EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE name = :'business_timezone'
) AS timezone_is_valid \gset
\if :timezone_is_valid
\echo 'CLIENTOPS_TIMEZONE validated'
\else
\echo 'CLIENTOPS_TIMEZONE is not a valid PostgreSQL timezone name'
\quit 3
\endif
SQL

psql --set ON_ERROR_STOP=1 --host postgres --username postgres --dbname clientops \
    --command 'SET ROLE clientops_owner' \
    --file /opt/clientops/database/migrations/002-universal-v1.1.sql

psql --set ON_ERROR_STOP=1 --host postgres --username postgres --dbname clientops \
    --command 'SET ROLE clientops_owner' \
    --file /opt/clientops/database/schema.sql

psql --set ON_ERROR_STOP=1 --host postgres --username postgres --dbname clientops \
    --set business_timezone="$CLIENTOPS_TIMEZONE" <<'SQL'
SET ROLE clientops_owner;
INSERT INTO clientops.settings (key, value)
VALUES ('business_timezone', :'business_timezone')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = clock_timestamp();
SQL
