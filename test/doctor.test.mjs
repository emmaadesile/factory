import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runChecks, summarize } from '../plugin/doctor/doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../plugin/doctor/doctor.mjs', import.meta.url))

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
	'scripts/validate': '#!/usr/bin/env bash\nnpm test\n',
	'src/sum.test.ts': 'test("sum", () => {})\n',
	'.github/workflows/ci.yml':
		'on:\n  push:\njobs:\n  validate:\n    steps:\n      - run: scripts/validate\n      - run: node scripts/factory-doctor.mjs\n',
	'.github/workflows/deploy.yml':
		'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: npx vercel deploy --prod\n      - run: curl --fail https://example.com/api/health\n',
	'.githooks/pre-commit': 'scripts/validate --fast\n',
	'.github/pull_request_template.md': '## Intent\n',
}

test('a repo with every piece passes every check', () => {
	const root = makeRepo(COMPLETE_REPO)
	chmodSync(join(root, 'scripts/validate'), 0o755)
	gitInit(root, '2026-10-12')

	const report = runChecks(root)

	const failing = report.results.filter((entry) => entry.status !== 'pass')
	assert.deepEqual(failing, [])
	assert.equal(summarize(report, { strict: true }).ok, true)
})

test('an empty repo fails the error-level checks and the summary is not ok', () => {
	const root = makeRepo({ 'README.md': '# Nothing yet\n' })

	const report = runChecks(root)

	for (const id of ['agent-notes', 'notes-sections', 'validate', 'tests', 'ci', 'deploy']) {
		assert.equal(result(report, id).status, 'fail', id)
	}
	assert.equal(result(report, 'no-secrets').status, 'pass')
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
	const template = readFileSync(new URL('../plugin/templates/shared/CLAUDE.md', import.meta.url), 'utf8')
	const root = makeRepo({ 'CLAUDE.md': template })

	const notes = result(runChecks(root), 'agent-notes')

	assert.equal(notes.status, 'fail')
	assert.match(notes.detail, /placeholders still unfilled, e\.g\. \{\{project\}\}/)
})

test('GitHub Actions expressions in notes are not template placeholders', () => {
	const root = makeRepo({ 'CLAUDE.md': `${NOTES}\nCI reads \`\${{ secrets.CONVEX_DEPLOY_KEY }}\`.\n` })

	assert.equal(result(runChecks(root), 'agent-notes').status, 'pass')
})

test('section headings with extra words still count', () => {
	const root = makeRepo({
		'CLAUDE.md': NOTES.replace('## Decisions', "## The owner's decisions").replace(
			'## Commands',
			'## Commands and scripts',
		),
	})

	assert.equal(result(runChecks(root), 'notes-sections').status, 'pass')
})

test('a missing section is named in the detail', () => {
	const root = makeRepo({ 'CLAUDE.md': NOTES.replace('## Commands', '## Scripts') })

	const sections = result(runChecks(root), 'notes-sections')

	assert.equal(sections.status, 'fail')
	assert.equal(sections.detail, 'Missing: ## Commands.')
})

test('a Status dated weeks before the last commit is stale', () => {
	const root = makeRepo({ 'CLAUDE.md': NOTES })
	gitInit(root, '2026-11-20')

	const status = result(runChecks(root), 'status-fresh')

	assert.equal(status.status, 'fail')
	assert.match(status.detail, /dated 2026-10-10, 41 days before the last commit/)
})

test('a Status without a date fails', () => {
	const root = makeRepo({ 'CLAUDE.md': NOTES.replace(' (2026-10-10)', '') })

	assert.equal(result(runChecks(root), 'status-fresh').status, 'fail')
})

test('CI runs the doctor when it runs a validate script that calls the doctor', () => {
	const ci = { '.github/workflows/ci.yml': 'on:\n  push:\njobs:\n  v:\n    steps:\n      - run: scripts/validate\n' }
	const withDoctor = makeRepo({ ...ci, 'scripts/validate': 'node scripts/factory-doctor.mjs .\n' })
	const withoutDoctor = makeRepo({ ...ci, 'scripts/validate': 'npm test\n' })

	assert.equal(result(runChecks(withDoctor), 'ci-doctor').status, 'pass')
	assert.equal(result(runChecks(withoutDoctor), 'ci-doctor').status, 'fail')
})

