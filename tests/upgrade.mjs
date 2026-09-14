import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sqlSource(value) {
  return value.replace(/^\\set[^\n]*\n/gm, '');
}

const migration = sqlSource(await readFile(
  join(root, 'database', 'migrations', '002-universal-v1.1.sql'),
  'utf8',
));
const currentSchema = sqlSource(await readFile(
  join(root, 'database', 'schema.sql'),
  'utf8',
));

// This schema is deliberately frozen at the last v1 contract. It is test input,
// not a second source of truth for new installations.
const frozenV1Schema = `
CREATE SCHEMA clientops;

CREATE TABLE clientops.settings (
  key text PRIMARY KEY,
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE clientops.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_fingerprint bytea NOT NULL,
  policy_version text NOT NULL,
  channel text NOT NULL,
  customer_name text NOT NULL,
  city text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL,
  source text NOT NULL DEFAULT '',
  message text NOT NULL,
  consent boolean NOT NULL CHECK (consent),
  fit boolean NOT NULL,
  fit_reason text NOT NULL,
  space text NOT NULL,
  sqft integer NOT NULL,
  in_area boolean NOT NULL,
  urgency text NOT NULL,
  estimate jsonb NOT NULL,
  summary text NOT NULL,
  next_step text NOT NULL,
  draft_reply text NOT NULL,
  route text NOT NULL CHECK (route IN (
    'ROUTE_SPAM',
    'ROUTE_WRONG_SPECIALTY',
    'ROUTE_INSUFFICIENT_INFORMATION',
    'ROUTE_STANDARD_RESIDENTIAL',
    'ROUTE_COMMERCIAL',
    'ROUTE_URGENT',
    'ROUTE_OUT_OF_AREA',
    'ROUTE_MODEL_RETRY',
    'ROUTE_MANUAL_REVIEW'
  )),
  priority text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'closed')),
  sla_due_at timestamptz,
  escalated_at timestamptz,
  contacted_at timestamptz,
  closed_at timestamptz,
  canonical_request jsonb NOT NULL,
  raw_policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE clientops.lead_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES clientops.leads(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE clientops.delivery_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  lead_id uuid REFERENCES clientops.leads(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN (
    'customer_ack', 'owner_alert', 'sla_alert', 'daily_digest'
  )),
  channel text NOT NULL CHECK (channel IN ('smtp', 'ntfy')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 1 AND 512),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'delivered', 'dead_letter', 'cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'dead_letter') = (dead_lettered_at IS NOT NULL))
);

CREATE TABLE clientops.workflow_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_name text NOT NULL,
  workflow_id text NOT NULL DEFAULT '',
  execution_id text NOT NULL DEFAULT '',
  last_node text NOT NULL DEFAULT '',
  error_message text NOT NULL,
  sanitized_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

const legacyRouteContract = [
  { oldRoute: 'ROUTE_SPAM', newRoute: 'ROUTE_SPAM', score: 0 },
  { oldRoute: 'ROUTE_WRONG_SPECIALTY', newRoute: 'ROUTE_UNSUPPORTED', score: 10 },
  { oldRoute: 'ROUTE_INSUFFICIENT_INFORMATION', newRoute: 'ROUTE_INSUFFICIENT_INFORMATION', score: 25 },
  { oldRoute: 'ROUTE_STANDARD_RESIDENTIAL', newRoute: 'ROUTE_STANDARD', score: 60 },
  { oldRoute: 'ROUTE_COMMERCIAL', newRoute: 'ROUTE_SPECIALIST', score: 75 },
  { oldRoute: 'ROUTE_URGENT', newRoute: 'ROUTE_URGENT', score: 90 },
  { oldRoute: 'ROUTE_OUT_OF_AREA', newRoute: 'ROUTE_LOCATION_REVIEW', score: 40 },
  { oldRoute: 'ROUTE_MODEL_RETRY', newRoute: 'ROUTE_MANUAL_REVIEW', score: 35 },
  { oldRoute: 'ROUTE_MANUAL_REVIEW', newRoute: 'ROUTE_MANUAL_REVIEW', score: 35 },
];

function legacyId(index) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function normalizeRows(rows) {
  return rows.map((row) => JSON.parse(JSON.stringify(row)));
}

const db = new PGlite();

try {
  await db.exec('CREATE ROLE clientops_app NOLOGIN;');
  await db.exec(frozenV1Schema);
  await db.exec(`
    INSERT INTO clientops.settings (key, value) VALUES
      ('owner_email', 'owner@clientops.local'),
      ('ntfy_topic', 'clientops-local'),
      ('business_timezone', 'UTC'),
      ('retention_days', '90'),
      ('failure_retention_days', '30');
  `);

  for (const [index, route] of legacyRouteContract.entries()) {
    const id = legacyId(index);
    const idempotencyKey = `legacy:key-${String(index + 1).padStart(4, '0')}`;
    const categorySource = `historical-category-${index + 1}`;
    const serviceableSource = route.oldRoute !== 'ROUTE_OUT_OF_AREA';
    const request = {
      leadId: `legacy-request-${index + 1}`,
      channel: 'website',
      name: `Legacy Customer ${index + 1}`,
      city: '',
      phone: '',
      email: `legacy-${index + 1}@example.test`,
      source: 'v1-upgrade-fixture',
      message: `Historical request number ${index + 1} with enough detail.`,
      consent: true,
    };
    const rawPolicy = {
      ok: true,
      policyVersion: 'dlp-core-15e5321',
      lead: request,
      decision: {
        fit: true,
        fitReason: 'Historical v1 decision',
        space: categorySource,
        sqft: 100 + index,
        inArea: serviceableSource,
        urgency: route.oldRoute === 'ROUTE_URGENT' ? 'high' : 'medium',
        estimate: { low: 1000 + index, high: 2000 + index },
        summary: `Historical summary ${index + 1}`,
        nextStep: `Historical next step ${index + 1}`,
        draftReply: `Historical reply ${index + 1}`,
        route: route.oldRoute,
      },
    };
    const priority = route.oldRoute === 'ROUTE_URGENT'
      ? 'high'
      : ['ROUTE_STANDARD_RESIDENTIAL', 'ROUTE_COMMERCIAL'].includes(route.oldRoute)
        ? 'medium'
        : 'low';

    await db.query(`
      INSERT INTO clientops.leads (
        id, idempotency_key, request_fingerprint, policy_version,
        channel, customer_name, city, phone, email, source, message, consent,
        fit, fit_reason, space, sqft, in_area, urgency, estimate,
        summary, next_step, draft_reply, route, priority, status, sla_due_at,
        canonical_request, raw_policy, created_at, updated_at
      ) VALUES (
        $1::uuid, $2, decode(md5($3::jsonb::text), 'hex'), 'dlp-core-15e5321',
        'website', $4, '', '', $5, 'v1-upgrade-fixture', $6, true,
        true, 'Historical v1 decision', $7, $8, $9, $10, $11::jsonb,
        $12, $13, $14, $15, $16, 'new', '2025-01-15T13:00:00Z'::timestamptz,
        $3::jsonb, $17::jsonb, '2025-01-15T12:00:00Z'::timestamptz,
        '2025-01-15T12:05:00Z'::timestamptz
      )
    `, [
      id,
      idempotencyKey,
      JSON.stringify(request),
      request.name,
      request.email,
      request.message,
      categorySource,
      100 + index,
      serviceableSource,
      route.oldRoute === 'ROUTE_URGENT' ? 'high' : 'medium',
      JSON.stringify(rawPolicy.decision.estimate),
      rawPolicy.decision.summary,
      rawPolicy.decision.nextStep,
      rawPolicy.decision.draftReply,
      route.oldRoute,
      priority,
      JSON.stringify(rawPolicy),
    ]);
  }

  const preservedLeadId = legacyId(5);
  await db.query(`
    INSERT INTO clientops.lead_activity (
      lead_id, event_type, details, created_at
    ) VALUES (
      $1::uuid, 'accepted', '{"frozen":"activity-v1"}'::jsonb,
      '2025-01-15T12:06:00Z'::timestamptz
    )
  `, [preservedLeadId]);
  await db.query(`
    INSERT INTO clientops.delivery_outbox (
      id, dedupe_key, lead_id, kind, channel, recipient, subject, body,
      priority, status, available_at, created_at, updated_at
    ) VALUES (
      '10000000-0000-4000-8000-000000000001'::uuid,
      'legacy:preserved-owner-alert', $1::uuid, 'owner_alert', 'ntfy',
      'legacy-topic', 'Historical subject', 'Historical body', 'high', 'pending',
      '2025-01-15T12:07:00Z'::timestamptz,
      '2025-01-15T12:06:00Z'::timestamptz,
      '2025-01-15T12:06:00Z'::timestamptz
    )
  `, [preservedLeadId]);
  await db.exec(`
    INSERT INTO clientops.workflow_failures (
      workflow_name, workflow_id, execution_id, last_node,
      error_message, sanitized_context, created_at
    ) VALUES (
      'Legacy Intake', 'legacy-workflow', 'legacy-execution', 'Legacy Node',
      'Historical sanitized failure', '{"mode":"legacy"}'::jsonb,
      '2025-01-15T12:08:00Z'::timestamptz
    );
  `);

  const before = await db.query(`
    SELECT
      id::text, idempotency_key, encode(request_fingerprint, 'hex') AS fingerprint,
      policy_version, channel, customer_name, city, phone, email, source, message,
      consent, fit, fit_reason, space, in_area, urgency, summary, next_step,
      draft_reply, priority, status, sla_due_at, escalated_at, contacted_at,
      closed_at, canonical_request, raw_policy, created_at, updated_at
    FROM clientops.leads
    ORDER BY id
  `);
  const beforePreserved = normalizeRows(before.rows);
  const beforeActivity = normalizeRows((await db.query(
    'SELECT * FROM clientops.lead_activity ORDER BY id',
  )).rows);
  const beforeOutbox = normalizeRows((await db.query(
    'SELECT * FROM clientops.delivery_outbox ORDER BY id',
  )).rows);
  const beforeFailures = normalizeRows((await db.query(
    'SELECT * FROM clientops.workflow_failures ORDER BY id',
  )).rows);

  await db.exec(migration);

  const migrated = await db.query(`
    SELECT id::text, category, score, serviceable, route
      FROM clientops.leads
     ORDER BY id
  `);
  assert.equal(migrated.rows.length, legacyRouteContract.length);
  for (const [index, row] of migrated.rows.entries()) {
    assert.equal(row.id, legacyId(index));
    assert.equal(row.category, `historical-category-${index + 1}`);
    assert.equal(row.score, legacyRouteContract[index].score);
    assert.equal(
      row.serviceable,
      legacyRouteContract[index].oldRoute !== 'ROUTE_OUT_OF_AREA',
    );
    assert.equal(row.route, legacyRouteContract[index].newRoute);
  }

  const afterPreserved = normalizeRows((await db.query(`
    SELECT
      id::text, idempotency_key, encode(request_fingerprint, 'hex') AS fingerprint,
      policy_version, channel, customer_name, city, phone, email, source, message,
      consent, fit, fit_reason, category AS space, serviceable AS in_area,
      urgency, summary, next_step, draft_reply, priority, status, sla_due_at,
      escalated_at, contacted_at, closed_at, canonical_request, raw_policy,
      created_at, updated_at
    FROM clientops.leads
    ORDER BY id
  `)).rows);
  assert.deepEqual(afterPreserved, beforePreserved);
  assert.deepEqual(normalizeRows((await db.query(
    'SELECT * FROM clientops.lead_activity ORDER BY id',
  )).rows), beforeActivity);
  assert.deepEqual(normalizeRows((await db.query(
    'SELECT * FROM clientops.delivery_outbox ORDER BY id',
  )).rows), beforeOutbox);
  assert.deepEqual(normalizeRows((await db.query(
    'SELECT * FROM clientops.workflow_failures ORDER BY id',
  )).rows), beforeFailures);

  const removedColumns = await db.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'clientops'
       AND table_name = 'leads'
       AND column_name IN ('space', 'sqft', 'in_area', 'estimate')
     ORDER BY column_name
  `);
  assert.deepEqual(removedColumns.rows, []);

  const migrationRecord = await db.query(`
    SELECT version, checksum, applied_at
      FROM clientops.schema_migrations
     WHERE version = '1.1.0'
  `);
  assert.equal(migrationRecord.rows.length, 1);
  assert.equal(migrationRecord.rows[0].checksum, 'universal-triage-contract-1');
  const firstAppliedAt = migrationRecord.rows[0].applied_at.toISOString();

  const firstMigrationSnapshot = normalizeRows((await db.query(`
    SELECT id::text, idempotency_key, category, score, serviceable, route,
           canonical_request, raw_policy, created_at, updated_at
      FROM clientops.leads
     ORDER BY id
  `)).rows);
  await db.exec(migration);
  const secondMigrationSnapshot = normalizeRows((await db.query(`
    SELECT id::text, idempotency_key, category, score, serviceable, route,
           canonical_request, raw_policy, created_at, updated_at
      FROM clientops.leads
     ORDER BY id
  `)).rows);
  assert.deepEqual(secondMigrationSnapshot, firstMigrationSnapshot);
  const secondMigrationRecord = await db.query(`
    SELECT count(*)::int AS count, min(applied_at) AS applied_at
      FROM clientops.schema_migrations
     WHERE version = '1.1.0'
  `);
  assert.equal(secondMigrationRecord.rows[0].count, 1);
  assert.equal(secondMigrationRecord.rows[0].applied_at.toISOString(), firstAppliedAt);

  await db.exec(currentSchema);

  const genericRequest = {
    leadId: 'post-upgrade-001',
    channel: 'website',
    name: 'Taylor Morgan',
    city: '',
    phone: '',
    email: 'taylor@example.test',
    source: 'upgrade-contract',
    message: 'Please send pricing information and arrange a consultation.',
    consent: true,
  };
  const genericPolicy = {
    ok: true,
    policyVersion: 'clientops-triage-v1',
    lead: genericRequest,
    decision: {
      fit: true,
      fitReason: 'A supported request category was detected.',
      category: 'sales',
      score: 65,
      serviceable: true,
      urgency: 'medium',
      summary: 'A customer requested pricing and a consultation.',
      nextStep: 'Review the request and contact the customer.',
      draftReply: 'Thanks for reaching out. We will review your request and follow up.',
      route: 'ROUTE_STANDARD',
    },
  };
  const postUpgradeCreate = await db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    [
      'upgrade:new-generic-001',
      JSON.stringify(genericRequest),
      JSON.stringify(genericPolicy),
    ],
  );
  assert.equal(postUpgradeCreate.rows[0].status_code, 201);
  assert.equal(postUpgradeCreate.rows[0].route, 'ROUTE_STANDARD');

  const oldRequest = beforePreserved[3].canonical_request;
  const crossVersionReplay = await db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    [
      beforePreserved[3].idempotency_key,
      JSON.stringify(oldRequest),
      JSON.stringify({
        ...genericPolicy,
        lead: oldRequest,
      }),
    ],
  );
  assert.equal(crossVersionReplay.rows[0].status_code, 200);
  assert.equal(crossVersionReplay.rows[0].outcome, 'replayed');
  assert.equal(crossVersionReplay.rows[0].ticket_id, beforePreserved[3].id);
  assert.equal(crossVersionReplay.rows[0].route, 'ROUTE_STANDARD');

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    contract: 'database-upgrade-v1-to-v1.1',
    frozenV1Rows: legacyRouteContract.length,
    deterministicRouteMappings: legacyRouteContract.length,
    normalizedDataPreserved: true,
    canonicalRequestsPreserved: true,
    rawPoliciesPreserved: true,
    activityPreserved: true,
    outboxPreserved: true,
    failuresPreserved: true,
    removedLegacyColumns: ['estimate', 'in_area', 'space', 'sqft'],
    migrationIdempotent: true,
    migrationRecordStable: true,
    crossVersionReplayVerified: true,
    postUpgradeGenericIngestVerified: true,
  }, null, 2)}\n`);
} finally {
  await db.close();
}
