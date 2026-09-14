#include <sqlite3.h>

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr const char* kVersion = "2.0.0";
constexpr const char* kSchemaVersion = "2.0.0";
constexpr std::size_t kMaxText = 20000;
constexpr std::size_t kMaxShort = 512;

[[noreturn]] void fail(const std::string& message) {
    throw std::runtime_error(message);
}

std::string trim(std::string value) {
    std::size_t first = 0;
    while (first < value.size() && std::isspace(static_cast<unsigned char>(value[first]))) ++first;
    std::size_t last = value.size();
    while (last > first && std::isspace(static_cast<unsigned char>(value[last - 1]))) --last;
    return value.substr(first, last - first);
}

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string upper(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    return value;
}

std::string normalize_email(const std::string& email) {
    return lower(trim(email));
}

std::string normalize_domain(std::string domain) {
    domain = lower(trim(domain));
    if (domain.rfind("https://", 0) == 0) domain.erase(0, 8);
    if (domain.rfind("http://", 0) == 0) domain.erase(0, 7);
    if (domain.rfind("www.", 0) == 0) domain.erase(0, 4);
    auto slash = domain.find('/');
    if (slash != std::string::npos) domain.resize(slash);
    while (!domain.empty() && domain.back() == '.') domain.pop_back();
    return domain;
}

std::string normalize_phone(const std::string& phone) {
    std::string out;
    out.reserve(phone.size());
    for (unsigned char c : phone) {
        if (std::isdigit(c)) out.push_back(static_cast<char>(c));
    }
    if (out.rfind("00", 0) == 0) out.erase(0, 2);
    return out;
}

void validate_length(const std::string& value, const char* name, std::size_t max_len = kMaxShort) {
    if (value.size() > max_len) fail(std::string(name) + " exceeds maximum length");
}

void validate_nonempty(const std::string& value, const char* name) {
    if (trim(value).empty()) fail(std::string(name) + " must not be empty");
}

void validate_email(const std::string& email, bool optional = false) {
    if (email.empty() && optional) return;
    if (email.empty() || email.size() > 254) fail("invalid email address");
    const auto at = email.find('@');
    if (at == std::string::npos || at == 0 || at + 1 >= email.size() || email.find('@', at + 1) != std::string::npos) fail("invalid email address");
    const std::string local = email.substr(0, at);
    const std::string domain = email.substr(at + 1);
    if (local.size() > 64 || local.front() == '.' || local.back() == '.' || local.find("..") != std::string::npos) fail("invalid email address");
    const std::string allowed = ".!#$%&'*+/=?^_`{|}~-";
    for (unsigned char c : local) {
        if (!std::isalnum(c) && allowed.find(static_cast<char>(c)) == std::string::npos) fail("invalid email address");
    }
    if (domain.front() == '.' || domain.back() == '.' || domain.find('.') == std::string::npos) fail("invalid email address");
    std::size_t start = 0;
    while (start < domain.size()) {
        const auto dot = domain.find('.', start);
        const auto end = dot == std::string::npos ? domain.size() : dot;
        const auto len = end - start;
        if (len == 0 || len > 63 || domain[start] == '-' || domain[end - 1] == '-') fail("invalid email address");
        for (std::size_t i = start; i < end; ++i) {
            const unsigned char c = static_cast<unsigned char>(domain[i]);
            if (!std::isalnum(c) && c != '-') fail("invalid email address");
        }
        if (dot == std::string::npos) break;
        start = dot + 1;
    }
}

void validate_priority(const std::string& value) {
    if (value != "low" && value != "medium" && value != "high") fail("priority must be low, medium, or high");
}

void validate_date(const std::string& value, bool optional = false) {
    if (optional && value.empty()) return;
    if (value.size() != 10 || value[4] != '-' || value[7] != '-') fail("date must use YYYY-MM-DD");
    for (std::size_t i = 0; i < value.size(); ++i) {
        if (i == 4 || i == 7) continue;
        if (!std::isdigit(static_cast<unsigned char>(value[i]))) fail("date must use YYYY-MM-DD");
    }
    int year = std::stoi(value.substr(0, 4));
    int month = std::stoi(value.substr(5, 2));
    int day = std::stoi(value.substr(8, 2));
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) fail("invalid calendar date");
    static const int days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    int dim = days[month - 1];
    bool leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    if (month == 2 && leap) dim = 29;
    if (day > dim) fail("invalid calendar date");
}

std::int64_t parse_i64(const std::string& value, const char* name) {
    if (value.empty()) fail(std::string(name) + " must be an integer");
    std::int64_t result{};
    const char* begin = value.data();
    const char* end = value.data() + value.size();
    auto [ptr, ec] = std::from_chars(begin, end, result);
    if (ec != std::errc() || ptr != end) fail(std::string(name) + " must be an integer");
    return result;
}

int parse_int(const std::string& value, const char* name, int minv, int maxv) {
    auto v = parse_i64(value, name);
    if (v < minv || v > maxv) fail(std::string(name) + " is outside its allowed range");
    return static_cast<int>(v);
}

std::int64_t parse_money_minor(const std::string& input) {
    std::string value = trim(input);
    if (value.empty()) fail("amount must not be empty");
    bool neg = false;
    std::size_t pos = 0;
    if (value[0] == '-') { neg = true; pos = 1; }
    if (pos == value.size()) fail("invalid amount");
    std::size_t dot = value.find('.', pos);
    if (dot != std::string::npos && value.find('.', dot + 1) != std::string::npos) fail("invalid amount");
    std::string whole = dot == std::string::npos ? value.substr(pos) : value.substr(pos, dot - pos);
    std::string frac = dot == std::string::npos ? "" : value.substr(dot + 1);
    if (whole.empty()) whole = "0";
    if (whole.size() > 15 || frac.size() > 2) fail("amount supports at most two decimal places");
    if (!std::all_of(whole.begin(), whole.end(), [](unsigned char c){return std::isdigit(c);}) ||
        !std::all_of(frac.begin(), frac.end(), [](unsigned char c){return std::isdigit(c);})) fail("invalid amount");
    while (frac.size() < 2) frac.push_back('0');
    std::int64_t whole_v = parse_i64(whole, "amount");
    std::int64_t frac_v = frac.empty() ? 0 : parse_i64(frac, "amount");
    if (whole_v > (std::numeric_limits<std::int64_t>::max() - frac_v) / 100) fail("amount is too large");
    std::int64_t result = whole_v * 100 + frac_v;
    return neg ? -result : result;
}

std::string json_escape(const std::string& value) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20) {
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c) << std::dec;
                } else {
                    out << static_cast<char>(c);
                }
        }
    }
    out << '"';
    return out.str();
}

class Statement {
public:
    Statement(sqlite3* db, const std::string& sql) : stmt_(nullptr) {
        int rc = sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt_, nullptr);
        if (rc != SQLITE_OK) fail(std::string("SQL prepare failed: ") + sqlite3_errmsg(db));
    }
    ~Statement() { if (stmt_) sqlite3_finalize(stmt_); }
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;
    sqlite3_stmt* get() { return stmt_; }
    void bind(int index, const std::string& value) {
        if (sqlite3_bind_text(stmt_, index, value.c_str(), static_cast<int>(value.size()), SQLITE_TRANSIENT) != SQLITE_OK) fail("SQL bind failed");
    }
    void bind(int index, std::int64_t value) {
        if (sqlite3_bind_int64(stmt_, index, value) != SQLITE_OK) fail("SQL bind failed");
    }
    void bind_null(int index) {
        if (sqlite3_bind_null(stmt_, index) != SQLITE_OK) fail("SQL bind failed");
    }
    bool row() {
        int rc = sqlite3_step(stmt_);
        if (rc == SQLITE_ROW) return true;
        if (rc == SQLITE_DONE) return false;
        sqlite3* db = sqlite3_db_handle(stmt_);
        fail(std::string("SQL execution failed: ") + sqlite3_errmsg(db));
    }
    void done() {
        int rc = sqlite3_step(stmt_);
        if (rc != SQLITE_DONE) {
            sqlite3* db = sqlite3_db_handle(stmt_);
            fail(std::string("SQL execution failed: ") + sqlite3_errmsg(db));
        }
    }
    std::string text(int col) const {
        const unsigned char* p = sqlite3_column_text(stmt_, col);
        return p ? reinterpret_cast<const char*>(p) : std::string();
    }
    std::int64_t i64(int col) const { return sqlite3_column_int64(stmt_, col); }
    bool is_null(int col) const { return sqlite3_column_type(stmt_, col) == SQLITE_NULL; }
private:
    sqlite3_stmt* stmt_;
};

class Db {
public:
    explicit Db(const std::string& path) : db_(nullptr) {
        int rc = sqlite3_open_v2(path.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
        if (rc != SQLITE_OK) {
            std::string message = db_ ? sqlite3_errmsg(db_) : "unknown sqlite error";
            if (db_) sqlite3_close(db_);
            db_ = nullptr;
            fail("cannot open database: " + message);
        }
        sqlite3_extended_result_codes(db_, 1);
        exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    }
    ~Db() { if (db_) sqlite3_close(db_); }
    Db(const Db&) = delete;
    Db& operator=(const Db&) = delete;
    sqlite3* raw() { return db_; }
    void exec(const std::string& sql) {
        char* err = nullptr;
        int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &err);
        if (rc != SQLITE_OK) {
            std::string message = err ? err : sqlite3_errmsg(db_);
            sqlite3_free(err);
            fail("SQL execution failed: " + message);
        }
    }
    std::int64_t changes() const { return sqlite3_changes64(db_); }
private:
    sqlite3* db_;
};

class Transaction {
public:
    explicit Transaction(Db& db) : db_(db), active_(true) { db_.exec("BEGIN IMMEDIATE"); }
    ~Transaction() { if (active_) { try { db_.exec("ROLLBACK"); } catch (...) {} } }
    void commit() { db_.exec("COMMIT"); active_ = false; }
private:
    Db& db_;
    bool active_;
};

const char* kSchemaSql = R"SQL(
CREATE TABLE IF NOT EXISTS crm_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO crm_meta(key,value) VALUES('schema_version','2.0.0');

CREATE TABLE IF NOT EXISTS crm_context (
  id INTEGER PRIMARY KEY CHECK(id=1),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128)
);
INSERT OR IGNORE INTO crm_context(id,actor) VALUES(1,'local-operator');

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  domain TEXT NOT NULL DEFAULT '' CHECK(length(domain)<=255),
  domain_norm TEXT NOT NULL DEFAULT '' CHECK(length(domain_norm)<=255),
  website TEXT NOT NULL DEFAULT '' CHECK(length(website)<=1024),
  industry TEXT NOT NULL DEFAULT '' CHECK(length(industry)<=256),
  city TEXT NOT NULL DEFAULT '' CHECK(length(city)<=256),
  country TEXT NOT NULL DEFAULT '' CHECK(length(country)<=256),
  owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_domain_uq ON accounts(domain_norm) WHERE domain_norm<>'';
