import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = await readFile(join(root, 'compose.yaml'), 'utf8');
const cli = await readFile(join(root, 'clientops'), 'utf8');
const bootstrap = await readFile(join(root, 'scripts', 'bootstrap-n8n.sh'), 'utf8');
const schema = await readFile(join(root, 'database', 'schema.sql'), 'utf8');
const migrator = await readFile(join(root, 'database', 'migrate.sh'), 'utf8');
const migration = await readFile(join(root, 'database', 'migrations', '002-universal-v1.1.sql'), 'utf8');
const regionConfigurator = await readFile(join(root, 'scripts', 'configure-regions.mjs'), 'utf8');
const companionDockerfile = await readFile(join(root, 'companion', 'Dockerfile'), 'utf8');
const edgeConfigurator = await readFile(join(root, 'scripts', 'configure-edge.mjs'), 'utf8');

for (const required of [
  'n8nio/n8n:2.37.10',
  'n8nio/runners:2.37.10',
  'postgres:16.14-alpine',
  'axllent/mailpit:v1.30.6',
  'binwiederhier/ntfy:v2.27.0',
  'traefik:3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259',
  'N8N_PROTOCOL: https',
  'N8N_SECURE_COOKIE: "true"',
  'N8N_PROXY_HOPS: "1"',
  'N8N_EDITOR_BASE_URL: ${CLIENTOPS_PUBLIC_ORIGIN',
  'N8N_WEBHOOK_URL: ${CLIENTOPS_PUBLIC_ORIGIN',
  'EXECUTIONS_DATA_SAVE_ON_ERROR: none',
  'EXECUTIONS_DATA_SAVE_ON_SUCCESS: none',
  'EXECUTIONS_DATA_SAVE_ON_PROGRESS: "false"',
  'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "false"',
  'MP_MAX_AGE: 90d',
  'test: ["CMD", "/mailpit", "readyz"]',
  'N8N_RUNNERS_HEALTH_CHECK_SERVER_ENABLED: "true"',
  "fetch('http://127.0.0.1:5680')",
  'CLIENTOPS_TIMEZONE',
  'n8n-upgrade-preflight:',
  'CLIENTOPS_BOOTSTRAP_MODE: preflight',
  'database-migrate:',
  'condition: service_completed_successfully',
]) assert(compose.includes(required), `compose missing: ${required}`);

assert.doesNotMatch(compose, /CLIENTOPS_API_KEY/);
assert.match(compose, /CLIENTOPS_INTAKE_API_KEY/);
assert.match(compose, /CLIENTOPS_ADMIN_API_KEY/);
assert.match(cli, /readiness:probe/);
assert.match(cli, /probe_status.*422/s);
assert.match(cli, /127\.0\.0\.1:5680/);
assert.doesNotMatch(cli, /127\.0\.0\.1:5681/);
assert.doesNotMatch(compose, /127\.0\.0\.1:5681/);
assert.match(cli, /initial_timezone=\$\{2:-UTC\}/);
assert.match(cli, /CLIENTOPS_TIMEZONE=%s/);
assert.match(cli, /set-timezone/);
assert.match(cli, /set-regions/);
assert.match(regionConfigurator, /\['any', 'allowlist'\]/);
assert.match(bootstrap, /export:workflow --all/);
assert.match(bootstrap, /export:credentials --all/);
assert.match(bootstrap, /bootstrap-v2/);
assert.match(bootstrap, /write-backup-manifest/);
assert.match(bootstrap, /verify-backup-manifest/);
assert.match(compose, /database-migrate:[\s\S]*?postgres:[\s\S]*?condition: service_healthy/);
assert.match(compose, /database-migrate:[\s\S]*?n8n-upgrade-preflight:[\s\S]*?condition: service_completed_successfully/);
assert.match(compose, /n8n-upgrade-preflight:[\s\S]*?postgres:[\s\S]*?condition: service_healthy/);
assert.match(compose, /n8n-init:[\s\S]*?database-migrate:[\s\S]*?condition: service_completed_successfully/);
assert.match(migrator, /002-universal-v1\.1\.sql/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /schema_migrations/);
assert.match(migration, /BEGIN;/);
assert.match(migration, /COMMIT;/);
assert.doesNotMatch(schema, /source_ip|p_source_ip/i);
assert.match(schema, /clientops-triage-v1/);
assert.match(schema, /ROUTE_STANDARD/);

