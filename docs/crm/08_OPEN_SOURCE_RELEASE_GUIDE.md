# ClientOpsCRM 2.0.0 Open-Source Release Guide

## What the source AIO contains

The source AIO retains the complete ClientOps Relay 1.2.1 GitHub release and adds the CRM source, build system, tests, Relay bridge, control/planner material, research corpus, CRM documentation and verification evidence. The inherited Apache-2.0 license is preserved.

## Rebuild from source

```sh
make -C crm clean release debug sanitize
python3 crm/tests/test_crm.py
CRM_BIN=crm/build/clientops-crm-sanitize python3 crm/tests/test_crm.py
```

The release pack includes a Linux x86-64 build for convenience, but source is canonical. Other systems should rebuild with a C++17 compiler and SQLite development library.

## Recommended repository root

Publish the contents of the source AIO as the repository root. Do not commit generated local state (`runtime/`), `.env`, dependency directories, compiler scratch or private deployment secrets. The shipped `.gitignore` covers CRM build/runtime paths in addition to Relay exclusions.

## Primary entry points

- `README.md` — combined project start.
- `clientops` — combined operator launcher.
- `crm/src/clientops_crm.cpp` — CRM implementation.
- `crm/Makefile` — CRM build gates.
- `crm/tests/test_crm.py` — real integration/adversarial test.
- `crm/scripts/import-relay.sh` — live Relay-to-CRM bridge.
- `policy-engine/` — retained Relay C11 deterministic policy engine.
- `database/` — retained Relay PostgreSQL schema/migrations.
- `workflows/` — retained Relay n8n workflows.
- `research/` — 143-source research corpus and claim ledger.
- `docs/crm/` — CRM documentation.
- `evidence/crm/` — final machine verification evidence.

## Release discipline

1. Rebuild from a clean tree.
2. Run the CRM release and sanitizer suites.
3. Run Relay-compatible gates available on the target toolchain.
4. Run `./clientops crm --json doctor` on a fresh database.
5. Produce a deterministic release package.
6. Verify ZIP integrity.
7. Verify no empty files, secrets, runtime DBs or dependency directories are shipped.
8. Publish SHA-256 manifest alongside the release asset.

## Versioning

The combined product identifies itself as `ClientOpsCRM 2.0.0 + ClientOps Relay 1.2.1`. Relay's `package.json` stays at 1.2.1 so its own release/build tooling continues to describe the inherited subsystem correctly; `CLIENTOPSCRM_VERSION` carries the combined release identity.
