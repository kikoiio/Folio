import test from 'node:test'
import assert from 'node:assert/strict'
import { revisionFor } from './release.mjs'
import { maintainStorage, releaseObjects, retentionPlan as planRetention } from './storage-retention.mjs'
import { pagesSite, waitForDeployment, withStorageLease } from './storage-maintenance.mjs'
import { publishRelease } from './publish-release.mjs'
import { restoreRelease } from './restore-release.mjs'
import buildWorker from '../workers/build.mjs'
import { retentionLeaseKey, retentionStateKey } from '../workers/storage-keys.mjs'

const day = 86_400_000
const start = Date.UTC(2026, 10, 7)
const hash = character => character.repeat(64)
const revision = hash('a')
const retentionPlan = options => planRetention({ deploymentId: revision, previousDeploymentId: revision, ...options })
const source = (key = `sources/${hash('b')}`, uploaded = start - 100 * day) => ({ kind: 'source', key, uploaded: new Date(uploaded).toISOString(), size: 10 })
const emptyRelease = { version: 1, files: [], revision: revisionFor([]) }

test('old uploads get seven days from first becoming unused, never from upload age', () => {
  const object = source()
  const first = retentionPlan({ objects: [object], referenced: [], previous: null, now: start, revision })
  assert.equal(first.expired.length, 0)
  const before = retentionPlan({ objects: [object], referenced: [], previous: first.state, now: start + 7 * day - 1, revision })
  assert.equal(before.expired.length, 0)
  const after = retentionPlan({ objects: [object], referenced: [], previous: first.state, now: start + 7 * day, revision })
  assert.deepEqual(after.expired.map(object => object.key), [object.key])
})

test('restoring a reference cancels its timer durably and another removal starts seven new days', () => {
  const object = source()
  const first = retentionPlan({ objects: [object], referenced: [], previous: null, now: start, revision })
  const restored = retentionPlan({ objects: [object], referenced: [object], previous: first.state, now: start + 6 * day, revision })
  assert.deepEqual(restored.state.unused, [])
  const removedAgain = retentionPlan({ objects: [object], referenced: [], previous: restored.state, now: start + 8 * day, revision })
  assert.equal(removedAgain.state.unused[0].since, start + 8 * day)
  assert.equal(removedAgain.expired.length, 0)
})

test('reuploaded objects restart their grace period; unmanaged keys are never deleted', () => {
  const first = retentionPlan({ objects: [source()], referenced: [], previous: null, now: start, revision })
  const current = retentionPlan({ objects: [source(undefined, start + 7 * day), source('maintenance/other.json')], referenced: [], previous: first.state, now: start + 8 * day, revision })
  assert.equal(current.state.unused.length, 1)
  assert.equal(current.expired.length, 0)
})

test('malformed ledgers and inventories fail closed', () => {
  const base = { objects: [source()], referenced: [], previous: null, now: start, revision }
  for (const previous of [{}, undefined, { version: 1, unused: [], checkedAt: start + 1, activeRevision: revision }]) {
    assert.throws(() => retentionPlan({ ...base, previous }), /ledger/)
  }
  assert.throws(() => retentionPlan({ ...base, objects: [source(), source()] }), /Duplicate/)
  assert.throws(() => retentionPlan({ ...base, objects: [{ ...source(), uploaded: 'invalid' }] }), /inventory/)
})

test('the deployed recipe protects exactly its own variants', () => {
  const files = [{ path: 'pictures/one.jpg', size: 10, sha256: hash('b'), objectKey: `sources/${hash('b')}` }]
  const release = { version: 1, revision: revisionFor(files), files }
  assert(releaseObjects(release, 'v1').some(object => object.key === `images/v1/${hash('b')}/2400.webp`))
  assert(!releaseObjects(release, 'v1').some(object => object.key.includes('/1600.webp')))
  assert.throws(() => releaseObjects(release, 'v3'), /recipe/)
})

function collectionFixture() {
  const active = emptyRelease
  const files = [{ path: 'blogs/pending.md', size: 10, sha256: hash('c'), objectKey: `sources/${hash('c')}` }]
  const pending = { version: 1, revision: revisionFor(files), files }
  let objects = [source(`releases/${active.revision}.json`), source(`releases/${pending.revision}.json`), source(files[0].objectKey), source()]
  let ledger = null
  const deleted = []
  const api = { async getJSON(_bucket, key) { return key === 'releases/latest.json' ? pending : active } }
  const lease = {
    async inventory(kind, prefix) { return objects.filter(object => object.kind === kind && object.key.startsWith(prefix)) },
    async state() { return ledger }, async save(value) { ledger = value },
    async remove(object) { deleted.push(object.key); objects = objects.filter(item => item.key !== object.key) },
  }
  const options = { api, lease, sourceBucket: 'source', marker: { version: 1, revision: active.revision, recipe: 'v2', deploymentId: revision, previousDeploymentId: null }, now: start, apply: true }
  return { options, deleted, ledger: () => ledger }
}

