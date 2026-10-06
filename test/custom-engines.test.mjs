/**
 * 自定义引擎（`config.customEngines`）的单测。
 *
 * 覆盖三件事：**配置能编译成正确的元数据行**、**编译出的行驱动出的 HTTP 请求
 * 真的符合各家接口的约定**（GET 查询串、自定义头、密钥拼 URL）、
 * 以及**不合法的定义只跳过自己、不连累整条链**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_ENGINE_DEFAULT_PRIORITY,
  buildEngineChain,
  customEngineMetas,
  defaultDailyLimits,
} from '../lib/engines.js'
import { JsonApiEngine } from '../lib/json-api.js'
import { BingEngine } from '../lib/bing.js'
import { DEFAULT_DAILY_LIMIT } from '../lib/quota.js'
import { buildQuotaGuard } from '../lib/index.js'

// ─── 测试脚手架 ────────────────────────────────────────────────────────────

/** 只实现插件会碰的两个面：启动环境快照与凭据服务。 */
function envCtx(values = {}, credentials) {
  return {
    get(name) {
      if (name === 'launchEnvironment') {
        return { get: (key) => (key in values ? { value: values[key], source: 'process' } : undefined) }
      }
      if (name === 'credentials') return credentials
      return undefined
    },
  }
}

/** 替换 globalThis.fetch 并记录调用；务必在 finally 里 restore()。 */
function stubFetch(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init }
    calls.push(call)
    return responder(call)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 造一个 2xx JSON 响应。 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** 用元数据行直接实例化一个 JSON API 引擎（等价于链内的构造方式）。 */
function engineFor(custom, id, apiKey) {
  const { metas, problems } = customEngineMetas(custom)
  assert.deepEqual(problems, [], `定义应通过校验：${JSON.stringify(problems)}`)
  const meta = metas.find((entry) => entry.id === id)
  assert.ok(meta, `未编译出 ${id}`)
  return new JsonApiEngine({ meta, apiKey })
}

// ─── 编译：配置 → 元数据行 ────────────────────────────────────────────────

test('编译：标准 POST JSON API 的默认值都合理', () => {
  const { metas, problems } = customEngineMetas({
    'my-search': { endpoint: 'https://api.example.com/search', fields: { url: 'link' } },
  })
  assert.deepEqual(problems, [])
  const meta = metas[0]
  assert.equal(meta.kind, 'json-api')
  assert.equal(meta.id, 'my-search')
  assert.equal(meta.name, 'my-search', '缺省名用 id')
  assert.equal(meta.vendor, 'api.example.com', '缺省 vendor 用端点主机名')
  assert.equal(meta.method, 'POST')
  assert.equal(meta.auth, 'none', '没给 key 也没给 auth → none')
  assert.equal(meta.requiresKey, false)
  assert.equal(meta.defaultPriority, CUSTOM_ENGINE_DEFAULT_PRIORITY)
  assert.equal(meta.request.queryField, 'query')
  assert.equal(meta.response.resultsPath, 'results')
  assert.equal(meta.response.fields.url, 'link')
  assert.equal(meta.response.fields.title, 'title', '缺省标题字段')
  assert.equal(meta.freeTier.dailyRequests, DEFAULT_DAILY_LIMIT)
  assert.ok(meta.freeTier.note.includes('自定义引擎'))
})

test('编译：给出 key 时缺省鉴权为 bearer', () => {
  const { metas } = customEngineMetas({
    a: { endpoint: 'https://a.example/s', apiKey: 'k', fields: { url: 'u' } },
  })
  assert.equal(metas[0].auth, 'bearer')
  assert.equal(metas[0].requiresKey, true)
})

test('编译：apiKeyEnv 同时成为 authEnv，于是能走环境变量与凭据库', () => {
  const { metas } = customEngineMetas({
    a: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_SEARCH_KEY', fields: { url: 'u' } },
  })
  assert.equal(metas[0].authEnv, 'MY_SEARCH_KEY')
  assert.equal(metas[0].auth, 'bearer')
})

