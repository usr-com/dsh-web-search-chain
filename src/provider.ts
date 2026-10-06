/**
 * 提供者链：把多个引擎统一成一个 WebSearchProvider。
 *
 * - failover（顺次回退）：按优先级逐个尝试引擎，第一个成功即返回；
 *   失败原因被逐一记录，全部失败时聚合为一份可读错误摘要。
 * - aggregate（并发聚合）：所有可用引擎并行搜索，按 URL 去重合并，并按
 *   maxResults 截断。
 *
 * 该提供方在 `ctx.web` 上以单一 id（web-search-chain）注册 —— 对应
 * dsh-web 的「配置一个提供方」约定，后面接哪条引擎由插件的引擎表决定。
 * @module dsh-web-search-chain/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ChainStrategy } from './config.js'
import type { Engine } from './engine.js'
import type { QuotaGuard } from './quota.js'
import { humanizeDuration, isAbortError, isRateLimited, rateLimitedError, shortErrorMessage } from './util.js'

/** 本提供方在 `ctx.web` 注册表里的 id。 */
export const CHAIN_PROVIDER_ID = 'web-search-chain'

/** 构造提供者链所需选项。 */
export interface ChainSearchProviderOptions {
  /** 已优先级升序排序的引擎实例。 */
  readonly engines: readonly Engine[]
  readonly strategy: ChainStrategy
  /** 单个引擎的失效上限（毫秒）。 */
  readonly timeoutMs: number
  /** 请求未携带 maxResults 时套用的默认结果上限。 */
  readonly defaultMaxResults?: number
  /**
   * 请求预算护栏。给出后，超额或处于冷却期的引擎会被跳过，
   * 且每次真正发出的请求都会被计入当日用量。
   */
  readonly quota?: QuotaGuard
}

/** 提供者链：`ctx.web.registerSearchProvider` 的目标。 */
export class ChainSearchProvider implements WebSearchProvider {
  readonly id = CHAIN_PROVIDER_ID
  private readonly engines: readonly Engine[]

  constructor(private readonly options: ChainSearchProviderOptions) {
    this.engines = [...options.engines]
  }

