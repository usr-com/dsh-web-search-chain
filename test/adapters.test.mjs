import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_METAS } from '../lib/engines.js'
import { mapJsonApiPayload } from '../lib/json-api.js'
import { citationSnippets, mapAnthropicResponse } from '../lib/llm.js'
import { parseBingHtml, unwrapBingHref } from '../lib/bing.js'
import { decodeEntities } from '../lib/util.js'

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

// Bing 摘要里的分隔符是 &ensp;、时间戳是 &#0183; 这类数字实体；
// 不解码就会原样进入引用文本（实测线上输出里确实带着 &ensp;&#0183;&ensp;）。
test('decodeEntities：数字实体（十进制 / 十六进制）都要还原', () => {
  assert.equal(decodeEntities('a&#0183;b'), 'a·b')
  assert.equal(decodeEntities('a&#183;b'), 'a·b')
  assert.equal(decodeEntities('a&#x27;b'), "a'b")
  assert.equal(decodeEntities('a&#X2014;b'), 'a—b')
})

test('decodeEntities：命名实体覆盖摘要里真正会出现的那些', () => {
  assert.equal(decodeEntities('1&ensp;&#0183;&ensp;text'), '1 · text')
  assert.equal(decodeEntities('a&nbsp;b&mdash;c&hellip;d'), 'a b—c…d')
  assert.equal(decodeEntities('&ldquo;引号&rdquo;'), '“引号”')
  assert.equal(decodeEntities('A&middot;B&Trade;C'), 'A·B™C')
})

test('decodeEntities：转义只解一层，未知实体原样保留', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', '&amp;lt; 不能变成 <')
  assert.equal(decodeEntities('&amp;amp;'), '&amp;')
  assert.equal(decodeEntities('5 &lt; 6 &amp;&amp; 7 &gt; 6'), '5 < 6 && 7 > 6')
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;')
  assert.equal(decodeEntities('&#xZZ;'), '&#xZZ;', '非法十六进制保留原文')
  assert.equal(decodeEntities('&#99999999999;'), '&#99999999999;', '越界码点保留原文')
})

test('parseBingHtml：真实形状的摘要被清干净', () => {
  const html = `
    <li class="b_algo">
      <h2><a href="https://example.com/x">标题 &amp; 副标题</a></h2>
      <div class="b_caption"><p>2026年10月6日&ensp;&#0183;&ensp;正文 &mdash; 更多</p></div>
    </li>`
  const [source] = parseBingHtml(html)
  assert.equal(source.title, '标题 & 副标题')
  assert.equal(source.snippet, '2026年10月6日 · 正文 — 更多')
  assert.ok(!source.snippet.includes('&'), '摘要里不该残留任何实体')
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