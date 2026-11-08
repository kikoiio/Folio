import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const commandTimeoutMs = 60_000
const maximumWaitMs = 30 * 60_000
const statuses = new Set(['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed'])
const failures = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])

function validateRepository(repository) {
  if (typeof repository !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(repository)
    || ['.', '..'].includes(repository.split('/')[1])) {
    throw new TypeError('GitHub repository 必须是有效的 owner/name')
  }
}

function validateRevision(revision) {
  if (typeof revision !== 'string' || !revision || revision.trim() !== revision || /[\x00-\x1f\x7f]/.test(revision)) {
    throw new TypeError('发布 revision 必须是非空且不含控制字符的字符串')
  }
}

function runId(value) {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new TypeError('GitHub Actions run ID 必须是正的安全整数')
  }
  return Number(value)
}

function runUrl(repository, id, supplied) {
  const expected = `https://github.com/${repository}/actions/runs/${id}`
  if (supplied != null && supplied !== expected) throw new Error(`GitHub Actions URL 与仓库或 run ID 不匹配：${expected}`)
  return expected
}

function normalizeRun(repository, revision, data, id = data?.databaseId) {
  id = runId(id)
  if (!data || !statuses.has(data.status) || (data.conclusion != null && typeof data.conclusion !== 'string')) {
    throw new Error('GitHub Actions 返回了无效的运行状态')
  }
  return { id, url: runUrl(repository, id, data.url), revision, status: data.status, conclusion: data.conclusion || null }
}

function timeoutError(message, code) {
  return Object.assign(new Error(message), { name: 'TimeoutError', code })
}

