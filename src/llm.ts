/**
 * DeepSeek 官方后端：通过 Anthropic 兼容的 Messages API 使用原生
 * `web_search_20250305` 服务器端搜索工具。每次搜索消耗一次模型调用，
 * 但返回结构化结果块；对话适配器与搜索后端在密钥之外互不影响。
 * @module dsh-web-search-chain/llm
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { Engine } from './engine.js'
import type { LlmEngineMeta } from './engines.js'
import { isAbortError, parseRetryAfterHeader, PLUGIN_USER_AGENT, RATE_LIMIT_STATUS, rateLimitedError, shortErrorMessage } from './util.js'
import { CredentialKeyState } from './credential.js'
import type { CredentialSource } from './credential.js'

/** 构造 DeepSeek 适配器所需的解析结果。 */
export interface DeepSeekEngineOptions {
  /** 引擎的元数据行（端点、模型、token 上限等来自这里）。 */
  readonly meta: LlmEngineMeta
  /** 已从配置/环境解析出的字面量密钥（同步可知）。 */
  readonly apiKey?: string
  /** 端点基础覆盖；`/messages` 会被追加。 */
  readonly baseURL?: string
  /**
   * harness 凭据 seam：字面量为空时从这里解析。
   *
   * 内置换行搜索的 `web-search-deepseek` 正是这样取 key 的 —— 桌面端把
   * DeepSeek key 写在 `$DSH_HOME/.credentials.yaml`，启动环境里看不到它。
   * 同一个 seam 也覆盖 `.env`，并按「进程环境 > 凭据库 > 项目 .env > home .env」
   * 的信任顺序取第一个命中的值。
   */
  readonly credential?: CredentialSource
}

/** 一个 `web_search_result` 条目（可引用的结果形状）。 */
export interface WebSearchResultItem {
  type: string
  url: string
  title?: string | null
  /** 提供方给出的页面新旧程度字符串（映射到 publishedAt）。 */
  page_age?: string | null
}

/** 携带可引用结果的 content 块。 */
export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result'
  content?: WebSearchResultItem[]
}

/** text 块内的一条引用（摘要的真正来源）。 */
export interface CitationLocation {
  type?: string
  url?: string | null
  cited_text?: string | null
}

/** 携带引用位置的 text 块。 */
export interface TextBlock {
  type: 'text'
  text?: string | null
  citations?: CitationLocation[]
}

/** 任意 content 块；只有 `web_search_tool_result` 与 `text` 会被消费。 */
export type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string }

/** Messages 响应信封。 */
export interface AnthropicResponse {
  content?: ContentBlock[]
}

/** 错误响应信封（尽力提取字段，各提供方略有差异）。 */
export interface AnthropicError {
  error?: { message?: string } | string
  message?: string
}

/**
 * 从每个 text 块的 `citations[]` 构建 `url → cited_text` 映射。
 * 这是摘要来源：`web_search_result` 条目通常不带行内摘要，摘要在按 URL 关联的
 * 独立 text 块引用里（首次出现优先）。
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * 把 Anthropic Messages 响应规范化为搜索结果：逐条读取 `web_search_tool_result`
 * 块的可引用条目，按 URL 关联摘要去重；没有结果块时抛错。
 */
export function mapAnthropicResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek 未返回 web_search_tool_result 块：请求可能没有触发原生 web search',
      'WEB_PROVIDER_ERROR',
    )
  }
  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { sources, truncated: false }
}

/** 从非 2xx 响应尽最大努力提取一句可读错误。 */
async function describeError(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`
  try {
    const parsed = await response.json() as AnthropicError
    const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    if (typeof detail === 'string' && detail.length > 0) return detail
    return fallback
  } catch {
    return fallback
  }
}

/** DeepSeek 官方后端引擎。 */
export class DeepSeekEngine implements Engine {
  readonly id: string
  readonly name: string
  private readonly baseURL: string
  private readonly apiKey?: string
  private readonly keys: CredentialKeyState

  constructor(private readonly options: DeepSeekEngineOptions) {
    this.id = options.meta.id
    this.name = options.meta.name
    this.baseURL = options.baseURL ?? options.meta.endpoint
    this.apiKey = options.apiKey
    this.keys = new CredentialKeyState(options.credential)
  }

  /**
   * 本地可用性检查。
   *
   * 字面量密钥同步可知；凭据库只能异步读，但这里**不乐观放行** ——
   * 一旦凭据服务已挂载，`confirmed()` 会在毫秒级探到真实结论并缓存；
   * 在结论出来之前如实返回 false，避免把一个取不到 key 的引擎塞进链里
   * 白白发一次请求。负结论带 TTL，所以在凭据库里后补 key 无需重启。
   */
  available(): boolean {
    const hasKey = (this.apiKey?.length ?? 0) > 0 || this.keys.confirmed()
    return hasKey
      && URL.canParse(this.baseURL)
      && Number.isInteger(this.options.meta.maxTokens) && this.options.meta.maxTokens > 0
      && Number.isInteger(this.options.meta.maxUses) && this.options.meta.maxUses > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await this.keys.resolve(this.apiKey)
    if (apiKey === undefined) {
      throw new WebError(
        `DeepSeek 官方搜索需要 ${this.options.meta.authEnv}：它既不在插件配置/启动环境里，`
        + `也不在 harness 凭据库（$DSH_HOME/.credentials.yaml）中。`
        + '可在 Web UI 的 Models 页填入 DeepSeek key，或给本引擎配置 apiKey。',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    const endpoint = `${this.baseURL}/messages`
    const { model, apiVersion, maxTokens, maxUses } = this.options.meta
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }
    if (signal?.aborted === true) throw new WebError('DeepSeek 搜索已中止', 'WEB_ABORTED')

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          // 官方预期 x-api-key；兼容 Anthropic 代理的 Bearer 一并发送。
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': PLUGIN_USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DeepSeek 搜索已中止', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `DeepSeek 搜索请求失败：${shortErrorMessage(error)}（端点 ${endpoint}）`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = await describeError(response)
      // 402/429 都是「不要再打了」：模型调用按 token 计费，超限重试会真实花钱。
      if (RATE_LIMIT_STATUS.has(response.status)) {
        throw rateLimitedError(
          `DeepSeek 官方搜索触发限额（HTTP ${response.status}）：${detail}`,
          parseRetryAfterHeader(response.headers.get('retry-after')),
        )
      }
      throw new WebError(`DeepSeek API 错误（${detail}）`, 'WEB_PROVIDER_ERROR')
    }

    let payload: AnthropicResponse
    try {
      payload = await response.json() as AnthropicResponse
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DeepSeek 搜索已中止', 'WEB_ABORTED', { cause: error })
      throw new WebError('DeepSeek 返回了无法解析的响应体', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    return mapAnthropicResponse(payload)
  }
}