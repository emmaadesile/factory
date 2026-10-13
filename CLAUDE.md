# factory: notes for Claude

The owner's project factory: a repo doctor, shared templates and a Claude Code
plugin (`factory-retrofit`, `handoff`) used across all their projects (iOS with
Convex, Expo, Next.js, Python services). README.md has the checklist.

## Status (2026-10-13)

Done: doctor with 13 checks and tests; shared templates (CLAUDE.md, validate,
hooks, CI, PR template); `factory-retrofit` and `handoff` skills; plugin and
marketplace manifests pass `claude plugin validate --strict`. The doctor has
been run against lift, coin-trader, Readout, candlewick, fb-seller and
tweet-to-speech; none were changed.

Next, in order:

1. Retrofit lift with `factory-retrofit` (notes, one gate, then Convex deploy
   and Xcode Cloud to TestFlight).
2. Retrofit coin-trader (CI and a deploy job with a health check).
3. Extract stack templates (`templates/ios-swift`, `templates/web-nextjs`,
   `templates/expo`, `templates/python-service`) from the retrofitted repos,
   and add a `factory-new` skill that scaffolds from them.

Waiting on the owner: install the plugin
(`/plugin install factory --marketplace emmaadesile/factory`) and try both
skills in one project.

Known broken: nothing known.

## Decisions (don't change without asking)

- **One repo, plugin inside it** (2026-10-13): the plugin directory holds the
  doctor and templates, so an installed plugin has everything it references.
- **Repos vendor the doctor** as `scripts/factory-doctor.mjs` (2026-10-13), so
  CI in private repos runs it without reading this repo.
- **The doctor stays one file with no dependencies** (2026-10-13), for the
  same reason.
- **Checks enforce; skills apply** (2026-10-13): a rule that can be checked
  goes in the doctor, not only in skill prose.

## Working rules

- Work on a branch from `main` and open a PR. Never push to `main`.
- Every doctor check needs a test that fails when the check breaks.
  `scripts/mutation-check.mjs` (part of `scripts/validate`) forces each check
  to always pass, then always fail, and fails if the suite stays green. Give
  each negative test a `status` assertion, not only a `detail` one.
- Fixed paths (`scripts/validate`, workflows, hooks, PR template) are checked
  directly, never through the file walk, which stops at 20,000 files.
- When a check changes, update the checklist table in README.md and the fix
  text the skills rely on.
- Before raising false-positive or false-negative rules, run the doctor
  against the owner's repos (lift, coin-trader, Readout, candlewick) and
  compare.

## Commands

```bash
scripts/validate                               # every check; CI runs this
node --test 'test/*.test.mjs'                  # doctor tests only
node scripts/mutation-check.mjs                # each check has a test that notices it breaking
node plugin/doctor/doctor.mjs <repo> [--json]  # run the doctor
claude plugin validate . --strict              # marketplace manifest
claude plugin validate plugin --strict         # plugin manifest and skills
```

## Deploy

Not deployed. Claude Code installs the plugin from this GitHub repo, so a
merge to `main` is the release. Bump `version` in `plugin/.claude-plugin/plugin.json`
and the marketplace entry together.

## Gotchas

- `node --test test/` fails on Node 22 (it treats the folder as a module);
  pass the glob `'test/*.test.mjs'`.
