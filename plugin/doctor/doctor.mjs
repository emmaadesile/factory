#!/usr/bin/env node
// factory doctor: checks a repository against the factory checklist.
// Zero dependencies and a single file, so a repo can vendor it as
// scripts/factory-doctor.mjs and run it in CI without network access.
//
//   node doctor.mjs [dir] [--json] [--strict]
//
// Exit code 1 when an error-level check fails (with --strict, warnings too),
// 2 when the directory or .factory.json can't be read.
// A repo can skip a check with a reason in .factory.json:
//   { "skip": { "deploy": "Local MCP server, nothing to deploy" } }

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCTOR_VERSION = '0.1.0'

export const CHECK_IDS = [
	'agent-notes',
	'notes-sections',
	'status-fresh',
	'validate',
	'tests',
	'ci',
	'ci-validate',
	'ci-doctor',
	'hooks',
	'pr-template',
	'deploy',
	'deploy-verified',
	'no-secrets',
]

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
	'.yarn',
	'coverage',
	'DerivedData',
	'Pods',
	'.build',
	'.swiftpm',
	'.gradle',
	'.dart_tool',
	'.venv',
	'venv',
	'.tox',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.ruff_cache',
	'target',
	'vendor',
	'.tmp',
])
const MAX_FILES = 20000

const TEST_FILE_PATTERNS = [
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/,
	/(^|\/)test_[^/]*\.py$/,
	/_test\.(py|go)$/,
	/Tests?\.swift$/,
	/(^|\/)[^/]*Tests\/[^/]*\.swift$/,
]

// Triggers that only run for proposed changes; a workflow with nothing else
// never deploys.
const PR_ONLY_TRIGGERS = new Set(['pull_request', 'pull_request_target', 'merge_group'])

const DEPLOY_COMMAND =
	/\bvercel\s+(deploy|--prod)|\bnetlify\s+deploy|\bwrangler\s+(deploy|pages\s+deploy)|\b(npm|pnpm|yarn)\s+(run\s+)?deploy(?![\w-])|\beas\s+(build|update|submit)\b|\bfastlane\b|\btestflight\b|\bconvex\s+deploy\b|\bdocker\s+push\b|\bfly(ctl)?\s+deploy\b|\brailway\s+up\b|appleboy\/ssh-action|\bssh\b.*\s[\w.-]+@[\w.-]+|\bkubectl\s+apply\b|\bhelm\s+upgrade\b|actions\/deploy-pages|\bfirebase\s+deploy\b/i
const DEPLOY_CHECK =
	/\b(curl|wget)\b.*\b(health|smoke|status)\b|\/health\b|\bconvex\s+run\b.*health|\bsmoke[-_ ]?test|\bhealth\b.*--sha/i

const STALE_STATUS_DAYS = 14
// Below this, the notes are only an include line or tool-written boilerplate.
const MIN_NOTES_LINES = 5
const TEMPLATE_MARKERS = /\{\{FACTORY:|replace with this repo's/

export class DoctorConfigError extends Error {}

export function listFiles(root, { maxFiles = MAX_FILES } = {}) {
	const files = []
	let truncated = false
	const walk = (dir) => {
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) {
				truncated = true
				return
			}
			const path = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) walk(path)
			} else if (entry.isFile() || (entry.isSymbolicLink() && isFile(path))) {
				// Symlinked directories are not followed, so a link cycle can't loop.
				files.push(relative(root, path).split('\\').join('/'))
			}
		}
	}
	walk(root)
	return { files, truncated }
}

