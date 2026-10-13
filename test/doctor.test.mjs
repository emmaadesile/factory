import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DoctorConfigError, runChecks, summarize } from '../plugin/doctor/doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../plugin/doctor/doctor.mjs', import.meta.url))
const TEMPLATES = new URL('../plugin/templates/shared/', import.meta.url)

function makeRepo(files) {
	const root = mkdtempSync(join(tmpdir(), 'factory-doctor-'))
	for (const [path, content] of Object.entries(files)) {
		// `undefined` removes a file inherited from a spread fixture.
		if (content === undefined) continue
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), content)
	}
	return root
}

function gitInit(root, commitDate) {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
		GIT_AUTHOR_DATE: `${commitDate}T12:00:00Z`,
		GIT_COMMITTER_DATE: `${commitDate}T12:00:00Z`,
	}
	execFileSync('git', ['init', '-q'], { cwd: root })
	execFileSync('git', ['add', '-A'], { cwd: root })
	execFileSync('git', ['commit', '-qm', 'init', '--no-gpg-sign'], { cwd: root, env })
}

function result(report, id) {
	return report.results.find((entry) => entry.id === id)
}

function template(path) {
	return readFileSync(new URL(path, TEMPLATES), 'utf8')
}

function workflow(on, run) {
	return `name: Test\non: ${on}\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`
}

const NOTES = `# Example

What this project is, in two lines.

## Status (2026-10-10)

Done: sign-in.
Next: payments.

## Decisions (don't change without asking)

- Hosting: Vercel.
- Auth: Clerk.

## Commands

\`\`\`bash
scripts/validate
\`\`\`
`

const COMPLETE_REPO = {
	'CLAUDE.md': NOTES,
	'scripts/validate': '#!/usr/bin/env bash\nnpm test\nnode scripts/factory-doctor.mjs .\n',
	'scripts/factory-doctor.mjs': '// vendored copy\n',
	'src/sum.test.ts': 'test("sum", () => {})\n',
	'.github/workflows/ci.yml': workflow('\n  push:\n  pull_request:', 'scripts/validate'),
	'.github/workflows/deploy.yml':
		'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: npx vercel deploy --prod\n      - run: curl --fail https://example.com/api/health\n',
	'.githooks/pre-commit': 'scripts/validate --fast\n',
	'.github/pull_request_template.md': '## Intent\n',
}

function completeRepo(overrides = {}) {
	const root = makeRepo({ ...COMPLETE_REPO, ...overrides })
	if (existsSync(join(root, 'scripts/validate'))) chmodSync(join(root, 'scripts/validate'), 0o755)
	return root
}

test('a repo with every piece passes every check', () => {
	const root = completeRepo()
	gitInit(root, '2026-10-12')

	const report = runChecks(root, { now: new Date('2026-10-13T00:00:00Z') })

	assert.deepEqual(
		report.results.filter((entry) => entry.status !== 'pass'),
		[],
	)
	assert.deepEqual(report.notices, [])
	assert.equal(summarize(report, { strict: true }).ok, true)
})

test('an empty repo fails every check except no-secrets, and the summary is not ok', () => {
	const root = makeRepo({ 'README.md': '# Nothing yet\n' })

	const report = runChecks(root)

	const passing = report.results.filter((entry) => entry.status === 'pass').map((entry) => entry.id)
	assert.deepEqual(passing, ['no-secrets'])
	assert.equal(summarize(report).ok, false)
})

test('notes that only include tool-written boilerplate do not count', () => {
	const root = makeRepo({
		'CLAUDE.md': '@AGENTS.md\n',
		'AGENTS.md':
			'<!-- BEGIN:nextjs-agent-rules -->\n# This is NOT the Next.js you know\nRead the docs.\nHeed deprecations.\nMore lines.\nAnd more.\n<!-- END:nextjs-agent-rules -->\n',
	})

	const notes = result(runChecks(root), 'agent-notes')

	assert.equal(notes.status, 'fail')
	assert.match(notes.detail, /0 lines of its own/)
})

