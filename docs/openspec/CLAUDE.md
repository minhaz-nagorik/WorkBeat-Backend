# openspec/ — writing a requirement

`docs/` explains. **This directory specifies.** A doc never states a normative requirement; a spec
never explains why.

## Format that fails validation if you get it wrong

```markdown
### Requirement: <name>
<!-- source: D43 · B4 · Plan-v3.2 §5.3 -->
The API SHALL ...

#### Scenario: <name>
- **WHEN** <condition>
- **THEN** <expected outcome>
- **AND** <expected outcome>
```

- **SHALL or MUST** in every requirement. Never "should", never "may".
- **Exactly four hashtags** on `#### Scenario:`. Three parse as something else and the requirement
  validates with no scenario — silently.
- **At least one scenario** per requirement.
- **Under 500 characters** per requirement statement. Split rather than run over.
- **`## Purpose`** (≥50 chars) on a new-capability delta only.
- **`## Why`** 50–1000 chars in a proposal.
- **≤10 deltas** per change.

## What a spec here describes

**Observable behaviour of the API**: the route, who may call it, the status and `code` it returns,
the fields it returns, the rows it writes, the email it sends, and what it never does. Use the
schema's table and column names and the codes in
[agent-contract.md](../core/api/agent-contract.md).

The agents, the Downloader and the web platform are consumers. Never specify their behaviour; cite
their spec where a requirement exists because they rely on it.

## Sources

Cite **D-numbers** (Plan v3.2 Appendix A), **B-numbers**
([backend-decisions.md](../decisions/backend-decisions.md)), `Plan-v3.2 §n`, then
`PRD "<section>"`.

## Commands

```bash
cd docs                              # the CLI resolves openspec/ from here
openspec list --changes
openspec show <change-id>
openspec validate --all --strict
```

`openspec/specs/` is empty by design. Every capability is an `ADDED` delta inside a change;
`openspec archive` promotes it when the change ships.
