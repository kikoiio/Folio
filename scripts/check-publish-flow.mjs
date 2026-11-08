import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { revisionFor } from './release.mjs'
import { publicationPlan, publishArchive, releaseDiff } from './publish-flow.mjs'
import { acquirePublishLock } from './publish-lock.mjs'
import { cloudflareClient } from './cloudflare.mjs'
import { withStorageLease } from './storage-maintenance.mjs'

const file = (name, character = 'a') => ({ path: name, size: 10, sha256: character.repeat(64), objectKey: `sources/${character.repeat(64)}` })
const release = files => ({ version: 1, files, revision: revisionFor(files) })
const previous = release([file('blogs/one.md'), file('pictures/one.jpg')])
const changed = release([file('blogs/one.md', 'b'), file('site/config.json', 'c')])

function fixture() {
  const events = []
  let latest = previous
  let marker = { revision: previous.revision }
  let leased = false
  let uploads = 0
  let dispatches = 0
  const run = { id: 1, url: 'https://github.com/example/folio/actions/runs/1', status: 'in_progress' }
  const options = {
    release: changed,
    readLatest: async () => latest,
    readMarker: async () => marker,
    withLease: async work => { leased = true; try { return await work({}) } finally { leased = false } },
    publish: async () => { assert(leased); uploads++; dispatches++; latest = changed; return { uploaded: 2, run } },
    dispatch: async () => { dispatches++; return run },
    findRun: async () => run,
    waitRun: async () => { assert(!leased, 'Do not keep the storage lease while waiting for CI'); marker = { revision: changed.revision }; return { ...run, status: 'completed', conclusion: 'success' } },
    report: event => { events.push(event) },
    verifyAttempts: 2, pause: async () => {},
  }
  return { options, events, counts: () => ({ uploads, dispatches }), setLatest: value => { latest = value }, setMarker: value => { marker = value } }
}

test('diff covers added, edited and deleted content by path and hash', () => {
  assert.deepEqual(releaseDiff(previous, changed), { added: ['site/config.json'], modified: ['blogs/one.md'], removed: ['pictures/one.jpg'] })
  assert.deepEqual(releaseDiff(changed, changed), { added: [], modified: [], removed: [] })
})

test('unchanged content creates no upload, storage lease or build request', async () => {
  const f = fixture()
  f.options.release = previous
  for (const key of ['withLease', 'publish', 'dispatch', 'findRun', 'waitRun']) f.options[key] = async () => { assert.fail(`${key} must not run without changes`) }
  assert.equal((await publishArchive(f.options)).status, 'unchanged')
  assert.equal(f.events.at(-1).message, '内容没有变化，网站已是最新，已跳过发布。')
})

test('equivalent files in another manifest order do not trigger a rebuild', () => {
  const reordered = release([...previous.files].reverse())
  assert.notEqual(reordered.revision, previous.revision)
  assert(publicationPlan(reordered, previous, { revision: previous.revision }).unchanged)
})

test('check-only reports differences without acquiring a lease or publishing', async () => {
  const f = fixture()
  f.options.checkOnly = true
  f.options.withLease = async () => { assert.fail('Checking must not acquire the cloud lease') }
  assert.equal((await publishArchive(f.options)).status, 'changes')
  assert.deepEqual(f.counts(), { uploads: 0, dispatches: 0 })
  assert.deepEqual(f.events.find(event => event.type === 'diff').modified, ['blogs/one.md'])
})

test('a changed archive waits for confirmed website publication; the next invocation is a no-op', async () => {
  const f = fixture()
  assert.equal((await publishArchive(f.options)).status, 'published')
  assert(f.events.some(event => event.phase === 'verifying'))
  assert.equal((await publishArchive(f.options)).status, 'unchanged')
  assert.deepEqual(f.counts(), { uploads: 1, dispatches: 1 })
})

test('an already uploaded archive follows its existing build without uploading or dispatching again', async () => {
  const f = fixture()
  f.setLatest(changed)
  f.options.withLease = async () => { assert.fail('An existing build needs no upload lease') }
  assert.equal((await publishArchive(f.options)).status, 'published')
  assert.deepEqual(f.counts(), { uploads: 0, dispatches: 0 })
})

test('rechecking under the lease prevents duplicate uploads after a competing publisher', async () => {
  const f = fixture()
  const lease = f.options.withLease
  f.options.withLease = async work => { f.setLatest(changed); return lease(work) }
  assert.equal((await publishArchive(f.options)).status, 'published')
  assert.deepEqual(f.counts(), { uploads: 0, dispatches: 0 })
})