CREATE INDEX IF NOT EXISTS accounts_name_idx ON accounts(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts(owner,status);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL DEFAULT '' CHECK(length(first_name)<=256),
  last_name TEXT NOT NULL DEFAULT '' CHECK(length(last_name)<=256),
  email TEXT NOT NULL DEFAULT '' CHECK(length(email)<=254),
  email_norm TEXT NOT NULL DEFAULT '' CHECK(length(email_norm)<=254),
  phone TEXT NOT NULL DEFAULT '' CHECK(length(phone)<=128),
  phone_norm TEXT NOT NULL DEFAULT '' CHECK(length(phone_norm)<=128),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=256),
  owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(first_name<>'' OR last_name<>'' OR email<>'')
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_uq ON contacts(email_norm) WHERE email_norm<>'';
CREATE INDEX IF NOT EXISTS contacts_account_idx ON contacts(account_id,last_name,first_name);
CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts(phone_norm) WHERE phone_norm<>'';
CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts(owner,status);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_ticket_id TEXT NOT NULL DEFAULT '' CHECK(length(relay_ticket_id)<=128),
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  converted_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  converted_deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  email TEXT NOT NULL DEFAULT '' CHECK(length(email)<=254),
  email_norm TEXT NOT NULL DEFAULT '' CHECK(length(email_norm)<=254),
  phone TEXT NOT NULL DEFAULT '' CHECK(length(phone)<=128),
  phone_norm TEXT NOT NULL DEFAULT '' CHECK(length(phone_norm)<=128),
  company TEXT NOT NULL DEFAULT '' CHECK(length(company)<=512),
  source TEXT NOT NULL DEFAULT '' CHECK(length(source)<=256),
  message TEXT NOT NULL DEFAULT '' CHECK(length(message)<=20000),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json)<=20000 AND json_valid(metadata_json)),
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
  owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','qualified','disqualified','converted')),
  disqualify_reason TEXT NOT NULL DEFAULT '' CHECK(length(disqualify_reason)<=1024),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  converted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_relay_ticket_uq ON leads(relay_ticket_id) WHERE relay_ticket_id<>'';
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status,priority,created_at DESC);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(email_norm) WHERE email_norm<>'';
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads(owner,status);

CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 256),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_default_pipeline ON pipelines(is_default) WHERE is_default=1;

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 1000),
  probability INTEGER NOT NULL CHECK(probability BETWEEN 0 AND 100),
  kind TEXT NOT NULL DEFAULT 'open' CHECK(kind IN ('open','won','lost')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(pipeline_id,name COLLATE NOCASE),
  UNIQUE(pipeline_id,position),
  UNIQUE(pipeline_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stages_won_uq ON stages(pipeline_id) WHERE kind='won';
CREATE UNIQUE INDEX IF NOT EXISTS stages_lost_uq ON stages(pipeline_id) WHERE kind='lost';

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  primary_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  source_lead_id INTEGER UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id),
  stage_id INTEGER NOT NULL REFERENCES stages(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(amount_minor>=0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency)=3),
  probability INTEGER NOT NULL CHECK(probability BETWEEN 0 AND 100),
  expected_close TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost')),
  lost_reason TEXT NOT NULL DEFAULT '' CHECK(length(lost_reason)<=1024),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS deals_pipeline_idx ON deals(pipeline_id,stage_id,status,expected_close);
CREATE INDEX IF NOT EXISTS deals_account_idx ON deals(account_id,status);
CREATE INDEX IF NOT EXISTS deals_owner_idx ON deals(owner,status);

CREATE TRIGGER IF NOT EXISTS deals_consistency_bi BEFORE INSERT ON deals BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM stages s WHERE s.id=NEW.stage_id AND s.pipeline_id=NEW.pipeline_id AND s.kind=NEW.status
  ) THEN RAISE(ABORT,'deal pipeline/stage/status mismatch') END;
  SELECT CASE WHEN NEW.status='lost' AND trim(NEW.lost_reason)='' THEN RAISE(ABORT,'lost deal requires a reason') END;
END;
CREATE TRIGGER IF NOT EXISTS deals_consistency_bu BEFORE UPDATE OF pipeline_id,stage_id,status,lost_reason ON deals BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM stages s WHERE s.id=NEW.stage_id AND s.pipeline_id=NEW.pipeline_id AND s.kind=NEW.status
  ) THEN RAISE(ABORT,'deal pipeline/stage/status mismatch') END;
  SELECT CASE WHEN NEW.status='lost' AND trim(NEW.lost_reason)='' THEN RAISE(ABORT,'lost deal requires a reason') END;
END;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('account','contact','lead','deal')),
  entity_id INTEGER NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'follow_up' CHECK(length(task_type) BETWEEN 1 AND 64),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
  due_date TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(status,due_date,priority);
CREATE INDEX IF NOT EXISTS tasks_entity_idx ON tasks(entity_type,entity_id,created_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('account','contact','lead','deal')),
  entity_id INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
  author TEXT NOT NULL DEFAULT '' CHECK(length(author)<=256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notes_entity_idx ON notes(entity_type,entity_id,created_at DESC);

CREATE TABLE IF NOT EXISTS custom_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('account','contact','lead','deal')),
  entity_id INTEGER NOT NULL,
  field_key TEXT NOT NULL CHECK(field_key GLOB '[A-Za-z][A-Za-z0-9_]*' AND length(field_key)<=64),
  field_value TEXT NOT NULL CHECK(length(field_value)<=20000),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entity_type,entity_id,field_key)
);
CREATE INDEX IF NOT EXISTS custom_values_entity_idx ON custom_values(entity_type,entity_id,field_key);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('account','contact','lead','deal')),
  entity_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 64),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 1024),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS activities_entity_idx ON activities(entity_type,entity_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('insert','update','delete')),
  actor TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity_type,entity_id,created_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS audit_immutable_bu BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT,'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_immutable_bd BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT,'audit_log is append-only');
END;

CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, content, tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS accounts_ai AFTER INSERT ON accounts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('account',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('name',NEW.name,'domain',NEW.domain,'industry',NEW.industry,'owner',NEW.owner,'status',NEW.status));
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('account',NEW.id,NEW.name||' '||NEW.domain||' '||NEW.industry||' '||NEW.city||' '||NEW.country||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS accounts_au AFTER UPDATE ON accounts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('account',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('name',OLD.name,'domain',OLD.domain,'industry',OLD.industry,'owner',OLD.owner,'status',OLD.status),json_object('name',NEW.name,'domain',NEW.domain,'industry',NEW.industry,'owner',NEW.owner,'status',NEW.status));
  DELETE FROM crm_fts WHERE entity_type='account' AND entity_id=NEW.id;
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('account',NEW.id,NEW.name||' '||NEW.domain||' '||NEW.industry||' '||NEW.city||' '||NEW.country||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS accounts_ad AFTER DELETE ON accounts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json) VALUES('account',OLD.id,'delete',(SELECT actor FROM crm_context WHERE id=1),json_object('name',OLD.name,'domain',OLD.domain,'industry',OLD.industry,'owner',OLD.owner,'status',OLD.status));
  DELETE FROM crm_fts WHERE entity_type='account' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('contact',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('account_id',NEW.account_id,'first_name',NEW.first_name,'last_name',NEW.last_name,'email',NEW.email,'phone',NEW.phone,'title',NEW.title,'owner',NEW.owner,'status',NEW.status));
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('contact',NEW.id,NEW.first_name||' '||NEW.last_name||' '||NEW.email||' '||NEW.phone||' '||NEW.title||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('contact',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('account_id',OLD.account_id,'first_name',OLD.first_name,'last_name',OLD.last_name,'email',OLD.email,'phone',OLD.phone,'title',OLD.title,'owner',OLD.owner,'status',OLD.status),json_object('account_id',NEW.account_id,'first_name',NEW.first_name,'last_name',NEW.last_name,'email',NEW.email,'phone',NEW.phone,'title',NEW.title,'owner',NEW.owner,'status',NEW.status));
  DELETE FROM crm_fts WHERE entity_type='contact' AND entity_id=NEW.id;
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('contact',NEW.id,NEW.first_name||' '||NEW.last_name||' '||NEW.email||' '||NEW.phone||' '||NEW.title||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json) VALUES('contact',OLD.id,'delete',(SELECT actor FROM crm_context WHERE id=1),json_object('account_id',OLD.account_id,'first_name',OLD.first_name,'last_name',OLD.last_name,'email',OLD.email,'phone',OLD.phone,'title',OLD.title,'owner',OLD.owner,'status',OLD.status));
  DELETE FROM crm_fts WHERE entity_type='contact' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS leads_ai AFTER INSERT ON leads BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('lead',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('relay_ticket_id',NEW.relay_ticket_id,'name',NEW.name,'email',NEW.email,'phone',NEW.phone,'company',NEW.company,'source',NEW.source,'metadata_json',NEW.metadata_json,'score',NEW.score,'priority',NEW.priority,'owner',NEW.owner,'status',NEW.status));
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('lead',NEW.id,NEW.name||' '||NEW.email||' '||NEW.phone||' '||NEW.company||' '||NEW.source||' '||NEW.message||' '||NEW.metadata_json||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS leads_au AFTER UPDATE ON leads BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('lead',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('account_id',OLD.account_id,'converted_contact_id',OLD.converted_contact_id,'converted_deal_id',OLD.converted_deal_id,'score',OLD.score,'priority',OLD.priority,'owner',OLD.owner,'status',OLD.status,'disqualify_reason',OLD.disqualify_reason),json_object('account_id',NEW.account_id,'converted_contact_id',NEW.converted_contact_id,'converted_deal_id',NEW.converted_deal_id,'score',NEW.score,'priority',NEW.priority,'owner',NEW.owner,'status',NEW.status,'disqualify_reason',NEW.disqualify_reason));
  DELETE FROM crm_fts WHERE entity_type='lead' AND entity_id=NEW.id;
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('lead',NEW.id,NEW.name||' '||NEW.email||' '||NEW.phone||' '||NEW.company||' '||NEW.source||' '||NEW.message||' '||NEW.metadata_json||' '||NEW.owner);
END;
CREATE TRIGGER IF NOT EXISTS leads_ad AFTER DELETE ON leads BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json) VALUES('lead',OLD.id,'delete',(SELECT actor FROM crm_context WHERE id=1),json_object('name',OLD.name,'email',OLD.email,'company',OLD.company,'score',OLD.score,'priority',OLD.priority,'owner',OLD.owner,'status',OLD.status));
  DELETE FROM crm_fts WHERE entity_type='lead' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS deals_ai AFTER INSERT ON deals BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('deal',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('account_id',NEW.account_id,'primary_contact_id',NEW.primary_contact_id,'source_lead_id',NEW.source_lead_id,'pipeline_id',NEW.pipeline_id,'stage_id',NEW.stage_id,'name',NEW.name,'amount_minor',NEW.amount_minor,'currency',NEW.currency,'probability',NEW.probability,'expected_close',NEW.expected_close,'owner',NEW.owner,'status',NEW.status));
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('deal',NEW.id,NEW.name||' '||NEW.currency||' '||NEW.owner||' '||NEW.lost_reason);
END;
CREATE TRIGGER IF NOT EXISTS deals_au AFTER UPDATE ON deals BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('deal',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('stage_id',OLD.stage_id,'amount_minor',OLD.amount_minor,'currency',OLD.currency,'probability',OLD.probability,'expected_close',OLD.expected_close,'owner',OLD.owner,'status',OLD.status,'lost_reason',OLD.lost_reason),json_object('stage_id',NEW.stage_id,'amount_minor',NEW.amount_minor,'currency',NEW.currency,'probability',NEW.probability,'expected_close',NEW.expected_close,'owner',NEW.owner,'status',NEW.status,'lost_reason',NEW.lost_reason));
  DELETE FROM crm_fts WHERE entity_type='deal' AND entity_id=NEW.id;
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('deal',NEW.id,NEW.name||' '||NEW.currency||' '||NEW.owner||' '||NEW.lost_reason);
END;
CREATE TRIGGER IF NOT EXISTS deals_ad AFTER DELETE ON deals BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json) VALUES('deal',OLD.id,'delete',(SELECT actor FROM crm_context WHERE id=1),json_object('name',OLD.name,'amount_minor',OLD.amount_minor,'currency',OLD.currency,'status',OLD.status));
  DELETE FROM crm_fts WHERE entity_type='deal' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('task',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('entity_type',NEW.entity_type,'entity_id',NEW.entity_id,'task_type',NEW.task_type,'subject',NEW.subject,'due_date',NEW.due_date,'owner',NEW.owner,'priority',NEW.priority,'status',NEW.status));
END;
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('task',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('subject',OLD.subject,'due_date',OLD.due_date,'owner',OLD.owner,'priority',OLD.priority,'status',OLD.status),json_object('subject',NEW.subject,'due_date',NEW.due_date,'owner',NEW.owner,'priority',NEW.priority,'status',NEW.status));
END;

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('note',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('entity_type',NEW.entity_type,'entity_id',NEW.entity_id,'author',NEW.author,'body',NEW.body));
  INSERT INTO crm_fts(entity_type,entity_id,content) VALUES('note',NEW.id,NEW.body||' '||NEW.author||' '||NEW.entity_type||' '||NEW.entity_id);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json) VALUES('note',OLD.id,'delete',(SELECT actor FROM crm_context WHERE id=1),json_object('entity_type',OLD.entity_type,'entity_id',OLD.entity_id,'author',OLD.author,'body',OLD.body));
  DELETE FROM crm_fts WHERE entity_type='note' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS custom_ai AFTER INSERT ON custom_values BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,after_json) VALUES('custom_value',NEW.id,'insert',(SELECT actor FROM crm_context WHERE id=1),json_object('entity_type',NEW.entity_type,'entity_id',NEW.entity_id,'field_key',NEW.field_key,'field_value',NEW.field_value));
