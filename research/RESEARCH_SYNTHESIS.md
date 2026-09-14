# ClientOpsCRM 2.0.0 Research Synthesis

## Corpus

The canonical corpus contains 143 unique traceable sources. Sources 1–77 are the inherited Relay 1.2.1 research corpus covering automation platforms, n8n, deployment, PostgreSQL, networking, security standards and adjacent operational systems. Sources 78–143 extend the corpus with current CRM object models and workflows, SQLite persistence/search/integrity material, security guidance, peer-reviewed CRM research and decision-science evidence.

The dominant source class is first-party documentation. Academic sources are used for CRM process theory and uncertainty/decision framing, not as implementation manuals. Vendor pages are compared for recurring primitives; no vendor code/schema is copied.

## Evidence-backed design conclusions

- Separate organization/person/opportunity objects are a robust recurring CRM data model (HubSpot 78–85; Microsoft 103; Pipedrive 88–90).
- Qualification before opportunity creation is recurrent (Microsoft 99–100; Pipedrive 89; Odoo 106; SAP 110–112).
- Pipeline stages/probabilities are explicit operational state, not labels embedded in notes (Pipedrive 94–95; Odoo 108–109; SAP 115).
- Activities/follow-up need durable association to CRM objects (Pipedrive 87; Odoo 107; SAP 114).
- Custom fields and search are expected extensibility surfaces (HubSpot 82,84; Pipedrive 92–93).
- Import needs stable identity/error semantics (HubSpot 86), motivating Relay UUID identity and idempotent replay.
- Mutation audit and operator-facing activity history solve different questions (Microsoft 104–105), motivating separate audit/activity tables.
- Prepared statements and early syntactic/semantic validation are appropriate primary controls for untrusted CRM/import data (OWASP 129–132).
- SQLite provides explicit transactions, full-text search, integrity checking, JSON validation and foreign keys appropriate to a self-contained local application file (120–128).
- CRM should be designed as a process and performance system, not merely a contact database (Payne/Frow 138; Reinartz/Krafft/Hoyer 139; Kumar/Reinartz 141).
- Customer interactions occur across multiple touch points over time (Lemon/Verhoef 140), supporting persistent source/history rather than overwrite-only records.
- Human probability judgments are framing-sensitive (Tversky/Kahneman 142; Nobel source 143), so weighted forecast arithmetic is exposed as an assumption-based summary rather than marketed as objective prediction.

## Novel synthesis

ClientOpsCRM combines these recurring CRM primitives with Relay's deterministic intake/outbox philosophy in a deliberately small executable state machine. The distinctive element is not a new name for ordinary CRUD: conversion is an atomic provenance-preserving transformation from intake evidence to opportunity state; lifecycle contradictions are blocked in SQLite itself; the human timeline is separated from append-only mutation evidence; and a Relay ticket remains a stable external identity through repeated imports. This permits independent verification of business state without requiring the automation stack to be running for ordinary CRM operation.

## Research quality controls

URLs are unique in the merged register. Retrieval dates are recorded. Primary/official sources dominate. Academic sources are traceable by DOI/publisher. The claim ledger identifies consequential design decisions and the source IDs that informed them. The implementation test suite is independent of vendor software and therefore tests the produced system rather than testing examples from the literature.