function cancellation(signal) {
  if (signal.reason?.code === 'FOLIO_WAIT_TIMEOUT' || signal.reason?.code === 'FOLIO_GH_TIMEOUT') return signal.reason
  return Object.assign(new Error('GitHub 发布操作已取消', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
}

// Racing the signal also bounds injected commands/pauses that ignore cancellation.
async function bounded(action, { signal, timeoutMs, error }) {
  if (signal?.aborted) throw cancellation(signal)
  const controller = new AbortController()
  let rejectStopped
  const stopped = new Promise((_, reject) => { rejectStopped = reject })
  const stop = reason => {
    rejectStopped(reason)
    controller.abort(reason)
  }
  const abort = () => stop(cancellation(signal))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop(error), timeoutMs)
  try {
    return await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return action(controller.signal)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function execGh(args, { signal }) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8', signal, timeout: commandTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

async function command(runCommand, args, signal, description) {
  try {
    const stdout = await bounded(innerSignal => runCommand(args, { signal: innerSignal }), {
      signal, timeoutMs: commandTimeoutMs,
      error: timeoutError(`${description}超时（60 秒），请检查 gh 登录和网络连接`, 'FOLIO_GH_TIMEOUT'),
    })
    if (typeof stdout !== 'string') throw new TypeError('runCommand 必须返回 stdout 字符串')
    return stdout
  } catch (error) {
    if (signal?.aborted) throw cancellation(signal)
    if (error?.name === 'AbortError' || error?.code === 'FOLIO_GH_TIMEOUT') throw error
    throw new Error(`${description}失败：${error?.message ?? error}`, { cause: error })
  }
}

function parseJSON(stdout, description) {
  try { return JSON.parse(stdout) } catch (error) {
    throw new Error(`${description}返回了无效的 JSON`, { cause: error })
  }
}

/** Enable publishing, dispatch deploy.yml, and return { id, url, revision }.
 * runCommand(args, { signal }) returns gh stdout. Each command has a 60s limit.
 * If dispatch prints no run URL, look up the exact title once; missing runs throw
 * explicitly so callers can retry findDeployment without dispatching twice.
 */
export async function dispatchDeployment({ repository, revision, signal, runCommand = execGh }) {
  validateRepository(repository)
  validateRevision(revision)
  await command(runCommand, ['variable', 'set', 'FOLIO_PUBLISH_ENABLED', '--repo', repository, '--body', 'true'], signal, '启用 GitHub 发布')
  const stdout = await command(runCommand, ['workflow', 'run', 'deploy.yml', '--repo', repository, '-f', `revision=${revision}`], signal, '发起 GitHub 发布')
  const urls = [...new Set((stdout.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).filter(url => url.includes('/actions/runs/')))]
  if (urls.length) {
    if (urls.length !== 1) throw new Error('GitHub 发布输出包含多个 run URL，无法确认本次任务')
    const match = urls[0].match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)$/)
    if (!match || match[1] !== repository) throw new Error('GitHub 发布返回的 run URL 与目标仓库不匹配')
    const id = runId(match[2])
    return { id, url: runUrl(repository, id, urls[0]), revision }
  }
  const run = await findDeployment({ repository, revision, signal, runCommand })
  if (!run) throw new Error('发布已发起，但尚未找到对应的 GitHub Actions run；请稍后调用 findDeployment，勿重复发起发布')
  return { id: run.id, url: run.url, revision }
}

/** Return the newest exact `Publish ${revision}` match among the latest 100
 * workflow_dispatch runs of deploy.yml, or null. No SHA/prefix matching.
 */
export async function findDeployment({ repository, revision, signal, runCommand = execGh }) {
  validateRepository(repository)
  validateRevision(revision)
  const stdout = await command(runCommand, [
    'run', 'list', '--repo', repository, '--workflow', 'deploy.yml', '--event', 'workflow_dispatch', '--limit', '100',
    '--json', 'databaseId,status,conclusion,url,displayTitle,createdAt',
  ], signal, '查找 GitHub 发布任务')
  const runs = parseJSON(stdout, 'GitHub 发布任务列表')
  if (!Array.isArray(runs)) throw new Error('GitHub 发布任务列表必须是数组')
  const matches = runs.filter(run => run?.displayTitle === `Publish ${revision}`).map(run => {
    const createdAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : NaN
    if (!Number.isFinite(createdAt)) throw new Error('GitHub 发布任务包含无效的 createdAt')
    return { run: normalizeRun(repository, revision, run), createdAt }
  })
  matches.sort((a, b) => b.createdAt - a.createdAt || b.run.id - a.run.id)
  return matches[0]?.run ?? null
}

function stepName(job, step) {
  return [job.name || '发布任务', step?.name].filter(Boolean).join(' / ')
}

function failedStep(jobs) {
  for (const job of jobs) {
    const step = job.steps?.find(item => failures.has(item.conclusion))
    if (step || failures.has(job.conclusion)) return stepName(job, step)
  }
  return null
}

const runningStages = new Map([
  ['Set up job', '准备发布环境'],
  ['Check out website source', '准备发布环境'],
  ['Set up Node.js', '准备发布环境'],
  ['Install dependencies', '准备发布环境'],
  ['Check photo reuse and cacheable image responses', '检查内容'],
  ['Check seven-day storage retention', '检查内容'],
  ['Check publication diff, duplicate protection and progress', '检查内容'],
  ['Restore immutable archive from private R2', '准备发布内容'],
  ['Process pictures and build static site', '构建网站'],
  ['Add release marker for safe storage reconciliation', '准备部署网站'],
  ['Install browser for gallery interaction checks', '验证网站'],
  ['Check mobile gestures and desktop gallery motion', '验证网站'],
  ['Save gallery interaction screenshots', '验证网站'],
  ['Deploy to Cloudflare Pages', '部署网站'],
  ['Mark unused objects and clean those unused for seven days', '整理存储'],
])

function runningStage(step) {
  if (typeof step?.name === 'string' && /^(?:Post .+|Complete job)$/.test(step.name)) return '整理发布环境'
  return runningStages.get(step?.name) ?? '云端正在处理发布任务'
}

function progressMessage(run, jobs) {
  if (run.status === 'completed') {
    const conclusions = {
      success: '已完成', failure: '失败', cancelled: '已取消', timed_out: '执行超时',
      skipped: '已跳过', neutral: '已结束', action_required: '需要人工处理',
      startup_failure: '启动失败', stale: '已失效',
    }
    return `GitHub Actions 发布流程${conclusions[run.conclusion] ?? `已结束（${run.conclusion ?? '未提供结果'}）`}${run.failedStep ? `：${run.failedStep}` : ''}`
  }
  const active = jobs.find(job => job.status === 'in_progress')
  if (active) {
    const step = active.steps?.find(item => item.status === 'in_progress')
    if (step) return runningStage(step)
    const completed = active.steps?.findLast(item => item.status === 'completed')
    return completed ? runningStage(completed) : '准备发布环境'
  }
  if (run.failedStep) return `发布步骤失败：${run.failedStep}，等待流程结束`
  if (run.status === 'waiting') return '发布任务等待审批或部署环境就绪'
  if (run.status === 'in_progress') return '准备发布环境'
  return '等待云端开始发布'
}

/** Poll a { id, url?, revision } run. Return { id, url, revision, status,
 * conclusion, failedStep }, where failedStep is a "job / step" string or null.
 * Completed failures are returned, not thrown. Timeout returns pending/timed_out;
 * abort rejects with AbortError, command timeout with FOLIO_GH_TIMEOUT, and query
 * errors reject explicitly. Default/max deadline: 30min; default interval: 5s.
 * pause(ms, { signal }) is injectable and abortable. Immediate fake pauses consume
 * their requested time budget, so tests cannot poll indefinitely. report(event)
 * may be async and is covered by the overall deadline, like commands and pauses.
 */
export async function waitForDeploymentRun({
  repository, run, signal, report = () => {}, runCommand = execGh,
  pause = (ms, options) => sleep(ms, undefined, options), intervalMs = 5_000, timeoutMs = maximumWaitMs,
}) {
  validateRepository(repository)
  validateRevision(run?.revision)
  const id = runId(run?.id)
  let latest = { id, url: runUrl(repository, id, run.url), revision: run.revision, status: 'pending', conclusion: null, failedStep: null }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > maximumWaitMs
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumWaitMs) {
    throw new TypeError('intervalMs 和 timeoutMs 必须是 1 到 1800000 之间的整数毫秒')
  }
  let previousMessage
  let budget = timeoutMs
  const deadline = performance.now() + timeoutMs
  const remaining = () => Math.min(budget, deadline - performance.now())
  const expired = timeoutError('等待 GitHub 发布任务超时，请通过任务 URL 检查后续结果', 'FOLIO_WAIT_TIMEOUT')
  try {
    return await bounded(async monitorSignal => {
      while (remaining() > 0) {
        const started = performance.now()
        const stdout = await command(runCommand, ['run', 'view', String(id), '--repo', repository, '--json', 'status,conclusion,url,jobs'], monitorSignal, '查询 GitHub 发布状态')
        const data = parseJSON(stdout, 'GitHub 发布状态')
        const jobs = data?.jobs ?? []
        if (!Array.isArray(jobs) || jobs.some(job => !job || (job.steps != null && (!Array.isArray(job.steps) || job.steps.some(step => !step))))) {
          throw new Error('GitHub 发布状态包含无效的 jobs/steps')
        }
        latest = { ...normalizeRun(repository, run.revision, data, id), failedStep: failedStep(jobs) }
        const message = progressMessage(latest, jobs)
        if (message !== previousMessage) {
          previousMessage = message
          await report({ type: 'progress', phase: 'deploying', message, url: latest.url })
        }
        if (monitorSignal.aborted) throw monitorSignal.reason
        budget -= performance.now() - started
        if (remaining() <= 0) throw expired
        if (latest.status === 'completed') return latest
        const delay = Math.min(intervalMs, remaining())
        const paused = performance.now()
        await pause(delay, { signal: monitorSignal })
        if (monitorSignal.aborted) throw monitorSignal.reason
        budget -= Math.max(delay, performance.now() - paused)
      }
      throw expired
    }, { signal, timeoutMs, error: expired })
  } catch (error) {
    if (error !== expired) throw error
    return { ...latest, status: 'pending', conclusion: 'timed_out' }
  }
}
