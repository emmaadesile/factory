# Stack reference

For each stack: the steps for `scripts/validate`, the CI setup, and how
deploys work. Prefer the repo's own scripts when they exist. These are
starting points, not replacements.

In `scripts/validate`, put one command per line. Under `set -e`, a failure in
the middle of an `a && b && c` chain does not stop the script, so slow steps
use `if slow "name"; then ... fi`, never `slow "name" && a && b`.

## Next.js on Vercel

**Validate**

```bash
step "lint"
npm run lint
step "typecheck"
npx tsc --noEmit
step "unit tests"
npm test
if slow "build"; then
	npm run build
fi
```

**CI setup:** `actions/setup-node@v4` with `node-version: 22` and
`cache: npm`, then `npm ci`. Use `pnpm/action-setup@v4` first for pnpm repos.

**Deploy:** connect the repo in Vercel (Project → Settings → Git). Every PR
gets a preview URL and `main` goes to production, with no workflow needed.
Add a health route that returns the commit, and a workflow that checks it
after each production deploy:

```ts
// app/api/health/route.ts
export function GET() {
	return Response.json({ ok: true, commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' })
}
```

```yaml
# .github/workflows/deploy-check.yml
name: Deploy check
on: deployment_status
permissions:
  contents: read
jobs:
  health:
    if: github.event.deployment_status.state == 'success' && startsWith(github.event.deployment.environment, 'Production')
    runs-on: ubuntu-latest
    steps:
      - env:
          URL: ${{ vars.PRODUCTION_URL }}
          SHA: ${{ github.event.deployment.sha }}
        run: |
          body=$(curl --fail --silent --show-error --retry 10 --retry-delay 3 --retry-all-errors "$URL/api/health")
          echo "$body"
          echo "$body" | grep -q "\"commit\":\"$SHA\""
```

- Check the production domain (`vars.PRODUCTION_URL`, a repository variable
  such as `https://candlewick.app`), not `deployment_status.environment_url`.
  That's the generated per-deployment URL, and Vercel's default Deployment
  Protection puts it behind a login, so the check would always fail.
- Look at one real `deployment_status` run before relying on the `if:` line.
  The environment name Vercel sends must start with `Production`.

Secrets: none in GitHub. Add the `PRODUCTION_URL` repository variable. App
secrets go in Vercel → Project → Settings → Environment Variables, separately
for Preview and Production.

## Expo (React Native) with EAS

**Validate**

```bash
step "typecheck"
npx tsc --noEmit
step "unit tests"
npm test
step "expo doctor"
npx expo-doctor
```

**CI setup:** as for Node. Add `expo/expo-github-action@v8` with
`eas-version: latest` and `token: ${{ secrets.EXPO_TOKEN }}` for EAS steps.

**Deploy:** non-interactive `eas update` needs `--message` (or `--auto`).
Pass the commit message through an environment variable, never straight into
the shell line, so quotes in a message can't break or inject the command:

```yaml
# On pull_request: a preview update the PR can be opened with.
- env:
    PR: ${{ github.event.number }}
  run: eas update --branch "pr-$PR" --message "PR #$PR" --environment preview --non-interactive

# On push to main: JS-only changes go straight to production.
- env:
    MESSAGE: ${{ github.event.head_commit.message }}
  run: eas update --branch production --message "$MESSAGE" --environment production --non-interactive
```

- `--environment` loads that EAS environment's variables into the bundle.
- Native changes need a store build:
  `eas build --platform all --profile production --non-interactive --auto-submit`.
  Run it on a tag or by hand, since builds cost credits.
- Health check: the API the app talks to gets its own health route, as in
  the Node section. For the app itself, the deploy is verified when the
  update shows up on a device; put that under Waiting on the owner.

Secrets: `EXPO_TOKEN` (expo.dev → Account settings → Access tokens).

## iOS (Swift, XcodeGen) with Convex

**Validate**

```bash
step "swiftlint"
swiftlint lint --strict
step "package tests"
swift test --package-path Packages/<Kit>
if [[ "$(uname)" == "Darwin" ]]; then
	if slow "iOS build"; then
		xcodegen generate
		xcodebuild build -project <App>.xcodeproj -scheme <App> \
			-destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO -quiet
	fi
else
	printf '\n– skipping iOS build (needs macOS)\n'
fi
step "convex typecheck"
npm run typecheck
step "convex tests"
npm test
```

