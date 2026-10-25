import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

async function loadClientPlugin() {
  const source = await readFile(new URL('../client-plugin/lib/client.js', import.meta.url), 'utf8')
  const styles = new Set()
  let registration
  const document = {
    head: { appendChild(style) { styles.add(style) } },
    querySelector() { return null },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        remove() { styles.delete(this) },
      }
    },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document,
    Set,
    Object,
    JSON,
  })
  assert.equal(registration.id, 'dsh-dev-loop-ui')
  const React = {
    memo: component => component,
    createElement(type, props, ...children) {
      const elementProps = { ...props }
      if (children.length === 1) elementProps.children = children[0]
      if (children.length > 1) elementProps.children = children
      return { type, props: elementProps }
    },
  }
  const plugin = registration.factory(specifier => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { plugin, styles }
}

function createClientContext() {
  const effects = []
  const pendingInjections = []
  const entries = new Set()
  const injectedSlots = []
  const openedSessionIds = []
  const listedSessionIds = new Set()
  let definition
  const context = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    uiConversation: {
      events: {
        register(value) {
          definition = value
          return () => { definition = undefined }
        },
      },
    },
    sessions: {
      list: { getSnapshot() { return { ids: [...listedSessionIds] } } },
    },
    uiWorkspace: { openSession(id) { openedSessionIds.push(id) } },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        let active = true
        let disposeEntry
        context.effect(() => () => {
          active = false
          disposeEntry?.()
        })
        pendingInjections.push(() => {
          if (active) disposeEntry = callback()
        })
        return () => {
          active = false
          disposeEntry?.()
        }
      },
      register(config, component) {
        const entry = { config, component }
        entries.add(entry)
        return () => entries.delete(entry)
      },
    },
  }
  return {
    context,
    get definition() { return definition },
    entries,
    injectedSlots,
    openedSessionIds,
    listedSessionIds,
    effects,
    pendingInjections,
  }
}

function elementText(element) {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(elementText).join('')
  if (element && typeof element === 'object') return elementText(element.props?.children)
  return ''
}

test('client manifest injects only installed DSH modules required for chat, sessions, and navigation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../client-plugin/package.json', import.meta.url), 'utf8'))

  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-ui-workspace',
  ])
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-api-session-controller'], '>=0.2.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-workspace'], '>=0.2.1-rc.2')
  assert.equal('@deepseek-ai/dsh-client-runtime' in manifest.peerDependencies, false)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), false)
  for (const dependency of manifest.dsh.client.inject) {
    assert.equal(dependency in manifest.peerDependencies, true)
  }
})

test('client plugin registers with current DSH services and releases registrations on unload', async () => {
  const { plugin, styles } = await loadClientPlugin()
  const client = createClientContext()

  assert.deepEqual([...plugin.inject].sort(), ['sessions', 'slots', 'uiConversation', 'uiWorkspace'].sort())
  plugin.apply(client.context)
  assert.equal(client.definition.kind, 'dev-loop-run')
  assert.equal(styles.size, 1)

  for (const inject of client.pendingInjections) inject()
  assert.deepEqual(client.injectedSlots, ['conversation.chat.node', 'conversation.chat.commandview'])
  assert.equal(client.entries.size, 2)
  assert.ok([...client.entries].some(entry => entry.config.key === 'dev-loop-card'))
  assert.ok([...client.entries].some(entry => entry.config.key === 'dev-loop-m2'))

  for (const dispose of [...client.effects].reverse()) dispose()
  assert.equal(client.definition, undefined)
  assert.equal(client.entries.size, 0)
  assert.equal(styles.size, 0)
})

test('M2 command row opens only the Session named by a live pending-approval progress update', async () => {
  const { plugin } = await loadClientPlugin()
  const client = createClientContext()
  plugin.apply(client.context)
  client.pendingInjections.forEach(inject => inject())
  const row = [...client.entries].find(entry => entry.config.key === 'dev-loop-m2')
  const injected = row.config.inject()
  const sessionId = 'dev-loop-run-ui-round-0-test'
  client.listedSessionIds.add(sessionId)
  const rendered = row.component({
    node: {
      name: 'dev-loop-m2',
      progress: { text: `状态：COLLECTING_EVIDENCE\n审批状态：待处理\n等待工具审批\n审批操作：bash（npm test）\n审批 Session：${sessionId}` },
      outcome: null,
    },
    ...injected,
  })
  const findButton = element => {
    if (element === null || typeof element !== 'object') return undefined
    if (element?.type === 'button') return element
    const children = element?.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      const button = findButton(child)
      if (button) return button
    }
    return undefined
  }
  const button = findButton(rendered)
  assert.ok(button)
  assert.match(elementText(button), /打开审批 Session/)
  button.props.onClick()
  assert.deepEqual(client.openedSessionIds, [sessionId])

  client.listedSessionIds.clear()
  const unavailable = row.component({
    node: {
      name: 'dev-loop-m2',
      outcome: { text: `审批状态：待处理\n等待工具审批\n审批操作：bash（npm test）\n审批 Session：${sessionId}` },
      progress: null,
    },
    ...injected,
  })
  assert.equal(findButton(unavailable), undefined)
  assert.match(elementText(unavailable), /请在 DSH 会话列表中查找/)

  const settled = row.component({
    node: { name: 'dev-loop-m2', progress: { text: '测试 Agent 已收到允许结果，正在完成测试。' }, outcome: null },
    ...injected,
  })
  assert.equal(findButton(settled), undefined)
})

