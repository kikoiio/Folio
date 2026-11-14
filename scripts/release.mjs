import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const pictureTypes = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif'])
const blogTypes = new Set([...pictureTypes, '.md', '.mdx', '.html', '.svg', '.gif', '.pdf', '.txt'])
const siteFiles = new Set(['site/config.json', 'site/icon.png'])
const sort = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const hashPattern = /^[a-f0-9]{64}$/

export async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export function revisionFor(files) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

export function validArchivePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return false
  if (siteFiles.has(value)) return true
  const parts = value.split('/')
  if (!['blogs', 'pictures'].includes(parts.shift()) || parts.length === 0) return false
  if (parts.some(part => !part || part.startsWith('.'))) return false
  const extension = path.posix.extname(value).toLowerCase()
  return (value.startsWith('pictures/') ? pictureTypes : blogTypes).has(extension)
}

export function validateRelease(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !hashPattern.test(value.revision) || !Array.isArray(value.files)) {
    throw new Error('Invalid Folio release manifest')
  }
  const seen = new Set()
  for (const entry of value.files) {
    if (!entry || !validArchivePath(entry.path) || seen.has(entry.path) ||
      !hashPattern.test(entry.sha256) || entry.objectKey !== `sources/${entry.sha256}` ||
      !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 300 * 1024 * 1024) {
      throw new Error('Invalid file entry in Folio release')
    }
    seen.add(entry.path)
  }
  if (revisionFor(value.files) !== value.revision) throw new Error('Release checksum mismatch')
  return value
}

export async function createRelease(root) {
  const files = []
  async function walk(relative, optional = false) {
    let directory
    try {
      directory = await fs.lstat(path.join(root, relative))
    } catch (error) {
      if (optional && error.code === 'ENOENT') return
      throw error
    }
    if (!directory.isDirectory()) return
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => sort.compare(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory() && relative !== 'site') await walk(name)
      else if (entry.isFile() && validArchivePath(name)) {
        const source = path.join(root, name)
        const before = await fs.stat(source)
        const sha256 = await hashFile(source)
        const after = await fs.stat(source)
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`File changed during publishing: ${name}`)
        files.push({ path: name, sha256, size: before.size, objectKey: `sources/${sha256}` })
      }
    }
  }
  for (const directory of ['blogs', 'pictures']) await walk(directory)
  await walk('site', true)
  return validateRelease({ version: 1, revision: revisionFor(files), files })
}
