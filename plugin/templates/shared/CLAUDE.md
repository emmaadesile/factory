# {{project}}: notes for Claude

{{One or two sentences: what this is, who it is for, and where it runs.}}

Read {{the plan or spec, e.g. docs/PLAN.md}} before starting work.

## Status ({{YYYY-MM-DD}})

<!-- The handoff skill rewrites this section at the end of every session.
Keep it under ~25 lines; git log is the history. -->

Done: {{what works today, verified where it runs (device, preview, server)}}.

Next, in order:

1. {{next task}}
2. {{the one after}}

Waiting on the owner: {{things only the owner can do, with the exact command
or screen. "None" when empty.}}

Known broken: {{anything that fails today. "Nothing known" when empty.}}

## Decisions (don't change without asking)

<!-- Choices the owner made. An agent must ask before changing one. Add the
date and the reason, so nobody has to guess later. -->

- **{{Topic}}:** {{choice}} ({{YYYY-MM-DD}}, {{why}}).

## Working rules

- Work on a branch from `main` and open a PR. Never push to `main`.
- A change is done when `scripts/validate` passes and it has run where users
  will run it (device, preview URL or server), not when the code compiles.
- Keep PRs small: one slice of behaviour per PR. Split anything that touches
  auth, payments or the database schema from everything else.
- Tests must be able to fail. After writing one, break the code on purpose and
  check the test catches it.

## Commands

```bash
scripts/validate          # every check; CI runs the same script
scripts/validate --fast   # the quick subset the pre-commit hook runs
{{dev server command}}
{{deploy command, if there is a manual one}}
```

## Deploy

{{Where it runs, how a merge to main gets there, the health check URL, and
which secrets live where. "Not deployed" with the reason, if so.}}

## Gotchas

<!-- Things that cost a session time. Add one whenever it happens. -->

- {{gotcha}}