**CI setup:** a `macos-26` (or latest) job for the app, plus an
`ubuntu-latest` job with `container: swift:6.2` for package tests, which is
faster and cheaper. Keep UI tests in their own job with a timeout.

**Deploy:**

- **Backend:** on push to `main`, run `npx convex deploy` with the
  `CONVEX_DEPLOY_KEY` secret (Convex dashboard → production deployment →
  Settings → Deploy key). Deploy the backend before any app build that
  depends on it.
- **App to TestFlight:** Xcode Cloud is the least work for one person.
  Create the workflow from Xcode, with the generated project open, so it
  archives `main` and sends it to TestFlight. Signing is handled for you.
  For XcodeGen, add `ci_scripts/ci_post_clone.sh`:

  ```bash
  #!/bin/sh
  set -e
  brew install xcodegen
  cd "$CI_PRIMARY_REPOSITORY_PATH" && xcodegen generate
  ```

  - **Make it executable** (`chmod +x`, committed as mode 100755). Xcode Cloud
    skips a script that isn't, and the build fails later with no project.
  - **`ci_scripts/` must sit next to the `.xcodeproj`.** With XcodeGen at the
    repo root, that's the root. If the app is in a subfolder such as `ios/`,
    it's `ios/ci_scripts/`.
  - Release keys live in `Config/*.xcconfig` files, which are gitignored. Give
    Xcode Cloud the values as workflow environment variables (secret ones
    marked secret), and write the file in `ci_post_clone.sh`.
- Health check: after `convex deploy`, run a smoke query against
  production (`npx convex run <health:check> --prod`). The TestFlight build
  is verified when it is installed on a device; put that under Waiting on
  the owner until it is.

Secrets: `CONVEX_DEPLOY_KEY` in GitHub. Clerk, RevenueCat and other server
secrets stay in Convex environment variables.

## Python service in Docker on a server

**Validate**

```bash
step "lint"
ruff check .
step "unit tests"
python -m pytest -q
if slow "image"; then
	docker build -q -t factory-validate .
fi
```

Add the frontend's steps (lint, test, build) when the repo has one.

**CI setup:** `actions/setup-python@v5` with `python-version-file` or a
pinned version and `cache: pip`, then `pip install -r requirements.txt`.

**Deploy:**

1. Log in to GHCR, then build and push the image. The job needs its own
   permissions, because the CI template only grants `contents: read`:

   ```yaml
   permissions:
     contents: read
     packages: write
   steps:
     - uses: docker/login-action@v3
       with:
         registry: ghcr.io
         username: ${{ github.actor }}
         password: ${{ secrets.GITHUB_TOKEN }}
     - uses: docker/build-push-action@v6
       with:
         push: true
         tags: ghcr.io/<owner>/<repo>:latest   # image names must be lowercase
   ```

2. SSH to the server (`appleboy/ssh-action`) and run
   `docker compose pull && docker compose up -d`. Images from a private repo
   are private, so the server needs a one-time `docker login ghcr.io` with a
   token that has `read:packages`.
3. Check health on the server itself, which also works when the app is only
   reachable over Tailscale. `--retry-all-errors` matters: right after
   `up -d`, the port refuses connections for a few seconds, and plain
   `--retry` gives up on that at once.

   ```bash
   docker compose ps
   curl --fail --silent --show-error --retry 10 --retry-delay 3 --retry-all-errors http://localhost:<port>/health
   ```

For a service that holds live state (a trading bot with open positions), a
deploy is a restart. Run the deploy job on `workflow_dispatch` with a GitHub
environment that requires the owner's approval, not on every merge. Ask the
owner which they want.

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a key used only for
deploys, added to the server's `authorized_keys`). On the server, once: a
GitHub token with `read:packages` for `docker login ghcr.io`. App secrets stay
in the server's `.env`, never in GitHub.

## Node library, CLI or local MCP server

**Validate:** lint, typecheck, `npm test`, and `npm run build` as a slow step.

**Deploy:** usually nothing to deploy. Ask the owner, then record it in
`.factory.json`:

```json
{ "skip": { "deploy": "Runs locally over stdio; nothing to deploy", "deploy-verified": "Nothing to deploy" } }
```

Publish to npm on a tag with `npm publish --provenance` if it is a package.
