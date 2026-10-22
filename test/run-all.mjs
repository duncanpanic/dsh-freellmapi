/**
 * Run every test file in this directory and report a summary.
 *
 * Each test is a standalone script that exits non-zero on failure (they use
 * `node:assert` and print a "checks passed" line at the end), so this runner
 * only has to spawn them one at a time. They are kept offline on purpose:
 * `fetch` is stubbed per case, so the suite needs no network and no keys.
 *
 * Run: node test/run-all.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const self = fileURLToPath(import.meta.url)

const files = readdirSync(here)
  .filter(name => name.endsWith('.mjs') && join(here, name) !== self)
  .sort()

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

const failures = []

for (const name of files) {
  const result = spawnSync(process.execPath, [join(here, name)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  })
  if (result.status !== 0) failures.push({ name, status: result.status })
}

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${files.length}:`)
  for (const { name, status } of failures) {
    console.error(`  - ${name} (exit ${status ?? 'signal'})`)
  }
  process.exit(1)
}

console.log(`ok — ${files.length} test files passed`)
