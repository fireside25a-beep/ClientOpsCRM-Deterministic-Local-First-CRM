# ClientOpsCRM compiled core

`clientops-crm` is the C++17 operator-side CRM shipped with ClientOpsCRM 2.0.0.

Build:

```sh
make release
```

Run against an explicit database:

```sh
./build/clientops-crm --db ./clientops.db init
./build/clientops-crm --db ./clientops.db doctor
./build/clientops-crm --db ./clientops.db help
```

Build gates:

```sh
make release debug sanitize
python3 tests/test_crm.py
CRM_BIN=build/clientops-crm-sanitize python3 tests/test_crm.py
```

The application uses SQLite prepared statements, database constraints/triggers, exact integer money, deterministic parsers, FTS5 search, transactional conversion, and insert-only audit history. There are no mocked storage or network layers in the CRM integration test.
