import test from 'node:test'
import assert from 'node:assert/strict'
import * as workflow from './publish-workflow.mjs'

const { dispatchDeployment, findDeployment, waitForDeploymentRun } = workflow
const repository = 'owner/folio'
const revision = 'a'.repeat(64)
const urlFor = id => `https://github.com/${repository}/actions/runs/${id}`
const run = { id: 42, url: urlFor(42), revision }
const state = (status, options = {}) => ({ status, conclusion: null, url: run.url, jobs: [], ...options })
const listed = (id, createdAt, options = {}) => ({
  databaseId: id, createdAt, displayTitle: `Publish ${revision}`, status: 'queued', conclusion: null, url: urlFor(id), ...options,
})

function commands(...responses) {
  const calls = []
  const signals = []
  return {
    calls, signals,
    async runCommand(args, { signal }) {
      calls.push(args)
      signals.push(signal)
      assert(!signal.aborted)
      assert(responses.length, `Unexpected gh command: ${args.join(' ')}`)
      const response = responses.shift()
      if (response instanceof Error) throw response
      return typeof response === 'string' ? response : JSON.stringify(response)
    },
  }
}

const noPause = async () => { assert.fail('This test must not pause') }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('exports only the three workflow helpers', () => {
  assert.deepEqual(Object.keys(workflow).sort(), ['dispatchDeployment', 'findDeployment', 'waitForDeploymentRun'].sort())
})

test('dispatch enables publishing first and captures the printed exact run URL', async () => {
  const fake = commands('', `✓ Created workflow_dispatch event\n${run.url}\n`)
  assert.deepEqual(await dispatchDeployment({ repository, revision, runCommand: fake.runCommand }), run)
  assert.deepEqual(fake.calls, [
    ['variable', 'set', 'FOLIO_PUBLISH_ENABLED', '--repo', repository, '--body', 'true'],
    ['workflow', 'run', 'deploy.yml', '--repo', repository, '-f', `revision=${revision}`],
  ])
  assert(fake.signals.every(signal => signal instanceof AbortSignal))
})

test('revision is a literal argument, including shell metacharacters', async () => {
  const literal = 'release;$(touch forbidden) & echo `no`'
  const fake = commands('', run.url)
  assert.equal((await dispatchDeployment({ repository, revision: literal, runCommand: fake.runCommand })).revision, literal)
  assert.equal(fake.calls[1].at(-1), `revision=${literal}`)
})

test('dispatch falls back to the newest exact workflow title, never a prefix or SHA', async () => {
  const rows = [
    listed(50, '2026-11-08T10:00:00Z'),
    listed(999, '2026-11-08T12:00:00Z', { displayTitle: `Publish ${revision} extra` }),
    listed(998, '2026-11-08T12:00:00Z', { displayTitle: 'Publish another-revision', headSha: revision }),
    listed(40, '2026-11-08T11:00:00Z'),
  ]
  const fake = commands('', 'Created workflow_dispatch event for deploy.yml', rows)
  assert.deepEqual(await dispatchDeployment({ repository, revision, runCommand: fake.runCommand }), { id: 40, url: urlFor(40), revision })
  assert.deepEqual(fake.calls[2], [
    'run', 'list', '--repo', repository, '--workflow', 'deploy.yml', '--event', 'workflow_dispatch', '--limit', '100',
    '--json', 'databaseId,status,conclusion,url,displayTitle,createdAt',
  ])
})

test('find normalizes absent URLs/conclusions, breaks equal-date ties by ID, and returns null when absent', async () => {
  const date = '2026-11-08T10:00:00Z'
  const fake = commands([
    listed(41, date), listed(42, date, { databaseId: '42', url: undefined, conclusion: undefined }),
    listed(99, '2026-11-08T11:00:00Z', { displayTitle: `Publish ${revision.slice(0, -1)}` }),
  ], [])
  assert.deepEqual(await findDeployment({ repository, revision, runCommand: fake.runCommand }), { ...run, status: 'queued', conclusion: null })
  assert.equal(await findDeployment({ repository, revision, runCommand: fake.runCommand }), null)
})

test('missing fallback run throws explicitly without repeating dispatch', async () => {
  const fake = commands('', '', [])
  await assert.rejects(dispatchDeployment({ repository, revision, runCommand: fake.runCommand }), /发布已发起.*findDeployment/)
  assert.equal(fake.calls.filter(args => args[0] === 'workflow').length, 1)
})

