import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { cloudflareClient } from './cloudflare.mjs'

export async function pagesSite(api, project) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Invalid Pages project')
  const data = await (await api.request(`pages/projects/${project}`)).json()
  if (!data.success || typeof data.result?.subdomain !== 'string' || !/^[a-z0-9-]+\.pages\.dev$/.test(data.result.subdomain)) throw new Error('Cannot resolve the production Pages hostname')
  return `https://${data.result.subdomain}`
}

export async function waitForDeployment(readMarker, expected, {
  attempts = 12, intervalMs = 5000, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const marker = await readMarker()
    if (marker && marker.revision === expected.revision && marker.recipe === expected.recipe && marker.deploymentId === expected.deploymentId) return marker
    if (attempt + 1 < attempts) await pause(intervalMs)
  }
  throw new Error('The new release is not live; cleanup stopped')
}

export async function storageMaintenanceClient() {
  let gateway = process.env.FOLIO_BUILD_URL
  let token = process.env.FOLIO_STORAGE_TOKEN
  if (!gateway) gateway = JSON.parse(await fs.readFile(new URL('../.folio/cloudflare-setup.json', import.meta.url), 'utf8')).FOLIO_BUILD_URL
  if (!token) token = (await fs.readFile(new URL('../.folio/storage-token', import.meta.url), 'utf8')).trim()
  if (!gateway || !token) throw new Error('Run Cloudflare setup before publishing or maintaining storage')
  return cloudflareClient({ gateway, token })
}

export async function withStorageLease(api, work) {
  const owner = randomUUID()
  async function update(mode) {
    const response = await api.request('maintenance/lease', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: () => JSON.stringify({ owner, mode }),
    })
    await response.body?.cancel()
  }
  await update('acquire')
  const headers = { 'X-Folio-Lease': owner }
  const lease = {
    renew: () => update('renew'),
    async state() { return (await api.request('maintenance/state', { headers })).json() },
    async save(state) {
      await update('renew')
      const response = await api.request('maintenance/state', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: () => JSON.stringify(state) })
      await response.body?.cancel()
    },
    async inventory(kind, prefix) {
      const objects = []
      const cursors = new Set()
      let cursor = ''
      do {
        await update('renew')
        const params = new URLSearchParams({ bucket: kind, prefix, ...(cursor ? { cursor } : {}) })
        const page = await (await api.request(`maintenance/inventory?${params}`, { headers })).json()
        if (!Array.isArray(page.objects) || typeof page.truncated !== 'boolean') throw new Error('Invalid R2 inventory')
        objects.push(...page.objects.map(object => ({ ...object, kind })))
        if (!page.truncated) break
        if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) throw new Error('Incomplete R2 inventory')
        cursor = page.cursor
        cursors.add(cursor)
      } while (cursor)
      return objects
    },
    async remove({ kind, key }) {
      await update('renew')
      const params = new URLSearchParams({ bucket: kind, key })
      const response = await api.request(`maintenance/object?${params}`, { method: 'DELETE', headers })
      await response.body?.cancel()
    },
  }
  try { return await work(lease) } finally { await update('release') }
}