END;
CREATE TRIGGER IF NOT EXISTS custom_au AFTER UPDATE ON custom_values BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor,before_json,after_json) VALUES('custom_value',NEW.id,'update',(SELECT actor FROM crm_context WHERE id=1),json_object('entity_type',OLD.entity_type,'entity_id',OLD.entity_id,'field_key',OLD.field_key,'field_value',OLD.field_value),json_object('entity_type',NEW.entity_type,'entity_id',NEW.entity_id,'field_key',NEW.field_key,'field_value',NEW.field_value));
END;

INSERT OR IGNORE INTO pipelines(name,is_default) VALUES('Default Sales',1);
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Qualification',10,20,'open' FROM pipelines WHERE name='Default Sales';
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Discovery',20,40,'open' FROM pipelines WHERE name='Default Sales';
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Proposal',30,65,'open' FROM pipelines WHERE name='Default Sales';
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Negotiation',40,85,'open' FROM pipelines WHERE name='Default Sales';
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Won',90,100,'won' FROM pipelines WHERE name='Default Sales';
INSERT OR IGNORE INTO stages(pipeline_id,name,position,probability,kind)
SELECT id,'Lost',100,0,'lost' FROM pipelines WHERE name='Default Sales';

DELETE FROM crm_fts;
INSERT INTO crm_fts(entity_type,entity_id,content) SELECT 'account',id,name||' '||domain||' '||industry||' '||city||' '||country||' '||owner FROM accounts;
INSERT INTO crm_fts(entity_type,entity_id,content) SELECT 'contact',id,first_name||' '||last_name||' '||email||' '||phone||' '||title||' '||owner FROM contacts;
INSERT INTO crm_fts(entity_type,entity_id,content) SELECT 'lead',id,name||' '||email||' '||phone||' '||company||' '||source||' '||message||' '||metadata_json||' '||owner FROM leads;
INSERT INTO crm_fts(entity_type,entity_id,content) SELECT 'deal',id,name||' '||currency||' '||owner||' '||lost_reason FROM deals;
INSERT INTO crm_fts(entity_type,entity_id,content) SELECT 'note',id,body||' '||author||' '||entity_type||' '||entity_id FROM notes;
)SQL";

void set_actor(Db& db, const std::string& actor) {
    validate_nonempty(actor, "actor");
    validate_length(actor, "actor", 128);
    Statement s(db.raw(), "UPDATE crm_context SET actor=? WHERE id=1");
    s.bind(1, actor);
    s.done();
}

bool table_exists(Db& db, const std::string& name) {
    Statement s(db.raw(), "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1");
    s.bind(1, name);
    return s.row();
}

void require_schema(Db& db) {
    if (!table_exists(db, "crm_meta")) fail("database is not initialized; run: clientops-crm init");
    Statement s(db.raw(), "SELECT value FROM crm_meta WHERE key='schema_version'");
    if (!s.row()) fail("database schema version is missing");
    if (s.text(0) != kSchemaVersion) fail("unsupported database schema version: " + s.text(0));
}

std::optional<std::string> option(const std::vector<std::string>& args, const std::string& name) {
    for (std::size_t i = 0; i < args.size(); ++i) {
        if (args[i] == name) {
            if (i + 1 >= args.size()) fail(name + " requires a value");
            return args[i + 1];
        }
        if (args[i].rfind(name + "=", 0) == 0) return args[i].substr(name.size() + 1);
    }
    return std::nullopt;
}

std::string opt(const std::vector<std::string>& args, const std::string& name, const std::string& fallback = "") {
    auto v = option(args, name);
    return v ? *v : fallback;
}

std::string required_opt(const std::vector<std::string>& args, const std::string& name) {
    auto v = option(args, name);
    if (!v) fail("missing required option " + name);
    return *v;
}

std::vector<std::string> positionals(const std::vector<std::string>& args) {
    std::vector<std::string> out;
    for (std::size_t i = 0; i < args.size(); ++i) {
        if (args[i].rfind("--", 0) == 0) {
            if (args[i].find('=') == std::string::npos && i + 1 < args.size() && args[i + 1].rfind("--", 0) != 0) ++i;
            continue;
        }
        out.push_back(args[i]);
    }
    return out;
}

struct Row {
    std::vector<std::string> names;
    std::vector<std::optional<std::string>> values;
};

