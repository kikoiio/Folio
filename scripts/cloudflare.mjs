import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

export function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing configuration: ${name}`)
  return value
}

export function cloudflareClient(options = {}) {
  const externalSignal = options.signal
  const account = required('CLOUDFLARE_ACCOUNT_ID')
  const gateway = options.gateway ?? process.env.FOLIO_BUILD_URL
  let token = options.token ?? (gateway ? required('FOLIO_STORAGE_TOKEN') : process.env.CLOUDFLARE_API_TOKEN)
  if (!token && !process.env.CI) {
    const auth = JSON.parse(execFileSync('wrangler', ['auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }))
    token = auth.token
  }
  if (!token) throw new Error('Configure CLOUDFLARE_API_TOKEN or sign in with Wrangler locally')
  const base = gateway ? gateway.replace(/\/$/, '') : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}`
  if (!base.startsWith('https://')) throw new Error('Storage endpoint must use HTTPS')

  async function request(endpoint, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      externalSignal?.throwIfAborted()
      options.signal?.throwIfAborted()
      try {
        const response = await fetch(`${base}/${endpoint}`, {
          method: options.method ?? 'GET',
          headers: { Authorization: `Bearer ${token}`, ...options.headers },
          body: options.body?.(),
          ...(options.body ? { duplex: 'half' } : {}),
          signal: AbortSignal.any([AbortSignal.timeout(180_000), ...[externalSignal, options.signal].filter(Boolean)]),
        })
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
          await response.body?.cancel()
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1500))
          continue
        }
        if (response.status === 404 && options.allowMissing) {
          await response.body?.cancel()
          return null
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 800)
          throw new Error(`Cloudflare HTTP ${response.status}: ${detail}`)
        }
        return response
      } catch (error) {
        if (attempt === 2 || !(error instanceof TypeError || error.name === 'TimeoutError')) throw error
      }
    }
    throw new Error('Cloudflare request failed')
  }

  const objectPath = (bucket, key) => `r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`
  return {
    request,
    async exists(bucket, key, expectedSize) {
      const response = await request(objectPath(bucket, key), { allowMissing: true, headers: { Range: 'bytes=0-0' } })
      if (!response) return false
      const range = response.headers.get('content-range')
      const length = response.headers.get('content-length')
      let size
      if (range) size = Number(range.split('/').pop())
      else if (length && !response.headers.get('content-encoding')) size = Number(length)
      if (size === undefined && expectedSize !== undefined) {
        size = 0
        for await (const chunk of response.body) size += chunk.byteLength
      } else await response.body?.cancel()
      if (expectedSize !== undefined && size !== expectedSize) throw new Error(`Remote size mismatch: ${key}`)
      return true
    },
    async putFile(bucket, key, filename, contentType = 'application/octet-stream') {
      const stat = await fs.stat(filename)
      const response = await request(objectPath(bucket, key), {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Cache-Control': 'public, max-age=31536000, immutable' },
        body: () => createReadStream(filename),
      })
      await response.body?.cancel()
      if (!await this.exists(bucket, key, stat.size)) throw new Error(`Upload could not be verified: ${key}`)
    },
    async getFile(bucket, key, filename) {
      const response = await request(objectPath(bucket, key))
      await pipeline(Readable.fromWeb(response.body), createWriteStream(filename))
    },
    async getJSON(bucket, key, allowMissing = false) {
      const response = await request(objectPath(bucket, key), { allowMissing })
      return response ? response.json() : null
    },
  }
}
