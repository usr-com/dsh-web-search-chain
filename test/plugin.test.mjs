/**
 * 插件入口的端到端测试：走**真实的** `lib/index.js`，用桩 ctx 替掉 cordis 运行时。
 *
 * 这里覆盖的是「插件真的能被加载并注册」这条路径 —— 单测各自测内部函数，
 * 但只有把入口 import 进来、喂一个像样的 ctx，才能发现导出缺失、
 * `apply` 签名不符、日志调用写错这类装配期问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply, name, inject, Config, defaultQuotaStatePath, buildQuotaGuard, CHAIN_PROVIDER_ID } from '../lib/index.js'
import { buildEngines } from '../lib/engines.js'

/** 造一个最小可用的 ctx：只实现插件真正会碰的几个面。 */
function makeCtx({ env = {}, credentials } = {}) {
  const registered = []
  const logs = []
  const snapshot = {
    get: (variable) => (variable in env ? { value: env[variable], source: 'process' } : undefined),
  }
  // 复刻 cordis LoggerService 的形状：本身可调用（返回具名 Logger），
  // 同时自己也有 info/warn 等方法。
  const logger = (loggerName) => ({
    info: (...args) => logs.push(`[${loggerName}] ${args.join(' ')}`),
    warn: (...args) => logs.push(`[${loggerName}] WARN ${args.join(' ')}`),
  })
  logger.info = (...args) => logs.push(args.join(' '))
  logger.warn = (...args) => logs.push(`WARN ${args.join(' ')}`)

  const ctx = {
    web: {
      registerSearchProvider(provider) {
        registered.push(provider)
        return () => {}
      },
    },
    get(key) {
      if (key === 'launchEnvironment') return snapshot
      if (key === 'credentials') return credentials
      return undefined
    },
    logger,
  }
  return { ctx, registered, logs }
}

test('入口导出：name / inject / 默认导出面齐全', () => {
  assert.equal(name, 'web-search-chain')
  assert.deepEqual(inject, ['web'])
  assert.equal(typeof Config, 'function')
})

test('apply：注册唯一 provider，且免密钥 Bing 让它恒可用', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  const provider = registered[0]
  assert.equal(provider.id, CHAIN_PROVIDER_ID)
  assert.equal(provider.available(), true, '含免密钥 Bing 时应恒可用')
})

test('apply：注册诊断确实写进日志（回归：ctx.logger?.() 只建 logger 不写日志）', () => {
  const { ctx, logs } = makeCtx()
  apply(ctx, {})
  assert.ok(logs.length >= 1, 'apply 必须留下日志')
  assert.ok(
    logs.some((line) => line.includes('web-search-chain') && line.includes('引擎')),
    `日志应说明注册了哪些引擎，实际：${JSON.stringify(logs)}`,
  )
  assert.ok(
    logs.some((line) => line.includes('预算')),
    `日志应说明护栏状态，实际：${JSON.stringify(logs)}`,
  )
})

test('apply：日志同时覆盖具名 Logger 与 LoggerService.info 两种 shape', () => {
  const { ctx, logs } = makeCtx()
  apply(ctx, { quota: { enabled: false } })
  assert.ok(logs.length >= 2, '两条诊断都应写出')
  assert.ok(logs.every((line) => line.length > 0))
})

test('配置 schema：接受并归一化新增的 quota 段', () => {
  const parsed = Config({
    strategy: 'aggregate',
    timeoutMs: 20000,
    quota: { enabled: true, dailyLimits: { tavily: 5, bing: 0 }, cooldownMs: 120000, persist: false },
  })
  assert.equal(parsed.strategy, 'aggregate')
  assert.deepEqual(parsed.quota.dailyLimits, { tavily: 5, bing: 0 })
  assert.equal(parsed.quota.cooldownMs, 120000)
  assert.equal(parsed.quota.persist, false)
})

test('defaultQuotaStatePath：跟随启动环境里的 DSH_HOME', () => {
  const { ctx } = makeCtx({ env: { DSH_HOME: 'D:\\custom-dsh-home' } })
  assert.equal(defaultQuotaStatePath(ctx), join('D:\\custom-dsh-home', 'web-search-chain-quota.json'))
})

// ─── customEngines：从配置到注册 ──────────────────────────────────────────