std::vector<Row> query(Db& db, const std::string& sql, const std::vector<std::string>& params = {}) {
    Statement s(db.raw(), sql);
    for (std::size_t i = 0; i < params.size(); ++i) s.bind(static_cast<int>(i + 1), params[i]);
    std::vector<Row> rows;
    while (s.row()) {
        int n = sqlite3_column_count(s.get());
        Row row;
        for (int i = 0; i < n; ++i) {
            row.names.emplace_back(sqlite3_column_name(s.get(), i));
            if (s.is_null(i)) row.values.push_back(std::nullopt);
            else row.values.push_back(s.text(i));
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

void print_rows(const std::vector<Row>& rows, bool json) {
    if (json) {
        std::cout << '[';
        for (std::size_t r = 0; r < rows.size(); ++r) {
            if (r) std::cout << ',';
            std::cout << '{';
            for (std::size_t c = 0; c < rows[r].names.size(); ++c) {
                if (c) std::cout << ',';
                std::cout << json_escape(rows[r].names[c]) << ':';
                if (!rows[r].values[c]) std::cout << "null";
                else std::cout << json_escape(*rows[r].values[c]);
            }
            std::cout << '}';
        }
        std::cout << "]\n";
        return;
    }
    if (rows.empty()) { std::cout << "No records.\n"; return; }
    for (std::size_t i = 0; i < rows[0].names.size(); ++i) {
        if (i) std::cout << '\t';
        std::cout << rows[0].names[i];
    }
    std::cout << '\n';
    for (const auto& row : rows) {
        for (std::size_t i = 0; i < row.values.size(); ++i) {
            if (i) std::cout << '\t';
            std::string value = row.values[i] ? *row.values[i] : std::string("NULL");
            std::replace(value.begin(), value.end(), '\t', ' ');
            std::replace(value.begin(), value.end(), '\n', ' ');
            std::cout << value;
        }
        std::cout << '\n';
    }
}

void print_one_id(const std::string& entity, std::int64_t id, bool json) {
    if (json) std::cout << "{\"ok\":true,\"entity\":" << json_escape(entity) << ",\"id\":" << id << "}\n";
    else std::cout << entity << " created: " << id << "\n";
}

std::int64_t last_id(Db& db) { return sqlite3_last_insert_rowid(db.raw()); }

bool entity_exists(Db& db, const std::string& type, std::int64_t id) {
    std::string table;
    if (type == "account") table = "accounts";
    else if (type == "contact") table = "contacts";
    else if (type == "lead") table = "leads";
    else if (type == "deal") table = "deals";
    else fail("entity type must be account, contact, lead, or deal");
    Statement s(db.raw(), "SELECT 1 FROM " + table + " WHERE id=?");
    s.bind(1, id);
    return s.row();
}

std::string actor_from_db(Db& db) {
    Statement s(db.raw(), "SELECT actor FROM crm_context WHERE id=1");
    if (!s.row()) return "local-operator";
    return s.text(0);
}

void activity(Db& db, const std::string& type, std::int64_t id, const std::string& event, const std::string& summary) {
    validate_length(summary, "activity summary", 1024);
    Statement s(db.raw(), "INSERT INTO activities(entity_type,entity_id,event_type,summary,actor) VALUES(?,?,?,?,?)");
    s.bind(1, type); s.bind(2, id); s.bind(3, event); s.bind(4, summary); s.bind(5, actor_from_db(db)); s.done();
}

struct Stage {
    std::int64_t id{};
    std::int64_t pipeline_id{};
    std::string name;
    int probability{};
    std::string kind;
};

Stage resolve_stage(Db& db, std::int64_t pipeline_id, const std::string& token, const std::string& required_kind = "") {
    Statement s(db.raw(), "SELECT id,pipeline_id,name,probability,kind FROM stages WHERE pipeline_id=? AND (CAST(id AS TEXT)=? OR name=? COLLATE NOCASE) LIMIT 1");
    s.bind(1, pipeline_id); s.bind(2, token); s.bind(3, token);
    if (!s.row()) fail("pipeline stage not found: " + token);
    Stage st{s.i64(0), s.i64(1), s.text(2), static_cast<int>(s.i64(3)), s.text(4)};
    if (!required_kind.empty() && st.kind != required_kind) fail("stage kind must be " + required_kind);
    return st;
}

std::int64_t default_pipeline(Db& db) {
    Statement s(db.raw(), "SELECT id FROM pipelines WHERE is_default=1 LIMIT 1");
    if (!s.row()) fail("default pipeline is missing");
    return s.i64(0);
}

Stage first_open_stage(Db& db, std::int64_t pipeline_id) {
    Statement s(db.raw(), "SELECT id,pipeline_id,name,probability,kind FROM stages WHERE pipeline_id=? AND kind='open' ORDER BY position LIMIT 1");
    s.bind(1, pipeline_id);
    if (!s.row()) fail("pipeline has no open stage");
    return Stage{s.i64(0),s.i64(1),s.text(2),static_cast<int>(s.i64(3)),s.text(4)};
}

Stage terminal_stage(Db& db, std::int64_t pipeline_id, const std::string& kind) {
    Statement s(db.raw(), "SELECT id,pipeline_id,name,probability,kind FROM stages WHERE pipeline_id=? AND kind=? ORDER BY position LIMIT 1");
    s.bind(1, pipeline_id); s.bind(2, kind);
    if (!s.row()) fail("pipeline terminal stage is missing: " + kind);
    return Stage{s.i64(0),s.i64(1),s.text(2),static_cast<int>(s.i64(3)),s.text(4)};
}

std::string fts_query(const std::string& input) {
    std::vector<std::string> tokens;
    std::string cur;
    for (unsigned char c : input) {
        if (std::isalnum(c) || c >= 0x80) cur.push_back(static_cast<char>(c));
        else if (!cur.empty()) { tokens.push_back(cur); cur.clear(); }
    }
    if (!cur.empty()) tokens.push_back(cur);
    if (tokens.empty()) fail("search term has no searchable characters");
    std::ostringstream out;
    for (std::size_t i = 0; i < tokens.size(); ++i) {
        if (i) out << " AND ";
        out << '"';
        for (char c : tokens[i]) { if (c == '"') out << "\"\""; else out << c; }
        out << '"' << '*';
    }
    return out.str();
}

void command_init(Db& db, bool json) {
    Statement table_check(db.raw(), "SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_meta'");
    if (table_check.row()) {
        Statement version_check(db.raw(), "SELECT value FROM crm_meta WHERE key='schema_version'");
        if (version_check.row() && version_check.text(0) != kSchemaVersion) {
            fail("database schema version " + version_check.text(0) + " is incompatible with " + kSchemaVersion + "; explicit migration required");
        }
    }
    db.exec(kSchemaSql);
    Statement s(db.raw(), "PRAGMA user_version=20000"); s.done();
    auto rows = query(db, "SELECT value AS schema_version FROM crm_meta WHERE key='schema_version'");
    if (json) print_rows(rows, true);
    else std::cout << "ClientOpsCRM database initialized at schema " << kSchemaVersion << "\n";
}

void command_account(Db& db, const std::vector<std::string>& args, bool json) {
    if (args.empty()) fail("account requires add, list, show, or update");
    if (args[0] == "add") {
        std::string name = trim(required_opt(args, "--name"));
        std::string domain = trim(opt(args, "--domain"));
        std::string website = trim(opt(args, "--website"));
        std::string industry = trim(opt(args, "--industry"));
        std::string city = trim(opt(args, "--city"));
        std::string country = trim(opt(args, "--country"));
        std::string owner = trim(opt(args, "--owner"));
        validate_nonempty(name, "name");
        for (auto* p : {&name,&domain,&industry,&city,&country,&owner}) validate_length(*p, "account field");
        validate_length(website, "website", 1024);
        Statement s(db.raw(), "INSERT INTO accounts(name,domain,domain_norm,website,industry,city,country,owner) VALUES(?,?,?,?,?,?,?,?)");
        s.bind(1,name); s.bind(2,domain); s.bind(3,normalize_domain(domain)); s.bind(4,website); s.bind(5,industry); s.bind(6,city); s.bind(7,country); s.bind(8,owner); s.done();
        auto id = last_id(db); activity(db,"account",id,"created","Account created"); print_one_id("account",id,json);
    } else if (args[0] == "list") {
        std::string status = opt(args,"--status");
        std::string owner = opt(args,"--owner");
        std::string sql = "SELECT id,name,domain,industry,city,country,owner,status,created_at FROM accounts WHERE 1=1";
        std::vector<std::string> params;
        if (!status.empty()) { sql += " AND status=?"; params.push_back(status); }
        if (!owner.empty()) { sql += " AND owner=?"; params.push_back(owner); }
        sql += " ORDER BY name COLLATE NOCASE,id";
        print_rows(query(db,sql,params),json);
    } else if (args[0] == "show") {
        auto p = positionals(std::vector<std::string>(args.begin()+1,args.end()));
        if (p.size()!=1) fail("account show requires an ID");
        auto id = parse_i64(p[0],"account id");
        auto rows=query(db,"SELECT id,name,domain,website,industry,city,country,owner,status,created_at,updated_at FROM accounts WHERE id=?",{std::to_string(id)});
        if(rows.empty()) fail("account not found");
        print_rows(rows,json);
    } else if (args[0] == "update") {
        auto p = positionals(std::vector<std::string>(args.begin()+1,args.end()));
        if (p.empty()) fail("account update requires an ID");
        auto id=parse_i64(p[0],"account id"); if(!entity_exists(db,"account",id)) fail("account not found");
        std::vector<std::string> sets, vals;
        auto add=[&](const char* flag_name,const char* col,std::size_t max=kMaxShort){ auto v=option(args,flag_name); if(v){validate_length(*v,flag_name,max); sets.push_back(std::string(col)+"=?"); vals.push_back(trim(*v));}};
        add("--name","name"); add("--domain","domain",255); add("--website","website",1024); add("--industry","industry"); add("--city","city"); add("--country","country"); add("--owner","owner");
        auto status=option(args,"--status"); if(status){ if(*status!="active"&&*status!="inactive") fail("status must be active or inactive"); sets.push_back("status=?"); vals.push_back(*status); }
        if(auto d=option(args,"--domain")){ sets.push_back("domain_norm=?"); vals.push_back(normalize_domain(*d)); }
        if(sets.empty()) fail("account update requires at least one field option");
        sets.push_back("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
        std::ostringstream sql; sql<<"UPDATE accounts SET "; for(std::size_t i=0;i<sets.size();++i){if(i)sql<<',';sql<<sets[i];} sql<<" WHERE id=?";
        Statement s(db.raw(),sql.str()); int bi=1; for(auto&v:vals)s.bind(bi++,v); s.bind(bi,id); s.done(); activity(db,"account",id,"updated","Account updated");
        if(json) std::cout<<"{\"ok\":true,\"updated\":\"account\",\"id\":"<<id<<"}\n"; else std::cout<<"account updated: "<<id<<"\n";
    } else fail("unknown account subcommand");
}

void command_contact(Db& db, const std::vector<std::string>& args, bool json) {
    if(args.empty()) fail("contact requires add, list, show, or update");
    if(args[0]=="add"){
        std::string first=trim(opt(args,"--first")), last=trim(opt(args,"--last")), email=trim(opt(args,"--email")), phone=trim(opt(args,"--phone")), title=trim(opt(args,"--title")), owner=trim(opt(args,"--owner"));
        if(first.empty()&&last.empty()&&email.empty()) fail("contact requires --first, --last, or --email");
        if(!email.empty()) validate_email(email);
        for(auto* p:{&first,&last,&phone,&title,&owner}) validate_length(*p,"contact field");
        std::optional<std::int64_t> account; if(auto a=option(args,"--account")){account=parse_i64(*a,"account id"); if(!entity_exists(db,"account",*account)) fail("account not found");}
        Statement s(db.raw(),"INSERT INTO contacts(account_id,first_name,last_name,email,email_norm,phone,phone_norm,title,owner) VALUES(?,?,?,?,?,?,?,?,?)");
        if(account)s.bind(1,*account);else s.bind_null(1); s.bind(2,first);s.bind(3,last);s.bind(4,email);s.bind(5,normalize_email(email));s.bind(6,phone);s.bind(7,normalize_phone(phone));s.bind(8,title);s.bind(9,owner);s.done();
        auto id=last_id(db); activity(db,"contact",id,"created","Contact created"); print_one_id("contact",id,json);
    }else if(args[0]=="list"){
        std::string sql="SELECT c.id,c.first_name,c.last_name,c.email,c.phone,a.name AS account,c.title,c.owner,c.status,c.created_at FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE 1=1"; std::vector<std::string> params;
        if(auto a=option(args,"--account")){sql+=" AND c.account_id=?";params.push_back(*a);} if(auto o=option(args,"--owner")){sql+=" AND c.owner=?";params.push_back(*o);} sql+=" ORDER BY c.last_name COLLATE NOCASE,c.first_name COLLATE NOCASE,c.id";
        print_rows(query(db,sql,params),json);
    }else if(args[0]=="show"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end())); if(p.size()!=1) fail("contact show requires an ID"); auto id=parse_i64(p[0],"contact id");
        auto rows=query(db,"SELECT c.id,c.first_name,c.last_name,c.email,c.phone,c.title,c.owner,c.status,c.account_id,a.name AS account,c.created_at,c.updated_at FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=?",{std::to_string(id)}); if(rows.empty()) fail("contact not found");
        print_rows(rows,json);
    }else if(args[0]=="update"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end())); if(p.empty()) fail("contact update requires an ID"); auto id=parse_i64(p[0],"contact id"); if(!entity_exists(db,"contact",id)) fail("contact not found");
        std::vector<std::string> sets,vals; auto add=[&](const char*f,const char*c,std::size_t m=kMaxShort){auto v=option(args,f);if(v){validate_length(*v,f,m);sets.push_back(std::string(c)+"=?");vals.push_back(trim(*v));}}; add("--first","first_name");add("--last","last_name");add("--phone","phone",128);add("--title","title");add("--owner","owner");
        if(auto e=option(args,"--email")){if(!e->empty())validate_email(*e);sets.push_back("email=?");vals.push_back(trim(*e));sets.push_back("email_norm=?");vals.push_back(normalize_email(*e));}
        if(auto ph=option(args,"--phone")){sets.push_back("phone_norm=?");vals.push_back(normalize_phone(*ph));}
        if(auto a=option(args,"--account")){auto aid=parse_i64(*a,"account id");if(!entity_exists(db,"account",aid))fail("account not found");sets.push_back("account_id=?");vals.push_back(std::to_string(aid));}
        if(auto st=option(args,"--status")){if(*st!="active"&&*st!="inactive")fail("status must be active or inactive");sets.push_back("status=?");vals.push_back(*st);} if(sets.empty())fail("contact update requires at least one field option"); sets.push_back("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
        std::ostringstream sql;sql<<"UPDATE contacts SET ";for(std::size_t i=0;i<sets.size();++i){if(i)sql<<',';sql<<sets[i];}sql<<" WHERE id=?";Statement s(db.raw(),sql.str());int bi=1;for(auto&v:vals)s.bind(bi++,v);s.bind(bi,id);s.done();activity(db,"contact",id,"updated","Contact updated"); if(json)std::cout<<"{\"ok\":true,\"updated\":\"contact\",\"id\":"<<id<<"}\n";else std::cout<<"contact updated: "<<id<<"\n";
    }else fail("unknown contact subcommand");
}

void insert_lead(Db& db,const std::string& relay,const std::string& name,const std::string& email,const std::string& phone,const std::string& company,const std::string& source,const std::string& message,const std::string& metadata_json,int score,const std::string& priority,const std::string& owner,bool emit,bool json){
    validate_nonempty(name,"name");if(!email.empty())validate_email(email);validate_priority(priority);for(auto* p:{&relay,&name,&phone,&company,&source,&owner})validate_length(*p,"lead field");validate_length(message,"message",kMaxText);validate_length(metadata_json,"metadata json",kMaxText);
    Statement valid(db.raw(),"SELECT json_valid(?)");valid.bind(1,metadata_json);if(!valid.row()||valid.i64(0)!=1)fail("metadata json must be valid JSON");
    Statement s(db.raw(),"INSERT INTO leads(relay_ticket_id,name,email,email_norm,phone,phone_norm,company,source,message,metadata_json,score,priority,owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");s.bind(1,relay);s.bind(2,name);s.bind(3,email);s.bind(4,normalize_email(email));s.bind(5,phone);s.bind(6,normalize_phone(phone));s.bind(7,company);s.bind(8,source);s.bind(9,message);s.bind(10,metadata_json);s.bind(11,static_cast<std::int64_t>(score));s.bind(12,priority);s.bind(13,owner);s.done();auto id=last_id(db);activity(db,"lead",id,"created","Lead created");if(emit)print_one_id("lead",id,json);
}

std::vector<std::vector<std::string>> parse_csv(std::istream& in){
    std::vector<std::vector<std::string>> rows;std::vector<std::string> row;std::string field;bool quoted=false;char c;
    while(in.get(c)){
        if(quoted){if(c=='"'){if(in.peek()=='"'){in.get(c);field.push_back('"');}else quoted=false;}else field.push_back(c);}
        else{if(c=='"'&&field.empty())quoted=true;else if(c==','){row.push_back(field);field.clear();}else if(c=='\n'){if(!field.empty()||!row.empty()){if(!field.empty()&&field.back()=='\r')field.pop_back();row.push_back(field);rows.push_back(row);row.clear();field.clear();}}else field.push_back(c);}
    }
    if (quoted) fail("CSV ended inside a quoted field");
    if (!field.empty() || !row.empty()) {
        if (!field.empty() && field.back() == '\r') field.pop_back();
        row.push_back(field);
        rows.push_back(row);
    }
    return rows;
}

void command_lead(Db& db,const std::vector<std::string>& args,bool json){
    if(args.empty())fail("lead requires add, list, show, qualify, disqualify, convert, or import-csv");
    if(args[0]=="add"){
        std::string name=trim(required_opt(args,"--name"));std::string email=trim(opt(args,"--email")),phone=trim(opt(args,"--phone")),company=trim(opt(args,"--company")),source=trim(opt(args,"--source")),message=trim(opt(args,"--message")),metadata=opt(args,"--metadata-json","{}"),priority=opt(args,"--priority","medium"),owner=trim(opt(args,"--owner")),relay=trim(opt(args,"--relay-ticket"));int score=parse_int(opt(args,"--score","0"),"score",0,100);insert_lead(db,relay,name,email,phone,company,source,message,metadata,score,priority,owner,true,json);
    }else if(args[0]=="list"){
        std::string sql="SELECT id,relay_ticket_id,name,email,phone,company,source,score,priority,owner,status,created_at FROM leads WHERE 1=1";std::vector<std::string> params;if(auto s=option(args,"--status")){sql+=" AND status=?";params.push_back(*s);}if(auto o=option(args,"--owner")){sql+=" AND owner=?";params.push_back(*o);}sql+=" ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,score DESC,created_at DESC,id DESC";print_rows(query(db,sql,params),json);
    }else if(args[0]=="show"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.size()!=1)fail("lead show requires an ID");auto id=parse_i64(p[0],"lead id");auto rows=query(db,"SELECT id,relay_ticket_id,name,email,phone,company,source,message,metadata_json,score,priority,owner,status,disqualify_reason,account_id,converted_contact_id,converted_deal_id,created_at,updated_at,converted_at FROM leads WHERE id=?",{std::to_string(id)});if(rows.empty())fail("lead not found");print_rows(rows,json);
    }else if(args[0]=="qualify"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.size()!=1)fail("lead qualify requires an ID");auto id=parse_i64(p[0],"lead id");Statement s(db.raw(),"UPDATE leads SET status='qualified',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='new'");s.bind(1,id);s.done();if(db.changes()!=1)fail("lead is not in new state");activity(db,"lead",id,"qualified","Lead qualified");if(json)std::cout<<"{\"ok\":true,\"lead_id\":"<<id<<",\"status\":\"qualified\"}\n";else std::cout<<"lead qualified: "<<id<<"\n";
    }else if(args[0]=="disqualify"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.empty())fail("lead disqualify requires an ID");auto id=parse_i64(p[0],"lead id");std::string reason=trim(required_opt(args,"--reason"));validate_nonempty(reason,"reason");validate_length(reason,"reason",1024);Statement s(db.raw(),"UPDATE leads SET status='disqualified',disqualify_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('new','qualified')");s.bind(1,reason);s.bind(2,id);s.done();if(db.changes()!=1)fail("lead cannot be disqualified from its current state");activity(db,"lead",id,"disqualified","Lead disqualified: "+reason);if(json)std::cout<<"{\"ok\":true,\"lead_id\":"<<id<<",\"status\":\"disqualified\"}\n";else std::cout<<"lead disqualified: "<<id<<"\n";
    }else if(args[0]=="convert"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.empty())fail("lead convert requires an ID");auto lead_id=parse_i64(p[0],"lead id");
        Transaction tx(db);Statement l(db.raw(),"SELECT name,email,phone,company,owner,status FROM leads WHERE id=?");l.bind(1,lead_id);if(!l.row())fail("lead not found");std::string name=l.text(0),email=l.text(1),phone=l.text(2),company=l.text(3),lead_owner=l.text(4),status=l.text(5);if(status!="new"&&status!="qualified")fail("lead cannot be converted from its current state");
        std::string owner=trim(opt(args,"--owner",lead_owner));std::optional<std::int64_t> account_id;
        if(auto a=option(args,"--account")){auto id=parse_i64(*a,"account id");if(!entity_exists(db,"account",id))fail("account not found");account_id=id;}
        else if(!company.empty()){
            Statement f(db.raw(),"SELECT id FROM accounts WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1");f.bind(1,company);if(f.row())account_id=f.i64(0);else{Statement a(db.raw(),"INSERT INTO accounts(name,owner) VALUES(?,?)");a.bind(1,company);a.bind(2,owner);a.done();account_id=last_id(db);activity(db,"account",*account_id,"created_from_lead","Account created from lead "+std::to_string(lead_id));}
        }
        std::optional<std::int64_t> contact_id;
        if(!email.empty()){
            Statement f(db.raw(),"SELECT id FROM contacts WHERE email_norm=? LIMIT 1");f.bind(1,normalize_email(email));if(f.row())contact_id=f.i64(0);
        }
        if(!contact_id){std::string first=name,last;auto sp=name.find(' ');if(sp!=std::string::npos){first=name.substr(0,sp);last=trim(name.substr(sp+1));}Statement c(db.raw(),"INSERT INTO contacts(account_id,first_name,last_name,email,email_norm,phone,phone_norm,owner) VALUES(?,?,?,?,?,?,?,?)");if(account_id)c.bind(1,*account_id);else c.bind_null(1);c.bind(2,first);c.bind(3,last);c.bind(4,email);c.bind(5,normalize_email(email));c.bind(6,phone);c.bind(7,normalize_phone(phone));c.bind(8,owner);c.done();contact_id=last_id(db);activity(db,"contact",*contact_id,"created_from_lead","Contact created from lead "+std::to_string(lead_id));}
        else if(account_id){Statement c(db.raw(),"UPDATE contacts SET account_id=COALESCE(account_id,?),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");c.bind(1,*account_id);c.bind(2,*contact_id);c.done();}
        std::int64_t pipeline=default_pipeline(db);if(auto pi=option(args,"--pipeline"))pipeline=parse_i64(*pi,"pipeline id");Stage stage=first_open_stage(db,pipeline);if(auto st=option(args,"--stage"))stage=resolve_stage(db,pipeline,*st,"open");
        std::string deal_name=trim(opt(args,"--deal-name",company.empty()?name+" opportunity":company+" opportunity"));validate_nonempty(deal_name,"deal name");std::int64_t amount=parse_money_minor(opt(args,"--amount","0"));if(amount<0)fail("deal amount must not be negative");std::string currency=upper(trim(opt(args,"--currency","USD")));if(currency.size()!=3||!std::all_of(currency.begin(),currency.end(),[](unsigned char c){return std::isalpha(c);}))fail("currency must be a three-letter code");std::string close=trim(opt(args,"--close"));validate_date(close,true);
        Statement d(db.raw(),"INSERT INTO deals(account_id,primary_contact_id,source_lead_id,pipeline_id,stage_id,name,amount_minor,currency,probability,expected_close,owner) VALUES(?,?,?,?,?,?,?,?,?,?,?)");if(account_id)d.bind(1,*account_id);else d.bind_null(1);if(contact_id)d.bind(2,*contact_id);else d.bind_null(2);d.bind(3,lead_id);d.bind(4,pipeline);d.bind(5,stage.id);d.bind(6,deal_name);d.bind(7,amount);d.bind(8,currency);d.bind(9,static_cast<std::int64_t>(stage.probability));d.bind(10,close);d.bind(11,owner);d.done();auto deal_id=last_id(db);
        Statement u(db.raw(),"UPDATE leads SET account_id=?,converted_contact_id=?,converted_deal_id=?,status='converted',converted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");if(account_id)u.bind(1,*account_id);else u.bind_null(1);if(contact_id)u.bind(2,*contact_id);else u.bind_null(2);u.bind(3,deal_id);u.bind(4,lead_id);u.done();activity(db,"lead",lead_id,"converted","Lead converted to deal "+std::to_string(deal_id));activity(db,"deal",deal_id,"created_from_lead","Deal created from lead "+std::to_string(lead_id));tx.commit();
        if(json)std::cout<<"{\"ok\":true,\"lead_id\":"<<lead_id<<",\"account_id\":"<<(account_id?std::to_string(*account_id):"null")<<",\"contact_id\":"<<(contact_id?std::to_string(*contact_id):"null")<<",\"deal_id\":"<<deal_id<<"}\n";else std::cout<<"lead converted: "<<lead_id<<" -> deal "<<deal_id<<"\n";
    }else if(args[0]=="import-csv"){
        std::string path=required_opt(args,"--in");std::ifstream file;std::istream* in=&std::cin;if(path!="-"){file.open(path,std::ios::binary);if(!file)fail("cannot open CSV input");in=&file;}auto rows=parse_csv(*in);if(rows.empty())fail("CSV is empty");std::map<std::string,std::size_t> cols;for(std::size_t i=0;i<rows[0].size();++i)cols[lower(trim(rows[0][i]))]=i;for(const char* req:{"name"})if(!cols.count(req))fail(std::string("CSV missing required column: ")+req);auto cell=[&](const std::vector<std::string>&r,const char*n){auto it=cols.find(n);return it==cols.end()||it->second>=r.size()?std::string():trim(r[it->second]);};
        const bool skip_existing=std::find(args.begin(),args.end(),"--skip-existing")!=args.end();
        Transaction tx(db);std::size_t imported=0,skipped=0;
        for(std::size_t ri=1;ri<rows.size();++ri){
            if(rows[ri].size()==1&&trim(rows[ri][0]).empty())continue;
            const std::string relay_id=cell(rows[ri],"relay_ticket_id");
            if(skip_existing&&!relay_id.empty()){
                Statement existing(db.raw(),"SELECT 1 FROM leads WHERE relay_ticket_id=? LIMIT 1");existing.bind(1,relay_id);
                if(existing.row()){++skipped;continue;}
            }
            int score=cell(rows[ri],"score").empty()?0:parse_int(cell(rows[ri],"score"),"score",0,100);
            std::string pri=cell(rows[ri],"priority").empty()?"medium":lower(cell(rows[ri],"priority"));
            std::string metadata=cell(rows[ri],"metadata_json").empty()?"{}":cell(rows[ri],"metadata_json");
            insert_lead(db,relay_id,cell(rows[ri],"name"),cell(rows[ri],"email"),cell(rows[ri],"phone"),cell(rows[ri],"company"),cell(rows[ri],"source"),cell(rows[ri],"message"),metadata,score,pri,cell(rows[ri],"owner"),false,json);++imported;
        }
        tx.commit();if(json)std::cout<<"{\"ok\":true,\"imported\":"<<imported<<",\"skipped\":"<<skipped<<"}\n";else std::cout<<"leads imported: "<<imported<<"; skipped: "<<skipped<<"\n";
    }else fail("unknown lead subcommand");
}

