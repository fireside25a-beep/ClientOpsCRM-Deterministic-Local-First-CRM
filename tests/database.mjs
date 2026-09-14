import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'policy-engine', 'build', 'policy_cli');
const policyConfig = join(root, 'policy-engine', 'config', 'policy.json');

function qualify(overrides = {}) {
  const request = {
    leadId: 'database-contract-001',
    channel: 'website',
    name: 'Jordan Lee',
    city: '',
    phone: '',
    email: 'JORDAN@EXAMPLE.TEST',
    source: 'database-contract',
    message: 'Our account has a critical issue and we need support today.',
    consent: true,
    ...overrides,
  };
  const result = spawnSync(binary, ['--config', policyConfig], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { request, policy: JSON.parse(result.stdout) };
}

function sqlSource(value) {
  return value.replace(/^\\set[^\n]*\n/gm, '');
}

async function ingest(db, key, fixture) {
  return db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    [key, JSON.stringify(fixture.request), JSON.stringify(fixture.policy)],
  );
}

async function expectPolicyRejection(db, key, request, policy, pattern) {
  await assert.rejects(
    db.query(
      'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
      [key, JSON.stringify(request), JSON.stringify(policy)],
    ),
    pattern,
  );
}

const schema = sqlSource(await readFile(join(root, 'database', 'schema.sql'), 'utf8'));
const db = new PGlite();