test('notes copied from the template but not filled in fail', () => {
	const root = makeRepo({ 'CLAUDE.md': template('CLAUDE.md') })

	const notes = result(runChecks(root), 'agent-notes')

	assert.equal(notes.status, 'fail')
	assert.match(notes.detail, /placeholders still unfilled, e\.g\. \{\{project\}\}/)
})

test('GitHub Actions expressions in notes are not template placeholders', () => {
	const root = makeRepo({ 'CLAUDE.md': `${NOTES}\nCI reads \`\${{ secrets.CONVEX_DEPLOY_KEY }}\`.\n` })

	assert.equal(result(runChecks(root), 'agent-notes').status, 'pass')
})

test('imports resolve from the importing file, inline imports count, and imports outside the repo are ignored', () => {
	const root = makeRepo({
		'CLAUDE.md': 'Read @docs/agents.md first.\n@../outside.md\n',
		'docs/agents.md': '@notes.md\n',
		'docs/notes.md': NOTES,
	})
	writeFileSync(join(dirname(root), 'outside.md'), '## Status (2026-10-10)\n')

	const report = runChecks(root)

	assert.equal(result(report, 'notes-sections').status, 'pass')
	assert.equal(result(report, 'agent-notes').status, 'pass')
})

test('section headings with extra words still count', () => {
	const root = makeRepo({
		'CLAUDE.md': NOTES.replace('## Decisions', "## The owner's decisions").replace('## Commands', '## Commands and scripts'),
	})

	assert.equal(result(runChecks(root), 'notes-sections').status, 'pass')
})

test('word prefixes and headings inside code fences are not sections', () => {
	const prefixes = makeRepo({ 'CLAUDE.md': NOTES.replace('## Status', '## Statusline config').replace('## Commands', '## Commandments') })
	const fenced = makeRepo({
		'CLAUDE.md': '# Example\n\nAn example of the layout:\n\n```markdown\n## Status (2026-10-10)\n## Decisions\n## Commands\n```\n\nMore text here.\n',
	})

	for (const [root, missing] of [
		[prefixes, 'Missing: ## Status, ## Commands.'],
		[fenced, 'Missing: ## Status, ## Decisions, ## Commands.'],
	]) {
		const sections = result(runChecks(root), 'notes-sections')
		assert.equal(sections.status, 'fail')
		assert.equal(sections.detail, missing)
	}
})

test('a Status dated weeks before the last commit is stale', () => {
	const root = makeRepo({ 'CLAUDE.md': NOTES })
	gitInit(root, '2026-11-20')

	const status = result(runChecks(root, { now: new Date('2026-11-21T00:00:00Z') }), 'status-fresh')

	assert.equal(status.status, 'fail')
	assert.equal(status.detail, 'Status is dated 2026-10-10, 41 days before the last commit.')
})

test('a deadline in the Status body does not make an old heading date fresh', () => {
	const root = makeRepo({
		'CLAUDE.md': NOTES.replace('(2026-10-10)', '(2026-01-05)').replace('Done: sign-in.', 'Done: sign-in. Renew the Apple cert by 2026-12-01.'),
	})
	gitInit(root, '2026-10-12')

	const status = result(runChecks(root, { now: new Date('2026-10-13T00:00:00Z') }), 'status-fresh')

	assert.equal(status.status, 'fail')
	assert.match(status.detail, /dated 2026-01-05/)
})

test('a Status dated in the future fails', () => {
	const root = makeRepo({ 'CLAUDE.md': NOTES.replace('(2026-10-10)', '(2099-01-01)') })

	const status = result(runChecks(root, { now: new Date('2026-10-13T00:00:00Z') }), 'status-fresh')

	assert.equal(status.status, 'fail')
	assert.equal(status.detail, 'Status is dated 2099-01-01, which is in the future.')
})

