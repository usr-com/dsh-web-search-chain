import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_METAS, sortEngines, buildEngines, resolveApiKey } from '../lib/engines.js'
import { JsonApiEngine } from '../lib/json-api.js'
import { DeepSeekEngine } from '../lib/llm.js'
import { BingEngine } from '../lib/bing.js'

const STUB = (id) => ({
  id,
  name: id,
  available: () => true,
  async search() {
    return { sources: [], truncated: false }
  },
})

test('引擎元数据表：id 唯一', () => {
  const ids = ENGINE_METAS.map((meta) => meta.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.ok(id.length > 0, `id 不应为空`)
})

test('引擎元数据表：必需字段齐全', () => {
  for (const meta of ENGINE_METAS) {
    assert.ok(meta.name.length > 0, `${meta.id} 缺少名称`)
    assert.ok(meta.vendor.length > 0, `${meta.id} 缺少 vendor`)
    assert.equal(typeof meta.defaultPriority, 'number', `${meta.id} 缺 defaultPriority`)
    if (meta.requiresKey) {
      assert.ok(meta.authEnv, `${meta.id} 需要密钥但未声明 authEnv`)
    }
    if (meta.kind === 'json-api') {
      assert.ok(meta.endpoint.startsWith('http'), `${meta.id} 端点应为绝对 URL`)
      assert.ok(['POST', 'GET'].includes(meta.method), `${meta.id} method 非法`)
      assert.ok(meta.response.resultsPath.length > 0, `${meta.id} 缺 resultsPath`)
    }
    if (meta.kind === 'scrape') {
      assert.ok(meta.endpoint.includes('{query}'), `${meta.id} 端点模板缺 {query}`)
    }
    if (meta.kind === 'llm') {
      assert.ok(meta.model.length > 0 && meta.maxTokens > 0 && meta.maxUses > 0, `${meta.id} llm 参数缺失`)
    }
  }
})

test('元数据表覆盖built-in引擎集合', () => {
  const ids = new Set(ENGINE_METAS.map((meta) => meta.id))
  for (const expected of ['tavily', 'langsearch', 'bing', 'deepseek-official']) {
    assert.ok(ids.has(expected), `缺少内置引擎 ${expected}`)
  }
})

test('每个元数据行都能实例化出对应适配器', () => {
  for (const meta of ENGINE_METAS) {
    const engine = instantiateForTest(meta)
    assert.equal(engine.id, meta.id)
  }
})

function instantiateForTest(meta) {
  if (meta.kind === 'json-api') return new JsonApiEngine({ meta, apiKey: meta.requiresKey ? 'test-key' : undefined })
  if (meta.kind === 'scrape') return new BingEngine({ meta })
  return new DeepSeekEngine({ meta, apiKey: 'test-key' })
}

test('sortEngines：按优先级升序排列', () => {
  const engines = [
    STUB('bing'),
    STUB('deepseek-official'),
    STUB('tavily'),
    STUB('langsearch'),
  ]
  const ordered = sortEngines(engines, {})
  assert.deepEqual(ordered.map((e) => e.id), ['tavily', 'langsearch', 'bing', 'deepseek-official'])
})

test('sortEngines：用户覆盖 priority 生效', () => {
  const engines = [STUB('tavily'), STUB('langsearch')]
  const ordered = sortEngines(engines, { langsearch: { priority: 1 } })
  assert.deepEqual(ordered.map((e) => e.id), ['langsearch', 'tavily'])
})

// —— 密钥解析与「配置密钥即用」——

const tavilyMeta = ENGINE_METAS.find((meta) => meta.id === 'tavily')

/** 构造携带指定启动环境快照的假 ctx（launchEnvironmentOf 只读 ctx.launchEnvironment）。 */
function envCtx(values = {}) {
  return {
    get() {
      return {
        get(name) {
          return name in values ? { value: values[name], source: 'process' } : undefined
        },
      }
    },
  }
}

test('resolveApiKey：engines.apiKey > apiKeys > 环境变量 > undefined', () => {
  assert.equal(resolveApiKey(envCtx({ TAVILY_API_KEY: 'env' }), tavilyMeta, { apiKey: 'lit' }, { tavily: 'pool' }), 'lit')
  assert.equal(resolveApiKey(envCtx({}), tavilyMeta, {}, { tavily: 'pool' }), 'pool')
  assert.equal(resolveApiKey(envCtx({ TAVILY_API_KEY: 'env' }), tavilyMeta, {}, {}), 'env')
  assert.equal(resolveApiKey(envCtx({}), tavilyMeta, {}, {}), undefined)
})

test('resolveApiKey：apiKeyEnv 指定名称的变量优先于元数据默认变量', () => {
  assert.equal(
    resolveApiKey(envCtx({ TAVILY_API_KEY: 'default', CUSTOM_TV: 'custom' }), tavilyMeta, { apiKeyEnv: 'CUSTOM_TV' }, {}),
    'custom',
  )
  assert.equal(resolveApiKey(envCtx({ TAVILY_API_KEY: 'default' }), tavilyMeta, { apiKeyEnv: 'CUSTOM_TV' }, {}), undefined)
})

test('resolveApiKey：scrape 引擎（免密钥）不参与密钥解析，始终无 key', () => {
  const bingMeta = ENGINE_METAS.find((meta) => meta.id === 'bing')
  assert.equal(resolveApiKey(envCtx({}), bingMeta, {}, { bing: 'ignored' }), undefined)
})

test('buildEngines：apiKeys / 环境变量都能让 has-key 引擎可用；缺 key 则自动不可用', () => {
  const viaPool = buildEngines(envCtx({}), {}, { tavily: 'pool' }).find((e) => e.id === 'tavily')
  assert.equal(viaPool.available(), true)

  const viaEnv = buildEngines(envCtx({ TAVILY_API_KEY: 'env' })).find((e) => e.id === 'tavily')
  assert.equal(viaEnv.available(), true)

  const bare = buildEngines(envCtx({})).find((e) => e.id === 'tavily')
  assert.equal(bare.available(), false)
})

test('buildEngines：免密钥 Bing 恒可用，构成自动降级兜底', () => {
  const engines = buildEngines(envCtx({}))
  const bing = engines.find((e) => e.id === 'bing')
  assert.equal(bing.available(), true)
  // 缺全部 key 时链里仍剩 Bing，保证 provider.available() 恒真。
  assert.ok(engines.some((e) => e.available()))
})