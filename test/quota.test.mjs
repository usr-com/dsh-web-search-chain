/**
 * 请求预算护栏与「限额 → 冷却 → 换引擎」链路的单测。
 *
 * 这些用例覆盖的是**新增的、与钱有关**的行为：额度耗尽要挡在请求发出之前，
 * 提供方限流要进冷却期，用量要跨重启保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaGuard, utcDay } from '../lib/quota.js'
import { ChainSearchProvider } from '../lib/provider.js'
import { parseRetryAfterHeader, rateLimitedError, isRateLimited } from '../lib/util.js'
import { pickErrorDetail } from '../lib/json-api.js'
import { ENGINE_METAS, defaultDailyLimits, credentialSourceFor, keyEnvName } from '../lib/engines.js'
import { DeepSeekEngine } from '../lib/llm.js'
import { CredentialKeyState } from '../lib/credential.js'

/** 可控时钟。 */
function clock(start = Date.parse('2026-10-06T10:00:00Z')) {
  let at = start
  const now = () => at
  now.advance = (ms) => { at += ms }
  return now
}

function tempStatePath() {
  const dir = mkdtempSync(join(tmpdir(), 'wsc-quota-'))
  return { path: join(dir, 'quota.json'), dir }
}

// —— 基础判定 ——

test('护栏：未超上限时放行，超出后拒绝并给出重置时间', () => {
  const now = clock()
  const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 2 }, cooldownMs: 1000, now })
  assert.equal(guard.check('tavily').allowed, true)
  guard.noteAttempt('tavily')
  guard.noteAttempt('tavily')
  const verdict = guard.check('tavily')
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'exhausted')
  assert.equal(verdict.limit, 2)
  assert.equal(verdict.used, 2)
  assert.ok(verdict.retryAfterMs > 0 && verdict.retryAfterMs <= 24 * 3600 * 1000)
})

test('护栏：上限为 0 表示不限制', () => {
  const guard = new QuotaGuard({ enabled: true, dailyLimits: { bing: 0 }, cooldownMs: 1000 })
  for (let i = 0; i < 50; i += 1) guard.noteAttempt('bing')
  assert.equal(guard.check('bing').allowed, true)
})

test('护栏：未声明上限的引擎不限制', () => {
  const guard = new QuotaGuard({ enabled: true, dailyLimits: {}, cooldownMs: 1000 })
  guard.noteAttempt('unknown-engine')
  assert.equal(guard.check('unknown-engine').allowed, true)
})

test('护栏：关闭后既不限制也不计数', () => {
  const guard = new QuotaGuard({ enabled: false, dailyLimits: { tavily: 1 }, cooldownMs: 1000 })
  guard.noteAttempt('tavily')
  guard.noteAttempt('tavily')
  assert.equal(guard.check('tavily').allowed, true)
  assert.deepEqual(guard.snapshot().engines, {})
})

test('护栏：限额错误进入冷却，冷却结束后自动恢复', () => {
  const now = clock()
  const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 100 }, cooldownMs: 60000, now })
  guard.noteRateLimited('tavily')
  const cooling = guard.check('tavily')
  assert.equal(cooling.allowed, false)
  assert.equal(cooling.reason, 'cooldown')
  assert.equal(cooling.retryAfterMs, 60000)

  now.advance(60001)
  assert.equal(guard.check('tavily').allowed, true)
})

test('护栏：Retry-After 优先于默认冷却时长，且被收敛到当日剩余时间', () => {
  const now = clock()
  const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 100 }, cooldownMs: 60000, now })
  guard.noteRateLimited('tavily', 5 * 60000)
  assert.equal(guard.check('tavily').retryAfterMs, 5 * 60000)

  // 一个荒谬的 Retry-After（10 天）不应把引擎永久关掉。
  const other = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 100 }, cooldownMs: 60000, now })
  other.noteRateLimited('tavily', 10 * 24 * 3600 * 1000)
  const capped = other.check('tavily').retryAfterMs
  assert.ok(capped <= 24 * 3600 * 1000, `冷却应被收敛到当日剩余时间，实际 ${capped}`)
})

