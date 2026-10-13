#!/usr/bin/env node
// factory doctor: checks a repository against the factory checklist.
// Zero dependencies and a single file, so a repo can vendor it as
// scripts/factory-doctor.mjs and run it in CI without network access.
//
//   node doctor.mjs [dir] [--json] [--strict]
//
// Exit code 1 when an error-level check fails (with --strict, warnings too).
// A repo can skip a check with a reason in .factory.json:
//   { "skip": { "deploy": "Local MCP server, nothing to deploy" } }

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCTOR_VERSION = '0.1.0'

const IGNORED_DIRS = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'.next',
	'.expo',
	'.turbo',
	'.vercel',
	'.wrangler',
	'coverage',
	'DerivedData',
	'Pods',
	'.build',
	'.swiftpm',
	'.venv',
	'venv',
	'__pycache__',
	'.pytest_cache',
	'.ruff_cache',
	'.tmp',
])
const MAX_FILES = 20000

const TEST_FILE_PATTERNS = [
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/(^|\/)test_[^/]*\.py$/,
	/_test\.(py|go)$/,
	/Tests?\.swift$/,
	/(^|\/)[^/]*Tests\/[^/]*\.swift$/,
]

const STALE_STATUS_DAYS = 14
// Below this, the notes are only an include line or tool-written boilerplate.
const MIN_NOTES_LINES = 5

export function listFiles(root) {
	const files = []
	const walk = (dir) => {
		if (files.length >= MAX_FILES) return
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name))
			} else if (entry.isFile()) {
				files.push(relative(root, join(dir, entry.name)).split('\\').join('/'))
				if (files.length >= MAX_FILES) return
			}
		}
	}
	walk(root)
	return files
}

function read(root, file) {
	try {
		return readFileSync(join(root, file), 'utf8')
	} catch {
		return null
	}
}

