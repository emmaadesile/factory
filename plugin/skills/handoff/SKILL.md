---
name: handoff
description: >
  Keep a project's CLAUDE.md Status true between sessions. Use at the end of a
  session or a PR ("wrap up", "handoff", "let's stop here", "I've merged it"),
  and at the start of one ("where did we stop", "resume", "what's next",
  "catch me up"). Resume reads Status and checks it against git; handoff
  rewrites Status so the next session starts without asking.
---

# Handoff

The project's memory is the `## Status` section of CLAUDE.md, not the chat.
If a fact matters next session, it goes there or into Decisions or Gotchas.

## Resume (start of a session)

1. Read CLAUDE.md: Status, Decisions, Gotchas.
2. Check it against reality: `git status`, `git log --oneline -15`, the
   current branch, and open PRs.
3. If Status disagrees with git (say a branch it names was merged, or work
   it calls next is already committed), say so and fix Status first.
4. Tell the owner in at most five lines: where things stand, what's waiting
   on them, and the next task you propose. Then wait for a go-ahead.

## Handoff (end of a session or PR)

Rewrite the Status section. Do not append to it.

```markdown
## Status (YYYY-MM-DD)

Done: <what works, and where it was verified (device, preview URL, server)>.

Next, in order:

1. <next task, specific enough to start without asking>
2. <the one after>

Waiting on the owner: <exact command, screen or decision; "None">.

Known broken: <what fails today; "Nothing known">.
```

Rules:

- **Done means verified where users run it.** Built but untried on a device,
  preview or server goes under Next or Waiting on the owner, with the exact
  step that would verify it.
- Keep Status under about 25 lines. Git log is the history, so drop finished
  detail.
- Name branches and PRs only while they are open. Once merged, say "merged
  to main".
- Add any decision the owner made this session to Decisions, with the date and
  the reason. Add anything that cost time to Gotchas.
- Commit on the current branch (never `main`) as `Handoff: <one-line summary>`,
  and push.
