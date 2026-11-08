import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { archiveRoot, projectRoot } from './archive.mjs'
import { createRelease } from './release.mjs'
import { cloudflareClient, required } from './cloudflare.mjs'
import { publishRelease } from './publish-release.mjs'
import { readSite } from './site-config.mjs'
import { pagesSite, storageMaintenanceClient, withStorageLease } from './storage-maintenance.mjs'
import { acquirePublishLock } from './publish-lock.mjs'
import { publishArchive } from './publish-flow.mjs'
import { dispatchDeployment, findDeployment, waitForDeploymentRun } from './publish-workflow.mjs'

const flags = new Set(process.argv.slice(2))
const json = flags.has('--json')
const checkOnly = flags.has('--check') || flags.has('--diff')
const prepare = flags.has('--prepare')
const generatedRoot = path.join(projectRoot, '.folio')
const statusFile = path.join(generatedRoot, 'publish-status.json')
const sessionId = randomUUID()
const controller = new AbortController()
const signal = controller.signal
const cancel = () => controller.abort(new Error('发布已中断。'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
const timeout = setTimeout(() => controller.abort(new Error('发布等待超时，请查看部署记录。')), 40 * 60 * 1000)
timeout.unref()
let writable = true
process.stdout.on('error', error => { if (error.code === 'EPIPE') writable = false })
let ownsLock = false
let site
let last = {}
let writes = Promise.resolve()
let stateWriteError

function report(event) {
  const value = { ...(last.revision ? { revision: last.revision } : {}), ...(last.url ? { url: last.url } : {}), ...event, ...(site ? { site } : {}), pid: process.pid, sessionId, updatedAt: new Date().toISOString() }
  if (value.type !== 'diff') last = value
  else last = { ...last, revision: value.revision }
  if (writable) {
    if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
    else if (value.type === 'diff') {
      process.stdout.write(`内容差异：新增 ${value.added.length}，修改 ${value.modified.length}，删除 ${value.removed.length}\n`)
      for (const [kind, label] of [['added', '新增'], ['modified', '修改'], ['removed', '删除']]) {
        for (const filename of value[kind]) process.stdout.write(`  ${label} ${filename}\n`)
      }
    } else process.stdout.write(`${value.message}\n${value.type === 'result' && value.url ? `部署记录：${value.url}\n` : ''}`)
  }
  if (ownsLock && value.type !== 'diff') {
    writes = writes.then(async () => {
      const temporary = `${statusFile}.${process.pid}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
      await fs.rename(temporary, statusFile)
      stateWriteError = undefined
    }).catch(error => { stateWriteError = error })
  }
}

function failure(error) {
  let message = error instanceof Error ? error.message : String(error)
  if (/Cloudflare HTTP 409/.test(message)) message = '云端存储正被占用，本次发布未完成。请稍后重试；中断遗留的锁需核查后恢复。'
  if (/Archive changed during upload|File changed during publishing/.test(message)) message = '发布期间内容发生变化，本次未部署。请等编辑完成后重试。'
  const pending = signal.aborted && !!last.url
  report({ type: 'result', status: pending ? 'pending' : 'failed', message: pending ? '已停止本地等待，云端任务可能仍在继续，请查看部署记录。' : `发布失败：${message}` })
  process.exitCode = pending ? 2 : 1
}

async function savedStatus() {
  try { return JSON.parse(await fs.readFile(statusFile, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    return null
  }
}

async function main() {
  for (const flag of flags) if (!['--json', '--check', '--diff', '--prepare'].includes(flag)) throw new Error(`未知参数：${flag}`)
  if (!archiveRoot) throw new Error('请先配置 FOLIO_ARCHIVE_PATH，指向文章和图片所在目录。')
  const previous = await savedStatus()
  let unlock
  let temporary
  if (!checkOnly && !prepare) {
    unlock = await acquirePublishLock(generatedRoot)
    if (!unlock) {
      report({ type: 'result', status: 'already_running', message: '已有发布任务正在运行，已跳过重复触发。', ...(previous?.url ? { url: previous.url } : {}) })
      return
    }
    ownsLock = true
  }
  try {
    report({ type: 'progress', phase: 'checking', message: '正在检查文章、图片和站点配置…' })
    await readSite(archiveRoot)
    const release = await createRelease(archiveRoot)
    if (!checkOnly) {
      await fs.mkdir(generatedRoot, { recursive: true })
      await fs.writeFile(path.join(generatedRoot, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
    }
    if (prepare) {
      report({ type: 'result', status: 'prepared', revision: release.revision, message: `已在本地准备 ${release.files.length} 个文件，尚未上传或部署。` })
      return
    }
    const sourceBucket = required('FOLIO_SOURCE_BUCKET')
    const repository = required('FOLIO_WEBSITE_REPOSITORY')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('网站仓库配置格式无效。')
    const client = cloudflareClient({ gateway: '', signal })
    site = await pagesSite(client, required('CLOUDFLARE_PAGES_PROJECT'))
    async function readMarker() {
      const url = new URL('/folio-release.json', site)
      url.searchParams.set('verify', randomUUID())
      const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
      if (response.status === 404) { await response.body?.cancel(); return null }
      if (!response.ok || !response.headers.get('Cache-Control')?.includes('no-store')) throw new Error(`无法确认网站版本：HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 1000) throw new Error('网站版本标记过大。')
      const marker = JSON.parse(text)
      if (marker?.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.revision) || !/^[a-f0-9]{64}$/.test(marker.deploymentId)) throw new Error('网站版本标记无效。')
      return marker
    }
    const dispatch = revision => dispatchDeployment({ repository, revision, signal })
    const result = await publishArchive({
      release, signal, checkOnly, report,
      readLatest: () => client.getJSON(sourceBucket, 'releases/latest.json', true),
      readMarker,
      withLease: async work => withStorageLease(await storageMaintenanceClient(), work),
      async publish(lease) {
        await fs.mkdir(path.join(projectRoot, '.tmp'), { recursive: true })
        temporary = await fs.mkdtemp(path.join(projectRoot, '.tmp/publish-'))
        const manifest = path.join(temporary, 'release.json')
        await fs.writeFile(manifest, JSON.stringify(release))
        let run
        let current = 0
        const uploaded = await publishRelease({
          archiveRoot, release, manifest, sourceBucket, client,
          checkLease: async () => { signal.throwIfAborted(); await lease.renew() },
          report() {
            current++
            report({ type: 'progress', phase: 'uploading', current, total: release.files.length, message: `正在确认云端文件 ${current}/${release.files.length}…` })
          },
          async requestBuild(revision) {
            run = await dispatch(revision)
            report({ type: 'progress', phase: 'deploying', revision, url: run.url, message: '上传完成，已请求云端部署…' })
          },
        })
        return { uploaded, run }
      },
      dispatch,
      async findRun(revision) {
        if (previous?.revision === revision && typeof previous.url === 'string') {
          const prefix = `https://github.com/${repository}/actions/runs/`
          const suffix = previous.url.startsWith(prefix) ? previous.url.slice(prefix.length) : ''
          if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) return { id: Number(suffix), url: previous.url, revision, status: 'in_progress' }
        }
        return findDeployment({ repository, revision, signal })
      },
      waitRun: run => waitForDeploymentRun({ repository, run, signal, report }),
    })
    if (['failed', 'pending', 'published_with_warning'].includes(result.status)) process.exitCode = result.status === 'failed' ? 1 : 2
  } catch (error) {
    failure(error)
  } finally {
    try {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true })
      await writes
      if (stateWriteError && !json && writable) process.stdout.write('本次结果未能保存到本地记录，请以当前窗口和部署记录为准。\n')
    } finally {
      if (unlock) await unlock()
      ownsLock = false
    }
  }
}

try {
  await main()
} catch (error) {
  failure(error)
  await writes.catch(() => {})
} finally {
  clearTimeout(timeout)
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
}