test('dispatch rejects foreign, ambiguous, or malformed run URLs rather than falling back', async () => {
  for (const url of [
    'https://github.com/other/folio/actions/runs/42',
    'https://github.com/owner/folio-other/actions/runs/42',
    'https://github.com/owner/folio/actions/runs/42/extra',
    'https://github.com/owner/folio/actions/runs/42?next=evil',
    'https://github.com/owner/folio/actions/runs/42#fragment',
    'https://github.com/owner/folio/actions/runs/0',
    'https://github.com/owner/folio/actions/runs/1.5',
    'https://github.com/owner/folio/actions/runs/9007199254740992',
    'https://github.com.evil/owner/folio/actions/runs/42',
    'https://github.com@evil.test/owner/folio/actions/runs/42',
    'http://github.com/owner/folio/actions/runs/42',
    `${run.url}\n${urlFor(43)}`,
  ]) {
    const fake = commands('', url)
    await assert.rejects(dispatchDeployment({ repository, revision, runCommand: fake.runCommand }), /URL|安全整数/)
    assert.equal(fake.calls.length, 2)
  }
})

test('validates repository, revision, IDs, and input URLs before executing commands', async () => {
  const runCommand = async () => { assert.fail('Validation must precede gh') }
  for (const invalid of ['', 'owner', 'owner/repo/extra', '../repo', '-owner/repo', 'owner-/repo', 'owner/..', 'owner/.', 'owner/repo?x', 'owner/repo\n', 'https://github.com/owner/repo', 'owner with spaces/repo']) {
    await assert.rejects(dispatchDeployment({ repository: invalid, revision, runCommand }), /owner\/name/)
    await assert.rejects(findDeployment({ repository: invalid, revision, runCommand }), /owner\/name/)
    await assert.rejects(waitForDeploymentRun({ repository: invalid, run, runCommand }), /owner\/name/)
  }
  for (const invalid of ['', null, 123, ' revision', 'revision\n', 'revision\0']) {
    await assert.rejects(dispatchDeployment({ repository, revision: invalid, runCommand }), /revision/)
  }
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '01', '42/extra', {}, null]) {
    await assert.rejects(waitForDeploymentRun({ repository, run: { ...run, id }, runCommand }), /安全整数/)
  }
  await assert.rejects(waitForDeploymentRun({ repository, run: { ...run, url: urlFor(43) }, runCommand }), /URL/)
  await assert.rejects(waitForDeploymentRun({ repository, run: { ...run, url: 'https://github.com/owner/folio-other/actions/runs/42' }, runCommand }), /URL/)
})

test('find rejects invalid JSON, schemas, dates, IDs, and repository URLs', async () => {
  for (const response of [
    '{invalid', {}, [listed(42, 'not-a-date')], [listed(0, '2026-11-08T10:00:00Z')],
    [listed(42, '2026-11-08T10:00:00Z', { status: 'Executing' })],
    [listed(42, '2026-11-08T10:00:00Z', { url: 'https://evil.test/owner/folio/actions/runs/42' })],
  ]) {
    await assert.rejects(findDeployment({ repository, revision, runCommand: commands(response).runCommand }), /JSON|数组|createdAt|安全整数|状态|URL/)
  }
})

test('enabling failure stops dispatch and query exceptions preserve useful context', async () => {
  const failure = new Error('permission denied')
  const fake = commands(failure)
  await assert.rejects(dispatchDeployment({ repository, revision, runCommand: fake.runCommand }), error => {
    assert.match(error.message, /启用 GitHub 发布失败.*permission denied/)
    assert.equal(error.cause, failure)
    return true
  })
  assert.equal(fake.calls.length, 1)
  await assert.rejects(findDeployment({ repository, revision, runCommand: commands(failure).runCommand }), /查找 GitHub 发布任务失败.*permission denied/)
  await assert.rejects(findDeployment({ repository, revision, runCommand: async () => ({ stdout: '[]' }) }), /stdout 字符串/)
})

test('monitor emits readable Chinese stages once each and returns completed success', async () => {
  const preparing = state('in_progress', { jobs: [{ name: 'deploy', status: 'in_progress', steps: [] }] })
  const building = state('in_progress', { jobs: [{ name: 'deploy', status: 'in_progress', steps: [{ name: 'Process pictures and build static site', status: 'in_progress' }] }] })
  const deploying = state('in_progress', { jobs: [{ name: 'deploy', status: 'in_progress', steps: [{ name: 'Deploy to Cloudflare Pages', status: 'in_progress' }] }] })
  const fake = commands(state('queued'), state('queued'), state('waiting'), preparing, building, building, deploying, state('completed', { conclusion: 'success' }))
  const reports = []
  const delays = []
  const result = await waitForDeploymentRun({
    repository, run, runCommand: fake.runCommand, report: async event => { reports.push(event) },
    pause: async (ms, { signal }) => { assert(!signal.aborted); delays.push(ms) },
  })
  assert.deepEqual(result, { ...run, status: 'completed', conclusion: 'success', failedStep: null })
  assert.deepEqual(delays, Array(7).fill(5_000))
  assert.deepEqual(reports.map(event => event.message), [
    '等待云端开始发布', '发布任务等待审批或部署环境就绪',
    '准备发布环境', '构建网站', '部署网站', 'GitHub Actions 发布流程已完成',
  ])
  assert(reports.every(event => event.type === 'progress' && event.phase === 'deploying' && event.url === run.url))
  assert(fake.calls.every(args => JSON.stringify(args) === JSON.stringify(['run', 'view', '42', '--repo', repository, '--json', 'status,conclusion,url,jobs'])))
})