void command_pipeline(Db& db,const std::vector<std::string>&args,bool json){
    if(args.empty()||args[0]=="list") print_rows(query(db,"SELECT p.id,p.name,p.is_default,s.id AS stage_id,s.name AS stage,s.position,s.probability,s.kind FROM pipelines p JOIN stages s ON s.pipeline_id=p.id ORDER BY p.id,s.position"),json);
    else if(args[0]=="add"){
        std::string name=trim(required_opt(args,"--name"));validate_nonempty(name,"pipeline name");validate_length(name,"pipeline name",256);Transaction tx(db);Statement p(db.raw(),"INSERT INTO pipelines(name,is_default) VALUES(?,0)");p.bind(1,name);p.done();auto pid=last_id(db);struct Def{const char*n;int pos;int prob;const char*k;};for(auto d:{Def{"Qualification",10,20,"open"},Def{"Discovery",20,40,"open"},Def{"Proposal",30,65,"open"},Def{"Negotiation",40,85,"open"},Def{"Won",90,100,"won"},Def{"Lost",100,0,"lost"}}){Statement s(db.raw(),"INSERT INTO stages(pipeline_id,name,position,probability,kind) VALUES(?,?,?,?,?)");s.bind(1,pid);s.bind(2,d.n);s.bind(3,static_cast<std::int64_t>(d.pos));s.bind(4,static_cast<std::int64_t>(d.prob));s.bind(5,d.k);s.done();}tx.commit();print_one_id("pipeline",pid,json);
    }else if(args[0]=="stage-add"){
        auto pid=parse_i64(required_opt(args,"--pipeline"),"pipeline id");
        std::string name=trim(required_opt(args,"--name"));
        validate_nonempty(name,"stage name");
        validate_length(name,"stage name",256);
        int pos=parse_int(required_opt(args,"--position"),"position",1,1000);
        int prob=parse_int(required_opt(args,"--probability"),"probability",0,100);
        std::string kind=lower(opt(args,"--kind","open"));
        if(kind!="open"&&kind!="won"&&kind!="lost") fail("kind must be open, won, or lost");
        Statement pipeline_check(db.raw(),"SELECT 1 FROM pipelines WHERE id=?");
        pipeline_check.bind(1,pid);
        if(!pipeline_check.row()) fail("pipeline not found");
        if(kind=="won"||kind=="lost"){
            Statement terminal_check(db.raw(),"SELECT 1 FROM stages WHERE pipeline_id=? AND kind=? LIMIT 1");
            terminal_check.bind(1,pid); terminal_check.bind(2,kind);
            if(terminal_check.row()) fail("pipeline already has a terminal "+kind+" stage");
        }
        Statement s(db.raw(),"INSERT INTO stages(pipeline_id,name,position,probability,kind) VALUES(?,?,?,?,?)");s.bind(1,pid);s.bind(2,name);s.bind(3,static_cast<std::int64_t>(pos));s.bind(4,static_cast<std::int64_t>(prob));s.bind(5,kind);s.done();print_one_id("stage",last_id(db),json);
    }else fail("unknown pipeline subcommand");
}

