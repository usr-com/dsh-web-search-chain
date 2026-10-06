/**
 * Bing 免密钥抓取适配器：直接请求桌面搜索引擎页面并解析结果列表。
 * 不需要任何 API key —— 这正是链上「不带 API 的后端」的兜底代表。
 * @module dsh-web-search-chain/bing
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { Engine } from './engine.js'
import type { ScrapeEngineMeta } from './engines.js'
import { BING_USER_AGENT, decodeEntities, isAbortError, shortErrorMessage, stripTags } from './util.js'

/** 构造 Bing 适配器所需的解析结果。 */
export interface BingEngineOptions {
  /** 引擎的元数据行（端点模板来自这里）。 */
  readonly meta: ScrapeEngineMeta
  /** 端点覆盖（须是端点模板）。 */
  readonly baseURL?: string
}

/** base64url 解码 Bing `ck/a` 链接里 `u=` 参数携带的真实 URL。 */
function unbase64Url(text: string): string | undefined {
  try {
    const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=')
    const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    if (/^https?:\/\//i.test(decoded)) return decoded
    return undefined
  } catch {
    return undefined
  }
}

/** 将 Bing 重定向链接解包为真实 URL；无法解包时返回 undefined。 */
export function unwrapBingHref(href: string): string | undefined {
  if (/^https?:\/\//i.test(href) && !href.includes('bing.com')) {
    return href.split('#')[0]
  }
  if (!href.includes('bing.com/ck/')) return undefined
  try {
    const url = new URL(href, 'https://www.bing.com')
    const encoded = url.searchParams.get('u')
    if (encoded !== null && encoded.length > 0) return unbase64Url(encoded)
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 把 Bing 搜索结果页 HTML 解析为规范化 sources。
 * 以 `li.b_algo` 为结果块逐条提取标题、URL 与摘要；提取不到任何条目的情况（
 * 验证码页 / 空结果 / DOM 结构变更）返回空数组，由调用方决定如何解读。
 * 导出为纯函数便于单测。
 */
export function parseBingHtml(html: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const itemPattern = /<li class="b_algo"[\s\S]*?<\/li>/g
  for (const match of html.matchAll(itemPattern)) {
    const block = match[0]
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (anchor === null) continue
    const url = unwrapBingHref(decodeEntities(anchor[1]))
    if (url === undefined) continue
    const title = stripTags(decodeEntities(anchor[2]))
    const caption = /class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = caption === null ? undefined : stripTags(decodeEntities(caption[1]))
    sources.push({
      url,
      ...title.length > 0 ? { title } : {},
      ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

/** 免密钥的 Bing 抓取引擎。 */
export class BingEngine implements Engine {
  readonly id: string
  readonly name: string
  private readonly endpointTemplate: string

  constructor(private readonly options: BingEngineOptions) {
    this.id = options.meta.id
    this.name = options.meta.name
    this.endpointTemplate = options.baseURL ?? options.meta.endpoint
  }

  available(): boolean {
    return URL.canParse(this.endpointTemplate.replace('{query}', 'q').replace('{count}', '1'))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const count = request.maxResults ?? 10
    const url = new URL(
      this.endpointTemplate
        .replace('{query}', encodeURIComponent(request.query))
        .replace('{count}', String(count)),
      'https://www.bing.com',
    )
    if (this.options.meta.extraQuery !== undefined) {
      for (const [key, value] of Object.entries(this.options.meta.extraQuery)) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value)
      }
    }

    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': BING_USER_AGENT,
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new WebError('Bing 抓取已中止', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`Bing 抓取失败：${shortErrorMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(`Bing 抓取失败（HTTP ${response.status}）`, 'WEB_PROVIDER_ERROR')
    }

    let html: string
    try {
      html = await response.text()
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new WebError('Bing 抓取已中止', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`Bing 响应体读取失败：${shortErrorMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (signal?.aborted === true) {
      throw new WebError('Bing 抓取已中止', 'WEB_ABORTED')
    }

    return { sources: parseBingHtml(html), truncated: false }
  }
}