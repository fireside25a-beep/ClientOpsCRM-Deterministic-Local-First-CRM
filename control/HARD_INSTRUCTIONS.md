# Hard implementation rules

1. Ship no mock, stub, placeholder, fake result, empty file, or decorative implementation-only artifact.
2. Do not claim a test, feature, source, build, or integration passed unless it was actually inspected or executed.
3. Preserve the verified ClientOps Relay 1.2.1 intake/automation core unless a change is required and separately verified.
4. New CRM behavior must be implemented in compiled C or C++; this release uses C++17 for the CRM CLI and keeps the existing C11 policy engine.
5. The current CRM interaction surface is CLI. Do not add a second interaction surface to this release.
6. Use real persistent storage, transactions, prepared statements, foreign keys, validation, audit records, and deterministic state rules.
7. Invalid state transitions must fail closed and leave persistent state unchanged.
8. Research claims must be traceable to individually listed sources. The source register must exceed 100 unique references.
9. Verification must include positive, negative, adversarial, deterministic-repeat, migration/schema, search, audit, and packaging checks.
10. Delivery folders must contain no transient build caches, generated test databases, editor swap files, or zero-byte files.
11. Final archives must pass ZIP integrity and SHA-256 manifest verification.
12. When an implementation limit is discovered, either remove it through engineering or make the behavior explicit and testable; do not replace missing functionality with prose.