void command_deal(Db&db,const std::vector<std::string>&args,bool json){
    if(args.empty())fail("deal requires add, list, show, move, win, or lost");
    if(args[0]=="add"){
        std::string name=trim(required_opt(args,"--name"));validate_nonempty(name,"deal name");auto amount=parse_money_minor(opt(args,"--amount","0"));if(amount<0)fail("deal amount must not be negative");std::string currency=upper(trim(opt(args,"--currency","USD")));if(currency.size()!=3||!std::all_of(currency.begin(),currency.end(),[](unsigned char c){return std::isalpha(c);}))fail("currency must be a three-letter code");std::string close=trim(opt(args,"--close"));validate_date(close,true);std::string owner=trim(opt(args,"--owner"));std::int64_t pipeline=option(args,"--pipeline")?parse_i64(*option(args,"--pipeline"),"pipeline id"):default_pipeline(db);Stage stage=option(args,"--stage")?resolve_stage(db,pipeline,*option(args,"--stage"),"open"):first_open_stage(db,pipeline);std::optional<std::int64_t>a,c;if(auto v=option(args,"--account")){a=parse_i64(*v,"account id");if(!entity_exists(db,"account",*a))fail("account not found");}if(auto v=option(args,"--contact")){c=parse_i64(*v,"contact id");if(!entity_exists(db,"contact",*c))fail("contact not found");}Statement s(db.raw(),"INSERT INTO deals(account_id,primary_contact_id,pipeline_id,stage_id,name,amount_minor,currency,probability,expected_close,owner) VALUES(?,?,?,?,?,?,?,?,?,?)");if(a)s.bind(1,*a);else s.bind_null(1);if(c)s.bind(2,*c);else s.bind_null(2);s.bind(3,pipeline);s.bind(4,stage.id);s.bind(5,name);s.bind(6,amount);s.bind(7,currency);s.bind(8,static_cast<std::int64_t>(stage.probability));s.bind(9,close);s.bind(10,owner);s.done();auto id=last_id(db);activity(db,"deal",id,"created","Deal created in stage "+stage.name);print_one_id("deal",id,json);
    }else if(args[0]=="list"){
        std::string sql="SELECT d.id,d.name,a.name AS account,c.first_name||CASE WHEN c.last_name<>'' THEN ' '||c.last_name ELSE '' END AS contact,d.amount_minor,d.currency,d.probability,p.name AS pipeline,s.name AS stage,d.expected_close,d.owner,d.status,d.created_at FROM deals d LEFT JOIN accounts a ON a.id=d.account_id LEFT JOIN contacts c ON c.id=d.primary_contact_id JOIN pipelines p ON p.id=d.pipeline_id JOIN stages s ON s.id=d.stage_id WHERE 1=1";std::vector<std::string>params;if(auto st=option(args,"--status")){sql+=" AND d.status=?";params.push_back(*st);}if(auto o=option(args,"--owner")){sql+=" AND d.owner=?";params.push_back(*o);}if(auto pi=option(args,"--pipeline")){sql+=" AND d.pipeline_id=?";params.push_back(*pi);}sql+=" ORDER BY d.status,s.position,d.expected_close,d.id";print_rows(query(db,sql,params),json);
    }else if(args[0]=="show"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.size()!=1)fail("deal show requires an ID");auto id=parse_i64(p[0],"deal id");auto rows=query(db,"SELECT d.id,d.name,d.account_id,a.name AS account,d.primary_contact_id,c.email AS contact_email,d.source_lead_id,d.amount_minor,d.currency,d.probability,p.name AS pipeline,s.name AS stage,s.kind AS stage_kind,d.expected_close,d.owner,d.status,d.lost_reason,d.created_at,d.updated_at,d.closed_at FROM deals d LEFT JOIN accounts a ON a.id=d.account_id LEFT JOIN contacts c ON c.id=d.primary_contact_id JOIN pipelines p ON p.id=d.pipeline_id JOIN stages s ON s.id=d.stage_id WHERE d.id=?",{std::to_string(id)});if(rows.empty())fail("deal not found");print_rows(rows,json);
    }else if(args[0]=="move"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.size()<2)fail("deal move requires DEAL_ID STAGE");auto id=parse_i64(p[0],"deal id");Statement d(db.raw(),"SELECT pipeline_id,status FROM deals WHERE id=?");d.bind(1,id);if(!d.row())fail("deal not found");if(d.text(1)!="open")fail("closed deal cannot move to an open stage");Stage st=resolve_stage(db,d.i64(0),p[1],"open");Statement u(db.raw(),"UPDATE deals SET stage_id=?,probability=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'");u.bind(1,st.id);u.bind(2,static_cast<std::int64_t>(st.probability));u.bind(3,id);u.done();activity(db,"deal",id,"stage_changed","Deal moved to "+st.name);if(json)std::cout<<"{\"ok\":true,\"deal_id\":"<<id<<",\"stage\":"<<json_escape(st.name)<<",\"probability\":"<<st.probability<<"}\n";else std::cout<<"deal moved: "<<id<<" -> "<<st.name<<"\n";
    }else if(args[0]=="win"||args[0]=="lost"){
        bool won=args[0]=="win";auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.empty())fail(std::string("deal ")+(won?"win":"lost")+" requires an ID");auto id=parse_i64(p[0],"deal id");Statement d(db.raw(),"SELECT pipeline_id,status FROM deals WHERE id=?");d.bind(1,id);if(!d.row())fail("deal not found");if(d.text(1)!="open")fail("deal is already closed");Stage st=terminal_stage(db,d.i64(0),won?"won":"lost");std::string reason=won?"":trim(required_opt(args,"--reason"));if(!won){validate_nonempty(reason,"reason");validate_length(reason,"reason",1024);}Statement u(db.raw(),"UPDATE deals SET stage_id=?,probability=?,status=?,lost_reason=?,closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'");u.bind(1,st.id);u.bind(2,static_cast<std::int64_t>(st.probability));u.bind(3,won?"won":"lost");u.bind(4,reason);u.bind(5,id);u.done();activity(db,"deal",id,won?"won":"lost",won?"Deal won":"Deal lost: "+reason);if(json)std::cout<<"{\"ok\":true,\"deal_id\":"<<id<<",\"status\":\""<<(won?"won":"lost")<<"\"}\n";else std::cout<<"deal "<<(won?"won: ":"lost: ")<<id<<"\n";
    }else fail("unknown deal subcommand");
}

void command_task(Db&db,const std::vector<std::string>&args,bool json){
    if(args.empty())fail("task requires add, list, done, or cancel");
    if(args[0]=="add"){
        std::string type=lower(required_opt(args,"--entity"));auto eid=parse_i64(required_opt(args,"--id"),"entity id");if(!entity_exists(db,type,eid))fail("target entity not found");std::string subject=trim(required_opt(args,"--subject"));validate_nonempty(subject,"subject");validate_length(subject,"subject");std::string due=trim(opt(args,"--due"));validate_date(due,true);std::string owner=trim(opt(args,"--owner"));std::string priority=lower(opt(args,"--priority","medium"));validate_priority(priority);std::string task_type=trim(opt(args,"--type","follow_up"));validate_nonempty(task_type,"task type");validate_length(task_type,"task type",64);Statement s(db.raw(),"INSERT INTO tasks(entity_type,entity_id,task_type,subject,due_date,owner,priority) VALUES(?,?,?,?,?,?,?)");s.bind(1,type);s.bind(2,eid);s.bind(3,task_type);s.bind(4,subject);s.bind(5,due);s.bind(6,owner);s.bind(7,priority);s.done();auto tid=last_id(db);activity(db,type,eid,"task_created","Task "+std::to_string(tid)+" created: "+subject);print_one_id("task",tid,json);
    }else if(args[0]=="list"){
        std::string sql="SELECT id,entity_type,entity_id,task_type,subject,due_date,owner,priority,status,created_at,completed_at FROM tasks WHERE 1=1";std::vector<std::string>params;if(auto s=option(args,"--status")){sql+=" AND status=?";params.push_back(*s);}if(auto o=option(args,"--owner")){sql+=" AND owner=?";params.push_back(*o);}if(auto e=option(args,"--entity")){sql+=" AND entity_type=?";params.push_back(*e);}if(auto i=option(args,"--id")){sql+=" AND entity_id=?";params.push_back(*i);}sql+=" ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,CASE WHEN due_date='' THEN '9999-12-31' ELSE due_date END,id";print_rows(query(db,sql,params),json);
    }else if(args[0]=="done"||args[0]=="cancel"){
        auto p=positionals(std::vector<std::string>(args.begin()+1,args.end()));if(p.size()!=1)fail("task state change requires an ID");auto id=parse_i64(p[0],"task id");std::string state=args[0]=="done"?"done":"cancelled";Statement q(db.raw(),"SELECT entity_type,entity_id,subject FROM tasks WHERE id=? AND status='open'");q.bind(1,id);if(!q.row())fail("open task not found");std::string et=q.text(0),subject=q.text(2);auto eid=q.i64(1);Statement u(db.raw(),"UPDATE tasks SET status=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'");u.bind(1,state);u.bind(2,id);u.done();activity(db,et,eid,state=="done"?"task_done":"task_cancelled","Task "+std::to_string(id)+" "+state+": "+subject);if(json)std::cout<<"{\"ok\":true,\"task_id\":"<<id<<",\"status\":"<<json_escape(state)<<"}\n";else std::cout<<"task "<<state<<": "<<id<<"\n";
    }else fail("unknown task subcommand");
}