test('successful reconciliation protects both live and pending releases and deletes only on a later publish', async () => {
  const fixture = collectionFixture()
  const first = await maintainStorage(fixture.options)
  assert.equal(first.managedUnused, 1)
  assert.deepEqual(fixture.deleted, [])
  await maintainStorage({ ...fixture.options, now: start + 8 * day })
  assert.deepEqual(fixture.deleted, [`sources/${hash('b')}`])
})

test('preview never writes or deletes, including already expired objects', async () => {
  const fixture = collectionFixture()
  await maintainStorage(fixture.options)
  const before = fixture.ledger()
  const result = await maintainStorage({ ...fixture.options, apply: false, now: start + 8 * day })
  assert.equal(result.eligibleForDeletion, 1)
  assert.equal(fixture.ledger(), before)
  assert.deepEqual(fixture.deleted, [])
})

test('missing references, a changed live marker, incomplete inventory or ledger write failure cause zero deletes', async () => {
  for (const failure of ['missing', 'marker', 'inventory', 'save']) {
    const fixture = collectionFixture()
    await maintainStorage(fixture.options)
    if (failure === 'missing') fixture.options.lease.inventory = async () => []
    if (failure === 'marker') fixture.options.assertDeployed = async () => { throw new Error('Deployment changed') }
    if (failure === 'inventory') fixture.options.lease.inventory = async () => { throw new Error('Page failed') }
    if (failure === 'save') fixture.options.lease.save = async () => { throw new Error('Write failed') }
    await assert.rejects(maintainStorage({ ...fixture.options, now: start + 8 * day }))
    assert.deepEqual(fixture.deleted, [], failure)
  }
})

test('metadata is invalidated before deleting image variants', () => {
  const objects = ['images/v2/' + hash('b') + '/640.webp', 'metadata/v2/' + hash('b') + '.json'].map(key => ({ ...source(key), kind: 'media' }))
  const first = retentionPlan({ objects, referenced: [], previous: null, now: start, revision })
  const after = retentionPlan({ objects, referenced: [], previous: first.state, now: start + 7 * day, revision })
  assert(after.expired[0].key.startsWith('metadata/'))
})

function memoryBucket() {
  const objects = new Map()
  let sequence = 0
  return {
    objects,
    async get(key) { const item = objects.get(key); return item ? { etag: item.etag, async json() { return JSON.parse(item.body) } } : null },
    async put(key, body, options = {}) {
      const old = objects.get(key)
      if (options.onlyIf instanceof Headers && options.onlyIf.has('If-None-Match') && old) return null
      if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag) return null
      const etag = String(++sequence)
      objects.set(key, { body, etag })
      return { etag }
    },
    async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, size: 10, uploaded: new Date(start) })), truncated: false } },
    async delete(key) { objects.delete(key) },
  }
}

