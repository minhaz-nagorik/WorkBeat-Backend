## Purpose

The collection notice every employee is shown and acknowledges: who edits its text, how its
version moves, and how it reaches the devices.

## ADDED Requirements

### Requirement: The company admin edits the notice
<!-- source: D25 · PRD "Privacy and legal requirements" · authenticate-users/role-access -->
`GET /v1/settings/notice` (`notice_text`, `notice_version`) and `PUT /v1/settings/notice` (`notice_text`) SHALL be accepted only from a `company_admin`; another role MUST get `403 FORBIDDEN`. An empty text, or one over the limit in `packages/shared`, MUST return `422 VALIDATION_FAILED`.

#### Scenario: An IT admin edits the notice
- **WHEN** an `it_admin` sends `PUT /v1/settings/notice`
- **THEN** the response is `403` with `code` `FORBIDDEN`

#### Scenario: An empty notice
- **WHEN** an admin sends an empty `notice_text`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and the notice is unchanged

#### Scenario: Only spaces
- **WHEN** an admin sends a `notice_text` of spaces and line breaks only
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Exactly the limit
- **WHEN** an admin sends a `notice_text` of exactly the limit
- **THEN** it is saved
- **AND** one character more gets `422` with `code` `VALIDATION_FAILED`

#### Scenario: A manager reads the notice
- **WHEN** a manager calls `GET /v1/settings/notice`
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: A changed text raises the notice and policy versions
<!-- source: D25 · B5 -->
A `PUT` whose `notice_text` differs from the stored text SHALL increase `companies.notice_version` by one and raise `companies.policy_version` in the same transaction. A `PUT` with the same text MUST change neither.

#### Scenario: The notice is reworded
- **WHEN** an admin saves a new text while `notice_version` is 3
- **THEN** `notice_version` is 4 and `companies.policy_version` rises

#### Scenario: Saved without a change
- **WHEN** an admin saves the current text again
- **THEN** `notice_version` and `policy_version` are unchanged

#### Scenario: Two admins save different texts at once
- **WHEN** two admins save two different texts concurrently while `notice_version` is 3
- **THEN** `notice_version` ends at 5, each saved text had its own version, and the stored text is the one saved last

### Requirement: The policy carries the current notice
<!-- source: D25 · agent-contract.md "Payload fields" -->
Every policy SHALL carry `collection_notice` as `{ "text": notice_text, "version": notice_version }` of the device's company. Acknowledgements are received on the heartbeat (`receive-device-health` `notice-acknowledgement`).

#### Scenario: A device fetches policy after a reword
- **WHEN** a device fetches policy after the notice moved to version 4
- **THEN** `collection_notice.version` is 4 and `text` is the new text

#### Scenario: Another company's notice
- **WHEN** two companies have different notice texts
- **THEN** each device's policy carries only its own company's text and version