  /** 任一引擎可用即视为整体可用（免网络调用的本地检查，不计预算）。 */
  available(): boolean {
    return this.engines.some((engine) => engine.available())
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const usable = this.engines.filter((engine) => engine.available())
    if (usable.length === 0) {
      throw new WebError(
        'web-search-chain：没有任何引擎可用。请配置至少一个 API 密钥（TAVILY_API_KEY / '
        + 'LANGSEARCH_API_KEY / DEEPSEEK_API_KEY），或保持免密钥的 Bing 引擎启用',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    const effectiveMax = request.maxResults ?? this.options.defaultMaxResults
    const innerRequest: WebSearchRequest = effectiveMax === undefined
      ? request
      : { ...request, maxResults: effectiveMax }

    // 预算过滤：额度已用尽或处于限额冷却期的引擎本次不参与。
    // 该判定发生在 available() 之后，因此「配好了但今天不能再打」会得到
    // 一条明确的护栏提示，而不是被误报成「全部引擎失败」。
    const allowed = usable.filter((engine) => this.checkBudget(engine))
    if (allowed.length === 0) throw this.budgetExhaustedError(usable)

    if (this.options.strategy === 'aggregate') {
      return this.aggregate(allowed, innerRequest, signal)
    }
    return this.failover(allowed, innerRequest, signal)
  }

  /** 该引擎此刻是否还在当日预算内（未配置护栏时恒为 true）。 */
  private checkBudget(engine: Engine): boolean {
    return this.options.quota?.check(engine.id).allowed ?? true
  }

  /** 所有可用引擎都被预算挡住时，给出可操作的说明。 */
  private budgetExhaustedError(engines: readonly Engine[]): WebError {
    const quota = this.options.quota as QuotaGuard
    const lines = engines.map((engine) => {
      const verdict = quota.check(engine.id)
      if (verdict.reason === 'exhausted') {
        return `${engine.name}：今日已用 ${verdict.used}/${verdict.limit} 次，${quotaNextReset(verdict.retryAfterMs)}`
      }
      if (verdict.reason === 'cooldown') {
        return `${engine.name}：被提供方限流，冷却中（约 ${humanizeDuration(verdict.retryAfterMs ?? 0)} 后恢复）`
      }
      return `${engine.name}：不可用`
    })
    return rateLimitedError(
      'web-search-chain：所有可用引擎都已触及请求预算，本次未发出任何请求'
      + `（这正是避免超出免费额度产生费用的保护）。现状：${lines.join('；')}。`
      + '可在插件配置 `quota.dailyLimits` 里调高或设为 0 取消限制。',
    )
  }

  /**
   * 顺次回退：依序尝试每个引擎；超时或任一错误都记录原因并继续下一个。
   * 外部取消（signal）则以 WEB_ABORTED 终止整条链，不吞掉。
   */
  private async failover(
    engines: readonly Engine[],
    request: WebSearchRequest,
    outerSignal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const failures: string[] = []
    for (const engine of engines) {
      if (outerSignal != null && outerSignal.aborted) throw aborted()
      try {
        return capResult(await this.runEngine(engine, request, outerSignal), request.maxResults)
      } catch (error: unknown) {
        if (outerSignal != null && outerSignal.aborted) throw aborted(error)
        failures.push(`${engine.name}：${shortErrorMessage(error)}`)
      }
    }
    throw new WebError(
      `web-search-chain：全部引擎失败（已依次尝试 ${engines.map((it) => it.name).join(' → ')}）：${failures.join('；')}`,
      'WEB_PROVIDER_ERROR',
    )
  }

  /**
   * 并发聚合：全部引擎并行搜索，成功者的结果按 URL 合并去重；
   * 全部失败时提供与 failover 一致的错误汇总。
   */
  private async aggregate(
    engines: readonly Engine[],
    request: WebSearchRequest,
    outerSignal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const outcomes = await Promise.all(
      engines.map(async (engine): Promise<{ engine: Engine; result: WebSearchResult } | { engine: Engine; error: unknown }> => {
        try {
          return { engine, result: await this.runEngine(engine, request, outerSignal) }
        } catch (error: unknown) {
          return { engine, error }
        }
      }),
    )
    const fulfilled: WebSearchResult[] = []
    const failures: string[] = []
    for (const outcome of outcomes) {
      if ('error' in outcome) {
        if (outerSignal != null && outerSignal.aborted) throw aborted(outcome.error)
        failures.push(`${outcome.engine.name}：${shortErrorMessage(outcome.error)}`)
      } else {
        fulfilled.push(outcome.result)
      }
    }
    if (fulfilled.length === 0) {
      throw new WebError(
        `web-search-chain：全部引擎失败（已并发尝试 ${engines.map((it) => it.name).join('、')}）：${failures.join('；')}`,
        'WEB_PROVIDER_ERROR',
      )
    }

    const seen = new Map<string, WebSearchSource>()
    let content: string | undefined
    let anyTruncated = false
    for (const result of fulfilled) {
      for (const source of result.sources) {
        if (source.url.length === 0 || seen.has(source.url)) continue
        seen.set(source.url, source)
      }
      if (content === undefined && result.content !== undefined && result.content.length > 0) {
        content = result.content
      }
      anyTruncated = anyTruncated || result.truncated
    }
    return capResult({
      ...content !== undefined ? { content } : {},
      sources: [...seen.values()],
      truncated: anyTruncated,
    }, request.maxResults)
  }

  /**
   * 执行单个引擎并施加超时：内部新建 AbortController，外部取消与时延
   * 都会触发中止；超时被当作该引擎的失败由调用方收集，而不是中断整条链。
   */
  private async runEngine(
    engine: Engine,
    request: WebSearchRequest,
    outerSignal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort()
    if (outerSignal !== undefined && !outerSignal.aborted) outerSignal.addEventListener('abort', onOuterAbort)
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)
    // 在真正发出请求前计入当日用量：额度是被「发出去的请求」消耗的，
    // 与它成功或失败无关。
    this.options.quota?.noteAttempt(engine.id)
    try {
      return await engine.search(request, controller.signal)
    } catch (error: unknown) {
      // 提供方明确说「额度/频率超限」时，把该引擎置入冷却期，
      // 避免后续每次提问都原样再撞一次墙（既无意义又可能计费）。
      if (isRateLimited(error)) this.options.quota?.noteRateLimited(engine.id, error.retryAfterMs)
      throw error
    } finally {
      clearTimeout(timer)
      if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** 预算用尽时的恢复时间描述。 */
function quotaNextReset(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return '额度尚未重置'
  return `约 ${humanizeDuration(retryAfterMs)} 后重置`
}

/** 外部信号触发时构造 ABORTED 错误。 */
function aborted(cause?: unknown): WebError {
  return new WebError('web-search-chain 搜索已中止', 'WEB_ABORTED', cause !== undefined ? { cause } : {})
}

/** 结果超过 maxResults 时截断并标记 truncated（与 dsh-web 上游 seam 的语义一致）。 */
function capResult(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return {
    ...result,
    sources: result.sources.slice(0, maxResults),
    truncated: true,
  }
}