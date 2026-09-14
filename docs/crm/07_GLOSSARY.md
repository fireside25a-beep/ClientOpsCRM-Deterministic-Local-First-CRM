# ClientOpsCRM 2.0.0 Glossary

**Account** — Organization/company record. May own many contacts and deals.

**Activity** — Business-facing event in an entity timeline, such as creation, qualification, conversion, stage move or closure.

**Actor** — Operator/automation identity attached to audit mutations through the CRM connection context.

**Audit log** — Append-only database record of mutations with actor and JSON before/after evidence where applicable.

**ClientOps Relay** — Existing 1.2.1 deterministic intake/automation subsystem retained in the combined release.

**ClientOpsCRM** — Compiled operator-side CRM introduced in version 2.0.0.

**Contact** — Person record, optionally associated with an account.

**Conversion** — Transaction that transforms a qualified lead into durable account/contact/deal links and marks the lead converted.

**Custom value** — Operator-defined key/value attached to an account, contact, lead or deal; key syntax is constrained.

**Deal / opportunity** — Qualified commercial pursuit that belongs to a pipeline and stage until won/lost.

**Dedupe signal** — Normalized identity collision presented for review; not every signal is automatically merged.

**Doctor** — Executable database/invariant health check.

**Expected close** — Validated calendar date associated with a deal.

**FTS5** — SQLite full-text-search extension used by `search`.

**Lead** — Pre-opportunity record that may be new, qualified, disqualified or converted.

**Minor units** — Integer representation of money at two decimal places (e.g. EUR 12.34 → 1234) used to avoid binary floating-point storage.

**Normalized identity** — Canonical form used for uniqueness/matching, such as lowercase email/domain or digits-only phone.

**Owner** — Business ownership label stored on the relevant CRM record.

**Pipeline** — Ordered sales process containing stages.

**Probability** — Integer 0..100 attached to a stage and synchronized into a deal for deterministic weighted pipeline reporting.

**Relay ticket ID** — Stable UUID from Relay used as the import identity for a CRM lead.

**Stage** — Ordered pipeline state with name, probability and kind (`open`, `won`, `lost`).

**Task** — Follow-up work item attached to one core CRM entity.

**Timeline** — Ordered activity view for business history; distinct from mutation audit.

**Transactional** — A multi-step operation that commits atomically or rolls back as a unit.

**Weighted forecast** — Sum of amount_minor × probability / 100 across open deals; an inspectable arithmetic summary, not a learned predictor.