test('a Status without a real date fails', () => {
	const none = makeRepo({ 'CLAUDE.md': NOTES.replace(' (2026-10-10)', '') })
	const impossible = makeRepo({ 'CLAUDE.md': NOTES.replace('2026-10-10', '2026-02-30') })

	assert.match(result(runChecks(none), 'status-fresh').detail, /no YYYY-MM-DD date/)
	assert.match(result(runChecks(impossible), 'status-fresh').detail, /no YYYY-MM-DD date/)
})

test('a validate script that is not executable fails', () => {
	const root = makeRepo({ 'scripts/validate': '#!/usr/bin/env bash\nnpm test\n' })
	chmodSync(join(root, 'scripts/validate'), 0o644)

	const validate = result(runChecks(root), 'validate')

	assert.equal(validate.status, 'fail')
	assert.equal(validate.detail, 'scripts/validate is not executable.')
})

test('the validate template copied without its steps filled in fails', () => {
	const root = makeRepo({ 'scripts/validate': template('scripts/validate') })
	chmodSync(join(root, 'scripts/validate'), 0o755)

	const validate = result(runChecks(root), 'validate')

	assert.equal(validate.status, 'fail')
	assert.equal(validate.detail, 'scripts/validate is still the unfilled template.')
})

test('a validate npm script or make target counts', () => {
	const npm = makeRepo({ 'package.json': JSON.stringify({ scripts: { validate: 'npm test' } }) })
	const make = makeRepo({ Makefile: 'validate: test lint\n\ttrue\n' })

	assert.equal(result(runChecks(npm), 'validate').detail, 'npm run validate')
	assert.equal(result(runChecks(make), 'validate').detail, 'make validate')
})

test('a symlinked validate script counts', () => {
	const root = makeRepo({ 'scripts/real-validate': '#!/usr/bin/env bash\nnpm test\n' })
	chmodSync(join(root, 'scripts/real-validate'), 0o755)
	symlinkSync('real-validate', join(root, 'scripts/validate'))

	assert.equal(result(runChecks(root), 'validate').status, 'pass')
})

test('test files are found across stacks and outside ignored folders', () => {
	const root = makeRepo({
		'tests/test_risk.py': '',
		'Packages/LiftKit/Tests/LiftCoreTests/SetTests.swift': '',
		'src/app.spec.tsx': '',
		'src/__tests__/format.js': '',
		'node_modules/lib/index.test.js': '',
		'vendor/bundle/gem_test.py': '',
	})

	assert.equal(result(runChecks(root), 'tests').detail, '4 test files')
})

test('a walk that stops early is reported and does not turn into error-level failures', () => {
	const files = { 'scripts/validate': '#!/usr/bin/env bash\nnpm test\n', 'src/x.test.ts': '' }
	for (let index = 0; index < 30; index += 1) files[`assets/file-${index}.png`] = ''
	const root = makeRepo(files)
	chmodSync(join(root, 'scripts/validate'), 0o755)

	const report = runChecks(root, { maxFiles: 10 })

	assert.equal(result(report, 'validate').status, 'pass')
	const tests = result(report, 'tests')
	assert.ok(tests.status === 'pass' || tests.level === 'warn', JSON.stringify(tests))
	assert.match(report.notices[0], /Stopped after 10 files/)
})

test('CI triggers are read from the on: key in all its forms', () => {
	const inline = makeRepo({ '.github/workflows/ci.yml': workflow('push', 'npm test') })
	const list = makeRepo({ '.github/workflows/ci.yml': workflow('[push, pull_request]', 'npm test') })
	const quoted = makeRepo({ '.github/workflows/ci.yml': workflow('\n  - "pull_request"', 'npm test').replace('on:', '"on":') })

	for (const root of [inline, list, quoted]) {
		assert.equal(result(runChecks(root), 'ci').status, 'pass')
	}
})

