# ClientOpsCRM 2.0.0 Operator Guide

## Purpose

ClientOpsCRM turns the accepted/qualified work entering ClientOps Relay into durable customer and sales records. Relay remains the intake/routing engine. The CRM is the system an operator uses to retain accounts, people, leads, opportunities, follow-up work, notes, and evidence of mutations.

## Build

From the release root:

```sh
make -C crm release
```

Or use the integrated launcher:

```sh
./clientops crm-build
```

The resulting optimized binary is `crm/build/clientops-crm`. The release package also includes a prebuilt Linux x86-64 binary under `crm/bin/linux-x86_64/`.

## Database selection

The integrated launcher defaults to `runtime/clientops-crm.db`, creates the runtime directory with mode 0700, initializes the database on first use under a restrictive umask, and sets the database file to mode 0600.

For an explicit database:

```sh
crm/build/clientops-crm --db /path/clientops.db init
```

Every modifying command accepts the global `--actor NAME` option. Use a stable operator or automation identity so audit provenance is meaningful.

## Daily workflow

### 1. Capture or import a lead

```sh
./clientops crm lead add --name "Jane Doe" --email jane@example.org --company "Example" --source referral --score 75 --priority medium --owner sam
```

A lead may carry a Relay UUID with `--relay-ticket` and arbitrary valid JSON with `--metadata-json`. Email and phone are normalized for matching while the entered display form is retained.

### 2. Qualify or disqualify

```sh
./clientops crm lead qualify 1
./clientops crm lead disqualify 2 --reason "Outside service scope"
```

A disqualification requires a reason. Only qualified leads are convertible.

### 3. Convert atomically

```sh
./clientops crm lead convert 1 --amount 12345.67 --currency EUR --close 2026-12-31 --owner sam
```

Conversion either commits the coherent result or leaves no partial account/contact/deal side effect. If a matching normalized account domain/contact email already exists, the operator can reference the known account explicitly; otherwise the converter can construct the needed records from the qualified lead.

### 4. Move the opportunity

```sh
./clientops crm pipeline list
./clientops crm deal move 1 Discovery
./clientops crm deal move 1 Proposal
./clientops crm deal win 1
```

A closed deal cannot be moved back to an open stage by the normal command surface. Lost deals require a reason:

```sh
./clientops crm deal lost 2 --reason "Budget cancelled"
```

### 5. Track follow-up work

```sh
./clientops crm task add --entity deal --id 1 --subject "Send revised proposal" --due 2026-09-14 --priority high --owner sam
./clientops crm task list --status open --owner sam
./clientops crm task done 1
```

Tasks can attach to an account, contact, lead, or deal.

### 6. Record durable context

```sh
./clientops crm note add --entity account --id 1 --body "Procurement requires a written security appendix" --author sam
./clientops crm field set --entity account --id 1 --key risk_band --value low
```

Custom field keys are restricted to deterministic identifier syntax and are unique per entity/key.

### 7. Find and inspect

```sh
./clientops crm search procurement
./clientops crm timeline --entity account --id 1
./clientops crm audit --entity deal --id 1
```

Search spans the core textual business records and notes. Timeline is the human-oriented business history; audit is the mutation record.

### 8. Forecast and health

```sh
./clientops crm dashboard
./clientops crm forecast
./clientops crm doctor
```

Forecasting is deterministic weighted pipeline arithmetic using integer minor units and the stage probability already stored on each open deal. It is not presented as a predictive model. `doctor` is the integrity gate and should be run after imports, before backup, and after restoring a database.

## Relay synchronization

With the Relay deployment running:

```sh
./clientops crm-import-relay
```

The bridge exports the canonical Relay lead rows from PostgreSQL with `COPY ... CSV HEADER`, streams them into `lead import-csv --in - --skip-existing`, and stores routing/policy fields in `metadata_json`. Because `relay_ticket_id` is unique and replay is skipped, the bridge is safe to invoke repeatedly for already-imported Relay leads.

## Backup and migration

The CRM database is a single SQLite application file. Quiesce writers or use SQLite's backup mechanisms before copying a live database. Preserve the entire database file, not selected tables. After restore, run `doctor`. The application refuses to initialize a database whose `crm_meta.schema_version` is not exactly the version it understands, preventing silent downgrade/overwrite.

## Machine-readable operation

Add `--json` globally for commands that return structured data:

```sh
./clientops crm --json deal list --status open
```

This is intended for scripts and future integrations without parsing decorative terminal output.