test('编译：scrape 引擎免密钥，且保留端点模板', () => {
  const { metas, problems } = customEngineMetas({
    ddg: { kind: 'scrape', endpoint: 'https://html.duckduckgo.com/html/?q={query}&s={count}' },
  })
  assert.deepEqual(problems, [])
  assert.equal(metas[0].kind, 'scrape')
  assert.equal(metas[0].requiresKey, false)
  assert.ok(new BingEngine({ meta: metas[0] }).available())
})

test('编译：dailyRequests / note 透传进 freeTier', () => {
  const { metas } = customEngineMetas({
    a: { endpoint: 'https://a.example/s', fields: { url: 'u' }, dailyRequests: 7, note: '免费 100/月' },
  })
  assert.equal(metas[0].freeTier.dailyRequests, 7)
  assert.equal(metas[0].freeTier.note, '免费 100/月')
})

test('编译：dailyRequests: 0 表示不限制（不进预算表）', () => {
  const { metas } = customEngineMetas({
    a: { endpoint: 'https://a.example/s', fields: { url: 'u' }, dailyRequests: 0 },
  })
  assert.deepEqual(defaultDailyLimits(metas), {})
})

// ─── 编译：不合法定义只跳过自己 ────────────────────────────────────────────

test('编译：各类非法定义都被跳过并给出可操作的原因', () => {
  const cases = [
    [{ endpoint: '' }, /缺少 endpoint/],
    [{ endpoint: 'ftp://a.example/s' }, /绝对 http\(s\) URL/],
    [{ endpoint: 'not a url' }, /绝对 http\(s\) URL/],
    [{ endpoint: 'https://a.example/s' }, /fields\.url/],
    [{ endpoint: 'https://a.example/s', fields: { url: 'u' }, auth: 'header' }, /authHeader/],
    [{ endpoint: 'https://a.example/s', fields: { url: 'u' }, auth: 'query' }, /authParam/],
    [{ kind: 'scrape', endpoint: 'https://a.example/s' }, /{query}/],
  ]
  for (const [definition, pattern] of cases) {
    const { metas, problems } = customEngineMetas({ bad: definition })
    assert.equal(metas.length, 0, `不该编译出元数据行：${JSON.stringify(definition)}`)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].id, 'bad')
    assert.match(problems[0].message, pattern)
  }
})

test('编译：与内置引擎 id 冲突的条目被跳过并提示改用 engines 覆盖', () => {
  const { metas, problems } = customEngineMetas({
    tavily: { endpoint: 'https://a.example/s', fields: { url: 'u' } },
  })
  assert.deepEqual(metas, [])
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /内置引擎 id 冲突/)
  assert.match(problems[0].message, /config\.engines\.tavily/)
})

test('编译：非法 id 被跳过', () => {
  for (const bad of ['has space', '.leading-dot', '']) {
    const { metas, problems } = customEngineMetas({ [bad]: { endpoint: 'https://a.example/s', fields: { url: 'u' } } })
    assert.deepEqual(metas, [], `id=${JSON.stringify(bad)} 不该通过`)
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /引擎 id/)
  }
})

test('编译：一个坏条目不会连累其它好条目', () => {
  const { metas, problems } = customEngineMetas({
    good: { endpoint: 'https://good.example/s', fields: { url: 'u' } },
    bad: { endpoint: '' },
    alsoGood: { endpoint: 'https://also.example/s', fields: { url: 'u' } },
  })
  assert.deepEqual(metas.map((meta) => meta.id), ['good', 'alsoGood'])
  assert.deepEqual(problems.map((problem) => problem.id), ['bad'])
})

// ─── 编译出的行驱动出的请求真的对 ──────────────────────────────────────────

test('请求：POST 把查询词、条数与固定字段放进请求体', async () => {
  const engine = engineFor({
    a: {
      endpoint: 'https://a.example/search',
      fields: { url: 'u' },
      countField: 'limit',
      extraBody: { safe: true },
      apiKey: 'secret',
    },
  }, 'a', 'secret')

  const stub = stubFetch(() => jsonResponse({ results: [{ u: 'https://hit.example', title: 'T' }] }))
  try {
    const result = await engine.search({ query: '你好', maxResults: 3 })
    assert.equal(result.sources[0].url, 'https://hit.example')
    const [call] = stub.calls
    assert.equal(call.url, 'https://a.example/search')
    assert.equal(call.init.method, 'POST')
    assert.deepEqual(JSON.parse(call.init.body), { query: '你好', limit: 3, safe: true })
    assert.equal(call.init.headers.authorization, 'Bearer secret')
  } finally {
    stub.restore()
  }
})

