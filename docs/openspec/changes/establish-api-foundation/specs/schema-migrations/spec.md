## Purpose

How the database schema is created and changed, how each change is checked, and how operators
learn that the API can reach its database.

## ADDED Requirements

### Requirement: Migrations are numbered and forward-only
<!-- source: Plan-v3.5 §6.5 "db/migrations" · B1 -->
The schema SHALL be built only by the files in `db/migrations/`, applied in number order, each exactly once and inside a transaction. An applied migration MUST NOT be edited; a change MUST be a new file.

#### Scenario: A new column is needed
- **WHEN** a change needs a new column
- **THEN** it adds `db/migrations/0002_<name>.sql`
- **AND** `0001_init.sql` is unchanged

### Requirement: Every migration has a passing self-check
<!-- source: Plan-v3.5 §7 "1. Foundation" gate -->
Each migration SHALL have `db/tests/<number>_<name>_test.sql`, and CI MUST apply all migrations to an empty PostgreSQL 15 database and run every self-check, failing the build on any failure.

#### Scenario: A migration breaks tenant isolation
- **WHEN** a migration drops a row-level security policy
- **THEN** the self-check for tenant isolation fails and CI fails

### Requirement: The API reports its health
<!-- source: Plan-v3.5 §2.1 "Backend API" -->
`GET /health` SHALL return `200` when the API can run a query on the database and `503 SERVICE_UNAVAILABLE` when it cannot. It MUST need no credential and MUST return no tenant data.

#### Scenario: The database is unreachable
- **WHEN** the pooler refuses connections
- **THEN** `GET /health` returns `503`