void command_note(Db&db,const std::vector<std::string>&args,bool json){
    if(args.empty()) fail("note requires add or list");
    if(args[0]=="add"){std::string type=lower(required_opt(args,"--entity"));auto eid=parse_i64(required_opt(args,"--id"),"entity id");if(!entity_exists(db,type,eid))fail("target entity not found");std::string body=required_opt(args,"--body");validate_nonempty(body,"body");validate_length(body,"body",kMaxText);std::string author=trim(opt(args,"--author",actor_from_db(db)));Statement s(db.raw(),"INSERT INTO notes(entity_type,entity_id,body,author) VALUES(?,?,?,?)");s.bind(1,type);s.bind(2,eid);s.bind(3,body);s.bind(4,author);s.done();auto nid=last_id(db);activity(db,type,eid,"note_added","Note "+std::to_string(nid)+" added");print_one_id("note",nid,json);}else if(args[0]=="list"){std::string type=lower(required_opt(args,"--entity"));auto eid=required_opt(args,"--id");print_rows(query(db,"SELECT id,entity_type,entity_id,author,body,created_at FROM notes WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC,id DESC",{type,eid}),json);}else fail("unknown note subcommand");
}

void command_field(Db&db,const std::vector<std::string>&args,bool json){
    if(args.empty()) fail("field requires set or list");
    std::string type=lower(required_opt(args,"--entity"));auto eid=parse_i64(required_opt(args,"--id"),"entity id");if(!entity_exists(db,type,eid))fail("target entity not found");if(args[0]=="set"){std::string key=required_opt(args,"--key"),value=required_opt(args,"--value");
        if(key.empty() || key.size()>64 || !std::isalpha(static_cast<unsigned char>(key[0]))) fail("custom field key must be alphanumeric/underscore and start with a letter");
        for(unsigned char c:key){if(!std::isalnum(c)&&c!='_')fail("custom field key must be alphanumeric/underscore and start with a letter");}
        validate_length(value,"custom field value",kMaxText);Statement s(db.raw(),"INSERT INTO custom_values(entity_type,entity_id,field_key,field_value) VALUES(?,?,?,?) ON CONFLICT(entity_type,entity_id,field_key) DO UPDATE SET field_value=excluded.field_value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");s.bind(1,type);s.bind(2,eid);s.bind(3,key);s.bind(4,value);s.done();activity(db,type,eid,"custom_field_set","Custom field "+key+" updated");if(json)std::cout<<"{\"ok\":true,\"entity\":"<<json_escape(type)<<",\"id\":"<<eid<<",\"key\":"<<json_escape(key)<<"}\n";else std::cout<<"custom field set: "<<key<<"\n";}else if(args[0]=="list")print_rows(query(db,"SELECT field_key,field_value,updated_at FROM custom_values WHERE entity_type=? AND entity_id=? ORDER BY field_key",{type,std::to_string(eid)}),json);else fail("unknown field subcommand");
}

void command_search(Db&db,const std::vector<std::string>&args,bool json){auto p=positionals(args);if(p.empty())fail("search requires a term");std::ostringstream term;for(std::size_t i=0;i<p.size();++i){if(i)term<<' ';term<<p[i];}std::string fq=fts_query(term.str());print_rows(query(db,"SELECT entity_type,entity_id,snippet(crm_fts,2,'[',']',' ... ',18) AS match,bm25(crm_fts) AS rank FROM crm_fts WHERE crm_fts MATCH ? ORDER BY rank,entity_type,entity_id LIMIT 100",{fq}),json);}

void command_dedupe(Db&db,bool json){
    std::string sql=R"SQL(
SELECT 'contact_phone' AS kind,phone_norm AS key,group_concat(id,',') AS record_ids,count(*) AS count
FROM contacts WHERE phone_norm<>'' GROUP BY phone_norm HAVING count(*)>1
UNION ALL
SELECT 'lead_matches_contact_email',l.email_norm,CAST(l.id AS TEXT)||':'||group_concat(c.id,','),count(c.id)
FROM leads l JOIN contacts c ON c.email_norm=l.email_norm WHERE l.email_norm<>'' AND l.status IN ('new','qualified') GROUP BY l.id,l.email_norm
UNION ALL
SELECT 'account_name',lower(trim(name)),group_concat(id,','),count(*) FROM accounts GROUP BY lower(trim(name)) HAVING count(*)>1
ORDER BY kind,key
)SQL";print_rows(query(db,sql),json);
}

void command_dashboard(Db&db,bool json){
    auto counts=query(db,R"SQL(
SELECT
 (SELECT count(*) FROM accounts WHERE status='active') AS active_accounts,
 (SELECT count(*) FROM contacts WHERE status='active') AS active_contacts,
 (SELECT count(*) FROM leads WHERE status IN ('new','qualified')) AS open_leads,
 (SELECT count(*) FROM deals WHERE status='open') AS open_deals,
 (SELECT count(*) FROM tasks WHERE status='open') AS open_tasks,
 (SELECT count(*) FROM tasks WHERE status='open' AND due_date<>'' AND due_date<date('now')) AS overdue_tasks,
 (SELECT count(*) FROM deals WHERE status='won' AND julianday(closed_at)>=julianday('now','-30 day')) AS won_30d,
 (SELECT count(*) FROM deals WHERE status='lost' AND julianday(closed_at)>=julianday('now','-30 day')) AS lost_30d
)SQL");
    auto money=query(db,"SELECT currency,COUNT(*) AS open_deals,SUM(amount_minor) AS pipeline_minor,SUM((amount_minor*probability)/100) AS weighted_minor FROM deals WHERE status='open' GROUP BY currency ORDER BY currency");
    if(json){
        auto emit=[&](const std::vector<Row>& rows){
            std::cout << '[';
            for(std::size_t r=0;r<rows.size();++r){
                if(r) std::cout << ',';
                std::cout << '{';
                for(std::size_t c=0;c<rows[r].names.size();++c){
                    if(c) std::cout << ',';
                    std::cout << json_escape(rows[r].names[c]) << ':';
                    if(rows[r].values[c]) std::cout << json_escape(*rows[r].values[c]); else std::cout << "null";
                }
                std::cout << '}';
            }
            std::cout << ']';
        };
        std::cout << "{\"counts\":";
        emit(counts);
        std::cout << ",\"pipeline_by_currency\":";
        emit(money);
        std::cout << "}\n";
    }else{std::cout<<"CRM COUNTS\n";print_rows(counts,false);std::cout<<"\nPIPELINE BY CURRENCY\n";print_rows(money,false);}
}

