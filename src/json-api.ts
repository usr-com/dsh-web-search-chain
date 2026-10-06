/**
 * 标准 JSON HTTP 搜索 API 适配器（Tavily、LangSearch 共用）。
 * 端点的所有差异都收进元数据行：鉴权写法、端点、请求构造与响应映射 ——
 * 因此新增一个同协议引擎不需要写任何适配器代码。
 * @module dsh-web-search-chain/json-api
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { Engine } from './engine.js'
import type {
  JsonApiEngineMeta,
  JsonApiResponseSpec,
} from './engines.js'
import { getPath, isAbortError, parseRetryAfterHeader, PLUGIN_USER_AGENT, RATE_LIMIT_STATUS, rateLimitedError, shortErrorMessage } from './util.js'
import { CredentialKeyState } from './credential.js'
import type { CredentialSource } from './credential.js'

/** 构造 JSON API 适配器所需的解析结果。 */
export interface JsonApiEngineOptions {
  /** 引擎的元数据行（端点、请求/响应映射都来自这里）。 */
  readonly meta: JsonApiEngineMeta
  /** 已从配置/环境解析出的字面量密钥（缺省 undefined）。 */
  readonly apiKey?: string
  /** 端点覆盖（完整 URL，常用于自建代理）。 */
  readonly baseURL?: string
  /**
   * harness 凭据 seam：需要密钥的引擎会先查字面量，再查它。
   * 走这条缝意味着 `$DSH_HOME/.credentials.yaml`（Models 页写模型密钥的地方）
   * 与 `.env` 都能供 key，且前者被热监听、改完即生效。
   */
  readonly credential?: CredentialSource
}

/**
 * 把原始响应 JSON 按元数据的响应映射规范化为 sources。
 * 暴露为导出纯函数便于单测；跳过没有非空 URL 的条目，避免编造引用。
 */
export function mapJsonApiPayload(payload: unknown, spec: JsonApiResponseSpec): WebSearchSource[] {
  const raw = getPath(payload, spec.resultsPath)
  if (!Array.isArray(raw)) return []
  const sources: WebSearchSource[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const url = stringValue(getPath(record, spec.fields.url))
    if (url === undefined) continue
    const title = stringValue(getPath(record, spec.fields.title))
    let snippet = spec.fields.snippet !== undefined
      ? stringValue(getPath(record, spec.fields.snippet))
      : undefined
    if (snippet === undefined && spec.fields.snippetFallback !== undefined) {
      snippet = stringValue(getPath(record, spec.fields.snippetFallback))
    }
    const publishedAt = spec.fields.publishedAt !== undefined
      ? stringValue(getPath(record, spec.fields.publishedAt))
      : undefined
    sources.push({
      url,
      ...title !== undefined ? { title } : {},
      ...snippet !== undefined ? { snippet } : {},
      ...publishedAt !== undefined ? { publishedAt } : {},
    })
  }
  return sources
}

/** 读取非空白字符串字段；其它类型一律视为无。 */
function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 从解析后的错误信封里尽量挑出一句可读细节。
 *
 * 各家的信封不同：Tavily 是 `{ detail: { error } }`，LangSearch 是
 * `{ code, message | msg }`，也有直接 `{ error: string }` 的。这里是纯函数，
 * 便于单测覆盖每种形状。
 * @param parsed - 已解析的响应体；非对象返回 undefined。
 * @param status - HTTP 状态码，用作最终兜底文案。
 */
export function pickErrorDetail(parsed: unknown, status: number): string {
  const fallback = `HTTP ${status}`
  if (parsed === null || typeof parsed !== 'object') return fallback
  const record = parsed as Record<string, unknown>
  const candidates: unknown[] = [
    record.error,
    record.message,
    record.msg,
    record.detail,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>
      for (const key of ['error', 'message', 'msg'] as const) {
        const value = nested[key]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
    }
  }
  return fallback
}

/** 从非 2xx 响应尽量提取一句可读错误（JSON 或纯文本均可）。 */
async function describeError(response: Response): Promise<string> {
  try {
    return pickErrorDetail(await response.json(), response.status)
  } catch {
    // 失败只损失更丰富的错误文案，绝不让body读取错误替换真实状态。
    return `HTTP ${response.status}`
  }
}

/** 标准的 JSON 搜索 API 引擎。 */
export class JsonApiEngine implements Engine {
  readonly id: string
  readonly name: string
  private readonly endpoint: string
  private readonly apiKey?: string
  private readonly keys: CredentialKeyState

  constructor(private readonly options: JsonApiEngineOptions) {
    this.id = options.meta.id
    this.name = options.meta.name
    this.endpoint = options.baseURL ?? options.meta.endpoint
    this.apiKey = options.apiKey
    this.keys = new CredentialKeyState(options.credential)
  }

