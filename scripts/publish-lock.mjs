import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export async function acquirePublishLock(directory) {
  await fs.mkdir(directory, { recursive: true })
  if (process.platform !== 'linux') return async () => {}
  const handle = await fs.open(path.join(directory, 'publish.lock'), 'a')
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', handle.fd] })
      let error = ''
      child.stderr.on('data', chunk => { error = (error + chunk).slice(-1000) })
      child.once('error', reject)
      child.once('close', code => code === 0 || code === 1 ? resolve(code) : reject(new Error(`无法启用重复发布保护：${error || code}`)))
    })
    if (code === 1) { await handle.close(); return null }
    return () => handle.close()
  } catch (error) {
    await handle.close()
    throw error
  }
}
