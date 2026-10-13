---
name: factory-retrofit
description: >
  Bring a repository up to the factory checklist: agent notes (CLAUDE.md with
  Status, Decisions, Commands), one scripts/validate gate, git hooks, CI that
  runs the gate, a PR template, automated deploys with a health check, and the
  factory doctor in CI. Use when the owner asks to set up, retrofit, audit or
  "factory" a repo, asks what a repo is missing, or starts a new project from
  an existing one. Also use to update a repo's vendored doctor.
---

# Factory retrofit

Paths below are relative to this skill's base directory.

- Doctor: `../../doctor/doctor.mjs`
- Shared templates: `../../templates/shared/`
- Per-stack commands, CI setup and deploy jobs: [references/stacks.md](references/stacks.md)

## 1. Measure

```bash
node <base>/../../doctor/doctor.mjs <repo>          # readable report
node <base>/../../doctor/doctor.mjs <repo> --json   # for planning
```

The report lists each gap with a fix and the detected stack. If the repo
already vendors `scripts/factory-doctor.mjs`, compare its `DOCTOR_VERSION`
with the plugin's and update the copy when it's older.

## 2. Learn the repo before writing anything

Read the README, any existing CLAUDE.md/AGENTS.md, plans and docs, the
package.json scripts or Makefile, every CI workflow, and `git log --oneline -30`.
The commands you put in `scripts/validate` and CLAUDE.md must be ones this repo
already runs. Do not invent commands.

## 3. Plan the PRs and show the owner

Group the gaps into at most three small PRs, in this order, and show the
owner the doctor report and the plan before starting:

1. **Notes:** CLAUDE.md from `templates/shared/CLAUDE.md`, merged into any
   existing notes (keep everything still true, and keep tool-generated blocks
   such as Next.js's `BEGIN:nextjs-agent-rules`, because the tool re-adds them),
   plus the PR template.
2. **One gate:** `scripts/validate` filled in for the stack, `.githooks/` and
   `scripts/setup-hooks`, the doctor copied to `scripts/factory-doctor.mjs`,
   and CI calling `scripts/validate`.
3. **Deploy:** the stack's deploy job with a health check, from
   [references/stacks.md](references/stacks.md). List every secret the owner
   must add, where in GitHub, and where to get each value.

## 4. Rules while doing it

- **Status only claims what was verified where users run it.** "Built but
  not tried on a device or preview" goes under Next or Waiting on the owner,
  never under Done.
- **Never invent Decisions.** Write the ones the code makes obvious (hosting,
  auth provider, database) as `(inferred from code, confirm)` and ask the
  owner to confirm or correct them.
- **Extend CI; don't replace it.** Keep existing jobs and checks. Move their
  commands into `scripts/validate` only when the same runner can run them;
  otherwise keep the job and add the validate step beside it.
- **Never weaken a check** (skipped tests, lowered thresholds, `|| true`) to
  get the doctor or CI green.
- **Run `scripts/validate` before every commit.** When a step cannot run in
  this environment (for example `xcodebuild` on Linux), guard it the way
  references/stacks.md shows and tell the owner which steps you could not run.
- **No secrets in the repo.** Secrets go in GitHub → Settings → Secrets and
  variables → Actions, or the platform's dashboard.
- **Skipping a check needs a reason** in `.factory.json`, for example
  `{ "skip": { "deploy": "Local MCP server; nothing to deploy" } }`. Ask the
  owner before skipping `deploy`.
- One branch and PR per group. Never push to `main`.

## 5. Finish

Run the doctor again and put the before and after summary lines in each PR
description. Then run the `handoff` skill so Status records what changed and
what the owner still has to do, such as adding secrets or confirming
Decisions.