// —— 跨日与持久化 ——

test('护栏：跨 UTC 日自动清零', () => {
  const now = clock(Date.parse('2026-10-06T23:00:00Z'))
  const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 1 }, cooldownMs: 1000, now })
  guard.noteAttempt('tavily')
  assert.equal(guard.check('tavily').allowed, false)

  now.advance(2 * 3600 * 1000) // 越过 UTC 00:00
  assert.equal(guard.check('tavily').allowed, true)
  assert.equal(guard.snapshot().engines.tavily?.used ?? 0, 0, '快照不应显示上一日的计数')
})

test('护栏：用量落盘并在「重启」后仍然生效', () => {
  const { path } = tempStatePath()
  try {
    const first = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 3 }, cooldownMs: 1000, statePath: path })
    first.noteAttempt('tavily')
    first.noteAttempt('tavily')
    first.flush(true)

    // 模拟进程重启：同一个状态文件，新的实例。
    const second = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 3 }, cooldownMs: 1000, statePath: path })
    assert.equal(second.check('tavily').used, 2)
    second.noteAttempt('tavily')
    assert.equal(second.check('tavily').allowed, false, '重启不应把当日额度重置')
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('护栏：状态文件跨日则忽略旧计数', () => {
  const { path } = tempStatePath()
  try {
    writeFileSync(path, JSON.stringify({ day: '2000-01-01', engines: { tavily: { used: 99, limited: 0, cooldownUntil: 0 } } }))
    const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 3 }, cooldownMs: 1000, statePath: path })
    assert.equal(guard.check('tavily').used, 0)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('护栏：状态文件损坏时以空状态继续，不抛错', () => {
  const { path } = tempStatePath()
  try {
    writeFileSync(path, '{ not json')
    const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 1 }, cooldownMs: 1000, statePath: path })
    assert.equal(guard.check('tavily').used, 0)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('护栏：状态文件不可写时降级为内存，不影响判定', () => {
  // 用一个目录冒充文件路径，写入必然失败。
  const { dir } = tempStatePath()
  try {
    const guard = new QuotaGuard({ enabled: true, dailyLimits: { tavily: 1 }, cooldownMs: 1000, statePath: dir })
    guard.noteAttempt('tavily')
    assert.equal(guard.check('tavily').allowed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('utcDay 与 parseRetryAfterHeader', () => {
  assert.equal(utcDay(Date.parse('2026-10-06T23:59:59Z')), '2026-10-06')
  assert.equal(utcDay(Date.parse('2026-10-07T00:00:00Z')), '2026-10-07')
  assert.equal(parseRetryAfterHeader('30'), 30000)
  assert.equal(parseRetryAfterHeader(null), undefined)
  assert.equal(parseRetryAfterHeader('  '), undefined)
  assert.equal(parseRetryAfterHeader('not-a-value'), undefined)
  const at = Date.parse('2026-10-06T10:00:00Z')
  assert.equal(parseRetryAfterHeader('Tue, 06 Oct 2026 10:00:30 GMT', at), 30000)
})

test('isRateLimited：只认本插件自己的限额 code', () => {
  const limited = rateLimitedError('x', 1234)
  assert.equal(limited.code, 'WEB_PROVIDER_RATE_LIMITED')
  assert.equal(limited.retryAfterMs, 1234)
  assert.equal(isRateLimited(limited), true)
  assert.equal(isRateLimited(new Error('nope')), false)
})

// —— 错误信封解析（各家形状不同） ——

test('pickErrorDetail：兼容 Tavily / LangSearch / 直给 error 三种信封', () => {
  assert.equal(pickErrorDetail({ detail: { error: 'plan usage limit' } }, 432), 'plan usage limit')
  assert.equal(pickErrorDetail({ code: 429, message: 'Rate limit or daily allowance exceeded' }, 429), 'Rate limit or daily allowance exceeded')
  assert.equal(pickErrorDetail({ msg: '业务错误' }, 200), '业务错误')
  assert.equal(pickErrorDetail({ error: 'boom' }, 500), 'boom')
  assert.equal(pickErrorDetail('plain text', 503), 'HTTP 503')
  assert.equal(pickErrorDetail(null, 500), 'HTTP 500')
  assert.equal(pickErrorDetail({ error: { message: 'nested' } }, 500), 'nested')
})

// —— 静态表推导出的默认预算 ——

test('defaultDailyLimits：覆盖全部内置引擎且都是正数', () => {
  const limits = defaultDailyLimits()
  for (const meta of ENGINE_METAS) {
    assert.ok(meta.freeTier.note.length > 0, `${meta.id} 缺少额度说明`)
    assert.equal(limits[meta.id], meta.freeTier.dailyRequests, `${meta.id} 预算与表内声明不一致`)
    assert.ok(limits[meta.id] > 0, `${meta.id} 默认预算应为正数`)
  }
})

// —— 与提供方链的集成 ——

class StubEngine {
  constructor(id, { fail = false, limited = false, sources = [{ url: `https://${id}.example` }] } = {}) {
    this.id = id
    this.name = id
    this.fail = fail
    this.limited = limited
    this.calls = 0
    this.sources = sources
  }

  available() {
    return true
  }

  async search() {
    this.calls += 1
    if (this.limited) throw rateLimitedError(`${this.id} limited`, 30000)
    if (this.fail) throw new Error(`failed-${this.id}`)
    return { sources: this.sources, truncated: false }
  }
}

function chain(engines, quota, overrides = {}) {
  return new ChainSearchProvider({
    engines,
    strategy: 'failover',
    timeoutMs: 50,
    ...quota === undefined ? {} : { quota },
    ...overrides,
  })
}

test('链：超出预算的引擎在请求发出前就被跳过', async () => {
  const quota = new QuotaGuard({ enabled: true, dailyLimits: { a: 1 }, cooldownMs: 1000 })
  const a = new StubEngine('a')
  const b = new StubEngine('b')
  const provider = chain([a, b], quota)

  const first = await provider.search({ query: 'q' })
  assert.equal(first.sources[0].url, 'https://a.example')
  assert.equal(a.calls, 1)

  // a 的预算已用尽 → 本次必须落到 b，且 a 一次都不能被调用。
  const second = await provider.search({ query: 'q' })
  assert.equal(second.sources[0].url, 'https://b.example')
  assert.equal(a.calls, 1, 'a 不应再次发出请求')
  assert.equal(b.calls, 1)
})

test('链：全部引擎都触顶时抛 WEB_PROVIDER_RATE_LIMITED 且不发请求', async () => {
  const quota = new QuotaGuard({ enabled: true, dailyLimits: { a: 1, b: 1 }, cooldownMs: 1000 })
  // a 失败而 b 成功，这样一次搜索会同时用掉两个引擎各自的 1 次额度。
  const a = new StubEngine('a', { fail: true })
  const b = new StubEngine('b')
  const provider = chain([a, b], quota)

  const first = await provider.search({ query: 'q' })
  assert.equal(first.sources[0].url, 'https://b.example')
  assert.equal(a.calls, 1)
  assert.equal(b.calls, 1)

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_RATE_LIMITED'
      && error.message.includes('请求预算')
      && error.message.includes('a')
      && error.message.includes('b'),
  )
  assert.equal(a.calls, 1, '触顶后不得再发请求')
  assert.equal(b.calls, 1, '触顶后不得再发请求')
})

test('链：提供方限额错误让该引擎进入冷却，后续请求直接换下一个', async () => {
  const quota = new QuotaGuard({ enabled: true, dailyLimits: { a: 100, b: 100 }, cooldownMs: 60000 })
  const a = new StubEngine('a', { limited: true })
  const b = new StubEngine('b')
  const provider = chain([a, b], quota)

  const first = await provider.search({ query: 'q' })
  assert.equal(first.sources[0].url, 'https://b.example')
  assert.equal(a.calls, 1)
  assert.equal(quota.check('a').reason, 'cooldown')

  // 冷却期内 a 直接出局，不再浪费一次请求。
  const second = await provider.search({ query: 'q' })
  assert.equal(second.sources[0].url, 'https://b.example')
  assert.equal(a.calls, 1, '冷却中的引擎不应被再次尝试')
  assert.equal(b.calls, 2)
})

test('链：没有配置护栏时行为与从前一致', async () => {
  const a = new StubEngine('a', { fail: true })
  const b = new StubEngine('b')
  const provider = chain([a, b])
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://b.example')
})

// —— DeepSeek 兜底引擎的凭据解析（桌面端的关键路径） ——

test('keyEnvName：显式 apiKeyEnv 覆盖元数据默认名，免密钥引擎没有引用名', () => {
  const llmMeta = ENGINE_METAS.find((meta) => meta.id === 'deepseek-official')
  const bingMeta = ENGINE_METAS.find((meta) => meta.id === 'bing')
  assert.equal(keyEnvName(llmMeta, {}), 'DEEPSEEK_API_KEY')
  assert.equal(keyEnvName(llmMeta, { apiKeyEnv: 'MY_KEY' }), 'MY_KEY')
  assert.equal(keyEnvName(bingMeta, {}), undefined)
})

test('credentialSourceFor：envName 缺失时不构造凭据来源', () => {
  assert.equal(credentialSourceFor({ get: () => undefined }, undefined), undefined)
  assert.equal(credentialSourceFor({ get: () => undefined }, ''), undefined)
})

test('credentialSourceFor：从 harness 凭据服务读 key（$DSH_HOME/.credentials.yaml）', async () => {
  const ctx = {
    get: (name) => (name === 'credentials'
      ? { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'from-store' } : undefined) }
      : undefined),
  }
  const source = credentialSourceFor(ctx, 'DEEPSEEK_API_KEY')
  assert.equal(await source.resolve(), 'from-store')
  assert.equal(source.present(), true)

  // 空串与缺失都读作「没有」，避免把空白当成已配置的密钥。
  const blankCtx = { get: () => ({ resolve: async () => ({ value: '' }) }) }
  assert.equal(await credentialSourceFor(blankCtx, 'DEEPSEEK_API_KEY').resolve(), undefined)
  const missingCtx = { get: () => undefined }
  assert.equal(await credentialSourceFor(missingCtx, 'DEEPSEEK_API_KEY').resolve(), undefined)
  assert.equal(credentialSourceFor(missingCtx, 'DEEPSEEK_API_KEY').present(), false)
})

test('credentialSourceFor：凭据服务抛错时读作「取不到」，不冒泡', async () => {
  const ctx = { get: () => ({ resolve: async () => { throw new Error('store offline') } }) }
  assert.equal(await credentialSourceFor(ctx, 'DEEPSEEK_API_KEY').resolve(), undefined)
})

// ─── 凭据状态机：同步判定 + 热重载友好的负缓存 ────────────────────────────

/**
 * 让后台探针的整条微任务链（`then` → `catch` → `finally`）跑完。
 *
 * 用 setTimeout 而不是数「几次 await Promise.resolve()」：探针链的长度是
 * 实现细节，数拍子会让测试在无关的实现改动下假性失败。
 */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

test('CredentialKeyState：只有确认有 key 才放行，绝不乐观返回 true', async () => {
  const source = { resolve: async () => undefined, present: () => true }
  const state = new CredentialKeyState(source)
  // 首次询问时探针刚发出，还没结论 —— 必须如实返回 false，
  // 否则没有 key 的引擎会白白发一次注定 401 的请求。
  assert.equal(state.confirmed(), false)
  await settle()
  assert.equal(state.confirmed(), false, '探到「没有」之后仍应拒绝')
})

test('CredentialKeyState：探到 key 之后同步判定放行', async () => {
  const source = { resolve: async () => 'sk-live', present: () => true }
  const state = new CredentialKeyState(source)
  assert.equal(state.confirmed(), false)
  assert.equal(await state.resolve(), 'sk-live')
  assert.equal(state.confirmed(), true, '解析过一次之后同步判定就应放行')
})

test('CredentialKeyState：负结论带 TTL，补上 key 后无需重启', async () => {
  let at = 0
  let stored
  const source = { resolve: async () => stored, present: () => true }
  const state = new CredentialKeyState(source, () => at, 5000)

  state.confirmed()          // 触发探针
  await settle()
  assert.equal(state.confirmed(), false, 'TTL 内沿用负结论')

  stored = 'sk-later'        // 用户往 .credentials.yaml 里补了 key
  at += 4999
  assert.equal(state.confirmed(), false, 'TTL 未到前不重探')
  at += 2
  state.confirmed()          // TTL 到期，重探
  await settle()
  assert.equal(state.confirmed(), true, '补上 key 后应被认到，无需重启')
})

test('CredentialKeyState：字面量优先，且不会去查凭据服务', async () => {
  let calls = 0
  const source = { resolve: async () => { calls += 1; return 'from-store' }, present: () => true }
  const state = new CredentialKeyState(source)
  assert.equal(await state.resolve('literal'), 'literal')
  assert.equal(calls, 0, '有字面量时不应查凭据服务')
  assert.equal(state.confirmed(), true)
})

test('CredentialKeyState：没有凭据来源时如实不可用', () => {
  const state = new CredentialKeyState(undefined)
  assert.equal(state.confirmed(), false)
  assert.equal(state.sourcePresent(), false)
})

test('CredentialKeyState：凭据服务未挂载时不写负结论，挂载后仍能认到', async () => {
  let mounted = false
  let stored = 'sk-live'
  const source = { resolve: async () => (mounted ? stored : undefined), present: () => mounted }
  const state = new CredentialKeyState(source, () => 0, 5000)
  assert.equal(state.confirmed(), false)

  mounted = true
  stored = 'sk-live'
  assert.equal(state.confirmed(), false, '首次触发探针时还没有结论')
  await settle()
  assert.equal(state.confirmed(), true)
})

test('DeepSeek 引擎：凭据库里有 key 时可用，没有时如实不可用', async () => {
  const meta = ENGINE_METAS.find((entry) => entry.id === 'deepseek-official')
  const withKey = new DeepSeekEngine({
    meta,
    credential: { resolve: async () => 'from-store', present: () => true },
  })
  await withKey.search({ query: 'q' }).catch(() => {}) // 只为了让状态机解析一次
  assert.equal(withKey.available(), true, '凭据库里配了 key 的机器不应被误判为不可用')

  const notMounted = new DeepSeekEngine({ meta, credential: { resolve: async () => undefined, present: () => false } })
  assert.equal(notMounted.available(), false)

  const bare = new DeepSeekEngine({ meta })
  assert.equal(bare.available(), false, '既无字面量也无凭据服务时不可用')
})

test('DeepSeek 引擎：凭据库无 key 时给出可读的缺失错误', async () => {
  const meta = ENGINE_METAS.find((entry) => entry.id === 'deepseek-official')
  const engine = new DeepSeekEngine({
    meta,
    credential: { resolve: async () => undefined, present: () => true },
  })
  await assert.rejects(
    engine.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE' && error.message.includes('DEEPSEEK_API_KEY'),
  )
})

test('引擎元数据：deepseek-official 声明了与内置搜索一致的环境变量端点覆盖', () => {
  const meta = ENGINE_METAS.find((entry) => entry.id === 'deepseek-official')
  assert.equal(meta.endpointEnv, 'DEEPSEEK_SEARCH_BASE_URL')
})
