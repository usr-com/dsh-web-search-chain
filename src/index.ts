/**
 * dsh-web-search-chain 插件入口。
 *
 * 在 `ctx.web` 上注册一条聚合的 WebSearchProvider（id: web-search-chain），
 * 其内部把带 API 与免密钥的后端统一成一条可扩展引擎链。启用方式见 README：
 * 在 profile 里把 `@deepseek-ai/dsh-web` 行的 `searchProvider` 配为该 id
 * （dsh-base 默认已把它钉在 `deepseek-official`），或设
 * `DSH_WEB_SEARCH_PROVIDER=web-search-chain`。
 * @module dsh-web-search-chain
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Config } from './config.js'
import type { QuotaConfig } from './config.js'
import { buildEngines, defaultDailyLimits } from './engines.js'
import { QuotaGuard } from './quota.js'
import { ChainSearchProvider, CHAIN_PROVIDER_ID } from './provider.js'

export { Config }
export type {
  ChainStrategy,
  EngineConfig,
  QuotaConfig,
} from './config.js'
export { ENGINE_METAS, buildEngines, credentialResolverFor, credentialSourcePresentFor, defaultDailyLimits, keyEnvName, resolveApiKey } from './engines.js'
export type {
  EngineFreeTier,
  EngineMeta,
  JsonApiEngineMeta,
  JsonApiRequestSpec,
  JsonApiResponseSpec,
  LlmEngineMeta,
  ScrapeEngineMeta,
} from './engines.js'
export { ChainSearchProvider, CHAIN_PROVIDER_ID } from './provider.js'
export type { ChainSearchProviderOptions } from './provider.js'
export { DEFAULT_DAILY_LIMIT, QuotaGuard, utcDay } from './quota.js'
export type { QuotaGuardOptions, QuotaState, QuotaUsage, QuotaVerdict } from './quota.js'
export {
  humanizeDuration,
  isRateLimited,
  parseRetryAfterHeader,
  RATE_LIMIT_STATUS,
  rateLimitedError,
  WEB_RATE_LIMITED,
} from './util.js'
export type { RateLimitedError } from './util.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'web-search-chain'

/** 注入 web 能力 seam：等待 `ctx.web` 就绪后再注册。 */
export const inject = ['web']

/**
 * 解析护栏状态文件的默认位置：`$DSH_HOME/web-search-chain-quota.json`。
 *
 * 用量必须跨重启保留，否则重启一次护栏就归零，等于没有。
 */
export function defaultQuotaStatePath(ctx: Context): string {
  const fromEnv = launchEnvironmentOf(ctx).get('DSH_HOME')?.value
  const home = fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : (process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  return join(home, 'web-search-chain-quota.json')
}

/**
 * 装配请求预算护栏。
 *
 * 默认启用：免费额度是静默消耗的，而「超出后被计费」的代价远大于
 * 一条被护栏挡下的搜索。`dailyLimits` 覆盖静态表里的推导值，
 * `0` 表示该引擎不限制。
 */
export function buildQuotaGuard(ctx: Context, config: QuotaConfig | undefined): QuotaGuard {
  const enabled = config?.enabled ?? true
  const limits: Record<string, number> = { ...defaultDailyLimits(), ...config?.dailyLimits }
  const persist = config?.persist ?? true
  const statePath = persist
    ? (config?.statePath ?? defaultQuotaStatePath(ctx))
    : undefined
  return new QuotaGuard({
    enabled,
    dailyLimits: limits,
    cooldownMs: config?.cooldownMs ?? 600000,
    ...statePath !== undefined ? { statePath } : {},
  })
}

/**
 * 装配引擎链并注册提供方。所有引擎默认进入链（缺密钥的自动不可用），
 * 需要免密钥兜底（Bing）时无需任何配置即可工作。密钥按
 * engines.<id>.apiKey → apiKeys.<id> → 环境变量 → harness 凭据库 的优先级解析。
 */
export function apply(ctx: Context, config: Config): void {
  const engines = buildEngines(ctx, config.engines ?? {}, config.apiKeys)
  const quota = buildQuotaGuard(ctx, config.quota)
  ctx.web.registerSearchProvider(new ChainSearchProvider({
    engines,
    strategy: config.strategy ?? 'failover',
    timeoutMs: config.timeoutMs ?? 15000,
    defaultMaxResults: config.maxResults,
    quota,
  }))
  // cordis 的 `ctx.logger` 是 LoggerService：`ctx.logger(name)` 返回具名 Logger，
  // `ctx.logger.info(...)` 才写日志。写成 `ctx.logger?.(msg)` 只会建一个名为
  // msg 的 logger 并静默丢弃这条诊断。
  const logger = ctx.logger('web-search-chain')
  logger.info(
    `已注册 ${engines.length} 个引擎（id=${CHAIN_PROVIDER_ID}）：`
    + engines.map((engine) => engine.id).join(' → '),
  )
  const snapshot = quota.snapshot()
  logger.info(
    `请求预算护栏 ${config.quota?.enabled ?? true ? '已启用' : '已关闭'}；`
    + `今日（${snapshot.day}）用量 ${JSON.stringify(snapshot.engines)}`,
  )
}