  /**
   * 本地可用性检查。
   *
   * 需要密钥时：字面量（配置/环境）同步可知，凭据库只能异步读 ——
   * `CredentialKeyState.confirmed()` 只在**确认**有 key 时返回 true，
   * 绝不乐观放行，否则没有 key 的引擎会白白发出注定 401 的请求，
   * 而链的设计恰恰要求这类引擎被瞬间跳过。
   */
  available(): boolean {
    if (!URL.canParse(this.endpoint)) return false
    if (!this.options.meta.requiresKey) return true
    if ((this.apiKey?.length ?? 0) > 0) return true
    return this.keys.confirmed()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const meta = this.options.meta
    const { queryField, countField, extra, extraQuery } = meta.request
    const method = meta.method

    // 每次搜索都重新解析密钥，凭据库改动立即可见。
    const key = await this.keys.resolve(this.apiKey)
    if (meta.requiresKey && key === undefined) {
      throw new WebError(
        `${this.name} 需要密钥${meta.authEnv !== undefined ? `（${meta.authEnv}）` : ''}：`
        + '它既不在插件配置/启动环境里，也不在 harness 凭据库中。'
        + '可把它写进 $DSH_HOME/.credentials.yaml，或配置 engines.'
        + `${meta.id}.apiKey。`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }

    // GET 的查询全部走查询串；POST 的查询词在请求体里，但 `extraQuery` 与
    // `auth: 'query'` 两种模式仍要拼到 URL 上（很多接口混用两者）。
    let endpoint = this.endpoint
    if (method === 'GET' || extraQuery !== undefined || meta.auth === 'query') {
      const url = new URL(this.endpoint)
      if (method === 'GET') {
        url.searchParams.set(queryField ?? 'query', request.query)
        if (countField !== undefined && request.maxResults !== undefined) {
          url.searchParams.set(countField, String(request.maxResults))
        }
      }
      if (extraQuery !== undefined) {
        for (const [name, value] of Object.entries(extraQuery)) url.searchParams.set(name, value)
      }
      if (meta.auth === 'query' && (key?.length ?? 0) > 0) {
        url.searchParams.set(meta.authParam as string, key as string)
      }
      endpoint = url.toString()
    }

    const body: Record<string, unknown> = { [queryField ?? 'query']: request.query }
    if (countField !== undefined && request.maxResults !== undefined) {
      body[countField] = request.maxResults
    }
    if (extra !== undefined) Object.assign(body, extra)

    let response: Response
    try {
      response = await fetch(endpoint, {
        method,
        redirect: 'error',
        headers: this.buildHeaders(key),
        ...method === 'POST' ? { body: JSON.stringify(body) } : {},
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      throw this.wrapFetchError(endpoint, `请求失败：${shortErrorMessage(error)}`, error)
    }

    if (!response.ok) {
      const detail = await describeError(response)
      // 限额/限流是「换引擎」与「进冷却」的分界：Tavily 用 432/433（额度用尽）
      // 与 429（限流，带 Retry-After）；LangSearch 把所有限额都收敛成 429。
      if (RATE_LIMIT_STATUS.has(response.status)) {
        throw rateLimitedError(
          `${this.name} 触发限额（HTTP ${response.status}）：${detail}`,
          parseRetryAfterHeader(response.headers.get('retry-after')),
        )
      }
      throw new WebError(`${this.name} API 错误（${detail}）`, 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new WebError(`${this.name} 请求已中止`, 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`${this.name} 返回了无法解析的响应体`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    // 带顶层 code 的业务信封（如 LangSearch）在 code !== 200 时视为失败；
    // 其中 429/432/433 仍按限额处理，否则链会在下一次提问时原样重试。
    const code = getPath(payload, 'code')
    if (typeof code === 'number' && code !== 200) {
      const message = getPath(payload, 'msg') ?? getPath(payload, 'message')
      const suffix = typeof message === 'string' && message.length > 0 ? `：${message}` : ''
      if (RATE_LIMIT_STATUS.has(code)) {
        throw rateLimitedError(
          `${this.name} 触发限额（业务 code=${code}）${suffix}`,
          parseRetryAfterHeader(response.headers.get('retry-after')),
        )
      }
      throw new WebError(`${this.name} 返回业务错误 code=${code}${suffix}`, 'WEB_PROVIDER_ERROR')
    }

    const sources = mapJsonApiPayload(payload, this.options.meta.response)
    return { sources, truncated: false }
  }

  /** 组装鉴权请求头；`auth: 'query'` 与 `'none'` 不加头，密钥已由调用方解析。 */
  private buildHeaders(key: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'user-agent': PLUGIN_USER_AGENT,
    }
    if (this.options.meta.method === 'POST') headers['content-type'] = 'application/json'
    const auth = this.options.meta.auth
    if (auth !== 'none' && auth !== 'query' && (key?.length ?? 0) > 0) {
      if (auth === 'x-api-key') {
        headers['x-api-key'] = key as string
      } else if (auth === 'header') {
        headers[this.options.meta.authHeader as string] = key as string
      } else {
        headers['authorization'] = `Bearer ${key as string}`
      }
    }
    return headers
  }

  private wrapFetchError(endpoint: string, message: string, cause: unknown): WebError {
    if (isAbortError(cause)) {
      return new WebError(`${this.name} 请求已中止`, 'WEB_ABORTED', { cause })
    }
    return new WebError(`${this.name}（${endpoint}）${message}`, 'WEB_PROVIDER_ERROR', { cause })
  }
}