test('请求：GET 把查询词、条数与 extraQuery 拼进查询串，且不带请求体', async () => {
  const engine = engineFor({
    a: {
      endpoint: 'https://a.example/search',
      method: 'GET',
      queryField: 'q',
      countField: 'num',
      extraQuery: { format: 'json', lang: 'zh' },
      fields: { url: 'u' },
    },
  }, 'a')

  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'hello world', maxResults: 5 })
    const [call] = stub.calls
    const url = new URL(call.url)
    assert.equal(url.origin + url.pathname, 'https://a.example/search')
    assert.equal(url.searchParams.get('q'), 'hello world')
    assert.equal(url.searchParams.get('num'), '5')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.equal(url.searchParams.get('lang'), 'zh')
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.body, undefined, 'GET 不该有请求体')
    assert.equal(call.init.headers['content-type'], undefined, 'GET 不该声称有 JSON 体')
  } finally {
    stub.restore()
  }
})

test('请求：auth=header 用自定义请求头名', async () => {
  const engine = engineFor({
    a: {
      endpoint: 'https://a.example/s',
      auth: 'header',
      authHeader: 'X-Subscription-Token',
      apiKey: 'k',
      fields: { url: 'u' },
    },
  }, 'a', 'k')

  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    const [call] = stub.calls
    assert.equal(call.init.headers['X-Subscription-Token'], 'k')
    assert.equal(call.init.headers.authorization, undefined)
  } finally {
    stub.restore()
  }
})

test('请求：auth=query 把密钥拼进查询串，且不放进任何请求头', async () => {
  const engine = engineFor({
    a: {
      endpoint: 'https://a.example/s',
      method: 'GET',
      auth: 'query',
      authParam: 'key',
      apiKey: 'k',
      fields: { url: 'u' },
    },
  }, 'a', 'k')

  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    const [call] = stub.calls
    assert.equal(new URL(call.url).searchParams.get('key'), 'k')
    assert.equal(call.init.headers.authorization, undefined)
    assert.equal(call.init.headers['x-api-key'], undefined)
  } finally {
    stub.restore()
  }
})

test('请求：auth=x-api-key 走 x-api-key 头', async () => {
  const engine = engineFor({
    a: { endpoint: 'https://a.example/s', auth: 'x-api-key', apiKey: 'k', fields: { url: 'u' } },
  }, 'a', 'k')

  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'k')
  } finally {
    stub.restore()
  }
})

test('请求：自定义响应映射（嵌套路径 + 摘要回退）', async () => {
  const engine = engineFor({
    a: {
      endpoint: 'https://a.example/s',
      resultsPath: 'web.results',
      fields: { title: 'name', url: 'link', snippet: 'desc', snippetFallback: 'summary', publishedAt: 'date' },
    },
  }, 'a')

  const stub = stubFetch(() => jsonResponse({
    web: {
      results: [
        { name: 'N', link: 'https://x.example', desc: '', summary: '回退摘要', date: '2026-01-01' },
        { name: 'no url 应被丢弃' },
      ],
    },
  }))
  try {
    const result = await engine.search({ query: 'q' })
    assert.equal(result.sources.length, 1)
    assert.deepEqual(result.sources[0], {
      url: 'https://x.example',
      title: 'N',
      snippet: '回退摘要',
      publishedAt: '2026-01-01',
    })
  } finally {
    stub.restore()
  }
})

test('请求：自定义引擎同样把 429 识别为限额（进冷却而不是普通失败）', async () => {
  const engine = engineFor({
    a: { endpoint: 'https://a.example/s', apiKey: 'k', fields: { url: 'u' } },
  }, 'a', 'k')

  const stub = stubFetch(() => jsonResponse({ detail: { error: 'quota exceeded' } }, 429, { 'retry-after': '30' }))
  try {
    await assert.rejects(
      engine.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_RATE_LIMITED' && error.retryAfterMs === 30000,
    )
  } finally {
    stub.restore()
  }
})

