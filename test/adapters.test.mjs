import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_METAS } from '../lib/engines.js'
import { mapJsonApiPayload } from '../lib/json-api.js'
import { citationSnippets, mapAnthropicResponse } from '../lib/llm.js'
import { parseBingHtml, unwrapBingHref } from '../lib/bing.js'

const metaById = new Map(ENGINE_METAS.map((meta) => [meta.id, meta]))

test('Tavily 响应映射：字段映射与无效条目丢弃', () => {
  const sources = mapJsonApiPayload({
    answer: 'an answer',
    results: [
      { title: 'A', url: 'https://a.example', content: 'snippet a', published_date: '2024-01-02' },
      { title: 'B', url: 'https://b.example', content: '   ' },
      { title: 'C', url: '', content: 'no url' },
      { title: 'D', url: 'https://d.example', content: null },
    ],
  }, metaById.get('tavily').response)

  assert.equal(sources.length, 3)
  assert.deepEqual(sources[0], {
    url: 'https://a.example',
    title: 'A',
    snippet: 'snippet a',
    publishedAt: '2024-01-02',
  })
  assert.equal(sources[1].snippet, undefined)
  assert.ok(sources.every((s) => s.url.startsWith('https://')))
})

test('LangSearch 响应映射：snippet 回退到 summary', () => {
  const sources = mapJsonApiPayload({
    code: 200,
    msg: null,
    data: {
      webPages: {
        value: [
          { name: 'T', url: 'https://t.example', snippet: '', summary: 'long summary' },
          { name: 'U', url: 'https://u.example', snippet: 'short', datePublished: '2024-03-01' },
        ],
      },
    },
  }, metaById.get('langsearch').response)

  assert.equal(sources.length, 2)
  assert.equal(sources[0].snippet, 'long summary')
  assert.equal(sources[1].snippet, 'short')
  assert.equal(sources[1].publishedAt, '2024-03-01')
})

test('DeepSeek 响应映射：结果块与按 URL 关联的引用摘要', () => {
  const blocks = [
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: 'https://a.example', title: 'A', page_age: '1d' },
        { type: 'web_search_result', url: 'https://b.example', title: 'B' },
      ],
    },
    { type: 'text', text: '..', citations: [{ url: 'https://a.example', cited_text: 'snippet a' }] },
  ]
  const result = mapAnthropicResponse({ content: blocks })
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].snippet, 'snippet a')
  assert.equal(result.sources[0].publishedAt, '1d')
  assert.equal(result.sources[1].snippet, undefined)
})

test('DeepSeek 响应映射：无结果块时抛错', () => {
  assert.throws(
    () => mapAnthropicResponse({ content: [{ type: 'text', text: 'no search' }] }),
    (error) => error.code === 'WEB_PROVIDER_ERROR',
  )
})

test('citationSnippets：url → cited_text 首次出现优先', () => {
  const blocks = [
    { type: 'text', text: 'a', citations: [
      { url: 'https://x.example', cited_text: 'first' },
      { url: 'https://x.example', cited_text: 'second' },
      { url: 'https://y.example' },
    ] },
  ]
  const map = citationSnippets(blocks)
  assert.equal(map.get('https://x.example'), 'first')
})

test('Bing HTML 解析：提取标题、URL、摘要并解码实体', () => {
  const html = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://example.com/page?a=1&amp;b=2">Title <b>One</b></a></h2>
        <div class="b_caption"><p>Snippet &amp; text</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="${'https://www.bing.com/ck/a?q=x&u=' + b64url('https://target.example/x')}">Redirected</a></h2>
      </li>
      <li class="b_algo"><h2><a href="/relative">No scheme</a></h2></li>
    </ol>`
  const sources = parseBingHtml(html)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://example.com/page?a=1&b=2')
  assert.equal(sources[0].title, 'Title One')
  assert.equal(sources[0].snippet, 'Snippet & text')
  assert.equal(sources[1].url, 'https://target.example/x')
  assert.equal(sources[1].title, 'Redirected')
})

test('unwrapBingHref：直链保留、ck 链接解包、无效链接拒绝', () => {
  assert.equal(unwrapBingHref('https://plain.example/path?q=1'), 'https://plain.example/path?q=1')
  assert.equal(unwrapBingHref(`https://www.bing.com/ck/a?u=${b64url('https://deep.example/z')}`), 'https://deep.example/z')
  assert.equal(unwrapBingHref('https://www.bing.com/ck/a?u=not-base64!'), undefined)
  assert.equal(unwrapBingHref('/relative/path'), undefined)
})

function b64url(plain) {
  return Buffer.from(plain, 'utf8').toString('base64url')
}