test('authenticated maintenance serializes publishers, rejects stale owners, and scopes deletion', async () => {
  const bucket = memoryBucket()
  const env = { BUILD_TOKEN: 'test', SOURCES: bucket, MEDIA: memoryBucket() }
  async function call(path, method = 'GET', body, owner) {
    return buildWorker.fetch(new Request(`https://build.example/${path}`, {
      method, headers: { Authorization: 'Bearer test', ...(owner ? { 'X-Folio-Lease': owner } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env)
  }
  const owner = '11111111-1111-4111-8111-111111111111'
  const rival = '22222222-2222-4222-8222-222222222222'
  assert.equal((await call('maintenance/state')).status, 409)
  assert.equal((await call('maintenance/lease', 'POST', { owner, mode: 'acquire' })).status, 200)
  assert.equal((await call('maintenance/lease', 'POST', { owner: rival, mode: 'acquire' })).status, 409)
  assert.equal((await call('maintenance/state', 'GET', null, rival)).status, 409)
  assert.equal((await call(`maintenance/object?bucket=source&key=${retentionStateKey}`, 'DELETE', null, owner)).status, 400)
  const orphan = `sources/${hash('b')}`
  await bucket.put(orphan, 'photo')
  assert.equal((await call(`maintenance/object?bucket=source&key=${orphan}`, 'DELETE', null, owner)).status, 200)
  assert(!bucket.objects.has(orphan))
  assert.equal((await call('maintenance/lease', 'POST', { owner, mode: 'release' })).status, 200)
  assert.equal((await call('maintenance/lease', 'POST', { owner: rival, mode: 'acquire' })).status, 200)
  assert.equal((await call('maintenance/lease', 'POST', { owner, mode: 'release' })).status, 409)
  await bucket.put(retentionLeaseKey, JSON.stringify({ owner: rival, expires: Date.now() - 1 }))
  assert.equal((await call('maintenance/lease', 'POST', { owner, mode: 'acquire' })).status, 409, 'An expired holder cannot be silently replaced')
  assert.equal((await call('maintenance/lease', 'POST', { owner: rival, mode: 'release' })).status, 200)
})

test('incomplete cursor pagination aborts before exposing a partial inventory', async () => {
  const api = { async request(endpoint) {
    if (endpoint.startsWith('maintenance/inventory')) return Response.json({ objects: [], truncated: true, cursor: 'same' })
    return Response.json({ success: true })
  } }
  await assert.rejects(withStorageLease(api, lease => lease.inventory('source', 'sources/')), /Incomplete/)
})

test('losing the publication lease stops uploads before the latest release can advance', async () => {
  await assert.rejects(publishRelease({
    archiveRoot: '.', manifest: 'unused', sourceBucket: 'source',
    release: { files: [{ objectKey: `sources/${hash('b')}`, size: 10 }] },
    async checkLease() { throw new Error('Lease expired') },
    client: { async exists() { assert.fail('Must not inspect or upload after losing the lease') } },
    requestBuild() { assert.fail('Must not deploy after losing the lease') },
  }), /Lease expired/)
})

test('restoring an immutable revision rejects a valid manifest stored under the wrong key', async () => {
  await assert.rejects(restoreRelease({
    client: { async getJSON() { return emptyRelease } },
    bucket: 'source', destination: '.', revision: hash('d'),
  }), /Requested release revision mismatch/)
})

test('a restoration whose reconciliation failed cannot cause immediate deletion on the next publication', () => {
  const object = source()
  const first = retentionPlan({ objects: [object], referenced: [], previous: null, now: start, revision })
  // Deployment B restored the object on day 6, but never persisted its ledger.
  // Deployment C removes it on day 8, so A -> C must restart the grace period.
  const after = retentionPlan({ objects: [object], referenced: [], previous: first.state, now: start + 8 * day,
    revision, deploymentId: hash('c'), previousDeploymentId: hash('b') })
  assert.equal(after.expired.length, 0)
  assert.equal(after.state.unused[0].since, start + 8 * day)
})

test('Pages project names resolve through the API instead of assuming a matching hostname', async () => {
  const api = { async request(endpoint) {
    assert.equal(endpoint, 'pages/projects/blog')
    return Response.json({ success: true, result: { subdomain: 'blog-b99.pages.dev' } })
  } }
  assert.equal(await pagesSite(api, 'blog'), 'https://blog-b99.pages.dev')
})

test('deployment verification waits until the exact release, recipe and deployment are visible', async () => {
  const expected = { revision, recipe: 'v2', deploymentId: hash('d') }
  const markers = [
    { ...expected, revision: hash('b') },
    null,
    { ...expected, recipe: 'v1' },
    { ...expected, deploymentId: hash('c') },
    expected,
  ]
  const delays = []
  let reads = 0
  const actual = await waitForDeployment(async () => markers[reads++], expected, {
    attempts: 5, intervalMs: 7, pause: async milliseconds => { delays.push(milliseconds) },
  })
  assert.equal(actual, expected)
  assert.equal(reads, 5)
  assert.deepEqual(delays, [7, 7, 7, 7])
})

test('deployment verification stays bounded when only an older deployment of the same release is live', async () => {
  const expected = { revision, recipe: 'v2', deploymentId: hash('d') }
  let reads = 0
  const delays = []
  await assert.rejects(waitForDeployment(async () => {
    reads++
    return { ...expected, deploymentId: hash('c') }
  }, expected, { attempts: 3, intervalMs: 7, pause: async milliseconds => { delays.push(milliseconds) } }), /The new release is not live; cleanup stopped/)
  assert.equal(reads, 3)
  assert.deepEqual(delays, [7, 7])
})

test('deployment verification rejects invalid marker reads without retrying or waiting', async () => {
  let reads = 0
  await assert.rejects(waitForDeployment(async () => {
    reads++
    throw new Error('Invalid production deployment marker')
  }, { revision, recipe: 'v2', deploymentId: hash('d') }, {
    pause: async () => { assert.fail('Invalid deployment data must not be retried') },
  }), /Invalid production deployment marker/)
  assert.equal(reads, 1)
})