test('restored M2 command row hides stale approval progress after a final outcome', async () => {
  const { plugin } = await loadClientPlugin()
  const client = createClientContext()
  plugin.apply(client.context)
  client.pendingInjections.forEach(inject => inject())
  const row = [...client.entries].find(entry => entry.config.key === 'dev-loop-m2')
  const injected = row.config.inject()
  const rendered = row.component({
    node: {
      name: 'dev-loop-m2',
      progress: { text: '审批状态：待处理\n等待工具审批\n审批操作：bash（npm test）\n审批 Session：dev-loop-run-ui-round-0-test' },
      outcome: { text: '状态：COMPLETE\n测试结果：通过\n变更文件：2 个\nReviewer 结论：ACCEPTED' },
    },
    ...injected,
  })

  assert.match(elementText(rendered), /状态：COMPLETE/)
  assert.match(elementText(rendered), /Reviewer 结论：ACCEPTED/)
  assert.doesNotMatch(elementText(rendered), /审批状态：待处理|等待工具审批|审批 Session：/)
  assert.doesNotMatch(elementText(rendered), /打开审批 Session/)
})

test('client definition assembles dev-loop events by runId and renders terminal summary', async () => {
  const { plugin } = await loadClientPlugin()
  const client = createClientContext()
  plugin.apply(client.context)
  const definition = client.definition

  const events = [
    {
      type: 'dev-loop/run-started', seq: 1, data: {
        runId: 'run-ui',
        at: '2026-08-30T00:00:00.000Z',
        projectRoot: '/tmp/project',
        artifactRoot: '/tmp/artifacts',
        fingerprint: { backend: { buildId: 'backend-test' }, client: { buildId: 'client-test' } },
      },
    },
    {
      type: 'dev-loop/progress', seq: 2, data: {
        runId: 'run-ui', stage: 'ANALYZING', label: '分析项目现状', detail: '读取项目文件', round: 0,
      },
    },
    {
      type: 'dev-loop/diagnostic', seq: 3, data: {
        runId: 'run-ui', diagnostic: {
          title: '需要人工确认', message: '检查方案', suggestion: '先审阅变更',
          technical: { reason: 'approval-required' },
        },
      },
    },
    {
      type: 'dev-loop/run-finished', seq: 4, data: {
        runId: 'run-ui', state: 'COMPLETE', at: '2026-08-30T00:01:00.000Z',
        summary: { test: { ok: true }, changedFiles: 2 }, decision: 'approved',
      },
    },
  ]

  assert.equal(definition.match(events[0]).id, 'run-ui')
  assert.equal(definition.match({ ...events[1], data: { runId: 'another-run' } }).id, 'another-run')
  let state = definition.start({}, { event: events[0] })
  for (const event of events.slice(1)) {
    assert.equal(definition.match(event).id, 'run-ui')
    state = definition.update({ state }, { event })
  }

  assert.equal(state.stage, 'COMPLETE')
  assert.equal(state.history.join(','), 'ANALYZING')
  assert.equal(state.diagnostic.title, '需要人工确认')
  assert.equal(state.summary.changedFiles, 2)
  assert.equal(state.fingerprint.backend.buildId, 'backend-test')
  assert.equal(state.fingerprint.client.buildId, 'client-test')

  const node = definition.buildViewNode({
    key: 'dev-loop-run:run-ui',
    id: 'run-ui',
    state,
    start: { location: { kind: 'assistant', seq: 1 } },
    matches: [{ location: { kind: 'assistant', seq: 1 } }],
  })
  assert.equal(node.kind, 'dev-loop-card')
  assert.equal(node.id, 'run-ui')
  assert.equal(node.anchorSeq, 1)

  const rendered = elementText(plugin.DevLoopCard({ node }))
  assert.match(rendered, /任务完成/)
  assert.match(rendered, /需要人工确认/)
  assert.match(rendered, /检查方案/)
  assert.match(rendered, /先审阅变更/)
  assert.match(rendered, /测试：通过/)
  assert.match(rendered, /变更文件：2 个/)
  assert.match(rendered, /后端 backend-test · 客户端 client-test/)
})
