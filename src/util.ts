/**
 * 插件内部共享的零依赖辅助函数。
 * @module dsh-web-search-chain/util
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** 本插件对外申报的 user-agent（随包版本递增）。 */
export const PLUGIN_USER_AGENT = 'dsh-web-search-chain/0.1.0'

/**
 * 提供方限额错误（HTTP 429/432/433）的稳定 code。
 *
 * 上游 `dsh-web` 的 `WebError.code` 是开放字符串，消费者必须容忍
 * 提供方自定义 code —— 这里新增一个，用于把「额度/频率被拒」与
 * 「网络或协议失败」区分开：前者要进冷却期，后者只需换下个引擎。
 */
export const WEB_RATE_LIMITED = 'WEB_PROVIDER_RATE_LIMITED'

/**
 * 提供方用来表达「额度/频率超限」的 HTTP 状态码。
 *
 * - `429` 通用限流（Tavily、LangSearch、DeepSeek）；
 * - `432` Tavily 套餐额度用尽；
 * - `433` Tavily 按量付费上限用尽。
 */
export const RATE_LIMIT_STATUS: ReadonlySet<number> = new Set([429, 432, 433])

/** 携带重试提示的限额错误。 */
export interface RateLimitedError extends WebError {
  /** 提供方要求的等待毫秒数（来自 `Retry-After`）。 */
  readonly retryAfterMs?: number
}

/**
 * 构造限额错误。
 * @param message - 面向人的一句话（已包含提供方返回的细节）。
 * @param retryAfterMs - `Retry-After` 解析结果；缺省表示提供方未给出。
 * @param cause - 原始异常（可选）。
 */
export function rateLimitedError(message: string, retryAfterMs?: number, cause?: unknown): RateLimitedError {
  const error = new WebError(message, WEB_RATE_LIMITED, cause !== undefined ? { cause } : {}) as RateLimitedError
  if (retryAfterMs !== undefined) {
    Object.defineProperty(error, 'retryAfterMs', { value: retryAfterMs, enumerable: true })
  }
  return error
}

/** 判断异常是否为限额错误。 */
export function isRateLimited(error: unknown): error is RateLimitedError {
  return error instanceof WebError && error.code === WEB_RATE_LIMITED
}

/** 解析 `Retry-After`（秒数或 HTTP 日期）为毫秒；无法解析时返回 undefined。 */
export function parseRetryAfterHeader(value: string | null, at: number = Date.now()): number | undefined {
  if (value === null || value.trim().length === 0) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const when = Date.parse(value)
  if (Number.isNaN(when)) return undefined
  return Math.max(0, when - at)
}

/** 把毫秒时长渲染成中文可读文案（用于「额度已用尽」提示）。 */
export function humanizeDuration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`
  return `${Math.round(minutes / 60)} 小时`
}

/** Bing 抓取使用的桌面端 UA，避免被当作脚本化爬虫直接拒绝。 */
export const BING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 判断 fetch / AbortSignal 的取消错误。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 把任意异常收敛为适合并入链错误摘要的一句话（剥离堆栈与密钥痕迹）。 */
export function shortErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * 按点分路径从对象读取字段。
 * @example getPath(resp, 'data.webPages.value') //-> unknown
 */
export function getPath(source: unknown, path: string): unknown {
  let value: unknown = source
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** 去掉 HTML 标签并把空白折叠为单个空格。 */
export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 解码搜索结果标题/摘要中常见的 HTML 实体。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}