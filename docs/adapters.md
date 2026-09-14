# Optional SaaS adapter

The Google Sheets, Slack, and Gmail workflow is an optional extension to the locally verified core:

<code>workflows/adapters/google-sheets-slack-gmail.json</code>

It is import-valid on n8n 2.37.10, inactive by default, and deliberately has no embedded credential references or secrets. It is not called by the core workflows.

## Behavior

The adapter accepts one qualified request, checks the ticket and generic decision contract, creates a safe spreadsheet row, upserts by that immutable ticket, posts an escaped Slack notification, and sends a Gmail acknowledgement.

Spreadsheet-bound text is prefixed when it could be interpreted as a formula. The Sheets node also uses RAW cell input and rejects unexpected columns. Retrying the Sheets step therefore updates the existing ticket row instead of appending a duplicate.

Slack and Gmail are at-least-once provider calls. If a provider accepts a message but the network response is lost, a retry can duplicate that message. The adapter should not be used as a claim of exactly-once SaaS delivery.

## Required input

| Field | Purpose |
| --- | --- |
| spreadsheetId | Target Google spreadsheet ID |
| sheetName | Target worksheet name |
| slackChannelId | Slack channel ID, not display name |
| customerEmail | Gmail recipient |
| ticketId | Immutable ClientOps ticket UUID and Sheets upsert key |
| name, email, phone, city | Request details; location fields may be empty |
| category | Configured request category |
| score | Integer from 0 through 100 |
| serviceable | Boolean region-policy result |
| urgency | `low`, `medium`, or `high` |
| priority, route, summary | Persistence and routing result |
| draftReply | Plain-text Gmail body |

## Configure

1. Import the workflow:

   ~~~bash
   n8n import:workflow --input=workflows/adapters/google-sheets-slack-gmail.json
   ~~~

2. Create OAuth credentials in n8n for Google Sheets, Slack, and Gmail.
3. Open each connector node and select the corresponding credential.
4. Create a worksheet whose first row contains:

   ~~~text
   ticketId | name | email | phone | city | category | score | serviceable | urgency | priority | route | summary
   ~~~

5. Call the adapter from an Execute Workflow node only after the core database transaction succeeds. Do not place the SaaS chain before the public webhook response.
6. Keep the adapter inactive until the live checklist below passes.

## Live checklist

- A new ticket creates one spreadsheet row.
- Replaying the same ticket updates that row and does not append.
- A value beginning with <code>=</code>, <code>+</code>, <code>-</code>, or <code>@</code> is stored as text.
- Slack receives the expected channel message.
- Gmail receives the expected plain-text acknowledgement.
- Removing one OAuth permission produces a visible failure without affecting core request acceptance.
- A deliberate retry is reviewed for possible Slack/Gmail duplication.

## Production extension

For stronger connector isolation, add provider-specific outbox kinds and workers instead of calling all three providers in one sequential workflow. Give each provider its own dedupe key, retry policy, dead-letter state, and operator replay action.
