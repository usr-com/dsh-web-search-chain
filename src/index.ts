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
import { buildEngineChain, ENGINE_METAS, defaultDailyLimits } from './engines.js'
import type { EngineMeta } from './engines.js'
import { QuotaGuard } from './quota.js'
import { ChainSearchProvider, CHAIN_PROVIDER_ID } from './provider.js'

export { Config }
export type {
  ChainStrategy,
  CustomEngineAuth,
  CustomEngineConfig,
  CustomEngineFields,
  EngineConfig,
  QuotaConfig,
} from './config.js'
export {
  CUSTOM_ENGINE_DEFAULT_PRIORITY,
  ENGINE_METAS,
  buildEngineChain,
  buildEngines,
  credentialResolverFor,
  credentialSourcePresentFor,
  customEngineMetas,
  defaultDailyLimits,
  keyEnvName,
  resolveApiKey,
  sortEngines,
} from './engines.js'
export type {
  BuildChainInput,
  BuildChainResult,
  CustomEngineCompileResult,
  EngineChainProblem,
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
 * 一条被护栏挡下的搜索。`dailyLimits` 覆盖元数据表里的推导值，
 * `0` 表示该引擎不限制。
 *
 * @param ctx - 插件上下文。
 * @param config - 护栏配置（缺省启用默认值）。
 * @param metas - 实际参与装配的元数据行；必须包含自定义引擎，
 *   否则用户新加的引擎会掉进 `DEFAULT_DAILY_LIMIT` 之外的「无上限」分支。
 */
export function buildQuotaGuard(
  ctx: Context,
  config: QuotaConfig | undefined,
  metas: readonly EngineMeta[] = ENGINE_METAS,
): QuotaGuard {
  const enabled = config?.enabled ?? true
  const limits: Record<string, number> = { ...defaultDailyLimits(metas), ...config?.dailyLimits }
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
 *
 * 自定义引擎（`customEngines`）与内置引擎走完全相同的装配路径；定义不合法的
 * 条目被跳过并逐条告警，不影响其余引擎 —— 一个写错的自定义条目不应该让整条链
 * 连 Bing 兜底都起不来。
 */
export function apply(ctx: Context, config: Config): void {
  const chain = buildEngineChain(ctx, {
    overrides: config.engines ?? {},
    apiKeys: config.apiKeys ?? {},
    custom: config.customEngines ?? {},
  })
  const engines = chain.engines
  const quota = buildQuotaGuard(ctx, config.quota, chain.metas)
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
  // 被跳过的自定义引擎必须让用户看见 —— 否则表现是「配了却没生效」，
  // 而配置本身看起来完全正常。
  for (const problem of chain.problems) {
    logger.warn(`自定义引擎 ${problem.id} 已被跳过：${problem.message}`)
  }
  if (chain.problems.length > 0) {
    logger.warn(`共跳过 ${chain.problems.length} 个自定义引擎定义，其余引擎照常工作。`)
  }
  const snapshot = quota.snapshot()
  logger.info(
    `请求预算护栏 ${config.quota?.enabled ?? true ? '已启用' : '已关闭'}；`
    + `今日（${snapshot.day}）用量 ${JSON.stringify(snapshot.engines)}`,
  )
}