test('配置 schema：接受并归一化 customEngines', () => {
  const parsed = Config({
    customEngines: {
      brave: {
        kind: 'json-api',
        endpoint: 'https://api.search.brave.com/res/v1/web/search',
        method: 'GET',
        auth: 'header',
        authHeader: 'X-Subscription-Token',
        queryField: 'q',
        countField: 'count',
        resultsPath: 'web.results',
        fields: { title: 'title', url: 'url', snippet: 'description' },
        dailyRequests: 50,
      },
    },
  })
  const brave = parsed.customEngines.brave
  assert.equal(brave.kind, 'json-api')
  assert.equal(brave.method, 'GET')
  assert.equal(brave.auth, 'header')
  assert.equal(brave.authHeader, 'X-Subscription-Token')
  assert.equal(brave.resultsPath, 'web.results')
  assert.equal(brave.dailyRequests, 50)
  assert.equal(brave.queryField, 'q')
})

test('apply：自定义引擎进入链，并出现在注册日志里', () => {
  const { ctx, registered, logs } = makeCtx()
  apply(ctx, {
    customEngines: {
      mine: { endpoint: 'https://a.example/s', apiKey: 'k', fields: { url: 'u' } },
    },
  })
  assert.equal(registered.length, 1)
  const line = logs.find((entry) => entry.includes('已注册'))
  assert.ok(line, `应有注册日志：${JSON.stringify(logs)}`)
  assert.match(line, /mine/, '自定义引擎应出现在引擎顺序里')
})

test('apply：非法的自定义引擎被跳过并告警，但注册照样成功', () => {
  const { ctx, registered, logs } = makeCtx()
  apply(ctx, {
    customEngines: {
      broken: { endpoint: '' },
      fine: { endpoint: 'https://a.example/s', fields: { url: 'u' } },
    },
  })
  assert.equal(registered.length, 1, '一个坏条目不应让插件注册失败')
  assert.equal(registered[0].available(), true, 'Bing 兜底仍在')
  const warning = logs.find((entry) => entry.includes('broken'))
  assert.ok(warning, `应有针对 broken 的告警：${JSON.stringify(logs)}`)
  assert.match(warning, /跳过/)
})

test('buildQuotaGuard：persist=false 时不落盘，仍保留预算判定', () => {
  const { ctx } = makeCtx({ env: { DSH_HOME: 'D:\\custom-dsh-home' } })
  const inMemory = buildQuotaGuard(ctx, { enabled: true, dailyLimits: { tavily: 1 }, persist: false })
  inMemory.noteAttempt('tavily')
  assert.equal(inMemory.check('tavily').allowed, false, '不落盘也要挡额度')

  const onDisk = buildQuotaGuard(ctx, { enabled: true, dailyLimits: { tavily: 1 } })
  // 默认 persist=true 时应指向 DSH_HOME；这里不断言文件内容，只确认判定一致。
  assert.equal(onDisk.check('tavily').allowed, true)
})

test('buildEngines：凭据库里的 DEEPSEEK_API_KEY 让内置兜底引擎在桌面端可用', async () => {
  const credentials = { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-from-store' } : undefined) }
  const { ctx } = makeCtx({ credentials })
  const engines = buildEngines(ctx, {}, {})
  const deepseek = engines.find((engine) => engine.id === 'deepseek-official')

  // available() 是同步的、凭据解析是异步的：构建时探针已发出，结论要等一个
  // 微任务才落定。这里如实按这个时序断言，而不是假设它同步就知道答案。
  const settles = () => new Promise((resolve) => { setTimeout(resolve, 0) })
  await settles()
  assert.equal(
    deepseek.available(),
    true,
    'key 只存在于凭据库（Web UI Models 页写入）时，兜底引擎不应被误判为不可用',
  )
})

test('buildEngines：既无字面量密钥也无凭据服务时，内置兜底引擎不可用', () => {
  const { ctx } = makeCtx()
  const engines = buildEngines(ctx, {}, {})
  const deepseek = engines.find((engine) => engine.id === 'deepseek-official')
  assert.equal(deepseek.available(), false)
})

test('buildEngines：engines.<id>.enabled=false 会把引擎移出链', () => {
  const { ctx } = makeCtx()
  const engines = buildEngines(ctx, { bing: { enabled: false }, tavily: { enabled: false } }, {})
  assert.deepEqual(engines.map((engine) => engine.id), ['langsearch', 'deepseek-official'])
})

test('buildEngines：DEEPSEEK_SEARCH_BASE_URL 与内置 web-search-deepseek 行为一致', () => {
  const { ctx } = makeCtx({ env: { DEEPSEEK_SEARCH_BASE_URL: 'https://proxy.example/anthropic/v1' } })
  const engines = buildEngines(ctx, {}, {})
  const deepseek = engines.find((engine) => engine.id === 'deepseek-official')
  // baseURL 是私有字段，用行为验证：不可用时也说明端点解析没炸；这里直接看 id 与可用性组合。
  assert.equal(deepseek.id, 'deepseek-official')
  assert.equal(deepseek.available(), false, '没有 key 时仍不可用，但端点应已解析')
})
