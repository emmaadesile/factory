## What and why

<!-- What this PR does and why, in a few sentences. Link the plan section or issue it comes from. -->

**Type:** feature | bug fix | refactor (no behaviour change) | docs | CI / deploy | performance

**Door:** `two-way` | `one-way`

<!--
two-way: cheap to undo. Ship it and change it if it's wrong.
one-way: hard to undo (auth, payments, database schema, stored data, a public API, an app store release).
Keep it in its own PR, say below how you'd roll it back, and review it slowly.
-->

## Changes

-

## How I verified it

<!-- scripts/validate is a given. Say where else it ran and paste the output, so a reviewer can trust it without re-running it. -->

- [ ] `scripts/validate` passes, with no new warnings
- [ ] Ran where users will run it: <!-- device, simulator, preview URL or server -->
- [ ] New or changed behaviour has a test that fails without the change
- [ ] Docs and CLAUDE.md Status are updated if this changes setup, or what's done, next or waiting

## How to test it

<!-- Steps a reviewer can follow to see it work. Delete for docs-only changes. -->

1.

## Screenshots

<!-- For UI changes: before and after, or a screen recording. Delete if there's no UI change. -->

## Before merging

<!-- What must happen first: secrets or settings to add, a PR to merge first, a backend deploy before an app build, a one-way door's rollback plan. "Nothing" is fine. -->

## Related

<!-- "Closes #123" closes the issue when this merges; "Related to #123" doesn't. List follow-ups as linked issues. -->