void command_forecast(Db&db,bool json){print_rows(query(db,R"SQL(
SELECT currency,
 CASE WHEN expected_close='' THEN 'unscheduled' ELSE substr(expected_close,1,7) END AS close_month,
 COUNT(*) AS deals,
 SUM(amount_minor) AS pipeline_minor,
 SUM((amount_minor*probability)/100) AS weighted_minor
FROM deals WHERE status='open'
GROUP BY currency,close_month
ORDER BY currency,CASE WHEN close_month='unscheduled' THEN '9999-99' ELSE close_month END
)SQL"),json);}

void command_timeline(Db&db,const std::vector<std::string>&args,bool json){std::string type=lower(required_opt(args,"--entity"));auto id=parse_i64(required_opt(args,"--id"),"entity id");if(!entity_exists(db,type,id))fail("target entity not found");print_rows(query(db,R"SQL(
SELECT created_at,'activity' AS source,event_type AS event,summary,actor FROM activities WHERE entity_type=? AND entity_id=?
UNION ALL SELECT created_at,'note','note',body,author FROM notes WHERE entity_type=? AND entity_id=?
UNION ALL SELECT created_at,'task','task:'||status,subject,owner FROM tasks WHERE entity_type=? AND entity_id=?
ORDER BY created_at DESC
)SQL",{type,std::to_string(id),type,std::to_string(id),type,std::to_string(id)}),json);}

void command_audit(Db&db,const std::vector<std::string>&args,bool json){std::string type=lower(required_opt(args,"--entity"));auto id=required_opt(args,"--id");print_rows(query(db,"SELECT id,entity_type,entity_id,action,actor,before_json,after_json,created_at FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC,id DESC",{type,id}),json);}

std::string csv_escape(const std::string& v){bool quote=v.find_first_of(",\"\r\n")!=std::string::npos;if(!quote)return v;std::string out="\"";for(char c:v){if(c=='\"')out+="\"\"";else out+=c;}out+='\"';return out;}

void command_export_csv(Db&db,const std::vector<std::string>&args){std::string entity=lower(required_opt(args,"--entity"));std::string outpath=required_opt(args,"--out");std::string sql;if(entity=="accounts")sql="SELECT id,name,domain,website,industry,city,country,owner,status,created_at,updated_at FROM accounts ORDER BY id";else if(entity=="contacts")sql="SELECT id,account_id,first_name,last_name,email,phone,title,owner,status,created_at,updated_at FROM contacts ORDER BY id";else if(entity=="leads")sql="SELECT id,relay_ticket_id,name,email,phone,company,source,message,metadata_json,score,priority,owner,status,created_at,converted_at FROM leads ORDER BY id";else if(entity=="deals")sql="SELECT id,account_id,primary_contact_id,source_lead_id,pipeline_id,stage_id,name,amount_minor,currency,probability,expected_close,owner,status,lost_reason,created_at,closed_at FROM deals ORDER BY id";else if(entity=="tasks")sql="SELECT id,entity_type,entity_id,task_type,subject,due_date,owner,priority,status,created_at,completed_at FROM tasks ORDER BY id";else fail("export entity must be accounts, contacts, leads, deals, or tasks");auto rows=query(db,sql);std::ofstream out(outpath,std::ios::binary|std::ios::trunc);if(!out)fail("cannot open export output");if(rows.empty()){out<<"\n";}else{for(std::size_t i=0;i<rows[0].names.size();++i){if(i)out<<',';out<<csv_escape(rows[0].names[i]);}out<<'\n';for(auto&r:rows){for(std::size_t i=0;i<r.values.size();++i){if(i)out<<',';out<<csv_escape(r.values[i] ? *r.values[i] : std::string());}out<<'\n';}}out.close();if(!out)fail("failed writing export file");std::cout<<"exported "<<rows.size()<<" records to "<<outpath<<"\n";}

void write_json_rows(std::ostream&out,const std::vector<Row>&rows){out<<'[';for(std::size_t r=0;r<rows.size();++r){if(r)out<<',';out<<'{';for(std::size_t c=0;c<rows[r].names.size();++c){if(c)out<<',';out<<json_escape(rows[r].names[c])<<':';if(rows[r].values[c])out<<json_escape(*rows[r].values[c]);else out<<"null";}out<<'}';}out<<']';}

void command_export_json(Db&db,const std::vector<std::string>&args){std::string outpath=required_opt(args,"--out");std::ofstream out(outpath,std::ios::binary|std::ios::trunc);if(!out)fail("cannot open export output");out<<"{\"format\":\"clientops-crm-export-v1\",\"schema_version\":"<<json_escape(kSchemaVersion)<<",\"accounts\":";write_json_rows(out,query(db,"SELECT * FROM accounts ORDER BY id"));out<<",\"contacts\":";write_json_rows(out,query(db,"SELECT * FROM contacts ORDER BY id"));out<<",\"leads\":";write_json_rows(out,query(db,"SELECT * FROM leads ORDER BY id"));out<<",\"pipelines\":";write_json_rows(out,query(db,"SELECT * FROM pipelines ORDER BY id"));out<<",\"stages\":";write_json_rows(out,query(db,"SELECT * FROM stages ORDER BY pipeline_id,position"));out<<",\"deals\":";write_json_rows(out,query(db,"SELECT * FROM deals ORDER BY id"));out<<",\"tasks\":";write_json_rows(out,query(db,"SELECT * FROM tasks ORDER BY id"));out<<",\"notes\":";write_json_rows(out,query(db,"SELECT * FROM notes ORDER BY id"));out<<",\"custom_values\":";write_json_rows(out,query(db,"SELECT * FROM custom_values ORDER BY id"));out<<",\"activities\":";write_json_rows(out,query(db,"SELECT * FROM activities ORDER BY id"));out<<",\"audit_log\":";write_json_rows(out,query(db,"SELECT * FROM audit_log ORDER BY id"));out<<"}\n";out.close();if(!out)fail("failed writing JSON export");std::cout<<"JSON export written: "<<outpath<<"\n";}

void command_doctor(Db&db,bool json){require_schema(db);auto integ=query(db,"PRAGMA integrity_check");if(integ.size()!=1||!integ[0].values[0]||*integ[0].values[0]!="ok")fail("SQLite integrity_check failed");auto fk=query(db,"PRAGMA foreign_key_check");if(!fk.empty())fail("foreign key violations detected");auto stages=query(db,"SELECT p.id,p.name,SUM(CASE WHEN s.kind='open' THEN 1 ELSE 0 END) AS open_stages,SUM(CASE WHEN s.kind='won' THEN 1 ELSE 0 END) AS won_stages,SUM(CASE WHEN s.kind='lost' THEN 1 ELSE 0 END) AS lost_stages FROM pipelines p LEFT JOIN stages s ON s.pipeline_id=p.id GROUP BY p.id HAVING open_stages<1 OR won_stages<>1 OR lost_stages<>1");if(!stages.empty())fail("pipeline terminal-stage invariant failed");auto mismatches=query(db,"SELECT d.id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE (d.status='open' AND s.kind<>'open') OR (d.status='won' AND s.kind<>'won') OR (d.status='lost' AND s.kind<>'lost') LIMIT 1");if(!mismatches.empty())fail("deal status/stage invariant failed");auto leadlinks=query(db,"SELECT id FROM leads WHERE status='converted' AND (converted_contact_id IS NULL OR converted_deal_id IS NULL) LIMIT 1");if(!leadlinks.empty())fail("converted lead invariant failed");
    auto orphans=query(db,R"SQL(
SELECT 'task' AS kind,t.id FROM tasks t WHERE NOT (
 (t.entity_type='account' AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=t.entity_id)) OR
 (t.entity_type='contact' AND EXISTS(SELECT 1 FROM contacts c WHERE c.id=t.entity_id)) OR
 (t.entity_type='lead' AND EXISTS(SELECT 1 FROM leads l WHERE l.id=t.entity_id)) OR
 (t.entity_type='deal' AND EXISTS(SELECT 1 FROM deals d WHERE d.id=t.entity_id)))
UNION ALL
SELECT 'note',n.id FROM notes n WHERE NOT (
 (n.entity_type='account' AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=n.entity_id)) OR
 (n.entity_type='contact' AND EXISTS(SELECT 1 FROM contacts c WHERE c.id=n.entity_id)) OR
 (n.entity_type='lead' AND EXISTS(SELECT 1 FROM leads l WHERE l.id=n.entity_id)) OR
 (n.entity_type='deal' AND EXISTS(SELECT 1 FROM deals d WHERE d.id=n.entity_id)))
UNION ALL
SELECT 'custom',v.id FROM custom_values v WHERE NOT (
 (v.entity_type='account' AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=v.entity_id)) OR
 (v.entity_type='contact' AND EXISTS(SELECT 1 FROM contacts c WHERE c.id=v.entity_id)) OR
 (v.entity_type='lead' AND EXISTS(SELECT 1 FROM leads l WHERE l.id=v.entity_id)) OR
 (v.entity_type='deal' AND EXISTS(SELECT 1 FROM deals d WHERE d.id=v.entity_id)))
LIMIT 1
)SQL");if(!orphans.empty())fail("polymorphic entity orphan invariant failed");
    auto auditguards=query(db,"SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('audit_immutable_bu','audit_immutable_bd') ORDER BY name");if(auditguards.size()!=2)fail("audit append-only guards are missing");
    if(json)std::cout<<"{\"ok\":true,\"schema_version\":\""<<kSchemaVersion<<"\",\"integrity\":\"ok\",\"foreign_keys\":\"ok\",\"business_invariants\":\"ok\"}\n";else std::cout<<"doctor: PASS\nschema: "<<kSchemaVersion<<"\nintegrity: PASS\nforeign keys: PASS\nbusiness invariants: PASS\n";}

void print_help(){
std::cout<<R"HELP(ClientOpsCRM 2.0.0 - compiled CRM CLI

Usage:
  clientops-crm [--db FILE] [--actor NAME] [--json] COMMAND ...

Core:
  init
  doctor
  dashboard
  forecast
  search TERM...
  dedupe
  timeline --entity account|contact|lead|deal --id ID
  audit --entity TYPE --id ID

Accounts:
  account add --name NAME [--domain D] [--website U] [--industry I] [--city C] [--country C] [--owner O]
  account list [--status active|inactive] [--owner O]
  account show ID
  account update ID [field options]

Contacts:
  contact add [--first F] [--last L] [--email E] [--phone P] [--account ID] [--title T] [--owner O]
  contact list [--account ID] [--owner O]
  contact show ID
  contact update ID [field options]

Leads:
  lead add --name N [--email E] [--phone P] [--company C] [--source S] [--message M] [--metadata-json JSON] [--score 0..100] [--priority P] [--owner O] [--relay-ticket UUID]
  lead list [--status STATE] [--owner O]
  lead show ID
  lead qualify ID
  lead disqualify ID --reason TEXT
  lead convert ID [--account ID] [--deal-name N] [--amount DECIMAL] [--currency ISO] [--pipeline ID] [--stage NAME|ID] [--close YYYY-MM-DD] [--owner O]
  lead import-csv --in FILE|- [--skip-existing] 

Pipelines and deals:
  pipeline list
  pipeline add --name NAME
  pipeline stage-add --pipeline ID --name NAME --position N --probability 0..100 [--kind open|won|lost]
  deal add --name N [--account ID] [--contact ID] [--amount DECIMAL] [--currency ISO] [--pipeline ID] [--stage NAME|ID] [--close YYYY-MM-DD] [--owner O]
  deal list [--status open|won|lost] [--owner O] [--pipeline ID]
  deal show ID
  deal move ID STAGE
  deal win ID
  deal lost ID --reason TEXT

Work tracking:
  task add --entity TYPE --id ID --subject TEXT [--type T] [--due YYYY-MM-DD] [--priority P] [--owner O]
  task list [--status STATE] [--owner O] [--entity TYPE] [--id ID]
  task done ID
  task cancel ID
  note add --entity TYPE --id ID --body TEXT [--author NAME]
  note list --entity TYPE --id ID
  field set --entity TYPE --id ID --key KEY --value VALUE
  field list --entity TYPE --id ID

Export:
  export-json --out FILE
  export-csv --entity accounts|contacts|leads|deals|tasks --out FILE

Money is stored as integer minor units; CLI --amount accepts a decimal with at most two fractional digits.
)HELP";
}

} // namespace

int main(int argc,char**argv){
    try{
        std::vector<std::string> all;for(int i=1;i<argc;++i)all.emplace_back(argv[i]);
        if(all.empty()||all[0]=="help"||all[0]=="--help"||all[0]=="-h"){print_help();return 0;}
        if(all[0]=="version"||all[0]=="--version"){std::cout<<"ClientOpsCRM "<<kVersion<<"\n";return 0;}
        std::string dbpath="clientops-crm.db";std::string actor;bool json=false;std::size_t idx=0;
        while(idx<all.size()&&all[idx].rfind("--",0)==0){
            if(all[idx]=="--json"){json=true;++idx;continue;}
            if(all[idx]=="--db"||all[idx]=="--actor"){if(idx+1>=all.size())fail(all[idx]+" requires a value");if(all[idx]=="--db")dbpath=all[idx+1];else actor=all[idx+1];idx+=2;continue;}
            if(all[idx].rfind("--db=",0)==0){dbpath=all[idx].substr(5);++idx;continue;}
            if(all[idx].rfind("--actor=",0)==0){actor=all[idx].substr(8);++idx;continue;}
            break;
        }
        if(idx>=all.size()) fail("missing command");
        std::string cmd=all[idx++];
        std::vector<std::string> args(all.begin()+static_cast<std::ptrdiff_t>(idx),all.end());
        if(cmd=="version"||cmd=="--version"){std::cout<<"ClientOpsCRM "<<kVersion<<"\n";return 0;}
        if(cmd=="help"||cmd=="--help"||cmd=="-h"){print_help();return 0;}
        Db db(dbpath);
        if(cmd=="init"){command_init(db,json);return 0;}
        require_schema(db);
        if(actor.empty()){const char* env=std::getenv("CLIENTOPS_CRM_ACTOR");actor=env&&*env?env:"local-operator";}set_actor(db,actor);
        if(cmd=="account")command_account(db,args,json);
        else if(cmd=="contact")command_contact(db,args,json);
        else if(cmd=="lead")command_lead(db,args,json);
        else if(cmd=="pipeline")command_pipeline(db,args,json);
        else if(cmd=="deal")command_deal(db,args,json);
        else if(cmd=="task")command_task(db,args,json);
        else if(cmd=="note")command_note(db,args,json);
        else if(cmd=="field")command_field(db,args,json);
        else if(cmd=="search")command_search(db,args,json);
        else if(cmd=="dedupe")command_dedupe(db,json);
        else if(cmd=="dashboard")command_dashboard(db,json);
        else if(cmd=="forecast")command_forecast(db,json);
        else if(cmd=="timeline")command_timeline(db,args,json);
        else if(cmd=="audit")command_audit(db,args,json);
        else if(cmd=="export-json")command_export_json(db,args);
        else if(cmd=="export-csv")command_export_csv(db,args);
        else if(cmd=="doctor")command_doctor(db,json);
        else fail("unknown command: "+cmd);
        return 0;
    }catch(const std::exception&e){std::cerr<<"clientops-crm: "<<e.what()<<"\n";return 2;}
}
