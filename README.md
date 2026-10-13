# factory

Run every project the same way. This repo holds:

- **A doctor** (`plugin/doctor/doctor.mjs`) that checks a repo against the
  checklist below and says how to fix each gap.
- **Shared templates** (`plugin/templates/shared/`) for the files every
  project needs.
- **A Claude Code plugin** with skills that apply the templates and keep
  projects on track:
  - `factory-retrofit` brings an existing repo up to the checklist in up to
    three small PRs.
  - `handoff` keeps each project's CLAUDE.md Status true between sessions.

## The checklist

| Check | Level | What passes |
| --- | --- | --- |
| Agent notes | error | CLAUDE.md or AGENTS.md written for this project, not only tool boilerplate or unfilled `{{placeholders}}` |
| Notes sections | error | `## Status`, `## Decisions` and `## Commands` |
| Status current | warn | Status has a date no more than 14 days before the last commit |
| Validate | error | One command runs every check: `scripts/validate`, `npm run validate` or `make validate` |
| Tests | error | At least one test file |
| CI | error | A workflow runs on push or pull request |
| CI runs validate | warn | CI calls the validate command, so local and CI agree |
| CI runs the doctor | warn | The doctor runs in CI, directly or from `scripts/validate` |
| Hooks | warn | A pre-commit hook |
| PR template | warn | `.github/pull_request_template.md` |
| Deploy | error | A workflow that deploys after merges (not one that only runs on pull requests), or a platform config (Vercel, EAS, Xcode Cloud, Fastlane) |
| Deploy verified | warn | The deploy job calls a health endpoint or runs a smoke test |
| No secrets | error | No committed `.env` files |

A repo can skip a check with a reason in `.factory.json`:

```json
{ "skip": { "deploy": "Runs locally over stdio; nothing to deploy" } }
```

## Use it

Install the plugin in Claude Code:

```
/plugin install factory --marketplace emmaadesile/factory
```

Then, in any repo, ask Claude to "retrofit this repo with the factory", or say
"where did we stop" or "wrap up" for the handoff skill.

Run the doctor by hand:

```bash
node plugin/doctor/doctor.mjs ../my-project            # readable report
node plugin/doctor/doctor.mjs ../my-project --json     # machine-readable
node plugin/doctor/doctor.mjs ../my-project --strict   # warnings fail too
```

Exit codes: 0 when no error-level check fails, 1 when one does (or a warning
with `--strict`), 2 when the directory or `.factory.json` can't be read. If a
repo has more than 20,000 files outside the ignored folders, the report says
the scan stopped early.

Repos vendor the doctor as `scripts/factory-doctor.mjs` (one file, no
dependencies), so CI runs it without network access to this repo.

## Develop

```bash
scripts/setup-hooks   # once: turns on the pre-commit hook
scripts/validate      # tests, mutation check, plugin validation, shell syntax, and the doctor on this repo
```
