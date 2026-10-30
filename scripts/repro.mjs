import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = require('next/package.json').version
const reportDir = path.join(root, 'results', version)
const scratch = path.join(root, '.repro')
const probes = ['no-cache', 'cacheable', 'default']
const responseKeys = ['noCache', 'cacheable', 'defaultCache']
const files = ['fixtures/trigger.js', ...probes.map((name) => `fixtures/${name}.probe`)]
const originals = new Map(await Promise.all(files.map(async (name) => [name, await readFile(path.join(root, name), 'utf8')])))
const requestedBundlers = process.argv.filter((arg) => arg.startsWith('--bundler=')).map((arg) => arg.split('=')[1])
const bundlers = requestedBundlers.length ? requestedBundlers : ['webpack', 'turbopack']
assert(bundlers.every((name) => ['webpack', 'turbopack'].includes(name)), 'Unknown bundler')
let activeChild

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    try {
      if (activeChild) await stop(activeChild)
      await restoreFiles()
    } finally {
      process.exit(code)
    }
  })
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function restoreFiles() {
  await Promise.all([...originals].map(([name, content]) => writeFile(path.join(root, name), content)))
}

async function readEvents() {
  const text = await readFile(path.join(scratch, 'loader.jsonl'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : []
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  process.kill(-child.pid, 'SIGTERM')
  const deadline = Date.now() + 5000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL')
}

async function run(bundler) {
  await restoreFiles()
  await rm(path.join(root, '.next'), { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  await writeFile(path.join(scratch, 'external.txt'), 'external-v1\n')
  const port = await freePort()
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', `--${bundler}`, '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    detached: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChild = child
  let serverLog = ''
  child.stdout.on('data', (data) => { serverLog += data.toString() })
  child.stderr.on('data', (data) => { serverLog += data.toString() })
  let spawnError
  child.on('error', (error) => { spawnError = error })
  const phases = []

  async function requestUntil(predicate, label) {
    const deadline = Date.now() + 90000
    let last
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      assert(child.exitCode === null && child.signalCode === null, `${bundler} exited early\n${serverLog}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/probe`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
        last = response.ok ? await response.json() : `HTTP ${response.status}: ${(await response.text()).slice(0,500)}`
        if (response.ok && predicate(last)) return last
      } catch (error) {
        last = error.message
      }
      await delay(200)
    }
    throw new Error(`${bundler}: timed out waiting for ${label}: ${JSON.stringify(last)}\n${serverLog}`)
  }

  async function snapshot(label, trigger, source = 'source-v1') {
    await requestUntil((value) => value.trigger === trigger && responseKeys.every((key) => value[key]?.source === source), label)
    await delay(700)
    const value = await requestUntil((value) => value.trigger === trigger && responseKeys.every((key) => value[key]?.source === source), label)
    const events = await readEvents()
    const calls = Object.fromEntries(probes.map((name) => [name, events.filter((event) => event.name === name).length]))
    phases.push({ label, value, calls })
    console.log(`${bundler.padEnd(9)} ${label.padEnd(20)} trigger=${value.trigger} no-cache=${value.noCache.external} cacheable=${value.cacheable.external} default=${value.defaultCache.external} calls=${JSON.stringify(calls)}`)
    return value
  }

  try {
    const initial = await snapshot('initial', 'trigger-0')
    for (const key of responseKeys) assert.equal(initial[key].external, 'external-v1')

    await writeFile(path.join(scratch, 'external.txt'), 'external-v2\n')
    const hidden = await snapshot('hidden-input-only', 'trigger-0')
    assert.deepEqual(hidden, initial, 'Changing only the unregistered input unexpectedly triggered recompilation')

    for (const round of [1, 2]) {
      const external = `external-v${round + 2}`
      await writeFile(path.join(scratch, 'external.txt'), external + '\n')
      await writeFile(path.join(root, 'fixtures/trigger.js'), `export default 'trigger-${round}'\n`)
      const value = await snapshot(`unrelated-edit-${round}`, `trigger-${round}`)
      assert.equal(value.cacheable.external, 'external-v1', 'cacheable(true) control unexpectedly rebuilt')
      assert.equal(value.defaultCache.external, 'external-v1', 'default-cache control unexpectedly rebuilt')
      if (bundler === 'webpack') assert.equal(value.noCache.external, external, 'webpack did not honor cacheable(false)')
    }

    await writeFile(path.join(scratch, 'external.txt'), 'external-v5\n')
    await Promise.all(probes.map((name) => writeFile(path.join(root, `fixtures/${name}.probe`), 'source-v2\n')))
    const direct = await snapshot('direct-source-edit', 'trigger-2', 'source-v2')
    for (const key of responseKeys) assert.equal(direct[key].external, 'external-v5', 'Direct source invalidation did not refresh loader output')
    const unrelated = phases.filter((phase) => phase.label.startsWith('unrelated-edit'))
    const honorsCacheableFalse = unrelated.every((phase, index) => phase.value.noCache.external === `external-v${index + 3}`)
    return { bundler, honorsCacheableFalse, phases }
  } finally {
    await stop(child)
    activeChild = undefined
    await writeFile(path.join(reportDir, `${bundler}-server.log`), serverLog.replaceAll(root, '<repo>'))
    const events = await readEvents()
    await writeFile(path.join(reportDir, `${bundler}-loader.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
}

await mkdir(reportDir, { recursive: true })
const report = {
  recordedAt: new Date().toISOString(),
  environment: { node: process.version, next: version, react: require('react/package.json').version, platform: process.platform, architecture: process.arch, osRelease: os.release() },
  results: [],
}
try {
  for (const bundler of bundlers) report.results.push(await run(bundler))
  await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`\nSaved results/${version}/report.json`)
  for (const result of report.results) console.log(`${result.bundler}: cacheable(false) ${result.honorsCacheableFalse ? 'HONORED' : 'NOT HONORED'} on unrelated recompilations`)
  if (process.argv.includes('--assert-compatible')) assert(report.results.every((result) => result.honorsCacheableFalse), 'cacheable(false) was not honored; see the saved report')
} finally {
  await restoreFiles()
}
