import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainSearchProvider } from '../lib/provider.js'

class StubEngine {
  constructor(id, { fail = false, sources = [{ url: `https://${id}.example` }], hang = false } = {}) {
    this.id = id
    this.name = id
    this.fail = fail
    this.hang = hang
    this.calls = 0
    this.sources = sources
  }

  available() {
    return true
  }

  async search(request, signal) {
    this.calls += 1
    if (this.hang) {
      // 真实引擎尊重 signal；这里挂起直到被取消，用于验证超时/外部取消路径。
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    }
    if (this.fail) throw new Error(`failed-${this.id}`)
    return { sources: this.sources, truncated: false }
  }
}

function chain(engines, overrides = {}) {
  return new ChainSearchProvider({
    engines,
    strategy: 'failover',
    timeoutMs: 50,
    ...overrides,
  })
}

test('failover：首个引擎失败时自动回退到下一个', async () => {
  const first = new StubEngine('first', { fail: true })
  const second = new StubEngine('second')
  const provider = chain([first, second])
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://second.example')
})

test('failover：首个成功即返回，不再尝试后续引擎', async () => {
  const first = new StubEngine('first')
  const second = new StubEngine('second')
  const provider = chain([first, second])
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://first.example')
  assert.equal(second.calls, 0)
})

test('failover：全部失败时抛出聚合的错误摘要', async () => {
  const provider = chain([new StubEngine('a', { fail: true }), new StubEngine('b', { fail: true })])
  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('a') && error.message.includes('b'),
  )
})

test('failover：外部取消以 WEB_ABORTED 终止整条链', async () => {
  const hangs = new StubEngine('hang', { hang: true })
  const provider = chain([hangs])
  const controller = new AbortController()
  const promise = provider.search({ query: 'q' }, controller.signal)
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await assert.rejects(promise, (error) => error.code === 'WEB_ABORTED')
})

test('failover：超时被视为该引擎失败并继续回退', async () => {
  const hang = new StubEngine('hang', { hang: true })
  const ok = new StubEngine('ok')
  const provider = chain([hang, ok])
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://ok.example')
})

test('aggregate：并发合并并以 URL 去重', async () => {
  const a = new StubEngine('a', { sources: [{ url: 'https://dup.example', title: 'from-a' }] })
  const b = new StubEngine('b', { sources: [{ url: 'https://dup.example', title: 'from-b' }] })
  const provider = chain([a, b], { strategy: 'aggregate' })
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].title, 'from-a')
})

test('aggregate：结果超上限时截断并标记 truncated', async () => {
  const a = new StubEngine('a', { sources: [{ url: 'https://a1.example' }, { url: 'https://a2.example' }] })
  const provider = chain([a, new StubEngine('b')], { strategy: 'aggregate' })
  const result = await provider.search({ query: 'q', maxResults: 1 })
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, true)
})

test('aggregate：全部失败时抛出聚合的错误摘要', async () => {
  const provider = chain([new StubEngine('a', { fail: true })], { strategy: 'aggregate' })
  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR',
  )
})

test('无任何可用引擎时，available=false 且搜索抛 WEB_PROVIDER_UNAVAILABLE', async () => {
  const dead = {
    id: 'dead',
    name: 'dead',
    available: () => false,
    async search() {
      throw new Error('never called')
    },
  }
  const provider = chain([dead])
  assert.equal(provider.available(), false)
  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
  )
})

test('request 未带 maxResults 时套用 defaultMaxResults', async () => {
  const many = new StubEngine('many', {
    sources: Array.from({ length: 5 }, (_, i) => ({ url: `https://m${i}.example` })),
  })
  const provider = chain([many], { defaultMaxResults: 3 })
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources.length, 3)
  assert.equal(result.truncated, true)
})