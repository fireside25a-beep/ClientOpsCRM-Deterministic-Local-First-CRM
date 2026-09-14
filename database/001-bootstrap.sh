#!/bin/sh
set -eu

: "${N8N_DB_PASSWORD:?N8N_DB_PASSWORD is required}"
: "${CLIENTOPS_DB_PASSWORD:?CLIENTOPS_DB_PASSWORD is required}"
: "${CLIENTOPS_OWNER_EMAIL:?CLIENTOPS_OWNER_EMAIL is required}"
: "${CLIENTOPS_NTFY_TOPIC:?CLIENTOPS_NTFY_TOPIC is required}"
: "${CLIENTOPS_TIMEZONE:?CLIENTOPS_TIMEZONE is required}"

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set n8n_password="$N8N_DB_PASSWORD" \
    --set clientops_password="$CLIENTOPS_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE n8n LOGIN PASSWORD %L', :'n8n_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'n8n') \gexec
SELECT format('ALTER ROLE n8n PASSWORD %L', :'n8n_password') \gexec

SELECT 'CREATE ROLE clientops_owner NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clientops_owner') \gexec

SELECT format('CREATE ROLE clientops_app LOGIN PASSWORD %L', :'clientops_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clientops_app') \gexec
SELECT format('ALTER ROLE clientops_app PASSWORD %L', :'clientops_password') \gexec

SELECT 'CREATE DATABASE n8n OWNER n8n'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n') \gexec
SELECT 'CREATE DATABASE clientops OWNER clientops_owner'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'clientops') \gexec
GRANT CONNECT ON DATABASE clientops TO clientops_app;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname clientops \
    --command 'SET ROLE clientops_owner' \
    --file /opt/clientops/schema.sql

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname clientops \
    --set owner_email="$CLIENTOPS_OWNER_EMAIL" \
    --set ntfy_topic="$CLIENTOPS_NTFY_TOPIC" \
    --set business_timezone="$CLIENTOPS_TIMEZONE" <<'SQL'
SELECT EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE name = :'business_timezone'
) AS timezone_is_valid \gset
\if :timezone_is_valid
SET ROLE clientops_owner;
INSERT INTO clientops.settings (key, value) VALUES
    ('owner_email', :'owner_email'),
    ('ntfy_topic', :'ntfy_topic'),
    ('business_timezone', :'business_timezone'),
    ('retention_days', '90'),
    ('failure_retention_days', '30')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = clock_timestamp();
\else
\echo 'CLIENTOPS_TIMEZONE is not a valid PostgreSQL timezone name'
\quit 3
\endif
SQL