try {
  await db.exec('CREATE ROLE clientops_app NOLOGIN;');
  await db.exec(schema);
  await db.exec(`
    INSERT INTO clientops.settings (key, value) VALUES
      ('owner_email', 'owner@clientops.local'),
      ('ntfy_topic', 'clientops-local'),
      ('business_timezone', 'UTC'),
      ('retention_days', '90'),
      ('failure_retention_days', '30');
  `);

  const version = await db.query(`
    SELECT version, checksum
      FROM clientops.schema_migrations
     WHERE version = '1.1.0'
  `);
  assert.deepEqual(version.rows, [{
    version: '1.1.0',
    checksum: 'universal-triage-contract-1',
  }]);

  const urgent = qualify();
  assert.equal(urgent.policy.policyVersion, 'clientops-triage-v1');
  assert.equal(urgent.policy.decision.category, 'support');
  assert.equal(urgent.policy.decision.route, 'ROUTE_URGENT');
  assert.equal(urgent.policy.decision.serviceable, true);
  assert.equal(urgent.policy.decision.urgency, 'high');
  assert(Number.isInteger(urgent.policy.decision.score));

  const key = 'contract:key-0001';
  const created = await ingest(db, key, urgent);
  assert.equal(created.rows[0].status_code, 201);
  assert.equal(created.rows[0].outcome, 'created');
  assert.equal(created.rows[0].priority, 'high');
  assert.equal(created.rows[0].route, 'ROUTE_URGENT');
  assert(created.rows[0].sla_due_at instanceof Date);
  const ticket = created.rows[0].ticket_id;
  assert.match(ticket, /^[0-9a-f-]{36}$/);

  const stored = await db.query(`
    SELECT category, score, serviceable, canonical_request, raw_policy
      FROM clientops.leads
     WHERE id = $1::uuid
  `, [ticket]);
  assert.equal(stored.rows[0].category, urgent.policy.decision.category);
  assert.equal(stored.rows[0].score, urgent.policy.decision.score);
  assert.equal(stored.rows[0].serviceable, true);
  assert.deepEqual(stored.rows[0].canonical_request, urgent.request);
  assert.deepEqual(stored.rows[0].raw_policy, urgent.policy);

  const replay = await ingest(db, key, urgent);
  assert.equal(replay.rows[0].status_code, 200);
  assert.equal(replay.rows[0].outcome, 'replayed');
  assert.equal(replay.rows[0].ticket_id, ticket);

  const changedPolicy = structuredClone(urgent.policy);
  changedPolicy.decision.summary = 'Wording changed after the original request was accepted.';
  const policyChangeReplay = await ingest(db, key, {
    request: urgent.request,
    policy: changedPolicy,
  });
  assert.equal(policyChangeReplay.rows[0].outcome, 'replayed');
  assert.equal(policyChangeReplay.rows[0].ticket_id, ticket);

  const changed = qualify({
    leadId: 'database-contract-002',
    message: 'Our account is unavailable and the entire team is blocked today.',
  });
  const conflict = await ingest(db, key, changed);
  assert.equal(conflict.rows[0].status_code, 409);
  assert.equal(conflict.rows[0].outcome, 'conflict');
  assert.equal(conflict.rows[0].ticket_id, null);

  const missingConsent = structuredClone(urgent.policy);
  delete missingConsent.lead.consent;
  await expectPolicyRejection(
    db,
    'contract:key-consent',
    urgent.request,
    missingConsent,
    /missing required fields/,
  );

  const missingOk = structuredClone(urgent.policy);
  delete missingOk.ok;
  await expectPolicyRejection(
    db,
    'contract:key-ok-missing',
    urgent.request,
    missingOk,
    /invalid or unsupported policy response/,
  );

  const missingCategory = structuredClone(urgent.policy);
  delete missingCategory.decision.category;
  await expectPolicyRejection(
    db,
    'contract:key-category',
    urgent.request,
    missingCategory,
    /missing required fields/,
  );

  const missingScore = structuredClone(urgent.policy);
  delete missingScore.decision.score;
  await expectPolicyRejection(
    db,
    'contract:key-score-missing',
    urgent.request,
    missingScore,
    /missing required fields/,
  );

  const fractionalScore = structuredClone(urgent.policy);
  fractionalScore.decision.score = 91.5;
  await expectPolicyRejection(
    db,
    'contract:key-score-fractional',
    urgent.request,
    fractionalScore,
    /integer between 0 and 100/,
  );

  const invalidServiceability = structuredClone(urgent.policy);
  invalidServiceability.decision.serviceable = 'yes';
  await expectPolicyRejection(
    db,
    'contract:key-serviceable',
    urgent.request,
    invalidServiceability,
    /missing required fields/,
  );

  const unsupportedPolicy = structuredClone(urgent.policy);
  unsupportedPolicy.policyVersion = 'unknown-policy';
  await expectPolicyRejection(
    db,
    'contract:key-policy-version',
    urgent.request,
    unsupportedPolicy,
    /invalid or unsupported policy response/,
  );

  const counts = await db.query(`
    SELECT
      (SELECT count(*)::int FROM clientops.leads) AS leads,
      (SELECT count(*)::int FROM clientops.delivery_outbox) AS deliveries
  `);
  assert.deepEqual(counts.rows[0], { leads: 1, deliveries: 2 });

  const claimed = await db.query(
    'SELECT * FROM clientops.claim_outbox($1, $2)',
    ['worker-contract-a', 20],
  );
  assert.equal(claimed.rows.length, 2);
  assert.deepEqual(
    new Set(claimed.rows.map((row) => row.channel)),
    new Set(['smtp', 'ntfy']),
  );
  assert(claimed.rows.every((row) => row.attempt === 1));
  assert(claimed.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.lease_token)));

  await db.query(
    'SELECT * FROM clientops.complete_outbox($1::uuid, $2, $3::uuid, $4)',
    [claimed.rows[0].outbox_id, claimed.rows[0].lease_owner, claimed.rows[0].lease_token, 'provider-message-001'],
  );
  const deferred = await db.query(
    'SELECT * FROM clientops.fail_outbox($1::uuid, $2, $3::uuid, $4)',
    [claimed.rows[1].outbox_id, claimed.rows[1].lease_owner, claimed.rows[1].lease_token, 'deliberate delivery failure'],
  );
  assert.equal(deferred.rows[0].status, 'pending');
  assert(deferred.rows[0].next_attempt_at instanceof Date);

  await db.query(`
    UPDATE clientops.delivery_outbox
       SET available_at = clock_timestamp() - interval '1 second'
     WHERE status = 'pending'
  `);
  const reclaimed = await db.query(
    'SELECT * FROM clientops.claim_outbox($1, $2)',
    ['worker-contract-a', 20],
  );
  assert.equal(reclaimed.rows.length, 1);
  assert.equal(reclaimed.rows[0].attempt, 2);
  assert.notEqual(reclaimed.rows[0].lease_token, claimed.rows[1].lease_token);
  await assert.rejects(
    db.query(
      'SELECT * FROM clientops.complete_outbox($1::uuid, $2, $3::uuid, $4)',
      [claimed.rows[1].outbox_id, claimed.rows[1].lease_owner, claimed.rows[1].lease_token, 'stale-completion'],
    ),
    /lease is missing or no longer owned/,
  );

  let activeDelivery = reclaimed.rows[0];
  while (activeDelivery.attempt < 6) {
    const retry = await db.query(
      'SELECT * FROM clientops.fail_outbox($1::uuid, $2, $3::uuid, $4)',
      [activeDelivery.outbox_id, activeDelivery.lease_owner, activeDelivery.lease_token, 'retry contract'],
    );
    assert.equal(retry.rows[0].status, 'pending');
    await db.query(`
      UPDATE clientops.delivery_outbox
         SET available_at = clock_timestamp() - interval '1 second'
       WHERE id = $1::uuid
    `, [activeDelivery.outbox_id]);
    const nextClaim = await db.query(
      'SELECT * FROM clientops.claim_outbox($1, $2)',
      ['worker-contract-a', 20],
    );
    assert.equal(nextClaim.rows.length, 1);
    activeDelivery = nextClaim.rows[0];
  }
  const deadLetter = await db.query(
    'SELECT * FROM clientops.fail_outbox($1::uuid, $2, $3::uuid, $4)',
    [activeDelivery.outbox_id, activeDelivery.lease_owner, activeDelivery.lease_token, 'final contract failure'],
  );
  assert.equal(deadLetter.rows[0].status, 'dead_letter');
  assert.equal(deadLetter.rows[0].next_attempt_at, null);

  await db.query(`
    UPDATE clientops.leads
       SET sla_due_at = clock_timestamp() - interval '1 minute'
     WHERE id = $1::uuid
  `, [ticket]);
  const escalation = await db.query('SELECT * FROM clientops.schedule_due_followups()');
  assert.equal(escalation.rows[0].scheduled_count, 1);
  const escalationReplay = await db.query('SELECT * FROM clientops.schedule_due_followups()');
  assert.equal(escalationReplay.rows[0].scheduled_count, 0);

  const claimedSla = await db.query(
    'SELECT * FROM clientops.claim_outbox($1, $2)',
    ['worker-sla', 20],
  );
  assert.equal(claimedSla.rows.length, 1);
  assert.equal(claimedSla.rows[0].kind, 'sla_alert');
  const preContactAuthorization = await db.query(
    'SELECT * FROM clientops.authorize_delivery($1::uuid, $2::uuid)',
    [claimedSla.rows[0].outbox_id, claimedSla.rows[0].lease_token],
  );
  assert.deepEqual(preContactAuthorization.rows[0], {
    allowed: true,
    reason: 'authorized',
  });

  const contacted = await db.query(
    'SELECT * FROM clientops.mark_lead_contacted($1::uuid, $2)',
    [ticket, 'Customer contacted during the contract test'],
  );
  assert.equal(contacted.rows[0].outcome, 'contacted');
  const staleSla = await db.query(
    'SELECT * FROM clientops.authorize_delivery($1::uuid, $2::uuid)',
    [claimedSla.rows[0].outbox_id, claimedSla.rows[0].lease_token],
  );
  assert.deepEqual(staleSla.rows[0], {
    allowed: false,
    reason: 'lease_not_current',
  });
  const contactedReplay = await db.query(
    'SELECT * FROM clientops.mark_lead_contacted($1::uuid, $2)',
    [ticket, 'Duplicate callback'],
  );
  assert.equal(contactedReplay.rows[0].outcome, 'replayed');

  const digest = await db.query('SELECT * FROM clientops.enqueue_daily_digest()');
  assert.equal(digest.rows[0].queued, true);
  const digestReplay = await db.query('SELECT * FROM clientops.enqueue_daily_digest()');
  assert.equal(digestReplay.rows[0].queued, false);
  const digestBody = await db.query(`
    SELECT body
      FROM clientops.delivery_outbox
     WHERE kind = 'daily_digest'
  `);
  assert.match(digestBody.rows[0].body, /Requests received: 1/);
  assert.match(digestBody.rows[0].body, /Still uncontacted: 0/);
  assert.match(digestBody.rows[0].body, /Contact events: 1/);

  const failure = await db.query(
    'SELECT clientops.record_workflow_failure($1, $2, $3, $4, $5, $6) AS id',
    ['Contract Test', 'contract', '1', 'Deliberate Failure', 'sanitized failure', 'contract'],
  );
  assert.equal(failure.rows[0].id, 1);
  const failureContext = await db.query(`
    SELECT sanitized_context
      FROM clientops.workflow_failures
     WHERE id = $1
  `, [failure.rows[0].id]);
  assert.deepEqual(failureContext.rows[0].sanitized_context, { mode: 'contract' });

  const ipColumns = await db.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'clientops'
       AND column_name ~ '(^|_)ip(_|$)'
     ORDER BY column_name
  `);
  assert.deepEqual(ipColumns.rows, []);

  await db.exec('SET ROLE clientops_app;');
  const queueHealth = await db.query('SELECT * FROM clientops.queue_health');
  assert.equal(queueHealth.rows.length, 1);
  await assert.rejects(
    db.query('SELECT count(*) FROM clientops.leads'),
    /permission denied/,
  );
  await assert.rejects(
    db.query('SELECT count(*) FROM clientops.schema_migrations'),
    /permission denied/,
  );
  await db.exec('RESET ROLE;');

  await db.exec(`
    INSERT INTO clientops.delivery_outbox (
      dedupe_key, kind, channel, recipient, subject, body, status,
      lease_owner, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES
      (
        'retention:stale-lease', 'owner_alert', 'smtp', 'expired@example.test',
        'Expired lease', 'expired personal data', 'leased', 'stale-worker', gen_random_uuid(),
        clock_timestamp() - interval '1 minute', clock_timestamp() - interval '91 days',
        clock_timestamp() - interval '91 days'
      ),
      (
        'retention:live-lease', 'owner_alert', 'smtp', 'active@example.test',
        'Active lease', 'temporarily protected personal data', 'leased', 'live-worker', gen_random_uuid(),
        clock_timestamp() + interval '5 minutes', clock_timestamp() - interval '91 days',
        clock_timestamp() - interval '91 days'
      );
  `);
  const purge = await db.query('SELECT * FROM clientops.purge_expired_data()');
  assert.equal(purge.rows[0].outbox_deleted, 1);
  const retentionRows = await db.query(`
    SELECT dedupe_key
      FROM clientops.delivery_outbox
     WHERE dedupe_key LIKE 'retention:%'
     ORDER BY dedupe_key
  `);
  assert.deepEqual(retentionRows.rows, [{ dedupe_key: 'retention:live-lease' }]);

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    contract: 'database-v1.1-generic',
    schemaVersion: '1.1.0',
    created: 1,
    replayed: 1,
    conflicts: 1,
    genericDecisionPersisted: true,
    invalidPolicyRejected: true,
    deliveryChannels: ['smtp', 'ntfy'],
    retriesVerified: 6,
    deadLetterVerified: true,
    leaseFencingVerified: true,
    slaVerified: true,
    contactCancellationVerified: true,
    digestVerified: true,
    runtimeRoleRestricted: true,
    noIpRetention: true,
    staleLeasePurged: true,
    liveLeasePreserved: true,
  }, null, 2)}\n`);
} finally {
  await db.close();
}