function git(root, args) {
	try {
		return execFileSync('git', ['-C', root, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		return null
	}
}

// CLAUDE.md files often just say "@AGENTS.md"; follow those includes once.
export function readAgentNotes(root) {
	const names = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']
	const found = names.filter((name) => existsSync(join(root, name)))
	if (found.length === 0) return null
	const seen = new Set()
	const parts = []
	const add = (name) => {
		if (seen.has(name)) return
		seen.add(name)
		const text = read(root, name)
		if (text == null) return
		parts.push(text)
		for (const match of text.matchAll(/^@(\S+\.md)\s*$/gm)) add(match[1])
	}
	found.forEach(add)
	return { files: found, text: parts.join('\n') }
}

// Text that tools write into agent files on their own (Next.js does this).
function stripGeneratedBlocks(text) {
	return text
		.replace(/<!-- BEGIN:[\w-]+ -->[\s\S]*?<!-- END:[\w-]+ -->/g, '')
		.replace(/^@\S+\.md\s*$/gm, '')
}

function meaningfulLines(text) {
	return text.split('\n').filter((line) => line.trim().length > 0).length
}

export function sections(text) {
	const result = new Map()
	let current = null
	for (const line of text.split('\n')) {
		const heading = /^##\s+(.+?)\s*$/.exec(line)
		if (heading) {
			current = heading[1].toLowerCase()
			result.set(current, [])
		} else if (current) {
			result.get(current).push(line)
		}
	}
	return result
}

function findSection(sectionMap, word) {
	for (const [title, lines] of sectionMap) {
		if (new RegExp(`\\b${word}`).test(title)) return { title, body: lines.join('\n') }
	}
	return null
}

function daysBetween(a, b) {
	return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export function detectStack(files, root) {
	const has = (pattern) => files.some((file) => pattern.test(file))
	const stack = []
	const packageFiles = files.filter((file) => /(^|\/)package\.json$/.test(file))
	const deps = new Set()
	for (const file of packageFiles) {
		try {
			const pkg = JSON.parse(read(root, file) ?? '{}')
			for (const key of ['dependencies', 'devDependencies']) {
				Object.keys(pkg[key] ?? {}).forEach((name) => deps.add(name))
			}
		} catch {
			// A broken package.json shows up in the project's own build.
		}
	}
	if (deps.has('next')) stack.push('nextjs')
	if (deps.has('expo')) stack.push('expo')
	else if (deps.has('react-native')) stack.push('react-native')
	if (deps.has('convex')) stack.push('convex')
	if (has(/(^|\/)(project\.yml|Package\.swift)$/) || has(/\.xcodeproj\//)) stack.push('ios')
	if (has(/(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/)) stack.push('python')
	if (has(/(^|\/)Dockerfile$/)) stack.push('docker')
	if (stack.length === 0 && packageFiles.length > 0) stack.push('node')
	return stack
}

function workflows(root, files) {
	return files
		.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))
		.map((file) => ({ file, text: read(root, file) ?? '' }))
}

function validateCommand(root, files) {
	if (files.includes('scripts/validate')) {
		const mode = statSync(join(root, 'scripts/validate')).mode
		return mode & 0o111 ? 'scripts/validate' : 'scripts/validate (not executable)'
	}
	const pkg = read(root, 'package.json')
	if (pkg) {
		try {
			if (JSON.parse(pkg).scripts?.validate) return 'npm run validate'
		} catch {
			// Ignore; see detectStack.
		}
	}
	const makefile = read(root, 'Makefile')
	if (makefile && /^validate\s*:/m.test(makefile)) return 'make validate'
	return null
}

export function runChecks(rootInput, { now = new Date() } = {}) {
	const root = resolve(rootInput)
	const files = listFiles(root)
	const config = JSON.parse(read(root, '.factory.json') ?? '{}')
	const skip = config.skip ?? {}
	const notes = readAgentNotes(root)
	const flows = workflows(root, files)
	const results = []

	const check = (id, level, title, run) => {
		if (skip[id]) {
			results.push({ id, level, title, status: 'skip', detail: skip[id] })
			return
		}
		const outcome = run()
		results.push({ id, level, title, status: outcome.pass ? 'pass' : 'fail', ...outcome })
	}

	check('agent-notes', 'error', 'Agent notes (CLAUDE.md) describe this project', () => {
		if (!notes) {
			return {
				pass: false,
				detail: 'No CLAUDE.md or AGENTS.md.',
				fix: 'Copy templates/shared/CLAUDE.md and fill it in from the repo (factory-retrofit).',
			}
		}
		// Template placeholders look like {{project}}; `${{ secrets.X }}` is GitHub Actions syntax.
		const placeholders = [...notes.text.matchAll(/(?<!\$)\{\{[^}\s][^}]*\}\}/g)].map((match) => match[0])
		if (placeholders.length > 0) {
			return {
				pass: false,
				detail: `${placeholders.length} template placeholder${placeholders.length === 1 ? '' : 's'} still unfilled, e.g. ${placeholders[0]}.`,
				fix: 'Replace each {{...}} with this project\'s facts, or delete the line.',
			}
		}
		const own = meaningfulLines(stripGeneratedBlocks(notes.text))
		if (own < MIN_NOTES_LINES) {
			return {
				pass: false,
				detail: `${notes.files.join(' + ')} has ${own} lines of its own (fewer than ${MIN_NOTES_LINES}); the rest is generated by tools.`,
				fix: 'Add Status, Decisions and Commands sections from templates/shared/CLAUDE.md.',
			}
		}
		return { pass: true, detail: `${notes.files.join(' + ')}, ${own} lines` }
	})

	const noteSections = notes ? sections(stripGeneratedBlocks(notes.text)) : new Map()

	check('notes-sections', 'error', 'Notes have Status, Decisions and Commands', () => {
		const required = { status: 'Status', decision: 'Decisions', command: 'Commands' }
		const missing = Object.keys(required).filter((word) => !findSection(noteSections, word))
		return missing.length === 0
			? { pass: true }
			: {
					pass: false,
					detail: `Missing: ${missing.map((word) => `## ${required[word]}`).join(', ')}.`,
					fix: 'Use the section headings from templates/shared/CLAUDE.md.',
				}
	})

	check('status-fresh', 'warn', 'Status is dated and kept current', () => {
		const status = findSection(noteSections, 'status')
		if (!status) return { pass: false, detail: 'No Status section.', fix: 'Run the handoff skill.' }
		const dates = [...`${status.title}\n${status.body}`.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)]
			.map((match) => new Date(`${match[1]}T00:00:00Z`))
			.filter((date) => !Number.isNaN(date.getTime()))
		if (dates.length === 0) {
			return {
				pass: false,
				detail: 'Status has no YYYY-MM-DD date, so nobody can tell how old it is.',
				fix: 'Run the handoff skill at the end of each session.',
			}
		}
		const latest = new Date(Math.max(...dates.map((date) => date.getTime())))
		const lastCommit = git(root, ['log', '-1', '--format=%cs'])
		const reference = lastCommit ? new Date(`${lastCommit}T00:00:00Z`) : now
		const behind = daysBetween(latest, reference)
		if (behind > STALE_STATUS_DAYS) {
			return {
				pass: false,
				detail: `Status is dated ${latest.toISOString().slice(0, 10)}, ${behind} days before the last commit.`,
				fix: 'Run the handoff skill to bring Status up to date.',
			}
		}
		return { pass: true, detail: `dated ${latest.toISOString().slice(0, 10)}` }
	})

	const validate = validateCommand(root, files)

	check('validate', 'error', 'One validate command runs every check', () =>
		validate && !validate.includes('not executable')
			? { pass: true, detail: validate }
			: {
					pass: false,
					detail: validate ?? 'No scripts/validate, "validate" npm script or make target.',
					fix: 'Copy templates/shared/scripts/validate and fill in the stack commands (references/stacks.md).',
				},
	)

	check('tests', 'error', 'The project has tests', () => {
		const tests = files.filter((file) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(file)))
		return tests.length > 0
			? { pass: true, detail: `${tests.length} test file${tests.length === 1 ? '' : 's'}` }
			: { pass: false, detail: 'No test files found.', fix: 'Add a first test for the riskiest logic.' }
	})

	check('ci', 'error', 'CI runs on every push or pull request', () => {
		const triggered = flows.filter(({ text }) => /^\s*(push|pull_request)\s*:?/m.test(text))
		return triggered.length > 0
			? { pass: true, detail: triggered.map(({ file }) => file.replace('.github/workflows/', '')).join(', ') }
			: {
					pass: false,
					detail: flows.length ? 'Workflows exist but none run on push or pull_request.' : 'No GitHub Actions workflows.',
					fix: 'Copy templates/shared/.github/workflows/ci.yml.',
				}
	})

	check('ci-validate', 'warn', 'CI runs the validate command', () => {
		const runs = flows.some(({ text }) => /scripts\/validate|npm run validate|make validate/.test(text))
		return runs
			? { pass: true }
			: {
					pass: false,
					detail: 'CI and local runs can disagree when CI has its own list of checks.',
					fix: 'Make the CI job call the validate command.',
				}
	})

	const runsDoctor = (text) => /factory-doctor|doctor\.mjs/.test(text)
	const validateRunsDoctor = files.includes('scripts/validate') && runsDoctor(read(root, 'scripts/validate') ?? '')

	check('ci-doctor', 'warn', 'CI runs this doctor', () =>
		flows.some(({ text }) => runsDoctor(text) || (validateRunsDoctor && /scripts\/validate/.test(text)))
			? { pass: true }
			: {
					pass: false,
					detail: 'Without it, the repo can drift from the checklist unnoticed.',
					fix: 'Vendor the doctor as scripts/factory-doctor.mjs and run it in CI.',
				},
	)

	check('hooks', 'warn', 'Git hooks run checks before commits', () => {
		const hook = files.find((file) =>
			/^(\.githooks\/pre-commit|\.husky\/pre-commit|[^/]+\/\.husky\/pre-commit|\.pre-commit-config\.yaml|lefthook\.ya?ml)$/.test(file),
		)
		return hook
			? { pass: true, detail: hook }
			: {
					pass: false,
					detail: 'No pre-commit hook.',
					fix: 'Copy templates/shared/.githooks and run scripts/setup-hooks.',
				}
	})

	check('pr-template', 'warn', 'PR template asks for intent, door and testing', () => {
		const template = files.find((file) => /^(\.github\/)?pull_request_template\.md$/i.test(file))
		return template
			? { pass: true, detail: template }
			: { pass: false, detail: 'No PR template.', fix: 'Copy templates/shared/.github/pull_request_template.md.' }
	})

	const deployPattern =
		/vercel|netlify|wrangler (deploy|pages)|npm run deploy|eas (build|update|submit)|fastlane|testflight|convex deploy|docker (push|compose)|flyctl|railway|render\.com|ssh /i
	const deployFlows = flows.filter(
		({ file, text }) =>
			/deploy|release/i.test(file.replace('.github/workflows/', '')) ||
			// A dry-run build in CI is not a deploy.
			deployPattern.test(text.split('\n').filter((line) => !/dry-run/.test(line)).join('\n')),
	)
	const deployConfig = files.find((file) =>
		// ci_scripts/ is where Xcode Cloud looks for build hooks.
		/^(vercel\.json|netlify\.toml|fly\.toml|render\.yaml|eas\.json|[^/]+\/eas\.json|apps\/[^/]+\/eas\.json|fastlane\/Fastfile|ci_scripts\/ci_post_clone\.sh)$/.test(file),
	)

	check('deploy', 'error', 'Deploys are automated', () => {
		if (deployFlows.length > 0) {
			return { pass: true, detail: deployFlows.map(({ file }) => file.replace('.github/workflows/', '')).join(', ') }
		}
		if (deployConfig) {
			return {
				pass: true,
				detail: `${deployConfig} (check the platform deploys from main on its own)`,
			}
		}
		return {
			pass: false,
			detail: 'No deploy workflow or platform config.',
			fix: 'Add the deploy job for this stack (references/stacks.md), or skip with a reason in .factory.json.',
		}
	})

	check('deploy-verified', 'warn', 'Each deploy is checked after it goes out', () => {
		const verified = deployFlows.some(({ text }) => /health|smoke|curl\s+(-\S+\s+)*--fail|curl -f/i.test(text))
		return verified
			? { pass: true }
			: {
					pass: false,
					detail: 'Nothing checks a health endpoint or smoke test after deploying.',
					fix: 'End the deploy job with a health check that compares the commit SHA.',
				}
	})

	check('no-secrets', 'error', 'No .env files with secrets are committed', () => {
		const tracked = git(root, ['ls-files'])
		const list = tracked == null ? files : tracked.split('\n')
		const leaked = list.filter((file) => /(^|\/)\.env(\.[\w-]+)?$/.test(file) && !/\.(example|sample|template)$/.test(file))
		return leaked.length === 0
			? { pass: true }
			: {
					pass: false,
					detail: `Committed: ${leaked.join(', ')}.`,
					fix: 'Remove the file from git, rotate every secret in it, and commit a .env.example instead.',
				}
	})

	return { root, version: DOCTOR_VERSION, stack: detectStack(files, root), results }
}

