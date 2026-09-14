\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS clientops;

CREATE TABLE IF NOT EXISTS clientops.schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $schema_version$
DECLARE
    v_existing text;
BEGIN
    SELECT checksum INTO v_existing
      FROM clientops.schema_migrations
     WHERE version = '1.1.0';
    IF FOUND AND v_existing <> 'universal-triage-contract-1' THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'ClientOps Relay 1.1.0 schema checksum mismatch';
    END IF;
    INSERT INTO clientops.schema_migrations (version, checksum)
    VALUES ('1.1.0', 'universal-triage-contract-1')
    ON CONFLICT (version) DO NOTHING;
END
$schema_version$;

CREATE TABLE IF NOT EXISTS clientops.settings (
    key text PRIMARY KEY,
    value text NOT NULL CHECK (length(value) BETWEEN 1 AND 512),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS clientops.leads (
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
    category text NOT NULL,
    score smallint NOT NULL
        CONSTRAINT leads_score_check CHECK (score BETWEEN 0 AND 100),
    serviceable boolean NOT NULL,
    urgency text NOT NULL
        CONSTRAINT leads_urgency_check CHECK (urgency IN ('low', 'medium', 'high')),
    summary text NOT NULL,
    next_step text NOT NULL,
    draft_reply text NOT NULL,
    route text NOT NULL CHECK (route IN (
        'ROUTE_SPAM',
        'ROUTE_UNSUPPORTED',
        'ROUTE_INSUFFICIENT_INFORMATION',
        'ROUTE_STANDARD',
        'ROUTE_SPECIALIST',
        'ROUTE_URGENT',
        'ROUTE_LOCATION_REVIEW',
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

CREATE INDEX IF NOT EXISTS leads_open_sla_idx
    ON clientops.leads (sla_due_at)
    WHERE status = 'new' AND escalated_at IS NULL AND sla_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_created_idx
    ON clientops.leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_route_idx
    ON clientops.leads (route, created_at DESC);

CREATE TABLE IF NOT EXISTS clientops.lead_activity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lead_id uuid NOT NULL REFERENCES clientops.leads(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS lead_activity_lead_idx
    ON clientops.lead_activity (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clientops.delivery_outbox (
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

CREATE INDEX IF NOT EXISTS delivery_outbox_ready_idx
    ON clientops.delivery_outbox (available_at, created_at)
    WHERE status IN ('pending', 'leased');
CREATE INDEX IF NOT EXISTS delivery_outbox_lead_idx
    ON clientops.delivery_outbox (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clientops.workflow_failures (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_name text NOT NULL,
    workflow_id text NOT NULL DEFAULT '',
    execution_id text NOT NULL DEFAULT '',
    last_node text NOT NULL DEFAULT '',
    error_message text NOT NULL,
    sanitized_context jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS workflow_failures_created_idx
    ON clientops.workflow_failures (created_at DESC);

CREATE OR REPLACE FUNCTION clientops.setting(p_key text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT value FROM clientops.settings WHERE key = p_key
$$;

CREATE OR REPLACE FUNCTION clientops.ingest_lead(
    p_idempotency_key text,
    p_request jsonb,
    p_policy jsonb
)
RETURNS TABLE (
    status_code integer,
    outcome text,
    ticket_id uuid,
    public_message text,
    priority text,
    route text,
    sla_due_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_fingerprint bytea;
    v_existing clientops.leads%ROWTYPE;
    v_lead jsonb;
    v_decision jsonb;
    v_lead_id uuid;
    v_route text;
    v_priority text;
    v_sla_due_at timestamptz;
    v_owner_email text;
    v_ntfy_topic text;
    v_subject text;
    v_owner_body text;
    v_score smallint;
    v_score_numeric numeric;
BEGIN
    IF p_idempotency_key IS NULL
       OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'invalid idempotency key';
    END IF;
    IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
       OR p_request->>'consent' IS DISTINCT FROM 'true'
       OR COALESCE(p_request->>'name', '') = ''
       OR COALESCE(p_request->>'email', '') = ''
       OR COALESCE(p_request->>'message', '') = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'invalid canonical request';
    END IF;
    IF jsonb_typeof(p_policy) IS DISTINCT FROM 'object'
       OR p_policy->>'ok' IS DISTINCT FROM 'true'
       OR p_policy->>'policyVersion' IS DISTINCT FROM 'clientops-triage-v1'
       OR jsonb_typeof(p_policy->'lead') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_policy->'decision') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'invalid or unsupported policy response';
    END IF;

    v_lead := p_policy->'lead';
    v_decision := p_policy->'decision';
    v_route := v_decision->>'route';
    IF COALESCE(v_lead->>'name', '') = ''
       OR COALESCE(v_lead->>'email', '') = ''
       OR COALESCE(v_lead->>'message', '') = ''
       OR v_lead->>'consent' IS DISTINCT FROM 'true'
       OR COALESCE(v_decision->>'category', '') = ''
       OR jsonb_typeof(v_decision->'fit') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_decision->'score') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_decision->'serviceable') IS DISTINCT FROM 'boolean'
       OR COALESCE(v_decision->>'urgency', '') NOT IN ('low', 'medium', 'high')
       OR v_route NOT IN (
            'ROUTE_SPAM', 'ROUTE_UNSUPPORTED',
            'ROUTE_INSUFFICIENT_INFORMATION', 'ROUTE_STANDARD',
            'ROUTE_SPECIALIST', 'ROUTE_URGENT', 'ROUTE_LOCATION_REVIEW',
            'ROUTE_MANUAL_REVIEW'
       ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'policy response is missing required fields';
    END IF;

    BEGIN
        v_score_numeric := (v_decision->>'score')::numeric;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'policy response contains an invalid score';
    END;
    IF v_score_numeric <> trunc(v_score_numeric)
       OR v_score_numeric NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'policy response score must be an integer between 0 and 100';
    END IF;
    v_score := v_score_numeric::smallint;

    -- The fingerprint is an index-friendly diagnostic. Replay safety compares the
    -- complete canonical request below, so it does not depend on hash strength.
    v_fingerprint := decode(md5(p_request::text), 'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
    SELECT * INTO v_existing
      FROM clientops.leads
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing.request_fingerprint = v_fingerprint
           AND v_existing.canonical_request = p_request THEN
            RETURN QUERY SELECT
                200,
                'replayed'::text,
                v_existing.id,
                'Request already accepted; returning the original ticket.'::text,
                v_existing.priority,
                v_existing.route,
                v_existing.sla_due_at;
        ELSE
            RETURN QUERY SELECT
                409,
                'conflict'::text,
                NULL::uuid,
                'That idempotency key was already used with different data.'::text,
                NULL::text,
                NULL::text,
                NULL::timestamptz;
        END IF;
        RETURN;
    END IF;

    v_priority := CASE
        WHEN v_route = 'ROUTE_URGENT' THEN 'high'
        WHEN v_route IN ('ROUTE_SPECIALIST', 'ROUTE_STANDARD') THEN 'medium'
        ELSE 'low'
    END;
    v_sla_due_at := CASE
        WHEN v_route = 'ROUTE_URGENT' THEN clock_timestamp() + interval '15 minutes'
        WHEN v_route IN ('ROUTE_SPECIALIST', 'ROUTE_STANDARD')
            THEN clock_timestamp() + interval '2 hours'
        WHEN v_route IN ('ROUTE_INSUFFICIENT_INFORMATION', 'ROUTE_MANUAL_REVIEW')
            THEN clock_timestamp() + interval '4 hours'
        ELSE NULL
    END;

    INSERT INTO clientops.leads (
        idempotency_key, request_fingerprint, policy_version,
        channel, customer_name, city, phone, email, source,
        message, consent, fit, fit_reason, category, score, serviceable, urgency,
        summary, next_step, draft_reply, route, priority,
        sla_due_at, canonical_request, raw_policy
    ) VALUES (
        p_idempotency_key, v_fingerprint, p_policy->>'policyVersion',
        COALESCE(v_lead->>'channel', ''), v_lead->>'name',
        COALESCE(v_lead->>'city', ''), COALESCE(v_lead->>'phone', ''),
        v_lead->>'email', COALESCE(v_lead->>'source', ''),
        v_lead->>'message', true,
        COALESCE((v_decision->>'fit')::boolean, false),
        COALESCE(v_decision->>'fitReason', ''),
        v_decision->>'category', v_score,
        (v_decision->>'serviceable')::boolean,
        COALESCE(v_decision->>'urgency', ''),
        COALESCE(v_decision->>'summary', ''),
        COALESCE(v_decision->>'nextStep', ''),
        COALESCE(v_decision->>'draftReply', ''),
        v_route, v_priority, v_sla_due_at, p_request, p_policy
    )
    RETURNING id INTO v_lead_id;

    INSERT INTO clientops.lead_activity (lead_id, event_type, details)
    VALUES (
        v_lead_id,
        'accepted',
        jsonb_build_object(
            'route', v_route,
            'priority', v_priority,
            'policyVersion', p_policy->>'policyVersion'
        )
    );

    IF COALESCE(v_decision->>'draftReply', '') <> ''
       AND v_route <> 'ROUTE_SPAM' THEN
        INSERT INTO clientops.delivery_outbox (
            dedupe_key, lead_id, kind, channel, recipient, subject, body, priority
        ) VALUES (
            format('lead:%s:customer-ack', v_lead_id),
            v_lead_id,
            'customer_ack',
            'smtp',
            v_lead->>'email',
            'We received your request',
            v_decision->>'draftReply',
            'medium'
        );
    END IF;

    IF v_route <> 'ROUTE_SPAM' THEN
        v_owner_email := clientops.setting('owner_email');
        v_ntfy_topic := clientops.setting('ntfy_topic');
        IF v_owner_email IS NULL OR v_ntfy_topic IS NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'owner_email and ntfy_topic settings must be configured';
        END IF;
        v_subject := format('[ClientOps] %s request — %s', upper(v_priority), v_lead->>'name');
        v_owner_body := concat_ws(
            E'\n',
            v_decision->>'summary',
            format('Route: %s', v_route),
            format('Next step: %s', v_decision->>'nextStep'),
            format('Contact: %s | %s', v_lead->>'email', COALESCE(v_lead->>'phone', '')),
            format('Ticket: %s', v_lead_id)
        );
        INSERT INTO clientops.delivery_outbox (
            dedupe_key, lead_id, kind, channel, recipient, subject, body, priority
        ) VALUES (
            format('lead:%s:owner-alert', v_lead_id),
            v_lead_id,
            'owner_alert',
            CASE WHEN v_priority = 'high' THEN 'ntfy' ELSE 'smtp' END,
            CASE WHEN v_priority = 'high' THEN v_ntfy_topic ELSE v_owner_email END,
            v_subject,
            v_owner_body,
            v_priority
        );
    END IF;

    RETURN QUERY SELECT
        201,
        'created'::text,
        v_lead_id,
        'Request accepted and queued for follow-up.'::text,
        v_priority,
        v_route,
        v_sla_due_at;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.claim_outbox(
    p_worker text,
    p_limit integer DEFAULT 20
)
RETURNS TABLE (
    outbox_id uuid,
    lead_id uuid,
    kind text,
    channel text,
    recipient text,
    subject text,
    body text,
    priority text,
    attempt smallint,
    lease_owner text,
    lease_token uuid
)
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid worker identity';
    END IF;

    UPDATE clientops.delivery_outbox AS o
       SET status = 'dead_letter',
           dead_lettered_at = clock_timestamp(),
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = COALESCE(o.last_error, 'delivery lease expired after final attempt'),
           updated_at = clock_timestamp()
     WHERE o.status = 'leased'
       AND o.lease_expires_at <= clock_timestamp()
       AND o.attempts >= 6;

    UPDATE clientops.delivery_outbox AS o
       SET status = 'cancelled',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
      FROM clientops.leads AS l
     WHERE o.lead_id = l.id
       AND o.kind = 'sla_alert'
       AND o.status IN ('pending', 'leased')
       AND l.status <> 'new';

    RETURN QUERY
    WITH candidates AS (
        SELECT o.id
          FROM clientops.delivery_outbox AS o
         WHERE (
                (o.status = 'pending' AND o.available_at <= clock_timestamp())
                OR
                (o.status = 'leased' AND o.lease_expires_at <= clock_timestamp())
               )
           AND o.attempts < 6
         ORDER BY
            CASE o.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
            o.available_at,
            o.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT LEAST(GREATEST(p_limit, 1), 100)
    ), leased AS (
        UPDATE clientops.delivery_outbox AS o
           SET status = 'leased',
               attempts = o.attempts + 1,
               lease_owner = p_worker,
               lease_token = gen_random_uuid(),
               lease_expires_at = clock_timestamp() + interval '5 minutes',
               updated_at = clock_timestamp()
          FROM candidates AS c
         WHERE o.id = c.id
        RETURNING o.*
    )
    SELECT
        l.id,
        l.lead_id,
        l.kind,
        l.channel,
        l.recipient,
        l.subject,
        l.body,
        l.priority,
        l.attempts,
        l.lease_owner,
        l.lease_token
      FROM leased AS l;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.authorize_delivery(
    p_outbox_id uuid,
    p_lease_token uuid
)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
    v_kind text;
    v_lead_status text;
BEGIN
    SELECT o.kind, l.status
      INTO v_kind, v_lead_status
      FROM clientops.delivery_outbox AS o
      LEFT JOIN clientops.leads AS l ON l.id = o.lead_id
     WHERE o.id = p_outbox_id
       AND o.status = 'leased'
       AND o.lease_token = p_lease_token
     FOR UPDATE OF o;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'lease_not_current'::text;
        RETURN;
    END IF;
    IF v_kind = 'sla_alert' AND v_lead_status IS DISTINCT FROM 'new' THEN
        UPDATE clientops.delivery_outbox
           SET status = 'cancelled',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = clock_timestamp()
         WHERE id = p_outbox_id;
        RETURN QUERY SELECT false, 'lead_already_contacted'::text;
        RETURN;
    END IF;
    RETURN QUERY SELECT true, 'authorized'::text;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.complete_outbox(
    p_outbox_id uuid,
    p_worker text,
    p_lease_token uuid,
    p_provider_message_id text DEFAULT ''
)
RETURNS TABLE (outbox_id uuid, status text)
LANGUAGE plpgsql
AS $$
DECLARE
    v_lead_id uuid;
BEGIN
    UPDATE clientops.delivery_outbox AS o
       SET status = 'delivered',
           delivered_at = clock_timestamp(),
           provider_message_id = LEFT(COALESCE(p_provider_message_id, ''), 512),
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = clock_timestamp()
     WHERE o.id = p_outbox_id
       AND o.status = 'leased'
       AND o.lease_owner = p_worker
       AND o.lease_token = p_lease_token
    RETURNING o.lead_id INTO v_lead_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'delivery lease is missing or no longer owned';
    END IF;
    IF v_lead_id IS NOT NULL THEN
        INSERT INTO clientops.lead_activity (lead_id, event_type, details)
        VALUES (
            v_lead_id,
            'delivery_succeeded',
            jsonb_build_object('outboxId', p_outbox_id)
        );
    END IF;
    RETURN QUERY SELECT p_outbox_id, 'delivered'::text;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.fail_outbox(
    p_outbox_id uuid,
    p_worker text,
    p_lease_token uuid,
    p_error text
)
RETURNS TABLE (outbox_id uuid, status text, next_attempt_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
    v_attempts smallint;
    v_lead_id uuid;
    v_status text;
    v_next timestamptz;
BEGIN
    SELECT o.attempts, o.lead_id
      INTO v_attempts, v_lead_id
      FROM clientops.delivery_outbox AS o
     WHERE o.id = p_outbox_id
       AND o.status = 'leased'
       AND o.lease_owner = p_worker
       AND o.lease_token = p_lease_token
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'delivery lease is missing or no longer owned';
    END IF;

    IF v_attempts >= 6 THEN
        v_status := 'dead_letter';
        v_next := NULL;
    ELSE
        v_status := 'pending';
        v_next := clock_timestamp() + CASE v_attempts
            WHEN 1 THEN interval '1 minute'
            WHEN 2 THEN interval '5 minutes'
            WHEN 3 THEN interval '15 minutes'
            WHEN 4 THEN interval '1 hour'
            ELSE interval '4 hours'
        END;
    END IF;

    UPDATE clientops.delivery_outbox AS o
       SET status = v_status,
           available_at = COALESCE(v_next, o.available_at),
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = LEFT(COALESCE(NULLIF(p_error, ''), 'delivery failed'), 2000),
           dead_lettered_at = CASE WHEN v_status = 'dead_letter' THEN clock_timestamp() ELSE NULL END,
           updated_at = clock_timestamp()
     WHERE o.id = p_outbox_id;

    IF v_lead_id IS NOT NULL THEN
        INSERT INTO clientops.lead_activity (lead_id, event_type, details)
        VALUES (
            v_lead_id,
            CASE WHEN v_status = 'dead_letter' THEN 'delivery_dead_lettered' ELSE 'delivery_deferred' END,
            jsonb_build_object(
                'outboxId', p_outbox_id,
                'attempt', v_attempts,
                'error', LEFT(COALESCE(p_error, ''), 500)
            )
        );
    END IF;
    RETURN QUERY SELECT p_outbox_id, v_status, v_next;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.schedule_due_followups(p_limit integer DEFAULT 100)
RETURNS TABLE (scheduled_count integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_lead clientops.leads%ROWTYPE;
    v_count integer := 0;
    v_owner_email text := clientops.setting('owner_email');
    v_ntfy_topic text := clientops.setting('ntfy_topic');
    v_inserted integer;
BEGIN
    IF v_owner_email IS NULL OR v_ntfy_topic IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'owner notification settings are missing';
    END IF;
    FOR v_lead IN
        SELECT *
          FROM clientops.leads AS l
         WHERE l.status = 'new'
           AND l.sla_due_at IS NOT NULL
           AND l.sla_due_at <= clock_timestamp()
           AND l.escalated_at IS NULL
         ORDER BY l.sla_due_at
         FOR UPDATE SKIP LOCKED
         LIMIT LEAST(GREATEST(p_limit, 1), 500)
    LOOP
        INSERT INTO clientops.delivery_outbox (
            dedupe_key, lead_id, kind, channel, recipient, subject, body, priority
        ) VALUES (
            format('lead:%s:sla-escalation', v_lead.id),
            v_lead.id,
            'sla_alert',
            CASE WHEN v_lead.priority = 'high' THEN 'ntfy' ELSE 'smtp' END,
            CASE WHEN v_lead.priority = 'high' THEN v_ntfy_topic ELSE v_owner_email END,
            format('[ClientOps] SLA overdue — %s', v_lead.customer_name),
            concat_ws(
                E'\n',
                format('Request %s is still uncontacted.', v_lead.id),
                format('Route: %s', v_lead.route),
                format('Next step: %s', v_lead.next_step),
                format('Due: %s', v_lead.sla_due_at)
            ),
            'high'
        ) ON CONFLICT (dedupe_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        UPDATE clientops.leads
           SET escalated_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = v_lead.id;
        INSERT INTO clientops.lead_activity (lead_id, event_type, details)
        VALUES (v_lead.id, 'sla_escalated', jsonb_build_object('dueAt', v_lead.sla_due_at));
        v_count := v_count + v_inserted;
    END LOOP;
    RETURN QUERY SELECT v_count;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.enqueue_daily_digest(p_day date DEFAULT NULL)
RETURNS TABLE (queued boolean, digest_day date)
LANGUAGE plpgsql
AS $$
DECLARE
    v_owner_email text := clientops.setting('owner_email');
    v_timezone text := COALESCE(clientops.setting('business_timezone'), 'UTC');
    v_day date;
    v_start timestamptz;
    v_end timestamptz;
    v_body text;
    v_inserted integer;
BEGIN
    IF v_owner_email IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'owner_email setting is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_timezone) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'business_timezone setting is invalid';
    END IF;
    v_day := COALESCE(p_day, (clock_timestamp() AT TIME ZONE v_timezone)::date);
    v_start := v_day::timestamp AT TIME ZONE v_timezone;
    v_end := (v_day + 1)::timestamp AT TIME ZONE v_timezone;
    SELECT concat_ws(
        E'\n',
        format('ClientOps Relay digest for %s (%s)', v_day, v_timezone),
        format('Requests received: %s', count(*)),
        format('Still uncontacted: %s', count(*) FILTER (WHERE status = 'new')),
        format('High priority: %s', count(*) FILTER (WHERE priority = 'high')),
        format('Contact events: %s', (
            SELECT count(*) FROM clientops.lead_activity AS a
             WHERE a.event_type = 'contacted' AND a.created_at >= v_start AND a.created_at < v_end
        )),
        format('SLA alerts queued: %s', (
            SELECT count(*) FROM clientops.lead_activity AS a
             WHERE a.event_type = 'sla_escalated' AND a.created_at >= v_start AND a.created_at < v_end
        )),
        format('Dead-letter deliveries: %s', (
            SELECT count(*) FROM clientops.delivery_outbox AS o
             WHERE o.status = 'dead_letter'
               AND o.dead_lettered_at >= v_start AND o.dead_lettered_at < v_end
        ))
    ) INTO v_body
      FROM clientops.leads AS l
     WHERE l.created_at >= v_start AND l.created_at < v_end;

    INSERT INTO clientops.delivery_outbox (
        dedupe_key, kind, channel, recipient, subject, body, priority
    ) VALUES (
        format('daily-digest:%s', v_day),
        'daily_digest',
        'smtp',
        v_owner_email,
        format('[ClientOps] Daily digest — %s', v_day),
        v_body,
        'low'
    ) ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN QUERY SELECT v_inserted = 1, v_day;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.mark_lead_contacted(
    p_ticket_id uuid,
    p_note text DEFAULT ''
)
RETURNS TABLE (status_code integer, outcome text, public_message text)
LANGUAGE plpgsql
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT l.status INTO v_status
      FROM clientops.leads AS l
     WHERE l.id = p_ticket_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 404, 'not_found'::text, 'Ticket was not found.'::text;
        RETURN;
    END IF;
    IF v_status IN ('contacted', 'closed') THEN
        RETURN QUERY SELECT 200, 'replayed'::text, 'Request was already marked as contacted.'::text;
        RETURN;
    END IF;
    UPDATE clientops.leads
       SET status = 'contacted',
           contacted_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE id = p_ticket_id;
    UPDATE clientops.delivery_outbox
       SET status = 'cancelled',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE lead_id = p_ticket_id
       AND kind = 'sla_alert'
       AND status IN ('pending', 'leased');
    INSERT INTO clientops.lead_activity (lead_id, event_type, details)
    VALUES (
        p_ticket_id,
        'contacted',
        jsonb_build_object('note', LEFT(COALESCE(p_note, ''), 1000))
    );
    RETURN QUERY SELECT 200, 'contacted'::text, 'Request marked as contacted.'::text;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.record_workflow_failure(
    p_workflow_name text,
    p_workflow_id text,
    p_execution_id text,
    p_last_node text,
    p_error_message text,
    p_mode text DEFAULT 'unknown'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_id bigint;
BEGIN
    INSERT INTO clientops.workflow_failures (
        workflow_name, workflow_id, execution_id, last_node,
        error_message, sanitized_context
    ) VALUES (
        LEFT(COALESCE(p_workflow_name, 'unknown'), 255),
        LEFT(COALESCE(p_workflow_id, ''), 128),
        LEFT(COALESCE(p_execution_id, ''), 128),
        LEFT(COALESCE(p_last_node, ''), 255),
        LEFT(COALESCE(p_error_message, 'unknown workflow error'), 2000),
        jsonb_build_object('mode', LEFT(COALESCE(p_mode, 'unknown'), 32))
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION clientops.purge_expired_data()
RETURNS TABLE (outbox_deleted integer, leads_deleted integer, failures_deleted integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_retention_days integer;
    v_failure_days integer;
    v_outbox integer;
    v_leads integer;
    v_failures integer;
BEGIN
    BEGIN
        v_retention_days := COALESCE(clientops.setting('retention_days'), '90')::integer;
        v_failure_days := COALESCE(clientops.setting('failure_retention_days'), '30')::integer;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retention settings must be integers';
    END;
    IF v_retention_days NOT BETWEEN 7 AND 3650 OR v_failure_days NOT BETWEEN 7 AND 3650 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retention settings must be between 7 and 3650 days';
    END IF;

    DELETE FROM clientops.delivery_outbox
     WHERE created_at < clock_timestamp() - make_interval(days => v_retention_days)
       AND (status <> 'leased' OR lease_expires_at <= clock_timestamp());
    GET DIAGNOSTICS v_outbox = ROW_COUNT;

    DELETE FROM clientops.leads
     WHERE created_at < clock_timestamp() - make_interval(days => v_retention_days);
    GET DIAGNOSTICS v_leads = ROW_COUNT;

    DELETE FROM clientops.workflow_failures
     WHERE created_at < clock_timestamp() - make_interval(days => v_failure_days);
    GET DIAGNOSTICS v_failures = ROW_COUNT;

    RETURN QUERY SELECT v_outbox, v_leads, v_failures;
END;
$$;

CREATE OR REPLACE VIEW clientops.queue_health AS
SELECT
    count(*) FILTER (WHERE status = 'pending') AS pending,
    count(*) FILTER (WHERE status = 'leased') AS leased,
    count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter,
    min(available_at) FILTER (WHERE status = 'pending') AS oldest_ready_at,
    max(updated_at) FILTER (WHERE status = 'delivered') AS last_delivery_at
FROM clientops.delivery_outbox;

ALTER FUNCTION clientops.setting(text) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.ingest_lead(text, jsonb, jsonb) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.claim_outbox(text, integer) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.authorize_delivery(uuid, uuid) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.complete_outbox(uuid, text, uuid, text) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.fail_outbox(uuid, text, uuid, text) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.schedule_due_followups(integer) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.enqueue_daily_digest(date) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.mark_lead_contacted(uuid, text) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.record_workflow_failure(text, text, text, text, text, text) SECURITY DEFINER SET search_path = pg_catalog, clientops;
ALTER FUNCTION clientops.purge_expired_data() SECURITY DEFINER SET search_path = pg_catalog, clientops;

REVOKE ALL ON ALL TABLES IN SCHEMA clientops FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA clientops FROM PUBLIC;
GRANT USAGE ON SCHEMA clientops TO clientops_app;
GRANT SELECT ON clientops.queue_health TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.ingest_lead(text, jsonb, jsonb) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.claim_outbox(text, integer) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.authorize_delivery(uuid, uuid) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.complete_outbox(uuid, text, uuid, text) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.fail_outbox(uuid, text, uuid, text) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.schedule_due_followups(integer) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.enqueue_daily_digest(date) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.mark_lead_contacted(uuid, text) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.record_workflow_failure(text, text, text, text, text, text) TO clientops_app;
GRANT EXECUTE ON FUNCTION clientops.purge_expired_data() TO clientops_app;
