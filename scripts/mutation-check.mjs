#!/usr/bin/env node
// Proves every doctor check has a test that notices when it breaks. For each
// check id, it runs the suite twice against a copy of the doctor whose check
// always passes, then always fails. A run that stays green is a gap.

import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_IDS } from '../plugin/doctor/doctor.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const doctorPath = 'plugin/doctor/doctor.mjs'
const source = readFileSync(join(repo, doctorPath), 'utf8')
const outcomeLine = 'const { pass, level: levelOverride, ...outcome } = run()'
if (!source.includes(outcomeLine)) {
	console.error(`mutation-check: can't find "${outcomeLine}" in ${doctorPath}; update this script with the doctor.`)
	process.exit(2)
}

function runSuite(dir) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: dir, stdio: 'ignore' })
		child.on('close', (code) => resolve(code))
	})
}

async function tryMutant(id, forced) {
	const dir = mkdtempSync(join(tmpdir(), 'factory-mutant-'))
	try {
		for (const part of ['plugin', 'test', 'README.md']) cpSync(join(repo, part), join(dir, part), { recursive: true })
		const mutated = source.replace(
			outcomeLine,
			`const { pass: actualPass, level: levelOverride, ...outcome } = run()\n\t\tconst pass = id === ${JSON.stringify(id)} ? ${forced} : actualPass`,
		)
		writeFileSync(join(dir, doctorPath), mutated)
		const code = await runSuite(dir)
		return { id, forced, caught: code !== 0 }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const mutants = CHECK_IDS.flatMap((id) => [
	[id, true],
	[id, false],
])
const results = []
const workers = Math.max(1, Math.min(availableParallelism(), 8))
let next = 0
await Promise.all(
	Array.from({ length: workers }, async () => {
		while (next < mutants.length) {
			const [id, forced] = mutants[next++]
			results.push(await tryMutant(id, forced))
		}
	}),
)

const survivors = results.filter((entry) => !entry.caught)
for (const { id, forced } of survivors) {
	console.error(`✗ "${id}" can be made to always ${forced ? 'pass' : 'fail'} and every test still passes.`)
}
if (survivors.length > 0) {
	console.error('Add a test that fails when the check gives that answer.')
	process.exit(1)
}
console.log(`✓ all ${mutants.length} mutants caught (${CHECK_IDS.length} checks × always pass / always fail)`)