assert.match(compose, /edge:\n[\s\S]*?image: traefik:3\.7\.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259/);
assert.match(compose, /127\.0\.0\.1:8025:8025/);
assert.match(compose, /127\.0\.0\.1:8081:80/);
assert.doesNotMatch(compose, /docker\.sock/);
assert.match(compose, /data:\n    internal: true/);
assert.match(compose, /automation:\n    internal: true/);
const n8nServiceBlock = compose.match(/\n  n8n:\n([\s\S]*?)\n  task-runner:/)?.[1] ?? '';
assert(n8nServiceBlock, 'n8n block missing');
assert.doesNotMatch(n8nServiceBlock, /\n\s+ports:/, 'n8n must not publish a host port');
const postgresServiceBlock = compose.match(/\n  postgres:\n([\s\S]*?)\n  database-migrate:/)?.[1] ?? '';
assert(postgresServiceBlock, 'postgres block missing');
assert.doesNotMatch(postgresServiceBlock, /\n\s+ports:/, 'postgres must not publish a host port');
assert.match(edgeConfigurator, /CLIENTOPS_EDGE_MODE/);
assert.match(edgeConfigurator, /set-public/);
assert.match(edgeConfigurator, /certificatesResolvers/);
assert.match(edgeConfigurator, /basicAuth:/);
assert.match(edgeConfigurator, /rateLimit:/);
assert.match(edgeConfigurator, /Path\(\\`\/webhook\/clientops\/leads\\`\)/);
assert.match(edgeConfigurator, /Path\(\\`\/webhook\/clientops\/leads\/contacted\\`\)/);
assert.doesNotMatch(edgeConfigurator, /PathPrefix\(\\`\/webhook\//, 'edge must not expose arbitrary n8n webhook paths');
assert.match(edgeConfigurator, /maxRequestBodyBytes: 1048576/);
assert.match(edgeConfigurator, /stsSeconds: 31536000/);
assert.match(edgeConfigurator, /strictTLSOptions: true/);
assert.match(edgeConfigurator, /aliasHeadersStrategy: reject/);
assert.match(edgeConfigurator, /sanitizePath: true/);
assert.match(edgeConfigurator, /maxHeaderBytes: 65536/);
assert.match(edgeConfigurator, /minVersion: VersionTLS12/);
assert.match(cli, /set-public/);
assert.match(cli, /set-local/);
assert.match(cli, /edge-credentials/);

assert.doesNotMatch(companionDockerfile, /COPY\s+\.\s/u);
assert.doesNotMatch(companionDockerfile, /COPY policy-engine\/(?:include|src|third_party|config)\s/u);
for (const exactInput of [
  'policy-engine/include/config.h', 'policy-engine/include/lead.h', 'policy-engine/include/lead_router.h', 'policy-engine/include/lead_rules.h',
  'policy-engine/src/config.c', 'policy-engine/src/lead.c', 'policy-engine/src/lead_router.c', 'policy-engine/src/lead_rules.c', 'policy-engine/src/policy_cli.c',
  'policy-engine/third_party/cJSON.c', 'policy-engine/third_party/cJSON.h', 'policy-engine/config/policy.json',
]) assert(companionDockerfile.includes(exactInput), `companion Dockerfile missing exact input: ${exactInput}`);
assert.match(companionDockerfile, /-fstack-protector-strong/u);
assert.match(companionDockerfile, /-D_FORTIFY_SOURCE=3/u);
assert.match(companionDockerfile, /-Wl,-z,relro,-z,now,-z,noexecstack,--build-id=none/u);
assert.match(companionDockerfile, /strip --strip-all/u);
assert.match(companionDockerfile, /USER 10001:10001/u);

process.stdout.write(JSON.stringify({
  status: 'PASS',
  contract: 'deployment',
  exactPins: 6,
  executionPersistenceDisabled: true,
  splitWebhookSecrets: true,
  codeRunnerProbed: true,
  staleMarkerRepair: true,
  mailpitReadinessProbed: true,
  trackedDatabaseMigration: true,
  configurableTimezone: true,
  configurableRegions: ['any', 'allowlist'],
  noIpRetention: true,
  hardenedCompanionImageBoundary: true,
  trustedTlsEdgeConfiguration: true,
  directN8nExposureRemoved: true,
  postgresHostExposureRemoved: true,
  editorEdgeAuthentication: true,
  edgeRateControls: true,
  proxyHops: 1,
  aliasHeaderSpoofingRejected: true,
  pathSanitization: true,
  minimumTlsVersion: 'TLS1.2',
}, null, 2) + '\n');
