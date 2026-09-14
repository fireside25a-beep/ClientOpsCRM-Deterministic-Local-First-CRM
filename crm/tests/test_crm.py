#!/usr/bin/env python3
import csv
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BIN = Path(os.environ.get("CRM_BIN", ROOT / "build" / "clientops-crm"))

class GateFailure(RuntimeError):
    pass

def run(db, *args, ok=True, actor="test-operator", json_mode=True, stdin=None):
    cmd = [str(BIN), "--db", str(db), "--actor", actor]
    if json_mode:
        cmd.append("--json")
    cmd.extend(str(a) for a in args)
    env = os.environ.copy()
    env.setdefault("ASAN_OPTIONS", "detect_leaks=1:halt_on_error=1")
    env.setdefault("UBSAN_OPTIONS", "halt_on_error=1:print_stacktrace=1")
    p = subprocess.run(cmd, input=stdin, text=True, capture_output=True, env=env)
    if ok and p.returncode != 0:
        raise GateFailure(f"command failed ({p.returncode}): {' '.join(cmd)}\nstdout={p.stdout}\nstderr={p.stderr}")
    if not ok and p.returncode == 0:
        raise GateFailure(f"command unexpectedly succeeded: {' '.join(cmd)}\nstdout={p.stdout}")
    if json_mode and ok:
        try:
            return json.loads(p.stdout)
        except Exception as exc:
            raise GateFailure(f"invalid JSON from {' '.join(cmd)}: {p.stdout!r}") from exc
    return p

def created_id(result):
    if not isinstance(result, dict) or not result.get("ok") or "id" not in result:
        raise GateFailure(f"expected creation result, got {result!r}")
    return int(result["id"])

def scalar(con, sql, params=()):
    return con.execute(sql, params).fetchone()[0]