// ─── 与链、护栏的集成 ─────────────────────────────────────────────────────

test('链：自定义引擎默认排在 LangSearch 之后、Bing 之前', () => {
  const ctx = envCtx()
  const { engines, problems } = buildEngineChain(ctx, {
    custom: { mine: { endpoint: 'https://a.example/s', fields: { url: 'u' } } },
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(
    engines.map((engine) => engine.id),
    ['tavily', 'langsearch', 'mine', 'bing', 'deepseek-official'],
  )
})

test('链：engines.<自定义 id> 的 priority / enabled / apiKey 覆盖都生效', () => {
  const custom = { mine: { endpoint: 'https://a.example/s', fields: { url: 'u' } } }

  const first = buildEngineChain(envCtx(), { custom, overrides: { mine: { priority: 1 } } })
  assert.equal(first.engines[0].id, 'mine')

  const second = buildEngineChain(envCtx(), { custom, overrides: { mine: { enabled: false } } })
  assert.ok(!second.engines.some((engine) => engine.id === 'mine'))

  const third = buildEngineChain(envCtx(), { custom, overrides: { mine: { apiKey: 'literal' } } })
  assert.equal(third.engines.find((engine) => engine.id === 'mine').available(), true)
})

test('链：自定义引擎的密钥也能从环境变量解析', () => {
  const custom = {
    mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_KEY', fields: { url: 'u' } },
  }
  const withEnv = buildEngineChain(envCtx({ MY_KEY: 'from-env' }), { custom })
  assert.equal(withEnv.engines.find((engine) => engine.id === 'mine').available(), true)

  const withoutEnv = buildEngineChain(envCtx(), { custom })
  assert.equal(withoutEnv.engines.find((engine) => engine.id === 'mine').available(), false)
})

test('链：一个非法自定义条目被跳过，其余引擎（含 Bing 兜底）照常装配', () => {
  const { engines, problems } = buildEngineChain(envCtx(), {
    custom: { broken: { endpoint: '' }, fine: { endpoint: 'https://a.example/s', fields: { url: 'u' } } },
  })
  assert.equal(problems.length, 1)
  assert.ok(engines.some((engine) => engine.id === 'fine'))
  assert.ok(engines.some((engine) => engine.id === 'bing'), 'Bing 兜底必须还在')
})

test('护栏：自定义引擎的 dailyRequests 进入默认预算表', () => {
  const ctx = envCtx({ DSH_HOME: 'D:\\h' })
  const { metas } = buildEngineChain(ctx, {
    custom: { mine: { endpoint: 'https://a.example/s', fields: { url: 'u' }, dailyRequests: 3 } },
  })
  assert.deepEqual(defaultDailyLimits(metas), {
    tavily: 30,
    langsearch: 200,
    bing: 200,
    'deepseek-official': 50,
    mine: 3,
  })

  const guard = buildQuotaGuard(ctx, { enabled: true, persist: false, dailyLimits: { mine: 1 } }, metas)
  guard.noteAttempt('mine')
  const verdict = guard.check('mine')
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.limit, 1, '用户覆盖应压过表内推导值')
})

// ─── 密钥来自 harness 凭据 seam（$DSH_HOME/.credentials.yaml）─────────────
//
// 这是「参考 DSH 模型密钥方案」的落点：密钥不再只能来自配置或启动环境，
// 而是和模型密钥放同一个文件、走同一套优先级，并且该文件被热监听。

/** 只有凭据库里才有 key 的引擎。 */
function storeBackedEngine(custom, id, stored) {
  const { metas, problems } = customEngineMetas(custom)
  assert.deepEqual(problems, [])
  const meta = metas.find((entry) => entry.id === id)
  return new JsonApiEngine({
    meta,
    credential: { resolve: async () => stored, present: () => true },
  })
}

test('凭据 seam：key 只在凭据库里时，引擎仍被视为可用', async () => {
  const engine = storeBackedEngine(
    { mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_STORE_KEY', fields: { url: 'u' } } },
    'mine',
    'key-from-store',
  )
  // available() 是同步的，凭据解析是异步的 —— 首次询问只触发探针、不乐观放行。
  assert.equal(engine.available(), false, '结论未出来之前不应乐观宣称可用')
  // search() 会解析并刷新状态；用一次失败的搜索把它推起来。
  await engine.search({ query: 'q' }).catch(() => {})
  assert.equal(engine.available(), true, '确认凭据库里有 key 之后应可用')
})

test('凭据 seam：解析出的 key 真的被用于鉴权请求头', async () => {
  const engine = storeBackedEngine(
    { mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_STORE_KEY', fields: { url: 'u' } } },
    'mine',
    'key-from-store',
  )
  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer key-from-store')
  } finally {
    stub.restore()
  }
})

test('凭据 seam：字面量密钥优先于凭据库，且不会去查凭据服务', async () => {
  let calls = 0
  const { metas } = customEngineMetas({
    mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_STORE_KEY', fields: { url: 'u' } },
  })
  const engine = new JsonApiEngine({
    meta: metas[0],
    apiKey: 'literal-key',
    credential: { resolve: async () => { calls += 1; return 'key-from-store' }, present: () => true },
  })
  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer literal-key')
    assert.equal(calls, 0, '有字面量时不应查凭据服务')
  } finally {
    stub.restore()
  }
})

test('凭据 seam：需要密钥却取不到时给出可读错误，而不是发一次裸请求', async () => {
  const engine = storeBackedEngine(
    { mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_STORE_KEY', fields: { url: 'u' } } },
    'mine',
    undefined,
  )
  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await assert.rejects(
      engine.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
        && error.message.includes('MY_STORE_KEY')
        && error.message.includes('.credentials.yaml'),
    )
    assert.equal(stub.calls.length, 0, '不应把注定 401 的请求发出去')
  } finally {
    stub.restore()
  }
})

test('凭据 seam：免密钥引擎不受影响，也不会去查凭据库', async () => {
  const { metas } = customEngineMetas({
    free: { endpoint: 'https://a.example/s', auth: 'none', requiresKey: false, fields: { url: 'u' } },
  })
  const engine = new JsonApiEngine({ meta: metas[0] })
  assert.equal(engine.available(), true)
  const stub = stubFetch(() => jsonResponse({ results: [] }))
  try {
    await engine.search({ query: 'q' })
    assert.equal(stub.calls[0].init.headers.authorization, undefined)
  } finally {
    stub.restore()
  }
})

test('凭据 seam：buildEngineChain 会为每个需要密钥的引擎接上凭据来源', () => {
  const seenRefs = []
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        resolve: async (ref) => { seenRefs.push(ref); return { value: `v:${ref}` } },
      }
    },
  }
  const { engines } = buildEngineChain(ctx, {
    custom: { mine: { endpoint: 'https://a.example/s', apiKeyEnv: 'MY_STORE_KEY', fields: { url: 'u' } } },
  })
  // 内置的 tavily / langsearch / deepseek-official 与自定义引擎都应可用；
  // bing 免密钥，不参与。
  assert.equal(engines.find((engine) => engine.id === 'bing').available(), true)
  for (const id of ['tavily', 'langsearch', 'deepseek-official', 'mine']) {
    assert.equal(engines.find((engine) => engine.id === id).available(), false, `${id} 首询不乐观放行`)
  }
  // 触发一次搜索式解析，确认引用名解析正确（内置用默认变量名，自定义用 apiKeyEnv）。
  return Promise.all([
    engines.find((engine) => engine.id === 'tavily').search({ query: 'q' }),
    engines.find((engine) => engine.id === 'mine').search({ query: 'q' }),
  ]).catch(() => {}).then(() => {
    assert.ok(seenRefs.includes('TAVILY_API_KEY'), `应查 TAVILY_API_KEY，实际 ${JSON.stringify(seenRefs)}`)
    assert.ok(seenRefs.includes('MY_STORE_KEY'), `应查 MY_STORE_KEY，实际 ${JSON.stringify(seenRefs)}`)
  })
})
