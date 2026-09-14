# ClientOpsCRM 2.0.0 release notes

ClientOpsCRM 2.0.0 extends ClientOps Relay 1.2.1 with a compiled local-first CRM while preserving Relay's existing deterministic intake, PostgreSQL, n8n, companion service, deployment, and verification assets.

Implemented CRM capabilities: accounts and contacts; leads with Relay identity and metadata; lead qualification/disqualification; atomic lead-to-account/contact/deal conversion; multiple pipelines and configurable stages; open/won/lost deal lifecycle; exact minor-unit money; tasks; notes; custom fields; ownership fields; FTS5 search; normalized duplicate signals; dashboard and weighted forecast views; entity timelines; append-only audit; JSON/CSV export; RFC-style CSV import; idempotent live Relay lead import; schema fail-closed behavior; integrity doctor.

Verification: strict release/debug/sanitizer compilation with warnings as errors; release and ASan/UBSan integration/adversarial suites; database-level corruption/state-transition attempts; audit tamper attempts; deterministic reads; import replay; shell syntax and release packaging audits. Detailed evidence is shipped separately.


Final closure: the permanent CRM suite contains 27 checks after adding a regression for global-option parsing through the combined launcher. GCC release, GCC debug, GCC ASan/UBSan, and Clang 17 builds each pass 27/27. Clang static analysis emits zero diagnostics.
