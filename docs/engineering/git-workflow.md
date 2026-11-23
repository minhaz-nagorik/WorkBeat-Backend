# Git workflow

## Branches

| Branch | Holds | Who pushes |
|---|---|---|
| `main` | Reviewed work. Deploys to staging; a tag on it deploys to production | Merge only, through a PR |
| `dev-<name>` (today: `dev-minhaz`) | One developer's integration branch | Its owner |
| `feat/<change-id>-<topic>`, `fix/<topic>`, `spec/<change-id>` | One piece of work, cut from `main` or your `dev-` branch | Its author |

Keep feature branches short. A PR targets `main` and is squash-merged, so the PR title becomes
the commit subject.

## Spec first

Every behaviour change starts in `docs/openspec/changes/` (rule 10).

```
OpenSpec change ──► review ──► code + tests ──► ship ──► archive
 (spec/ PR)        (merge)     (feat/ PRs)     (tag)    (spec/ PR)
```

1. **Write the change.** New capability: a new change folder with `proposal.md`, `tasks.md` and
   `specs/<capability>/spec.md`. Changing an existing one: a delta in the owning change (see
   [BUILD-ORDER.md](../BUILD-ORDER.md); no two changes specify the same behaviour).
2. **Validate.** `cd docs && openspec validate --all --strict`.
3. **Review the spec PR** before code. If it touches the agent contract, the agent owners review
   too, and both agent repositories get the matching change (rule 5).
4. **Code.** Implement tasks in order; tick them in `tasks.md` in the same PR.
5. **Archive** once every task is done and the change has shipped in a tagged release:
   `cd docs && openspec archive <change-id>`, in a `spec/` PR of its own.

Where a spec is silent, record a B-number in
[backend-decisions.md](../decisions/backend-decisions.md) or a question in
[open-questions.md](../decisions/open-questions.md). Never decide it only in code.

## Commit messages

Conventional Commits, scoped to the capability:

```
feat(device-enrollment): reuse the device row on reinstall
fix(activity-ingestion): count records outside the B7 window
spec(run-scheduled-jobs): add the token-expiry schedule
db(0003): add companies.example column
chore(ci): run self-checks on PostgreSQL 15
```

Reference the tasks in the body: `Implements enroll-devices 2.2, 2.3`.

## PR checklist

Copy into the PR description and tick each line.

- [ ] `cd docs && openspec validate --all --strict` passes
- [ ] Behaviour matches a spec scenario; new behaviour has a spec change merged first
- [ ] Each new scenario has a test named after it
- [ ] Migrations are new numbered files, forward-only, each with a passing `db/tests/` self-check
- [ ] No applied migration was edited
- [ ] No secret, token, key, JWT, signed URL, URL, window title or body in any log line
- [ ] `company_id` comes from the credential; the tenant-isolation suite covers every new read route
- [ ] Every new route declares its roles in the permission matrix
- [ ] No route in `staff` scope reads a tenant table
- [ ] No in-process timer; scheduled work is a `/cron/*` route
- [ ] Agent contract unchanged, or the agent repositories have the matching change
- [ ] Constants in `packages/shared`, secrets in the environment, never the reverse

## Migration numbering

| Rule | Why |
|---|---|
| Four digits, next free number, snake-case name: `0003_<name>.sql` | Applied in number order |
| Self-check with the same prefix: `db/tests/0003_<name>_test.sql` | CI pairs them |
| **Never edit an applied migration**, including comments. Fix forward with a new file | The runner records applied files and refuses a changed one (`schema-migrations` task 6.3) |
| One migration per PR where possible | Two PRs racing for `0003` is resolved by renumbering the one that merges second, before merge |
| Wrap in `BEGIN; … COMMIT;` | A half-applied migration never exists |
| Destructive steps (drop column, tighten a constraint) go in a later migration than the code that stops using them | The previous API version keeps working during a rollout ([deployment.md](../operations/deployment.md#migration-rollout-order)) |

"Applied" means applied anywhere shared: CI's database does not count, staging and production do.
Until the first staging deploy, `0001` and `0002` are still treated as applied, so changes go into
`0003` onward.

## Tags and versions

`vMAJOR.MINOR.PATCH` on `main`. CI builds the container from the tag and deploys it to production
after the approval step ([deployment.md](../operations/deployment.md)).