test('an uploaded revision whose previous build failed can be deployed again without uploading originals', async () => {
  const f = fixture()
  f.setLatest(changed)
  f.options.findRun = async () => ({ status: 'completed', conclusion: 'failure' })
  assert.equal((await publishArchive(f.options)).status, 'published')
  assert.deepEqual(f.counts(), { uploads: 0, dispatches: 1 })
})

test('failed deployment never produces a published result', async () => {
  const f = fixture()
  f.options.waitRun = async () => ({ status: 'completed', conclusion: 'failure', failedStep: 'Build' })
  const result = await publishArchive(f.options)
  assert.equal(result.status, 'failed')
  assert.match(result.message, /Build/)
})

test('a deployed page with failed post-deployment cleanup gets an explicit partial-success result', async () => {
  const f = fixture()
  f.options.waitRun = async () => { f.setMarker({ revision: changed.revision }); return { status: 'completed', conclusion: 'failure', failedStep: 'Cleanup' } }
  assert.equal((await publishArchive(f.options)).status, 'published_with_warning')
})

test('a successful workflow without the expected online revision is not reported as published', async () => {
  const f = fixture()
  f.options.waitRun = async () => ({ status: 'completed', conclusion: 'success' })
  assert.equal((await publishArchive(f.options)).status, 'failed')
})

test('a workflow wait timeout reports pending rather than claiming completion', async () => {
  const f = fixture()
  f.options.waitRun = async () => ({ status: 'in_progress', conclusion: 'timed_out' })
  assert.equal((await publishArchive(f.options)).status, 'pending')
})

test('cancelled publication does not access remote state', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  f.options.signal = controller.signal
  f.options.readLatest = async () => { assert.fail('Do not read remote state after cancellation') }
  await assert.rejects(publishArchive(f.options), { name: 'AbortError' })
})

test('local Linux publication protection rejects duplicate runs and releases automatically on close', { skip: process.platform !== 'linux' }, async t => {
  await fs.mkdir('.tmp', { recursive: true })
  const root = await fs.mkdtemp(path.resolve('.tmp/publish-lock-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const close = await acquirePublishLock(root)
  assert(close)
  try { assert.equal(await acquirePublishLock(root), null) } finally { await close() }
  const next = await acquirePublishLock(root)
  assert(next)
  await next()
})

test('a killed local publisher does not leave a stale local lock', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  await fs.mkdir('.tmp', { recursive: true })
  const root = await fs.mkdtemp(path.resolve('.tmp/publish-crash-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const code = `import { acquirePublishLock } from ${JSON.stringify(new URL('./publish-lock.mjs', import.meta.url).href)}; await acquirePublishLock(${JSON.stringify(root)}); process.stdout.write('locked'); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await once(child.stdout, 'data')
  assert.equal(await acquirePublishLock(root), null)
  const ended = once(child, 'close')
  child.kill('SIGKILL')
  await ended
  const close = await acquirePublishLock(root)
  assert(close)
  await close()
})

test('cancelling an upload still releases the independent cloud storage lease', async t => {
  const originalFetch = globalThis.fetch
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture'
  t.after(() => {
    globalThis.fetch = originalFetch
    if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
    else process.env.CLOUDFLARE_ACCOUNT_ID = account
  })
  let ready
  const started = new Promise(resolve => { ready = resolve })
  globalThis.fetch = async (_url, options) => new Promise((_, reject) => {
    ready()
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  const controller = new AbortController()
  const client = cloudflareClient({ gateway: 'https://build.example', token: 'fixture', signal: controller.signal })
  const modes = []
  const leaseAPI = { async request(_endpoint, options) { modes.push(JSON.parse(options.body()).mode); return Response.json({ success: true }) } }
  const pending = withStorageLease(leaseAPI, () => client.request('upload'))
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await started
  controller.abort()
  await rejected
  assert.deepEqual(modes, ['acquire', 'release'])
})

test('CLI startup failures produce a final JSON result instead of leaving an executing state', async t => {
  await fs.mkdir('.tmp', { recursive: true })
  const root = await fs.mkdtemp(path.resolve('.tmp/publish-cli-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let failed
  try {
    await promisify(execFile)(process.execPath, ['scripts/publish.mjs', '--prepare', '--json'], {
      cwd: path.resolve('.'), env: { ...process.env, FOLIO_ARCHIVE_PATH: root }, timeout: 10000,
    })
  } catch (error) { failed = error }
  assert.equal(failed?.code, 1)
  const records = failed.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.at(-1).type, 'result')
  assert.equal(records.at(-1).status, 'failed')
  assert.match(records.at(-1).message, /发布失败/)
})
