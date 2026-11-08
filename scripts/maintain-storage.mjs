import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { archiveRoot } from './archive.mjs'
import { cloudflareClient, required } from './cloudflare.mjs'
import { photoRecipe } from './photo-variants.mjs'
import { validateRelease } from './release.mjs'
import { maintainStorage } from './storage-retention.mjs'
import { pagesSite, storageMaintenanceClient, waitForDeployment, withStorageLease } from './storage-maintenance.mjs'

const mode = process.argv[2]
if (!['prepare', 'preview', 'apply'].includes(mode)) throw new Error('Usage: node scripts/maintain-storage.mjs prepare|preview|apply')
if (mode !== 'preview' && !process.env.CI) throw new Error('Deployment preparation and storage cleanup run only in cloud CI')
const site = await pagesSite(cloudflareClient({ gateway: '' }), required('CLOUDFLARE_PAGES_PROJECT'))
const markerURL = new URL('/folio-release.json', site)
async function liveMarker(allowMissing = false) {
  markerURL.searchParams.set('verify', randomUUID())
  const response = await fetch(markerURL, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (allowMissing && response.status === 404) { await response.body?.cancel(); return null }
  if (response.status !== 200 || !response.headers.get('Cache-Control')?.includes('no-store')) throw new Error(`Deployment verification failed: HTTP ${response.status} or cacheable marker`)
  const body = await response.text()
  if (body.length > 1000) throw new Error('Deployment marker too large')
  const value = JSON.parse(body)
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.revision)
    || !/^[a-f0-9]{64}$/.test(value.deploymentId)) throw new Error('Invalid production deployment marker')
  return value
}
if (mode === 'prepare') {
  const release = validateRelease(JSON.parse(await fs.readFile(path.join(archiveRoot, 'release.json'), 'utf8')))
  const previous = await liveMarker(true)
  await fs.writeFile('out/folio-release.json', JSON.stringify({ version: 1, revision: release.revision, recipe: photoRecipe,
    deploymentId: createHash('sha256').update(randomUUID()).digest('hex'), previousDeploymentId: previous?.deploymentId ?? null }))
} else {
  let marker
  if (mode === 'apply') {
    const expected = validateRelease(JSON.parse(await fs.readFile(path.join(archiveRoot, 'release.json'), 'utf8')))
    const prepared = JSON.parse(await fs.readFile('out/folio-release.json', 'utf8'))
    console.log('Waiting for the new deployment before storage cleanup')
    marker = await waitForDeployment(() => liveMarker(true), { revision: expected.revision, recipe: photoRecipe, deploymentId: prepared.deploymentId })
  } else marker = await liveMarker()
  const api = await storageMaintenanceClient()
  const summary = await withStorageLease(api, lease => maintainStorage({
    api, lease, sourceBucket: required('FOLIO_SOURCE_BUCKET'), marker, apply: mode === 'apply',
    async assertDeployed() {
      const current = await liveMarker()
      if (current.deploymentId !== marker.deploymentId || current.revision !== marker.revision || current.recipe !== marker.recipe) throw new Error('Live deployment changed; cleanup stopped')
    },
  }))
  console.log(JSON.stringify(summary, null, 2))
}