function isFile(path) {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
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

function inside(root, path) {
	const rel = relative(root, path)
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// CLAUDE.md files often say "@AGENTS.md". Follow imports the way Claude Code
// does: relative to the importing file, inline or on their own line. Imports
// that leave the repository are ignored.
export function readAgentNotes(root) {
	const names = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']
	const found = names.filter((name) => isFile(join(root, name)))
	if (found.length === 0) return null
	const seen = new Set()
	const parts = []
	const add = (name) => {
		if (seen.has(name)) return
		seen.add(name)
		const text = read(root, name)
		if (text == null) return
		parts.push(text)
		for (const match of text.matchAll(/(?:^|\s)@([^\s@]+\.md)\b/g)) {
			const target = resolve(root, dirname(name), match[1])
			if (inside(root, target)) add(relative(root, target).split('\\').join('/'))
		}
	}
	found.forEach(add)
	return { files: found, text: parts.join('\n') }
}

// Text that tools write into agent files on their own (Next.js does this),
// and lines that are only an import.
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
	let inFence = false
	for (const line of text.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
		const heading = inFence ? null : /^##\s+(.+?)\s*$/.exec(line)
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
	const pattern = new RegExp(`\\b${word}s?\\b`)
	for (const [title, lines] of sectionMap) {
		if (pattern.test(title)) return { title, body: lines.join('\n') }
	}
	return null
}

// Real calendar dates only: 2026-02-30 does not survive the round trip.
function parseDates(text) {
	return [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)]
		.map((match) => ({ text: match[1], date: new Date(`${match[1]}T00:00:00Z`) }))
		.filter(({ text, date }) => !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text)
		.map(({ date }) => date)
}

function daysBetween(a, b) {
	return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

function isoDay(date) {
	return date.toISOString().slice(0, 10)
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

// The event names under a workflow's top-level `on:` key, in any of its forms:
// `on: push`, `on: [push, pull_request]`, a list, or a mapping.
export function workflowTriggers(text) {
	const lines = text.split('\n')
	const start = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line))
	if (start < 0) return []
	const inline = lines[start].replace(/^["']?on["']?\s*:/, '').replace(/\s#.*$/, '').trim()
	if (inline) {
		return inline
			.replace(/[[\]{}"']/g, ' ')
			.split(/[\s,]+/)
			.map((word) => word.replace(/:.*$/, ''))
			.filter(Boolean)
	}
	const names = []
	let indent = null
	for (const line of lines.slice(start + 1)) {
		if (!line.trim() || /^\s*#/.test(line)) continue
		if (/^\S/.test(line)) break
		const match = /^(\s+)(?:-\s*)?["']?([\w-]+)["']?\s*(:|$)/.exec(line)
		if (!match) continue
		indent ??= match[1].length
		if (match[1].length === indent) names.push(match[2])
	}
	return names
}

// Lines that run or configure something, without YAML or shell comments.
function activeLines(text) {
	return text
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')
}

function workflows(root) {
	const dir = join(root, '.github/workflows')
	let names = []
	try {
		names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name) && isFile(join(dir, name)))
	} catch {
		return []
	}
	return names.sort().map((name) => {
		const text = read(root, `.github/workflows/${name}`) ?? ''
		return { name, text, active: activeLines(text), triggers: workflowTriggers(text) }
	})
}

function validateCommand(root) {
	const script = join(root, 'scripts/validate')
	if (isFile(script)) {
		const executable = statSync(script).mode & 0o111
		return { command: 'scripts/validate', executable: Boolean(executable), text: read(root, 'scripts/validate') ?? '' }
	}
	const pkg = read(root, 'package.json')
	if (pkg) {
		try {
			const command = JSON.parse(pkg).scripts?.validate
			if (command) return { command: 'npm run validate', executable: true, text: command }
		} catch {
			// Ignore; see detectStack.
		}
	}
	const makefile = read(root, 'Makefile')
	if (makefile && /^validate\s*:/m.test(makefile)) return { command: 'make validate', executable: true, text: makefile }
	return null
}

function readConfig(root) {
	const text = read(root, '.factory.json')
	if (text == null) return {}
	try {
		const config = JSON.parse(text)
		if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected an object')
		return config
	} catch (error) {
		throw new DoctorConfigError(`.factory.json is not valid JSON: ${error.message}`)
	}
}

// Any file under these folders whose name matches, case-insensitively.
function findCaseInsensitive(root, dirs, name) {
	for (const dir of dirs) {
		let entries = []
		try {
			entries = readdirSync(join(root, dir))
		} catch {
			continue
		}
		const hit = entries.find((entry) => entry.toLowerCase() === name)
		if (hit) return dir ? `${dir}/${hit}` : hit
	}
	return null
}

export function runChecks(rootInput, { now = new Date(), maxFiles = MAX_FILES } = {}) {
	const root = resolve(rootInput)
	const config = readConfig(root)
	const skip = config.skip ?? {}
	const { files, truncated } = listFiles(root, { maxFiles })
	const notes = readAgentNotes(root)
	const flows = workflows(root)
	const notices = []
	const results = []

	if (truncated) {
		notices.push(
			`Stopped after ${maxFiles} files, so the tests and stack results may be incomplete. Add large folders to the doctor's ignore list if they aren't source.`,
		)
	}
	const unknown = Object.keys(skip).filter((id) => !CHECK_IDS.includes(id))
	if (unknown.length > 0) {
		notices.push(`.factory.json skips unknown checks: ${unknown.join(', ')}. Known: ${CHECK_IDS.join(', ')}.`)
	}

	const check = (id, level, title, run) => {
		if (skip[id]) {
			results.push({ id, level, title, status: 'skip', detail: String(skip[id]) })
			return
		}
		const { pass, level: levelOverride, ...outcome } = run()
		results.push({ id, level: levelOverride ?? level, title, status: pass ? 'pass' : 'fail', ...outcome })
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
				fix: "Replace each {{...}} with this project's facts, or delete the line.",
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
		// The template and the handoff skill date the heading; body dates are
		// often deadlines, so they only count when the heading has none.
		const headingDates = parseDates(status.title)
		const dates = headingDates.length > 0 ? headingDates : parseDates(status.body)
		if (dates.length === 0) {
			return {
				pass: false,
				detail: 'Status has no YYYY-MM-DD date, so nobody can tell how old it is.',
				fix: 'Run the handoff skill at the end of each session.',
			}
		}
		const dated = new Date(Math.max(...dates.map((date) => date.getTime())))
		if (daysBetween(now, dated) > 1) {
			return {
				pass: false,
				detail: `Status is dated ${isoDay(dated)}, which is in the future.`,
				fix: 'Date Status with the day it was written (the handoff skill does this).',
			}
		}
		const lastCommit = git(root, ['log', '-1', '--format=%cs'])
		const reference = lastCommit ? new Date(`${lastCommit}T00:00:00Z`) : now
		const behind = daysBetween(dated, reference)
		if (behind > STALE_STATUS_DAYS) {
			return {
				pass: false,
				detail: `Status is dated ${isoDay(dated)}, ${behind} days before the last commit.`,
				fix: 'Run the handoff skill to bring Status up to date.',
			}
		}
		return { pass: true, detail: `dated ${isoDay(dated)}` }
	})

	const validate = validateCommand(root)

	check('validate', 'error', 'One validate command runs every check', () => {
		if (!validate) {
			return {
				pass: false,
				detail: 'No scripts/validate, "validate" npm script or make target.',
				fix: 'Copy templates/shared/scripts/validate and fill in the stack commands (references/stacks.md).',
			}
		}
		if (!validate.executable) {
			return { pass: false, detail: 'scripts/validate is not executable.', fix: 'chmod +x scripts/validate and commit it.' }
		}
		if (TEMPLATE_MARKERS.test(validate.text)) {
			return {
				pass: false,
				detail: `${validate.command} is still the unfilled template.`,
				fix: "Replace the placeholder steps with this repo's commands (references/stacks.md).",
			}
		}
		return { pass: true, detail: validate.command }
	})

	check('tests', 'error', 'The project has tests', () => {
		const tests = files.filter((file) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(file)))
		if (tests.length > 0) return { pass: true, detail: `${tests.length} test file${tests.length === 1 ? '' : 's'}` }
		return truncated
			? { pass: false, level: 'warn', detail: `No test files in the first ${maxFiles} files scanned.` }
			: { pass: false, detail: 'No test files found.', fix: 'Add a first test for the riskiest logic.' }
	})

	check('ci', 'error', 'CI runs on every push or pull request', () => {
		const unfilled = flows.find(({ text }) => TEMPLATE_MARKERS.test(text))
		if (unfilled) {
			return {
				pass: false,
				detail: `${unfilled.name} still has a template placeholder.`,
				fix: "Replace {{FACTORY:SETUP}} with this stack's setup steps (references/stacks.md).",
			}
		}
		const triggered = flows.filter(({ triggers }) => triggers.some((name) => /^(push|pull_request(_target)?)$/.test(name)))
		return triggered.length > 0
			? { pass: true, detail: triggered.map(({ name }) => name).join(', ') }
			: {
					pass: false,
					detail: flows.length ? 'Workflows exist but none run on push or pull_request.' : 'No GitHub Actions workflows.',
					fix: 'Copy templates/shared/.github/workflows/ci.yml.',
				}
	})

	check('ci-validate', 'warn', 'CI runs the validate command', () =>
		flows.some(({ active }) => /scripts\/validate|npm run validate|make validate/.test(active))
			? { pass: true }
			: {
					pass: false,
					detail: 'CI and local runs can disagree when CI has its own list of checks.',
					fix: 'Make the CI job call the validate command.',
				},
	)

	// The doctor runs in CI when a workflow calls it, or calls a validate
	// script that runs a doctor file that actually exists.
	const doctorCall = /\bnode\s+(\S*doctor\.mjs)\b/
	const runsDoctor = (text) => {
		const match = doctorCall.exec(text)
		return Boolean(match && isFile(join(root, match[1])))
	}
	const validateRunsDoctor = validate?.command === 'scripts/validate' && runsDoctor(activeLines(validate.text))

	check('ci-doctor', 'warn', 'CI runs this doctor', () =>
		flows.some(({ active }) => runsDoctor(active) || (validateRunsDoctor && /scripts\/validate/.test(active)))
			? { pass: true }
			: {
					pass: false,
					detail: 'Without it, the repo can drift from the checklist unnoticed.',
					fix: 'Vendor the doctor as scripts/factory-doctor.mjs and run it from scripts/validate.',
				},
	)

	check('hooks', 'warn', 'Git hooks run checks before commits', () => {
		const fixed = ['.githooks/pre-commit', '.husky/pre-commit', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml']
		const hook =
			fixed.find((file) => isFile(join(root, file))) ?? files.find((file) => /^[^/]+\/\.husky\/pre-commit$/.test(file))
		return hook
			? { pass: true, detail: hook }
			: {
					pass: false,
					detail: 'No pre-commit hook.',
					fix: 'Copy templates/shared/.githooks and run scripts/setup-hooks.',
				}
	})

	check('pr-template', 'warn', 'PR template asks for intent, door and testing', () => {
		const template =
			findCaseInsensitive(root, ['.github', '', 'docs'], 'pull_request_template.md') ??
			findCaseInsensitive(root, ['.github'], 'pull_request_template')
		return template
			? { pass: true, detail: template }
			: { pass: false, detail: 'No PR template.', fix: 'Copy templates/shared/.github/pull_request_template.md.' }
	})

	const deployFlows = flows.filter(({ name, active, triggers }) => {
		if (triggers.every((trigger) => PR_ONLY_TRIGGERS.has(trigger))) return false
		// A dry-run build in CI is not a deploy.
		const commands = active
			.split('\n')
			.filter((line) => !/dry-run/.test(line))
			.join('\n')
		const pushesImage = /docker\/build-push-action/.test(commands) && /^\s*push:\s*true\b/m.test(commands)
		return /deploy/i.test(name) || DEPLOY_COMMAND.test(commands) || pushesImage
	})
	const deployConfig =
		['vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'eas.json'].find((file) => isFile(join(root, file))) ??
		// ci_scripts/ sits next to the Xcode project, which may be in a subfolder.
		files.find((file) => /(^|\/)(eas\.json|fastlane\/Fastfile|ci_scripts\/ci_post_clone\.sh)$/.test(file))

	check('deploy', 'error', 'Deploys are automated', () => {
		if (deployFlows.length > 0) return { pass: true, detail: deployFlows.map(({ name }) => name).join(', ') }
		if (deployConfig) return { pass: true, detail: `${deployConfig} (check the platform deploys from main on its own)` }
		return {
			pass: false,
			detail: 'No deploy workflow or platform config.',
			fix: 'Add the deploy job for this stack (references/stacks.md), or skip with a reason in .factory.json.',
		}
	})

	check('deploy-verified', 'warn', 'Each deploy is checked after it goes out', () =>
		deployFlows.some(({ active }) => DEPLOY_CHECK.test(active))
			? { pass: true }
			: {
					pass: false,
					detail: 'Nothing checks a health endpoint or smoke test after deploying.',
					fix: 'End the deploy job with a health check that compares the commit SHA.',
				},
	)

	check('no-secrets', 'error', 'No .env files with secrets are committed', () => {
		const tracked = git(root, ['ls-files'])
		const list = tracked == null ? files : tracked.split('\n')
		const leaked = list.filter((file) => /(^|\/)\.env(\.[\w-]+)*$/.test(file) && !/\.(example|sample|template)$/.test(file))
		return leaked.length === 0
			? { pass: true }
			: {
					pass: false,
					detail: `Committed: ${leaked.join(', ')}.`,
					fix: 'Remove the file from git, rotate every secret in it, and commit a .env.example instead.',
				}
	})

	return { root, version: DOCTOR_VERSION, stack: detectStack(files, root), notices, results }
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
		...report.notices.map((notice) => `! ${notice}`),
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
	let report
	try {
		report = runChecks(dir)
	} catch (error) {
		if (!(error instanceof DoctorConfigError)) throw error
		if (flags.has('--json')) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2))
		console.error(`factory doctor: ${error.message}`)
		return 2
	}
	const strict = flags.has('--strict')
	const { ok } = summarize(report, { strict })
	console.log(flags.has('--json') ? JSON.stringify({ ...report, ok }, null, 2) : formatReport(report))
	return ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2))
}