test('running workflow steps use Chinese stages, deduplicate shared stages, and hide unknown labels', async () => {
  const stages = [
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
    ['Post Set up Node.js', '整理发布环境'],
    ['Post Check out website source', '整理发布环境'],
    ['Complete job', '整理发布环境'],
    ['New internal implementation step', '云端正在处理发布任务'],
    ['Another unknown internal step', '云端正在处理发布任务'],
  ]
  const fake = commands(...stages.map(([name]) => state('in_progress', {
    jobs: [{ name: 'internal-job-label', status: 'in_progress', steps: [{ name, status: 'in_progress' }] }],
  })), state('completed', { conclusion: 'success' }))
  const reports = []
  await waitForDeploymentRun({ repository, run, runCommand: fake.runCommand, pause: async () => {}, report: event => reports.push(event) })
  const expected = stages.map(([, message]) => message).filter((message, index, messages) => index === 0 || message !== messages[index - 1])
  assert.deepEqual(reports.map(event => event.message), [...expected, 'GitHub Actions 发布流程已完成'])
  assert(reports.every(event => !/[a-z]/i.test(event.message.replace('GitHub Actions ', ''))))
})

test('completed workflow failure returns its failed step instead of throwing', async () => {
  const fake = commands(state('completed', {
    conclusion: 'failure', jobs: [{ name: 'deploy', status: 'completed', conclusion: 'failure', steps: [
      { name: 'Build', status: 'completed', conclusion: 'success' },
      { name: 'Deploy to Cloudflare Pages', status: 'completed', conclusion: 'failure' },
    ] }],
  }))
  const reports = []
  const result = await waitForDeploymentRun({ repository, run, runCommand: fake.runCommand, pause: noPause, report: event => reports.push(event) })
  assert.deepEqual(result, { ...run, status: 'completed', conclusion: 'failure', failedStep: 'deploy / Deploy to Cloudflare Pages' })
  assert.match(reports[0].message, /发布流程失败.*deploy.*Deploy to Cloudflare Pages/)
})

test('completed cancellation, job timeout, skipped job, and job-only failure are returned', async () => {
  for (const conclusion of ['cancelled', 'timed_out', 'skipped', 'failure']) {
    const fake = commands(state('completed', { conclusion, jobs: [{ name: 'deploy', status: 'completed', conclusion }] }))
    const result = await waitForDeploymentRun({ repository, run, runCommand: fake.runCommand, pause: noPause })
    assert.equal(result.status, 'completed')
    assert.equal(result.conclusion, conclusion)
    assert.equal(result.failedStep, conclusion === 'skipped' ? null : 'deploy')
  }
})

test('monitor constructs absent URLs and preserves the Chinese stage between steps', async () => {
  const reports = []
  const fake = commands(state('in_progress', { url: undefined, jobs: [{ name: 'deploy', status: 'in_progress', steps: [{ name: 'Install dependencies', status: 'completed', conclusion: 'success' }] }] }), state('completed', { conclusion: 'success' }))
  const result = await waitForDeploymentRun({ repository, run: { id: '42', revision }, runCommand: fake.runCommand, pause: async () => {}, report: event => reports.push(event) })
  assert.equal(result.url, run.url)
  assert.equal(reports[0].message, '准备发布环境')
})

test('monitor rejects query errors and malformed or cross-repository responses immediately', async () => {
  for (const response of [
    new Error('offline'), '{bad', null, state('Executing'), state('queued', { jobs: {} }),
    state('queued', { jobs: [null] }), state('queued', { jobs: [{ steps: [null] }] }),
    state('queued', { conclusion: {} }), state('queued', { url: urlFor(43) }),
    state('queued', { url: 'https://github.com/other/folio/actions/runs/42' }),
  ]) {
    const fake = commands(response)
    await assert.rejects(waitForDeploymentRun({ repository, run, runCommand: fake.runCommand, pause: noPause }), /查询 GitHub 发布状态失败.*offline|JSON|状态|jobs|URL/)
    assert.equal(fake.calls.length, 1)
  }
})

test('timeouts and polling intervals are validated before querying', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 1_800_001 }, { intervalMs: 0 }, { intervalMs: 1.5 }, { intervalMs: 1_800_001 }]) {
    await assert.rejects(waitForDeploymentRun({ repository, run, ...options, runCommand: async () => assert.fail('Must validate first') }), /整数毫秒/)
  }
})

