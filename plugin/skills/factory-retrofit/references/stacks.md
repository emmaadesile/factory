# Stack reference

For each stack: the steps for `scripts/validate`, the CI setup, and how
deploys work. Prefer the repo's own scripts when they exist. These are
starting points, not replacements.

## Next.js on Vercel

**Validate**

```bash
step "lint";       npm run lint
step "typecheck";  npx tsc --noEmit
step "unit tests"; npm test
slow "build" &&    npm run build
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
jobs:
  health:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - run: |
          body=$(curl --fail --silent --retry 5 --retry-delay 5 "${{ github.event.deployment_status.environment_url }}/api/health")
          echo "$body"
          echo "$body" | grep -q '"commit":"${{ github.event.deployment.sha }}"'
```

Secrets: none in GitHub. App secrets go in Vercel → Project → Settings →
Environment Variables, separately for Preview and Production.

## Expo (React Native) with EAS

**Validate**

```bash
step "typecheck";  npx tsc --noEmit
step "unit tests"; npm test
step "expo doctor"; npx expo-doctor
```

**CI setup:** as for Node. Add `expo/expo-github-action@v8` with
`eas-version: latest` and `token: ${{ secrets.EXPO_TOKEN }}` for EAS steps.

**Deploy:**

- PRs: `eas update --branch pr-${{ github.event.number }} --message "..."
  --non-interactive` so the PR can be opened in a development build.
- `main`: `eas update --branch production --non-interactive` for JS-only
  changes. Native changes need a store build:
  `eas build --platform all --profile production --non-interactive --auto-submit`
  (run on a tag or by hand, since builds cost credits).
- Health check: the API the app talks to gets its own health route, as in
  the Node section. For the app itself, the deploy is verified when the
  update shows up on a device; put that under Waiting on the owner.

Secrets: `EXPO_TOKEN` (expo.dev → Account settings → Access tokens).

## iOS (Swift, XcodeGen) with Convex

**Validate**

```bash
step "swiftlint";     swiftlint lint --strict
step "package tests"; swift test --package-path Packages/<Kit>
if [[ "$(uname)" == "Darwin" ]]; then
	slow "iOS build" && xcodegen generate && xcodebuild build -project <App>.xcodeproj -scheme <App> \
		-destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO -quiet
else
	printf '\n– skipping iOS build (needs macOS)\n'
fi
step "convex typecheck"; npm run typecheck
step "convex tests";     npm test
```

**CI setup:** a `macos-26` (or latest) job for the app, plus an
`ubuntu-latest` job with `container: swift:6.2` for package tests, which is
faster and cheaper. Keep UI tests in their own job with a timeout.

**Deploy:**

- **Backend:** on push to `main`, run `npx convex deploy` with the
  `CONVEX_DEPLOY_KEY` secret (Convex dashboard → production deployment →
  Settings → Deploy key). Deploy the backend before any app build that
  depends on it.
- **App to TestFlight:** Xcode Cloud is the least work for one person: App
  Store Connect → the app → Xcode Cloud → a workflow that archives `main` and
  sends it to TestFlight. Signing is handled for you. For XcodeGen, add
  `ci_scripts/ci_post_clone.sh`:

  ```bash
  #!/bin/sh
  set -e
  brew install xcodegen
  cd "$CI_PRIMARY_REPOSITORY_PATH" && xcodegen generate
  ```

  Release keys live in `Config/*.xcconfig` files, which are gitignored. Give
  Xcode Cloud the values through workflow environment variables and write the
  file in `ci_post_clone.sh`.
- Health check: after `convex deploy`, run a smoke query against
  production (`npx convex run <health:check> --prod`). The TestFlight build
  is verified when it is installed on a device; put that under Waiting on
  the owner until it is.

Secrets: `CONVEX_DEPLOY_KEY` in GitHub. Clerk, RevenueCat and other server
secrets stay in Convex environment variables.

## Python service in Docker on a server

**Validate**

```bash
step "lint";       ruff check .
step "unit tests"; python -m pytest -q
slow "image" &&    docker build -q -t "$(basename "$PWD")":validate .
```

Add the frontend's steps (lint, test, build) when the repo has one.

**CI setup:** `actions/setup-python@v5` with `python-version-file` or a
pinned version and `cache: pip`, then `pip install -r requirements.txt`.

**Deploy:** on push to `main`, build and push the image to GHCR with
`docker/build-push-action@v6`, then SSH to the server (`appleboy/ssh-action`)
and run `docker compose pull && docker compose up -d`. Check health on the
server itself, which also works when the app is only reachable over
Tailscale:

```bash
docker compose ps
curl --fail --silent --retry 5 --retry-delay 3 http://localhost:<port>/health
```

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a key used only for
deploys, added to the server's `authorized_keys`). App secrets stay in the
server's `.env`, never in GitHub.

## Node library, CLI or local MCP server

**Validate:** lint, typecheck, `npm test`, slow `npm run build`.

**Deploy:** usually nothing to deploy. Ask the owner, then record it in
`.factory.json`:

```json
{ "skip": { "deploy": "Runs locally over stdio; nothing to deploy", "deploy-verified": "Nothing to deploy" } }
```

Publish to npm on a tag with `npm publish --provenance` if it is a package.
