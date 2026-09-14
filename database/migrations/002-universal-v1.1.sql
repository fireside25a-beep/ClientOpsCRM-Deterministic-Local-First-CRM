\set ON_ERROR_STOP on

BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('clientops-relay-schema-migration', 0));

CREATE SCHEMA IF NOT EXISTS clientops;
CREATE TABLE IF NOT EXISTS clientops.schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $migration$
BEGIN
    IF to_regclass('clientops.leads') IS NULL THEN
        RETURN;
    END IF;

    ALTER TABLE clientops.leads ADD COLUMN IF NOT EXISTS category text;
    ALTER TABLE clientops.leads ADD COLUMN IF NOT EXISTS score smallint;
    ALTER TABLE clientops.leads ADD COLUMN IF NOT EXISTS serviceable boolean;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'clientops' AND table_name = 'leads' AND column_name = 'space'
    ) THEN
        EXECUTE 'UPDATE clientops.leads
                    SET category = COALESCE(NULLIF(category, ''''), NULLIF(space, ''''), ''legacy''),
                        score = COALESCE(score, CASE route
                            WHEN ''ROUTE_SPAM'' THEN 0
                            WHEN ''ROUTE_WRONG_SPECIALTY'' THEN 10
                            WHEN ''ROUTE_INSUFFICIENT_INFORMATION'' THEN 25
                            WHEN ''ROUTE_STANDARD_RESIDENTIAL'' THEN 60
                            WHEN ''ROUTE_URGENT'' THEN 90
                            WHEN ''ROUTE_COMMERCIAL'' THEN 75
                            WHEN ''ROUTE_OUT_OF_AREA'' THEN 40
                            WHEN ''ROUTE_MODEL_RETRY'' THEN 35
                            WHEN ''ROUTE_MANUAL_REVIEW'' THEN 35
                            ELSE 0 END),
                        serviceable = COALESCE(serviceable, in_area, true)';
    ELSE
        UPDATE clientops.leads
           SET category = COALESCE(NULLIF(category, ''), 'general'),
               score = COALESCE(score, 0),
               serviceable = COALESCE(serviceable, true);
    END IF;

    ALTER TABLE clientops.leads DROP CONSTRAINT IF EXISTS leads_route_check;
    UPDATE clientops.leads
       SET route = CASE route
           WHEN 'ROUTE_WRONG_SPECIALTY' THEN 'ROUTE_UNSUPPORTED'
           WHEN 'ROUTE_STANDARD_RESIDENTIAL' THEN 'ROUTE_STANDARD'
           WHEN 'ROUTE_COMMERCIAL' THEN 'ROUTE_SPECIALIST'
           WHEN 'ROUTE_OUT_OF_AREA' THEN 'ROUTE_LOCATION_REVIEW'
           WHEN 'ROUTE_MODEL_RETRY' THEN 'ROUTE_MANUAL_REVIEW'
           ELSE route
       END;

    ALTER TABLE clientops.leads ALTER COLUMN category SET NOT NULL;
    ALTER TABLE clientops.leads ALTER COLUMN score SET NOT NULL;
    ALTER TABLE clientops.leads ALTER COLUMN serviceable SET NOT NULL;
    ALTER TABLE clientops.leads DROP COLUMN IF EXISTS space;
    ALTER TABLE clientops.leads DROP COLUMN IF EXISTS sqft;
    ALTER TABLE clientops.leads DROP COLUMN IF EXISTS in_area;
    ALTER TABLE clientops.leads DROP COLUMN IF EXISTS estimate;

    ALTER TABLE clientops.leads DROP CONSTRAINT IF EXISTS leads_score_check;
    ALTER TABLE clientops.leads ADD CONSTRAINT leads_score_check CHECK (score BETWEEN 0 AND 100);
    ALTER TABLE clientops.leads DROP CONSTRAINT IF EXISTS leads_urgency_check;
    ALTER TABLE clientops.leads ADD CONSTRAINT leads_urgency_check
        CHECK (urgency IN ('low', 'medium', 'high'));
    ALTER TABLE clientops.leads ADD CONSTRAINT leads_route_check CHECK (route IN (
        'ROUTE_SPAM',
        'ROUTE_UNSUPPORTED',
        'ROUTE_INSUFFICIENT_INFORMATION',
        'ROUTE_STANDARD',
        'ROUTE_SPECIALIST',
        'ROUTE_URGENT',
        'ROUTE_LOCATION_REVIEW',
        'ROUTE_MANUAL_REVIEW'
    ));
END
$migration$;

DO $migration_record$
DECLARE
    v_existing text;
BEGIN
    SELECT checksum INTO v_existing
      FROM clientops.schema_migrations
     WHERE version = '1.1.0';
    IF FOUND AND v_existing <> 'universal-triage-contract-1' THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'ClientOps Relay 1.1.0 migration checksum mismatch';
    END IF;
    INSERT INTO clientops.schema_migrations (version, checksum)
    VALUES ('1.1.0', 'universal-triage-contract-1')
    ON CONFLICT (version) DO NOTHING;
END
$migration_record$;

COMMIT;