test('a workflow that only runs by hand is not CI, even when a step says push: true', () => {
	const root = makeRepo({
		'.github/workflows/image.yml':
			'on: workflow_dispatch\njobs:\n  image:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n',
	})

	const ci = result(runChecks(root), 'ci')

	assert.equal(ci.status, 'fail')
	assert.equal(ci.detail, 'Workflows exist but none run on push or pull_request.')
})

test('the CI template copied without its setup filled in fails', () => {
	const root = makeRepo({ '.github/workflows/ci.yml': template('.github/workflows/ci.yml') })

	const ci = result(runChecks(root), 'ci')

	assert.equal(ci.status, 'fail')
	assert.equal(ci.detail, 'ci.yml still has a template placeholder.')
})

test('CI that runs its own steps instead of validate gets a warning', () => {
	const root = makeRepo({
		'.github/workflows/ci.yml': `# Same checks as scripts/validate\n${workflow('push', 'npm test')}`,
	})

	assert.equal(result(runChecks(root), 'ci-validate').status, 'fail')
})

test('CI runs the doctor only when the doctor file it calls exists', () => {
	const ci = { '.github/workflows/ci.yml': workflow('push', 'scripts/validate') }
	const validate = '#!/usr/bin/env bash\nnode scripts/factory-doctor.mjs .\n'
	const vendored = makeRepo({ ...ci, 'scripts/validate': validate, 'scripts/factory-doctor.mjs': '' })
	const missing = makeRepo({ ...ci, 'scripts/validate': validate })
	const noDoctor = makeRepo({ ...ci, 'scripts/validate': '#!/usr/bin/env bash\nnpm test\n' })

	assert.equal(result(runChecks(vendored), 'ci-doctor').status, 'pass')
	assert.equal(result(runChecks(missing), 'ci-doctor').status, 'fail')
	assert.equal(result(runChecks(noDoctor), 'ci-doctor').status, 'fail')
})

test('a repo without a pre-commit hook gets a warning', () => {
	const root = completeRepo({ '.githooks/pre-commit': undefined })
	const husky = completeRepo({ '.githooks/pre-commit': undefined, 'dashboard-ui/.husky/pre-commit': 'npm test\n' })

	assert.equal(result(runChecks(root), 'hooks').status, 'fail')
	assert.equal(result(runChecks(husky), 'hooks').detail, 'dashboard-ui/.husky/pre-commit')
})

test('a PR template is found in any of GitHub\'s locations and cases', () => {
	const upper = makeRepo({ '.github/PULL_REQUEST_TEMPLATE.md': '## Intent\n' })
	const docs = makeRepo({ 'docs/pull_request_template.md': '## Intent\n' })

	assert.equal(result(runChecks(upper), 'pr-template').detail, '.github/PULL_REQUEST_TEMPLATE.md')
	assert.equal(result(runChecks(docs), 'pr-template').detail, 'docs/pull_request_template.md')
})

test('test-only workflows are not deploys', () => {
	const cases = {
		'docker compose and a service health check on pull requests': {
			'.github/workflows/ci.yml':
				'on: pull_request\njobs:\n  test:\n    services:\n      postgres:\n        options: --health-cmd pg_isready\n    steps:\n      - run: docker compose -f docker-compose.test.yml up -d\n      - run: curl --fail http://localhost:8000/health\n',
		},
		'release-please': {
			'.github/workflows/release-please.yml':
				'on:\n  push:\n    branches: [main]\njobs:\n  release:\n    steps:\n      - uses: googleapis/release-please-action@v4\n',
		},
		'vercel pull': { '.github/workflows/ci.yml': workflow('push', 'npx vercel pull --yes --environment=preview') },
		'a dry-run build': { '.github/workflows/ci.yml': workflow('push', 'wrangler deploy --dry-run') },
		'an npm script that only mentions deploy': { '.github/workflows/ci.yml': workflow('push', 'npm run deploy-guardrails:check') },
	}

	for (const [name, files] of Object.entries(cases)) {
		assert.equal(result(runChecks(makeRepo(files)), 'deploy').status, 'fail', name)
	}
})