def main():
    if not BIN.is_file():
        raise GateFailure(f"CRM binary not found: {BIN}")
    workspace = Path(tempfile.mkdtemp(prefix="clientops-crm-test-"))
    db = workspace / "crm.db"
    checks = []
    try:
        def check(name, fn):
            fn()
            checks.append(name)

        def check_version_after_global_options():
            p = run(db, "version", json_mode=False)
            if p.stdout.strip() != "ClientOpsCRM 2.0.0":
                raise GateFailure(f"version contract mismatch: {p.stdout!r}")
            if db.exists():
                raise GateFailure("version command unexpectedly created/opened the database")

        check("version_after_global_options", check_version_after_global_options)

        check("init_and_schema", lambda: (
            run(db, "init"),
            run(db, "doctor")
        ))

        account = created_id(run(db, "account", "add", "--name", "Acme & Sons", "--domain", "https://www.Acme.example/", "--industry", "Robotics", "--city", "Paphos", "--country", "CY", "--owner", "alex"))
        check("account_normalization_and_uniqueness", lambda: run(db, "account", "add", "--name", "Duplicate", "--domain", "acme.example", ok=False))

        contact = created_id(run(db, "contact", "add", "--first", "Ada", "--last", "Lovelace", "--email", "Ada@Example.com", "--phone", "+357 99 123 456", "--account", account, "--title", "CTO", "--owner", "alex"))
        check("contact_email_normalization_and_uniqueness", lambda: run(db, "contact", "add", "--first", "Other", "--email", "ada@example.COM", ok=False))
        second_contact = created_id(run(db, "contact", "add", "--first", "Alan", "--last", "Turing", "--email", "alan@example.com", "--phone", "00357-99-123-456"))

        lead = created_id(run(db, "lead", "add", "--relay-ticket", "relay-0001", "--name", "Grace Hopper", "--email", "grace@example.net", "--phone", "+357 96 000000", "--company", "Compiler Labs", "--source", "relay", "--message", "Needs deterministic pipeline; quote contains ' and SQL -- safely", "--score", "91", "--priority", "high", "--owner", "alex"))
        check("lead_qualify", lambda: run(db, "lead", "qualify", lead))
        conversion = run(db, "lead", "convert", lead, "--amount", "12345.67", "--currency", "eur", "--close", "2026-12-31", "--owner", "alex")
        deal = int(conversion["deal_id"])
        converted_contact = int(conversion["contact_id"])
        if conversion["account_id"] is None:
            raise GateFailure("company lead did not create account")
        converted_account = int(conversion["account_id"])
        check("lead_conversion_transactional", lambda: run(db, "lead", "convert", lead, ok=False))

        before_counts = None
        with sqlite3.connect(db) as con:
            before_counts = tuple(scalar(con, f"SELECT count(*) FROM {t}") for t in ("accounts","contacts","deals"))
        run(db, "lead", "convert", lead, ok=False)
        with sqlite3.connect(db) as con:
            after_counts = tuple(scalar(con, f"SELECT count(*) FROM {t}") for t in ("accounts","contacts","deals"))
        if before_counts != after_counts:
            raise GateFailure("failed second conversion changed persistent state")
        checks.append("failed_conversion_has_no_side_effects")

        pipeline = run(db, "pipeline", "list")
        discovery = next(x for x in pipeline if x["stage"] == "Discovery" and x["is_default"] == "1")
        check("deal_stage_transition", lambda: run(db, "deal", "move", deal, discovery["stage_id"]))
        shown = run(db, "deal", "show", deal)[0]
        if shown["probability"] != "40" or shown["stage"] != "Discovery":
            raise GateFailure("stage move did not synchronize probability")
        check("deal_win", lambda: run(db, "deal", "win", deal))
        check("closed_deal_cannot_move", lambda: run(db, "deal", "move", deal, discovery["stage_id"], ok=False))

        lost_deal = created_id(run(db, "deal", "add", "--name", "Lost evaluation", "--account", account, "--contact", contact, "--amount", "87.40", "--currency", "USD", "--close", "2026-10-01", "--owner", "alex"))
        check("lost_reason_required", lambda: run(db, "deal", "lost", lost_deal, ok=False))
        check("deal_lost", lambda: run(db, "deal", "lost", lost_deal, "--reason", "Budget cancelled"))

        task = created_id(run(db, "task", "add", "--entity", "deal", "--id", lost_deal, "--subject", "Archive procurement notes", "--due", "2026-09-30", "--priority", "high", "--owner", "alex"))
        check("task_done", lambda: run(db, "task", "done", task))
        check("task_double_close_rejected", lambda: run(db, "task", "done", task, ok=False))
        check("note_and_custom_field", lambda: (
            run(db, "note", "add", "--entity", "account", "--id", account, "--body", "Prefers mathematically verifiable deliverables", "--author", "alex"),
            run(db, "field", "set", "--entity", "account", "--id", account, "--key", "risk_band", "--value", "low")
        ))
        check("invalid_custom_field_key", lambda: run(db, "field", "set", "--entity", "account", "--id", account, "--key", "drop table", "--value", "x", ok=False))

        search = run(db, "search", "mathematically")
        if not any(x["entity_type"] == "note" for x in search):
            raise GateFailure("FTS did not index note")
        checks.append("fts_search")

        dedupe = run(db, "dedupe")
        if not any(x["kind"] == "contact_phone" and x["count"] == "2" for x in dedupe):
            raise GateFailure("phone normalization duplicate signal missing")
        checks.append("dedupe_signal")

        dash = run(db, "dashboard")
        if not isinstance(dash, dict) or "counts" not in dash or "pipeline_by_currency" not in dash:
            raise GateFailure("dashboard JSON contract invalid")
        forecast = run(db, "forecast")
        if not isinstance(forecast, list):
            raise GateFailure("forecast JSON contract invalid")
        checks.append("dashboard_and_forecast_json")

        timeline = run(db, "timeline", "--entity", "deal", "--id", deal)
        audit = run(db, "audit", "--entity", "deal", "--id", deal)
        if len(timeline) < 3 or len(audit) < 3:
            raise GateFailure("timeline/audit evidence incomplete")
        if not all(row["actor"] == "test-operator" for row in audit if row["actor"]):
            raise GateFailure("audit actor provenance mismatch")
        checks.append("timeline_and_audit")

        # CSV parser: RFC-style quoting, comma, embedded newline, quote escaping, JSON metadata.
        csv_path = workspace / "relay.csv"
        relay_metadata = {"route":"sales","category":"consulting","policy_version":"1.2.1","serviceable":True}
        with csv_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "relay_ticket_id","name","email","company","source","message",
                "metadata_json","score","priority","owner"
            ])
            writer.writeheader()
            writer.writerow({
                "relay_ticket_id":"relay-0002", "name":"Doe, Jane", "email":"jane@example.org",
                "company":"Example, Inc", "source":"web",
                "message":"line one\nline two with \"quote\"",
                "metadata_json":json.dumps(relay_metadata, separators=(",",":"), sort_keys=True),
                "score":"75", "priority":"medium", "owner":"sam"
            })
        imported = run(db, "lead", "import-csv", "--in", csv_path)
        if imported.get("imported") != 1 or imported.get("skipped") != 0:
            raise GateFailure("CSV import count mismatch")
        row = run(db, "lead", "show", 2)[0]
        if row["name"] != "Doe, Jane" or "line one\nline two" not in row["message"]:
            raise GateFailure("CSV quoted field/newline parsing mismatch")
        if json.loads(row["metadata_json"]) != relay_metadata:
            raise GateFailure("Relay metadata did not round-trip through CSV import")
        checks.append("csv_roundtrip_content_and_metadata")

        repeated = run(db, "lead", "import-csv", "--in", csv_path, "--skip-existing")
        if repeated.get("imported") != 0 or repeated.get("skipped") != 1:
            raise GateFailure("idempotent Relay import did not skip existing ticket")
        with sqlite3.connect(db) as con:
            if scalar(con, "SELECT count(*) FROM leads WHERE relay_ticket_id='relay-0002'") != 1:
                raise GateFailure("idempotent Relay import duplicated a lead")
        checks.append("relay_import_idempotency")

        export_json = workspace / "export.json"
        export_csv = workspace / "contacts.csv"
        run(db, "export-json", "--out", export_json, json_mode=False)
        run(db, "export-csv", "--entity", "contacts", "--out", export_csv, json_mode=False)
        payload = json.loads(export_json.read_text(encoding="utf-8"))
        if payload["format"] != "clientops-crm-export-v1" or len(payload["deals"]) < 2:
            raise GateFailure("JSON export contract mismatch")
        with export_csv.open(newline='', encoding='utf-8') as fh:
            exported_contacts = list(csv.DictReader(fh))
        if len(exported_contacts) < 3:
            raise GateFailure("CSV export missing contacts")
        checks.append("exports_parseable")

        # Direct database adversary: business-state consistency and audit append-only guards.
        with sqlite3.connect(db) as con:
            won_stage = scalar(con, "SELECT id FROM stages WHERE pipeline_id=1 AND kind='won'")
            try:
                con.execute("INSERT INTO deals(pipeline_id,stage_id,name,status,probability) VALUES(1,?,'illegal','open',20)", (won_stage,))
                con.commit()
                raise GateFailure("database accepted stage/status mismatch")
            except sqlite3.IntegrityError:
                con.rollback()
            audit_id = scalar(con, "SELECT id FROM audit_log ORDER BY id LIMIT 1")
            try:
                con.execute("UPDATE audit_log SET actor='tampered' WHERE id=?", (audit_id,))
                con.commit()
                raise GateFailure("audit log update was not blocked")
            except sqlite3.DatabaseError:
                con.rollback()
            try:
                con.execute("DELETE FROM audit_log WHERE id=?", (audit_id,))
                con.commit()
                raise GateFailure("audit log delete was not blocked")
            except sqlite3.DatabaseError:
                con.rollback()
        checks.append("database_adversarial_guards")

        # Unknown schema cannot be silently overwritten by init.
        bad_db = workspace / "future.db"
        with sqlite3.connect(bad_db) as con:
            con.execute("CREATE TABLE crm_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            con.execute("INSERT INTO crm_meta VALUES('schema_version','99.0.0')")
        check("schema_downgrade_refused", lambda: run(bad_db, "init", ok=False))

        # Deterministic read surfaces after state is stable.
        d1 = run(db, "deal", "list")
        d2 = run(db, "deal", "list")
        if d1 != d2:
            raise GateFailure("stable deal list is nondeterministic")
        checks.append("deterministic_reads")

        doctor = run(db, "doctor")
        if not doctor.get("ok"):
            raise GateFailure("doctor did not pass")
        checks.append("final_doctor")

        with sqlite3.connect(db) as con:
            counts = {t: scalar(con, f"SELECT count(*) FROM {t}") for t in (
                "accounts","contacts","leads","deals","tasks","notes","custom_values","activities","audit_log")}

        result = {
            "status": "PASS",
            "binary": str(BIN),
            "checks_passed": len(checks),
            "checks": checks,
            "record_counts": counts,
            "key_ids": {
                "account": account,
                "contact": contact,
                "second_contact": second_contact,
                "converted_account": converted_account,
                "converted_contact": converted_contact,
                "converted_deal": deal,
                "lost_deal": lost_deal,
            },
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