test('a validate script that is not executable fails', () => {
	const root = makeRepo({ 'scripts/validate': '#!/usr/bin/env bash\n' })
	chmodSync(join(root, 'scripts/validate'), 0o644)

	const validate = result(runChecks(root), 'validate')

	assert.equal(validate.status, 'fail')
	assert.match(validate.detail, /not executable/)
})

test('a validate npm script or make target counts', () => {
	const npm = makeRepo({ 'package.json': JSON.stringify({ scripts: { validate: 'npm test' } }) })
	const make = makeRepo({ Makefile: 'validate: test lint\n\ttrue\n' })

	assert.equal(result(runChecks(npm), 'validate').detail, 'npm run validate')
	assert.equal(result(runChecks(make), 'validate').detail, 'make validate')
})

test('test files are found across stacks and outside ignored folders', () => {
	const root = makeRepo({
		'tests/test_risk.py': '',
		'Packages/LiftKit/Tests/LiftCoreTests/SetTests.swift': '',
		'src/app.spec.tsx': '',
		'node_modules/lib/index.test.js': '',
	})

	assert.equal(result(runChecks(root), 'tests').detail, '3 test files')
})

test('a dry-run build in CI is not a deploy', () => {
	const root = makeRepo({
		'.github/workflows/ci.yml': 'on:\n  push:\njobs:\n  build:\n    steps:\n      - run: wrangler deploy --dry-run\n',
	})

	assert.equal(result(runChecks(root), 'deploy').status, 'fail')
})

test('a platform config counts as an automated deploy', () => {
	const expo = makeRepo({ 'apps/mobile/eas.json': '{}' })
	const xcodeCloud = makeRepo({ 'ci_scripts/ci_post_clone.sh': 'xcodegen generate\n' })

	const deploy = result(runChecks(expo), 'deploy')

	assert.equal(deploy.status, 'pass')
	assert.match(deploy.detail, /apps\/mobile\/eas\.json/)
	assert.equal(result(runChecks(xcodeCloud), 'deploy').status, 'pass')
})

test('a skipped check shows its reason and does not fail the run', () => {
	const root = makeRepo({
		...COMPLETE_REPO,
		'.github/workflows/deploy.yml': undefined,
		'.factory.json': JSON.stringify({
			skip: { deploy: 'Local MCP server, nothing to deploy', 'deploy-verified': 'Nothing to deploy' },
		}),
	})
	chmodSync(join(root, 'scripts/validate'), 0o755)

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

test('a committed .env is an error but .env.example is fine', () => {
	const root = makeRepo({ '.env': 'SECRET=1\n', '.env.example': 'SECRET=\n', 'apps/api/.env.local': 'X=1\n' })
	gitInit(root, '2026-10-12')

	const secrets = result(runChecks(root), 'no-secrets')

	assert.equal(secrets.status, 'fail')
	assert.equal(secrets.detail, 'Committed: .env, apps/api/.env.local.')
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
	const root = makeRepo({ ...COMPLETE_REPO, '.github/pull_request_template.md': undefined })
	chmodSync(join(root, 'scripts/validate'), 0o755)

	const normal = spawnSync(process.execPath, [DOCTOR, root], { encoding: 'utf8' })
	const strict = spawnSync(process.execPath, [DOCTOR, root, '--strict'], { encoding: 'utf8' })

	assert.equal(normal.status, 0)
	assert.equal(strict.status, 1)
	assert.match(normal.stdout, /! PR template asks for intent, door and testing/)
})

test('the CLAUDE.md template passes the notes checks once filled in', () => {
	const template = readFileSync(new URL('../plugin/templates/shared/CLAUDE.md', import.meta.url), 'utf8')
	const filled = template.replace(/\{\{YYYY-MM-DD\}\}/g, '2026-10-12').replace(/\{\{[^}]+\}\}/g, 'filled in')
	const root = makeRepo({ 'CLAUDE.md': filled })
	gitInit(root, '2026-10-12')

	const report = runChecks(root)

	for (const id of ['agent-notes', 'notes-sections', 'status-fresh']) {
		assert.equal(result(report, id).status, 'pass', id)
	}
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
