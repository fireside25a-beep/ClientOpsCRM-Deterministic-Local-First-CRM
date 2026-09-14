# ClientOpsCRM 2.0.0 execution planner

## Gate 0 - Baseline truth
- Ingest ClientOps Relay 1.2.1 FINAL AIO.
- Verify archive integrity, inventory, non-empty files, C11 policy tests, server contract tests, and build parity.
- Preserve the working Relay line as the intake/automation subsystem.

## Gate 1 - Evidence expansion
- Retain the 77 inherited Relay references.
- Add current primary CRM sources covering object models, relationships, pipelines, ownership, activities, duplicate management, forecasting, audit, security, webhooks, and search.
- Add database/security/HTTP standards and selected high-grade academic systems/CRM sources where they change design.
- Finish with >100 unique individually traceable references.

## Gate 2 - CRM domain model
- Organizations/accounts.
- Contacts and account relationships.
- Leads and lead qualification/disqualification/conversion.
- Pipelines and ordered stages.
- Opportunities/deals with amount, currency, probability, expected close, owner, won/lost state.
- Tasks, notes, custom fields, tags/timeline/audit.
- Full-text search and duplicate detection.

## Gate 3 - Compiled CRM implementation
- C++17 CLI linked to SQLite.
- Versioned schema initialization/migration.
- Foreign keys, constraints, transactions, prepared statements, busy timeout, WAL.
- Transactional lead conversion and deal state transitions.
- Search, dashboard, forecast, dedupe, export, doctor, and audit commands.

## Gate 4 - Relay coexistence
- Keep the Relay C11 policy engine, PostgreSQL transactional outbox, workflows, edge hardening, deployment assets, and existing tests.
- Document lineage and operational separation between intake automation and local CRM operations.
- Add import/export interoperability artifacts where executable and testable.

## Gate 5 - Verification
- Compile warnings-as-errors.
- Sanitizer build.
- Real CLI end-to-end test against a real SQLite database.
- Negative/adversarial inputs and illegal transitions.
- Audit/timeline verification.
- Search/dedupe/forecast reconciliation.
- Deterministic read-output repetition after fixed state.
- Existing Relay native tests rerun.
- Release-content, zero-byte, checksum, and ZIP-integrity audits.

## Gate 6 - Documentation
- Operator guide.
- CLI/API reference.
- Architecture and data model.
- Adversarial analysis.
- Glossary.
- Research synthesis and design rationale.
- Verification report.
- LaTeX sources and rendered PDFs.

## Gate 7 - Smart ZIP delivery
- SOURCE_AIO ZIP.
- DOCUMENTATION ZIP.
- RESEARCH ZIP.
- VERIFICATION ZIP.
- Master ZIP with README_FIRST, release notes, inventory, checksums, and all inner archives.