export function summarize(report, { strict = false } = {}) {
	const failing = report.results.filter(
		(result) => result.status === 'fail' && (strict || result.level === 'error'),
	)
	return { ok: failing.length === 0, failing }
}

const SYMBOL = { pass: '✓', fail: { error: '✗', warn: '!' }, skip: '–' }

export function formatReport(report) {
	const lines = [
		`factory doctor ${report.version} · ${report.root}`,
		`stack: ${report.stack.join(', ') || 'unknown'}`,
		'',
	]
	for (const result of report.results) {
		const symbol = result.status === 'fail' ? SYMBOL.fail[result.level] : SYMBOL[result.status]
		lines.push(`${symbol} ${result.title}${result.detail ? ` — ${result.detail}` : ''}`)
		if (result.status === 'fail' && result.fix) lines.push(`    fix: ${result.fix}`)
	}
	const count = (status, level) =>
		report.results.filter((result) => result.status === status && (!level || result.level === level)).length
	lines.push(
		'',
		`${count('pass')} passed · ${count('fail', 'error')} errors · ${count('fail', 'warn')} warnings · ${count('skip')} skipped`,
	)
	return lines.join('\n')
}

function main(argv) {
	const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
	const dir = argv.find((arg) => !arg.startsWith('--')) ?? '.'
	if (flags.has('--help')) {
		console.log('Usage: factory-doctor [dir] [--json] [--strict]')
		return 0
	}
	if (!existsSync(dir)) {
		console.error(`factory doctor: ${dir} does not exist`)
		return 2
	}
	const report = runChecks(dir)
	const strict = flags.has('--strict')
	const { ok } = summarize(report, { strict })
	console.log(flags.has('--json') ? JSON.stringify({ ...report, ok }, null, 2) : formatReport(report))
	return ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2))
}
