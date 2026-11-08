import { setTimeout as delay } from 'node:timers/promises'
import { validateRelease } from './release.mjs'

export function releaseDiff(previous, current) {
  validateRelease(current)
  if (previous) validateRelease(previous)
  const before = new Map((previous?.files ?? []).map(file => [file.path, file]))
  const after = new Map(current.files.map(file => [file.path, file]))
  return {
    added: current.files.filter(file => !before.has(file.path)).map(file => file.path),
    modified: current.files.filter(file => before.has(file.path) &&
      (before.get(file.path).sha256 !== file.sha256 || before.get(file.path).size !== file.size)).map(file => file.path),
    removed: (previous?.files ?? []).filter(file => !after.has(file.path)).map(file => file.path),
  }
}

export function publicationPlan(release, latest, marker) {
  const diff = releaseDiff(latest, release)
  const needsUpload = !latest || Object.values(diff).some(files => files.length)
  const revision = needsUpload ? release.revision : latest.revision
  return { diff, revision, needsUpload, unchanged: !needsUpload && marker?.revision === revision }
}

export async function publishArchive({
  release, readLatest, readMarker, withLease, publish, dispatch, findRun, waitRun,
  report = () => {}, checkOnly = false, signal,
  verifyAttempts = 12, intervalMs = 5000,
  pause = milliseconds => delay(milliseconds, undefined, { signal }),
}) {
  signal?.throwIfAborted()
  report({ type: 'progress', phase: 'checking', message: '正在比较本地内容与上次发布…' })
  let latest = await readLatest()
  let marker = await readMarker()
  let plan = publicationPlan(release, latest, marker)
  report({ type: 'diff', ...plan.diff, revision: plan.revision })
  const finish = (status, message, run) => {
    const result = { type: 'result', status, message, revision: plan.revision, ...(run?.url ? { url: run.url } : {}) }
    report(result)
    return result
  }
  if (plan.unchanged) return finish('unchanged', '内容没有变化，网站已是最新，已跳过发布。')
  if (checkOnly) return finish(plan.needsUpload ? 'changes' : 'pending', plan.needsUpload ? '检测到内容变化，尚未上传或启动部署。' : '内容已经上传，尚未确认上线。')

  let run
  if (plan.needsUpload) {
    await withLease(async lease => {
      signal?.throwIfAborted()
      latest = await readLatest()
      marker = await readMarker()
      plan = publicationPlan(release, latest, marker)
      if (!plan.needsUpload) return
      report({ type: 'progress', phase: 'uploading', message: '检测到内容变化，正在上传…' })
      const uploaded = await publish(lease)
      run = uploaded.run
    })
    if (plan.unchanged) return finish('unchanged', '内容已由另一项发布更新，已跳过重复发布。')
  }
  signal?.throwIfAborted()
  if (!run) {
    run = await findRun(plan.revision)
    if (!run || (run.status === 'completed' && run.conclusion !== 'success')) run = await dispatch(plan.revision)
  }
  report({ type: 'progress', phase: 'deploying', message: '上传已完成，正在等待云端构建与部署…', url: run.url, revision: plan.revision })
  const completed = await waitRun(run)
  signal?.throwIfAborted()
  report({ type: 'progress', phase: 'verifying', message: '正在确认网站已更新…', url: run.url, revision: plan.revision })
  let visible = false
  for (let attempt = 0; attempt < verifyAttempts; attempt++) {
    signal?.throwIfAborted()
    marker = await readMarker()
    if (marker?.revision === plan.revision) { visible = true; break }
    if (attempt + 1 < verifyAttempts) await pause(intervalMs)
  }
  if (completed.status !== 'completed') {
    return finish(visible ? 'published_with_warning' : 'pending', visible ? '文章已上线，但云端任务尚未完成；可查看部署进度。' : '等待云端结果超时，尚未确认上线；可查看部署进度。', run)
  }
  if (completed.conclusion !== 'success') {
    const step = completed.failedStep ? `（${completed.failedStep}）` : ''
    return finish(visible ? 'published_with_warning' : 'failed', visible ? `文章已上线，但云端后续检查未通过${step}。` : `云端部署未成功${step}，请查看部署记录。`, run)
  }
  if (!visible) return finish('failed', '云端任务已完成，但尚未确认网站内容已更新，请查看部署记录。', run)
  return finish('published', '发布成功，已确认网站更新。', run)
}