test('deploy commands in workflows that run after merges count', () => {
	const cases = {
		'convex deploy': workflow('\n  push:\n    branches: [main]', 'npx convex deploy'),
		'npm run deploy': workflow('workflow_run', 'npm run deploy'),
		'ssh to a server': workflow('push', 'ssh -i key deploy@example.com "docker compose pull && docker compose up -d"'),
		'an image push': 'on: push\njobs:\n  image:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n',
	}

	for (const [name, text] of Object.entries(cases)) {
		const root = makeRepo({ '.github/workflows/release.yml': text })
		assert.equal(result(runChecks(root), 'deploy').status, 'pass', name)
	}
})

test('a platform config counts as an automated deploy', () => {
	const expo = makeRepo({ 'apps/mobile/eas.json': '{}' })
	const xcodeCloud = makeRepo({ 'ios/ci_scripts/ci_post_clone.sh': 'xcodegen generate\n' })

	assert.match(result(runChecks(expo), 'deploy').detail, /apps\/mobile\/eas\.json/)
	assert.match(result(runChecks(xcodeCloud), 'deploy').detail, /ios\/ci_scripts\/ci_post_clone\.sh/)
})

test('a deploy job that never checks the result gets a warning', () => {
	const root = completeRepo({ '.github/workflows/deploy.yml': workflow('push', 'npx vercel deploy --prod') })

	assert.equal(result(runChecks(root), 'deploy').status, 'pass')
	assert.equal(result(runChecks(root), 'deploy-verified').status, 'fail')
})

test('a skipped check shows its reason and does not fail the run', () => {
	const root = completeRepo({
		'.github/workflows/deploy.yml': undefined,
		'.factory.json': JSON.stringify({
			skip: { deploy: 'Local MCP server, nothing to deploy', 'deploy-verified': 'Nothing to deploy' },
		}),
	})

	const report = runChecks(root)

	assert.deepEqual(result(report, 'deploy'), {
		id: 'deploy',
		level: 'error',
		title: 'Deploys are automated',
		status: 'skip',
		detail: 'Local MCP server, nothing to deploy',
	})
	assert.equal(summarize(report).ok, true)
})

test('unknown skip ids are reported instead of silently skipping nothing', () => {
	const root = makeRepo({ '.factory.json': JSON.stringify({ skip: { deploy_verified: 'typo' } }) })

	const report = runChecks(root)

	assert.match(report.notices[0], /unknown checks: deploy_verified/)
	assert.equal(result(report, 'deploy-verified').status, 'fail')
})

test('a malformed .factory.json is a config error with exit code 2', () => {
	const root = makeRepo({ '.factory.json': '{ skip: }' })

	assert.throws(() => runChecks(root), DoctorConfigError)
	const run = spawnSync(process.execPath, [DOCTOR, root, '--json'], { encoding: 'utf8' })
	assert.equal(run.status, 2)
	assert.equal(JSON.parse(run.stdout).ok, false)
	assert.match(run.stderr, /\.factory\.json is not valid JSON/)
})

test('committed .env files with secrets are errors but examples are fine', () => {
	const root = makeRepo({
		'.env': 'SECRET=1\n',
		'.env.example': 'SECRET=\n',
		'apps/api/.env.local': 'X=1\n',
		'apps/web/.env.production.local': 'X=1\n',
		'apps/web/.env.production.example': 'X=\n',
	})
	gitInit(root, '2026-10-12')

	const secrets = result(runChecks(root), 'no-secrets')

	assert.equal(secrets.status, 'fail')
	assert.equal(secrets.detail, 'Committed: .env, apps/api/.env.local, apps/web/.env.production.local.')
})

