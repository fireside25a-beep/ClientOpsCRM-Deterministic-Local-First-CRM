# ClientOpsCRM 2.0.0 CLI API Reference

## Invocation

```text
clientops-crm [--db FILE] [--actor NAME] [--json] COMMAND ...
```

`--db` selects the SQLite application file. `--actor` is written into audit provenance for mutations. `--json` selects structured output where supported. Commands return nonzero on validation, state, database or I/O failure.

## Core

- `init` — create/validate schema, defaults, triggers and FTS material. Fails closed on an unknown schema version.
- `doctor` — run structural and relational integrity gates.
- `dashboard` — counts plus open pipeline totals grouped by currency.
- `forecast` — deterministic weighted value of open deals by currency/stage.
- `search TERM...` — FTS5 query across indexed CRM text.
- `dedupe` — emit normalized email/phone/domain duplicate signals.
- `timeline --entity account|contact|lead|deal --id ID` — business-event history.
- `audit --entity TYPE --id ID` — audit rows for the selected record.

## Accounts

```text
account add --name NAME [--domain D] [--website U] [--industry I] [--city C] [--country C] [--owner O]
account list [--status active|inactive] [--owner O]
account show ID
account update ID [field options]
```

Non-empty normalized domain is unique.

## Contacts

```text
contact add [--first F] [--last L] [--email E] [--phone P] [--account ID] [--title T] [--owner O]
contact list [--account ID] [--owner O]
contact show ID
contact update ID [field options]
```

At least first name, last name or email must be present. Non-empty normalized email is unique.

## Leads

```text
lead add --name N [--email E] [--phone P] [--company C] [--source S] [--message M]
         [--metadata-json JSON] [--score 0..100] [--priority low|medium|high]
         [--owner O] [--relay-ticket UUID]
lead list [--status STATE] [--owner O]
lead show ID
lead qualify ID
lead disqualify ID --reason TEXT
lead convert ID [--account ID] [--deal-name N] [--amount DECIMAL] [--currency ISO]
                [--pipeline ID] [--stage NAME|ID] [--close YYYY-MM-DD] [--owner O]
lead import-csv --in FILE|- [--skip-existing]
```

`metadata_json` must parse as JSON and is bounded in size. `--skip-existing` only skips rows carrying a non-empty Relay ticket already present; it does not silently discard unrelated uniqueness errors.

## Pipelines and deals

```text
pipeline list
pipeline add --name NAME
pipeline stage-add --pipeline ID --name NAME --position N --probability 0..100 [--kind open|won|lost]

deal add --name N [--account ID] [--contact ID] [--amount DECIMAL] [--currency ISO]
         [--pipeline ID] [--stage NAME|ID] [--close YYYY-MM-DD] [--owner O]
deal list [--status open|won|lost] [--owner O] [--pipeline ID]
deal show ID
deal move ID STAGE
deal win ID
deal lost ID --reason TEXT
```

Stage move synchronizes probability. A deal can be open only on an open stage, won only on a won stage, and lost only on a lost stage. Those rules are duplicated at the database trigger layer.

## Work tracking

```text
task add --entity TYPE --id ID --subject TEXT [--type T] [--due YYYY-MM-DD]
         [--priority P] [--owner O]
task list [--status STATE] [--owner O] [--entity TYPE] [--id ID]
task done ID
task cancel ID
note add --entity TYPE --id ID --body TEXT [--author NAME]
note list --entity TYPE --id ID
field set --entity TYPE --id ID --key KEY --value VALUE
field list --entity TYPE --id ID
```

Allowed entity types are `account`, `contact`, `lead`, `deal`.

## Export

```text
export-json --out FILE
export-csv --entity accounts|contacts|leads|deals|tasks --out FILE
```

JSON export has format marker `clientops-crm-export-v1`. CSV quoting handles commas, quotes and newlines. Lead CSV includes `metadata_json`.

## Integrated launcher API

```text
./clientops crm COMMAND ...
./clientops crm-build
./clientops crm-import-relay
```

The launcher is part of the combined Relay/CRM source tree and preserves all Relay 1.2.1 commands.

## Output contracts

Creation commands in JSON mode return `{ "ok": true, "entity": ..., "id": ... }`. Import returns imported/skipped counts. List/show/search/forecast surfaces return arrays. Dashboard and doctor return objects. Errors are written to stderr and use a nonzero process exit status; automation should use the exit code as the primary success signal.