test('immediate fake pauses consume a bounded timeout budget without sleeping', async () => {
  let polls = 0
  const delays = []
  const result = await waitForDeploymentRun({
    repository, run, timeoutMs: 120_000, intervalMs: 50_000,
    runCommand: async () => { polls++; assert(polls <= 3); return JSON.stringify(state('queued')) },
    pause: async delay => { delays.push(delay) },
  })
  assert.deepEqual(result, { ...run, status: 'pending', conclusion: 'timed_out', failedStep: null })
  assert.equal(polls, 3)
  assert.deepEqual(delays.slice(0, 2), [50_000, 50_000])
  assert(delays[2] > 0 && delays[2] <= 20_000)
})

test('pre-aborted signals cause explicit AbortError without any gh call', async () => {
  const signal = AbortSignal.abort(new Error('user stopped'))
  const runCommand = async () => { assert.fail('Aborted operation must not query') }
  for (const operation of [
    dispatchDeployment({ repository, revision, signal, runCommand }),
    findDeployment({ repository, revision, signal, runCommand }),
    waitForDeploymentRun({ repository, run, signal, runCommand }),
  ]) await assert.rejects(operation, { name: 'AbortError', message: 'GitHub 发布操作已取消' })
})

test('abort interrupts an uncooperative command and prevents subsequent dispatch', async () => {
  const controller = new AbortController()
  let calls = 0
  let commandSignal
  const pending = dispatchDeployment({ repository, revision, signal: controller.signal, runCommand: async (_args, { signal }) => {
    calls++; commandSignal = signal
    return new Promise(() => {})
  } })
  await flush()
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
  assert(commandSignal.aborted)
})

test('abort interrupts pauses even when the injected pause ignores its signal', async () => {
  const controller = new AbortController()
  const fake = commands(state('queued'))
  let pauseSignal
  const pending = waitForDeploymentRun({ repository, run, signal: controller.signal, runCommand: fake.runCommand, pause: async (_ms, { signal }) => {
    pauseSignal = signal
    return new Promise(() => {})
  } })
  await flush()
  assert(pauseSignal instanceof AbortSignal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert(pauseSignal.aborted)
  assert.equal(fake.calls.length, 1)
})

test('command deadline is enforced with simulated timers and aborts the gh signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const pending = dispatchDeployment({ repository, revision, runCommand: async (_args, options) => {
    signal = options.signal
    return new Promise(() => {})
  } })
  const rejection = assert.rejects(pending, { name: 'TimeoutError', code: 'FOLIO_GH_TIMEOUT' })
  await flush()
  t.mock.timers.tick(60_000)
  await rejection
  assert(signal.aborted)
})

test('overall deadline returns pending and interrupts a hung status query', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  let calls = 0
  const pending = waitForDeploymentRun({ repository, run, timeoutMs: 50, pause: noPause, runCommand: async (_args, options) => {
    calls++; signal = options.signal
    return new Promise(() => {})
  } })
  await flush()
  t.mock.timers.tick(50)
  assert.deepEqual(await pending, { ...run, status: 'pending', conclusion: 'timed_out', failedStep: null })
  assert(signal.aborted)
  assert.equal(calls, 1)
})

test('a hung status query with a longer overall deadline throws an explicit command timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = waitForDeploymentRun({ repository, run, pause: noPause, runCommand: async () => new Promise(() => {}) })
  const rejection = assert.rejects(pending, { name: 'TimeoutError', code: 'FOLIO_GH_TIMEOUT' })
  await flush()
  t.mock.timers.tick(60_000)
  await rejection
})

test('no further polls occur if an uncooperative pause resolves after the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fake = commands(state('in_progress'))
  let release
  let signal
  const pending = waitForDeploymentRun({ repository, run, timeoutMs: 50, runCommand: fake.runCommand, pause: async (_ms, options) => {
    signal = options.signal
    return new Promise(resolve => { release = resolve })
  } })
  await flush()
  assert.equal(typeof release, 'function')
  t.mock.timers.tick(50)
  assert.equal((await pending).conclusion, 'timed_out')
  assert(signal.aborted)
  release()
  await flush()
  assert.equal(fake.calls.length, 1)
})

test('async reporting is also bounded by the deadline, and synchronous reporting errors propagate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = waitForDeploymentRun({
    repository, run, timeoutMs: 50, runCommand: commands(state('queued')).runCommand, pause: noPause,
    report: async () => new Promise(() => {}),
  })
  await flush()
  t.mock.timers.tick(50)
  assert.equal((await pending).conclusion, 'timed_out')
  await assert.rejects(waitForDeploymentRun({
    repository, run, runCommand: commands(state('queued')).runCommand, pause: noPause,
    report() { throw new Error('report disconnected') },
  }), /report disconnected/)
})