test('the stack is detected from manifests', () => {
	const root = makeRepo({
		'package.json': JSON.stringify({ dependencies: { convex: '1.0.0' } }),
		'apps/mobile/package.json': JSON.stringify({ dependencies: { expo: '57.0.0' } }),
		'project.yml': 'name: Lift\n',
		'requirements.txt': 'ccxt\n',
	})

	assert.deepEqual(runChecks(root).stack, ['expo', 'convex', 'ios', 'python'])
})

test('the command line exits 1 on errors and prints JSON on request', () => {
	const root = makeRepo({ 'README.md': '# Nothing yet\n' })

	const run = spawnSync(process.execPath, [DOCTOR, root, '--json'], { encoding: 'utf8' })

	assert.equal(run.status, 1)
	const report = JSON.parse(run.stdout)
	assert.equal(report.ok, false)
	assert.equal(report.results.find((entry) => entry.id === 'tests').status, 'fail')
})

test('warnings only fail the command line with --strict', () => {
	const root = completeRepo({ '.github/pull_request_template.md': undefined })

	const normal = spawnSync(process.execPath, [DOCTOR, root], { encoding: 'utf8' })
	const strict = spawnSync(process.execPath, [DOCTOR, root, '--strict'], { encoding: 'utf8' })

	assert.equal(normal.status, 0)
	assert.equal(strict.status, 1)
	assert.match(normal.stdout, /! PR template asks for intent, door and testing/)
})

test('the CLAUDE.md template passes the notes checks once filled in', () => {
	const filled = template('CLAUDE.md')
		.replace(/\{\{YYYY-MM-DD\}\}/g, '2026-10-12')
		.replace(/\{\{[^}]+\}\}/g, 'filled in')
	const root = makeRepo({ 'CLAUDE.md': filled })
	gitInit(root, '2026-10-12')

	const report = runChecks(root, { now: new Date('2026-10-13T00:00:00Z') })

	for (const id of ['agent-notes', 'notes-sections', 'status-fresh']) {
		assert.equal(result(report, id).status, 'pass', id)
	}
})

test('setup-hooks refuses to turn hooks on when there is no scripts/validate', () => {
	const root = makeRepo({
		'scripts/setup-hooks': template('scripts/setup-hooks'),
		'.githooks/pre-commit': template('.githooks/pre-commit'),
	})
	execFileSync('git', ['init', '-q'], { cwd: root })

	const setup = spawnSync('bash', ['scripts/setup-hooks'], { cwd: root, encoding: 'utf8' })
	const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' })

	assert.equal(setup.status, 1)
	assert.match(setup.stderr, /no scripts\/validate/)
	assert.equal(hooksPath.stdout.trim(), '')
})

test('the pre-commit hook explains a missing validate script instead of crashing', () => {
	const root = makeRepo({ '.githooks/pre-commit': template('.githooks/pre-commit') })
	execFileSync('git', ['init', '-q'], { cwd: root })

	const hook = spawnSync('bash', ['.githooks/pre-commit'], { cwd: root, encoding: 'utf8' })

	assert.equal(hook.status, 1)
	assert.match(hook.stderr, /pre-commit: no executable scripts\/validate/)
})

test('every path the retrofit skill points at exists', () => {
	const skillDir = new URL('../plugin/skills/factory-retrofit/', import.meta.url)
	const skill = readFileSync(new URL('SKILL.md', skillDir), 'utf8')
	const paths = [...skill.matchAll(/`(\.\.\/\.\.\/[^`\s]+|references\/[^`\s]+)`|\]\((references\/[^)]+)\)/g)].map(
		(match) => match[1] ?? match[2],
	)

	assert.ok(paths.length >= 3, `expected the skill to reference its files, found ${paths.length}`)
	for (const path of paths) {
		assert.ok(existsSync(new URL(path, skillDir)), `${path} is missing`)
	}
})

test('the README checklist has one row per check', () => {
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
	const table = readme.split('## The checklist')[1].split('\n\n')[1]
	const rows = table.split('\n').filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith('| Check'))

	assert.equal(rows.length, runChecks(makeRepo({})).results.length)
})
