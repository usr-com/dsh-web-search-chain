/**
 * 插件配置：链接策略、超时、默认结果上限、按引擎 id 的部分覆盖，
 * 以及**用户自带的搜索引擎定义**（`customEngines` —— 只要对方提供 API key
 * 和一套标准查询接口，就能加进链里，无需改代码）。
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

/** 鉴权写法。 */
export type CustomEngineAuth = 'bearer' | 'x-api-key' | 'header' | 'query' | 'none'

/** 自定义引擎的结果字段映射；值都是响应 JSON 里的点分路径。 */
export interface CustomEngineFields {
  /** 标题字段路径。 */
  title?: string
  /** URL 字段路径（**必填**：seam 的 source 必须有 URL）。 */
  url?: string
  /** 摘要字段路径。 */
  snippet?: string
  /** 摘要为空时的回退字段路径。 */
  snippetFallback?: string
  /** 发布时间字段路径。 */
  publishedAt?: string
}

/**
 * 用户自定义引擎。
 *
 * 两种协议种类，都只需声明、不需要写代码：
 * - `json-api`：标准 JSON 搜索接口（POST 请求体，或 GET 查询串）；
 * - `scrape`：免密钥 HTML 抓取，端点模板支持 `{query}` 与 `{count}`。
 *
 * 继承 {@link EngineConfig}，因此 `engines.<自定义 id>` 也能覆盖它的
 * `enabled` / `priority` / `apiKey` / `apiKeyEnv` / `baseURL`。
 */
export interface CustomEngineConfig extends EngineConfig {
  /** 协议种类，默认 `'json-api'`。 */
  kind?: 'json-api' | 'scrape'
  /** 人类可读名；缺省用 id。 */
  name?: string
  /** 供应商描述；缺省用端点主机名。 */
  vendor?: string
  /**
   * `json-api`：完整端点 URL。
   * `scrape`：端点模板，须含 `{query}`。
   */
  endpoint: string
  /** HTTP 方法，默认 `'POST'`；`scrape` 恒为 GET。 */
  method?: 'GET' | 'POST'
  /** 鉴权写法；缺省时按「有没有 key」推断（有 key → bearer，无 key → none）。 */
  auth?: CustomEngineAuth
  /** `auth: 'header'` 时的请求头名。 */
  authHeader?: string
  /** `auth: 'query'` 时的查询参数名（密钥拼进 URL）。 */
  authParam?: string
  /** 是否需要密钥；缺省由 `auth` 推断。 */
  requiresKey?: boolean
  /** 查询词字段名，默认 `'query'`。 */
  queryField?: string
  /** 透传 `maxResults` 的字段名（Tavily 用 `max_results`，LangSearch 用 `count`）。 */
  countField?: string
  /** 固定附加的查询参数（`json-api` 的 GET 与 `scrape` 都会带上）。 */
  extraQuery?: Record<string, string>
  /** 固定附加的请求体字段（仅 `json-api` 的 POST）。 */
  extraBody?: Record<string, unknown>
  /** 结果数组的 JSON 路径，默认 `'results'`。 */
  resultsPath?: string
  /** 字段映射。 */
  fields?: CustomEngineFields
  /** 该引擎的每日请求上限；缺省用 `DEFAULT_DAILY_LIMIT`。`0` = 不限制。 */
  dailyRequests?: number
  /** 免费额度依据说明（出现在护栏的日志与错误里）。 */
  note?: string
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
   * 顶层集中密钥区：键为引擎 id（tavily / langsearch / deepseek-official / 自定义 id），
   * 值为该引擎的 API 密钥。这是「配置密钥即用」的推荐入口 —— Web UI 会以
   * 密码框渲染（role: secret）。优先级低于 `engines.<id>.apiKey`，
   * 高于环境变量。缺省为 undefined（全部回落到环境变量与凭据库）。
   */
  apiKeys?: Record<string, string>
  /** 按引擎 id 覆盖（内置 id 见 {@link ../engines!ENGINE_METAS}，自定义 id 见 `customEngines`）。 */
  engines?: Record<string, EngineConfig>
  /**
   * 自定义引擎：键为引擎 id，值为完整定义。内置 id 不可占用（要改内置引擎请用 `engines`）。
   * 定义不合法的条目会被**跳过并告警**，不影响其余引擎 —— 一个写错的条目不应该让
   * 整条链连 Bing 兜底都没有。
   */
  customEngines?: Record<string, CustomEngineConfig>
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
  customEngines: Schema.dict(Schema.object({
    kind: Schema.union(['json-api', 'scrape']).default('json-api'),
    name: Schema.string(),
    vendor: Schema.string(),
    enabled: Schema.boolean(),
    priority: Schema.number().min(-1000).max(1000).step(1),
    endpoint: Schema.string(),
    method: Schema.union(['GET', 'POST']).default('POST'),
    auth: Schema.union(['bearer', 'x-api-key', 'header', 'query', 'none']),
    authHeader: Schema.string(),
    authParam: Schema.string(),
    requiresKey: Schema.boolean(),
    queryField: Schema.string(),
    countField: Schema.string(),
    extraQuery: Schema.dict(Schema.string()),
    extraBody: Schema.dict(Schema.any()),
    resultsPath: Schema.string(),
    fields: Schema.object({
      title: Schema.string(),
      url: Schema.string(),
      snippet: Schema.string(),
      snippetFallback: Schema.string(),
      publishedAt: Schema.string(),
    }),
    dailyRequests: Schema.number().min(0).step(1),
    note: Schema.string(),
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string(),
    baseURL: Schema.string(),
  })).description(
    '自定义搜索引擎：键为引擎 id，值为完整定义。只要对方提供 API key 和标准查询接口，'
    + '就能加进链里参与降级，无需改插件代码。内置 id 不可占用；定义不合法的条目会被跳过并告警。',
  ),
})