/**
 * 插件配置：链接策略、超时、默认结果上限，以及按引擎 id 的部分覆盖。
 * 新增引擎时无需修改这里的 schema —— 只有 `engines.<id>.*` 覆盖字段才是用户可写的面。
 * @module dsh-web-search-chain/config
 */

import Schema from '@deepseek-ai/schemastery'

/** 链接策略：顺次回退，或并发聚合。 */
export type ChainStrategy = 'failover' | 'aggregate'

/** 对单个引擎的部分覆盖（未提供的字段回落到静态元数据表）。 */
export interface EngineConfig {
  /** 显式启用 / 禁用（默认：表内引擎全部启用，缺密钥的引擎自动不可用）。 */
  enabled?: boolean
  /** 链内优先级（越小越先；failover 模式下决定尝试顺序）。 */
  priority?: number
  /** 直接给出 API 密钥；优先于 {@link apiKeyEnv} 与元数据默认环境变量。 */
  apiKey?: string
  /** 覆盖密钥来源的环境变量名（例如 DEEPSEEK_SEARCH_API_KEY）。 */
  apiKeyEnv?: string
  /** 覆盖端点（如自建代理的完整 URL）。 */
  baseURL?: string
}

/** 插件生效配置。 */
export interface Config {
  /** 链接策略，默认 'failover'。 */
  strategy?: ChainStrategy
  /** 单个引擎的失效上限（毫秒），默认 15000。 */
  timeoutMs?: number
  /** 请求未携带 maxResults 时的默认结果上限，默认 8。 */
  maxResults?: number
  /**
   * 顶层集中密钥区：键为引擎 id（tavily / langsearch / deepseek-official），
   * 值为该引擎的 API 密钥。这是「配置密钥即用」的推荐入口 —— Web UI 会以
   * 密码框渲染（role: secret）。优先级低于 `engines.<id>.apiKey`，
   * 高于环境变量。缺省为 undefined（全部回落到环境变量）。
   */
  apiKeys?: Record<string, string>
  /** 按引擎 id 覆盖（id 见 {@link ../engines!ENGINE_METAS}）。 */
  engines?: Record<string, EngineConfig>
  /** 请求预算护栏：见 {@link QuotaConfig}。缺省启用内置默认值。 */
  quota?: QuotaConfig
}

/**
 * 请求预算护栏配置。
 *
 * 免费额度在链上是静默消耗的 —— 没有护栏时，每次联网提问都会真实扣减额度，
 * 超限后由提供方拒绝或（更糟）按量计费。这里用「每引擎每日请求上限」作为
 * 与计费无关的兜底代理量，并在提供方返回 429/432/433 时把引擎置入冷却期。
 */
export interface QuotaConfig {
  /** 总开关；默认 true。关闭后完全不限制、不统计。 */
  enabled?: boolean
  /**
   * 按引擎 id 覆盖每日请求上限；`0` 表示该引擎不限制。
   * 未列出的引擎套用静态表里的推导值（见 `ENGINE_METAS[].freeTier`）。
   */
  dailyLimits?: Record<string, number>
  /**
   * 提供方未给出 `Retry-After` 时，限额错误的默认冷却时长（毫秒），默认 600000（10 分钟）。
   * 上限会被收敛到当日剩余时间，不会永久关闭引擎。
   */
  cooldownMs?: number
  /** 是否把当日用量落盘，使重启不清零。默认 true。 */
  persist?: boolean
  /** 状态文件路径；缺省为 `$DSH_HOME/web-search-chain-quota.json`。 */
  statePath?: string
}

export const Config: Schema<Config> = Schema.object({
  strategy: Schema.union(['failover', 'aggregate']).default('failover'),
  timeoutMs: Schema.number().min(100).max(120000).default(15000),
  maxResults: Schema.number().min(1).max(100).default(8),
  apiKeys: Schema.dict(Schema.string().role('secret'))
    .description(
      '集中存放各引擎的 API 密钥，键为引擎 id：tavily / langsearch / deepseek-official。'
      + '显式填写优先于此处的值，此处又优先于对应环境变量；留空则自动回落。',
    ),
  quota: Schema.object({
    enabled: Schema.boolean().default(true),
    dailyLimits: Schema.dict(Schema.number().min(0).step(1)),
    cooldownMs: Schema.number().min(0).max(86400000).default(600000),
    persist: Schema.boolean().default(true),
    statePath: Schema.string(),
  }).description(
    '请求预算护栏：按引擎限制每日请求次数，并在提供方返回限额错误时进入冷却期，'
    + '避免免费额度被静默耗尽后产生费用。关闭会失去这层保护。',
  ),
  engines: Schema.dict(Schema.object({
    enabled: Schema.boolean(),
    priority: Schema.number().min(-100).max(1000).step(1),
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string(),
    baseURL: Schema.string(),
  })),
})