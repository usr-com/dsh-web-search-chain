/**
 * 静态引擎元数据表：这是「新增引擎只改一行」的落点。
 *
 * 表的一行完整描述一个引擎应如何被实例化 —— 协议种类（kind）、端点、鉴权、
 * 默认环境变量、请求/响应映射。`buildEngines` 借助表中信息驱动对应的适配器工厂，
 * 因此新增一个引擎通常只需要在 `ENGINE_METAS` 里追加一行，无需修改任何分支逻辑。
 *
 * - `json-api`：标准的 JSON HTTP 搜索 API（目前：Tavily、LangSearch）
 * - `scrape`：免密钥的 HTML 抓取（目前：Bing）
 * - `llm`：通过 Anthropic 兼容 Messages API 使用服务器端 web_search 工具（目前：DeepSeek 官方）
 *
 * @module dsh-web-search-chain/engines
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { CustomEngineAuth, CustomEngineConfig, EngineConfig } from './config.js'
import type { Engine } from './engine.js'
import { BingEngine } from './bing.js'
import { DeepSeekEngine } from './llm.js'
import { JsonApiEngine } from './json-api.js'
import { DEFAULT_DAILY_LIMIT } from './quota.js'

/**
 * 自定义引擎的默认优先级。
 *
 * 内置是 tavily 10 / langsearch 20 / bing 30 / deepseek-official 40。
 * 25 让用户新加的 API 引擎排在 Bing 之前 —— 对方给了 key 的正式接口，
 * 可信度高于免密钥抓取，但不该抢在已配好的 Tavily / LangSearch 前面。
 */
export const CUSTOM_ENGINE_DEFAULT_PRIORITY = 25

/** JSON API 引擎：请求构造的声明片段。 */
export interface JsonApiRequestSpec {
  /** 查询词字段名，默认 `'query'`。 */
  queryField?: string
  /** 透传 `maxResults` 的字段名（Tavily 用 `max_results`，LangSearch 用 `count`）。 */
  countField?: string
  /** 每次请求都会携带的固定附加字段（POST 请求体）。 */
  extra?: Record<string, unknown>
  /** 每次请求都会携带的固定查询参数（GET 查询串；POST 也会拼在 URL 上）。 */
  extraQuery?: Record<string, string>
}

/** JSON API 引擎：响应映射的声明片段。 */
export interface JsonApiResponseSpec {
  /** 到达结果数组的 JSON 路径（如 `results`、`data.webPages.value`）。 */
  resultsPath: string
  /** 字段映射；值都是 JSON 路径。 */
  fields: {
    /** 结果标题。 */
    title: string
    /** 结果 URL。 */
    url: string
    /** 首选摘要字段。 */
    snippet?: string
    /** 首选摘要为空时的回退字段。 */
    snippetFallback?: string
    /** 发布时间/更新时间的字段。 */
    publishedAt?: string
  }
}

/** 引擎的免费额度画像：用于推导「每日请求预算」的默认值。 */
export interface EngineFreeTier {
  /**
   * 建议的每日请求上限（0 = 不限制）。
   *
   * 免费额度多以「月」或「token」计量，而插件只能观察到「请求次数」，
   * 因此这里给出一个保守的每日代理值：即使某天全部用满，一个月也不会
   * 触到免费额度上限，从而避免被计费。
   */
  readonly dailyRequests: number
  /** 额度事实与推导依据（面向人的说明）。 */
  readonly note: string
}

/** 协议种类为 JSON API 的引擎元数据。 */
export interface JsonApiEngineMeta {
  readonly kind: 'json-api'
  readonly id: string
  readonly name: string
  readonly vendor: string
  /** 是否需要密钥；缺 key 时该引擎不可用但不出错。 */
  readonly requiresKey: boolean
  /** 密钥来源的默认环境变量名。 */
  readonly authEnv?: string
  /** 认证头写法；`none` 表示无需认证（`query` 表示密钥拼进 URL 查询串）。 */
  readonly auth: CustomEngineAuth
  /** `auth: 'header'` 时的请求头名。 */
  readonly authHeader?: string
  /** `auth: 'query'` 时的查询参数名。 */
  readonly authParam?: string
  /** 完整端点（含路径）。 */
  readonly endpoint: string
  readonly method: 'POST' | 'GET'
  readonly defaultPriority: number
  readonly freeTier: EngineFreeTier
  readonly request: JsonApiRequestSpec
  readonly response: JsonApiResponseSpec
}

/** 协议种类为免密钥抓取的引擎元数据。 */
export interface ScrapeEngineMeta {
  readonly kind: 'scrape'
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly requiresKey: false
  /** 端点模板；`{query}` 与 `{count}` 会被替换。 */
  readonly endpoint: string
  readonly defaultPriority: number
  readonly freeTier: EngineFreeTier
  /** 额外固定 query 参数（如语言/地区）。 */
  readonly extraQuery?: Record<string, string>
}

/** 协议种类为 LLM 搜索的引擎元数据。 */
export interface LlmEngineMeta {
  readonly kind: 'llm'
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly requiresKey: true
  /** 密钥来源的默认环境变量名。 */
  readonly authEnv: string
  /** Anthropic 兼容端点基础；`/messages` 会被追加。 */
  readonly endpoint: string
  /** 覆盖端点的环境变量名（与 dsh 内置 web-search-deepseek 保持一致）。 */
  readonly endpointEnv?: string
  /** Anthropic 格式模型名。 */
  readonly model: string
  /** `anthropic-version` 请求头。 */
  readonly apiVersion: string
  /** 生成 token 上限。 */
  readonly maxTokens: number
  /** 单次请求内 `web_search` 工具的最大使用次数。 */
  readonly maxUses: number
  readonly defaultPriority: number
  readonly freeTier: EngineFreeTier
}

/** 引擎元数据判别联合：表格行的种类约束。 */
export type EngineMeta = JsonApiEngineMeta | ScrapeEngineMeta | LlmEngineMeta

/**
 * 内置引擎静态表。新增引擎 = 在此追加一行：
 * 标准 JSON API（kind: 'json-api'）只需声明端点、鉴权、请求/响应映射；
 * 特殊协议（scrape / llm）在适配器文件里提供实现，表中声明其接入参数。
 */
export const ENGINE_METAS: readonly EngineMeta[] = [
  {
    kind: 'json-api',
    id: 'tavily',
    name: 'Tavily',
    vendor: 'Tavily (tavily.ai)',
    requiresKey: true,
    authEnv: 'TAVILY_API_KEY',
    auth: 'bearer',
    endpoint: 'https://api.tavily.com/search',
    method: 'POST',
    defaultPriority: 10,
    freeTier: {
      dailyRequests: 30,
      note: '免费 Researcher 计划 1000 credits/月（basic 搜索 1 credit/次），按 30 次/日 推导上限约 900/月，留出余量。',
    },
    request: {
      countField: 'max_results',
    },
    response: {
      resultsPath: 'results',
      fields: {
        title: 'title',
        url: 'url',
        snippet: 'content',
        publishedAt: 'published_date',
      },
    },
  },
  {
    kind: 'json-api',
    id: 'langsearch',
    name: 'LangSearch',
    vendor: 'LangSearch (langsearch.com)',
    requiresKey: true,
    authEnv: 'LANGSEARCH_API_KEY',
    auth: 'bearer',
    endpoint: 'https://api.langsearch.com/v1/web-search',
    method: 'POST',
    defaultPriority: 20,
    freeTier: {
      dailyRequests: 200,
      note: '免费计划按 token 计量（当前 $0/百万 token），只公布 RPS/TPM/TPD 而不公布具体数值；取 200 次/日 作为保守上限。',
    },
    request: {
      countField: 'count',
      extra: { freshness: 'noLimit', summary: false },
    },
    response: {
      resultsPath: 'data.webPages.value',
      fields: {
        title: 'name',
        url: 'url',
        snippet: 'snippet',
        snippetFallback: 'summary',
        publishedAt: 'datePublished',
      },
    },
  },
  {
    kind: 'scrape',
    id: 'bing',
    name: 'Bing（免密钥抓取）',
    vendor: 'Microsoft Bing',
    requiresKey: false,
    endpoint: 'https://www.bing.com/search?q={query}&count={count}&setlang=zh-Hans',
    defaultPriority: 30,
    freeTier: {
      dailyRequests: 200,
      note: '免密钥 HTML 抓取，无额度费用；上限只为对搜索引擎保持礼貌并避免被判定为爬虫。',
    },
  },
  {
    kind: 'llm',
    id: 'deepseek-official',
    name: 'DeepSeek 官方搜索',
    vendor: 'DeepSeek (api.deepseek.com)',
    requiresKey: true,
    authEnv: 'DEEPSEEK_API_KEY',
    endpoint: 'https://api.deepseek.com/anthropic/v1',
    endpointEnv: 'DEEPSEEK_SEARCH_BASE_URL',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    defaultPriority: 40,
    freeTier: {
      dailyRequests: 50,
      note: '内置兜底搜索，每次调用都是一次完整的模型请求（按 token 计费）；50 次/日 的默认上限用于防止兜底路径无限消费。',
    },
  },
]

/** 一次密钥解析的产物：空串与未定义都视为「没有」。 */
function resolvedKey(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * 按「单引擎字面值 > 顶层密钥区(app.apiKeys) > 显式环境变量 > 元数据默认环境变量」
 * 的顺序解析一个引擎的密钥。环境来自 harness 的启动环境层（launchEnvironmentOf），
 * 不被写进配置。导出为纯函数便于单测。
 */
export function resolveApiKey(
  ctx: Context,
  meta: EngineMeta,
  cfg: EngineConfig,
  apiKeys: Record<string, string> = {},
): string | undefined {
  // 免密钥引擎没有密钥概念，任何来源的 key 都不参与。
  if (!meta.requiresKey) return undefined
  const literal = resolvedKey(cfg.apiKey?.trim())
  if (literal !== undefined) return literal
  const pooled = resolvedKey(apiKeys[meta.id]?.trim())
  if (pooled !== undefined) return pooled
  const envName = cfg.apiKeyEnv?.trim() ?? ('authEnv' in meta ? meta.authEnv : undefined)
  if (envName !== undefined && envName.length > 0) {
    return resolvedKey(launchEnvironmentOf(ctx).get(envName)?.value)
  }
  return undefined
}

/** 构造一个引擎实例所需的、已经合并好默认值的解析结果。 */
interface ResolvedEngineInput {
  readonly meta: EngineMeta
  readonly apiKey?: string
  readonly baseURL?: string
  /** 仅 llm 引擎使用：延迟到每次搜索时从凭据服务解析密钥。 */
  readonly credentialResolver?: () => Promise<string | undefined>
  /** 仅 llm 引擎使用：同步判断凭据服务此刻是否已挂载。 */
  readonly credentialSourcePresent?: () => boolean
}

/** 依据元数据行 + 解析结果分发到对应适配器工厂。 */
function instantiateEngine(input: ResolvedEngineInput): Engine {
  const { meta, apiKey, baseURL, credentialResolver, credentialSourcePresent } = input
  switch (meta.kind) {
    case 'json-api':
      return new JsonApiEngine({ meta, apiKey, baseURL })
    case 'scrape':
      return new BingEngine({ meta, baseURL })
    case 'llm':
      return new DeepSeekEngine({ meta, apiKey, baseURL, credentialResolver, credentialSourcePresent })
  }
}

/** 解析引擎端点覆盖：显式配置 > 元数据声明的端点环境变量 > 表内默认端点。 */
function resolveBaseURL(ctx: Context, meta: EngineMeta, cfg: EngineConfig): string | undefined {
  const literal = resolvedKey(cfg.baseURL?.trim())
  if (literal !== undefined) return literal
  const envName = meta.kind === 'llm' ? meta.endpointEnv : undefined
  if (envName === undefined) return undefined
  return resolvedKey(launchEnvironmentOf(ctx).get(envName)?.value)
}

/**
 * 引擎密钥的环境变量名（供凭据服务按引用名查询）。
 *
 * 与 {@link resolveApiKey} 的优先级保持一致：显式 `apiKeyEnv` 覆盖元数据默认名。
 */
export function keyEnvName(meta: EngineMeta, cfg: EngineConfig): string | undefined {
  if (!meta.requiresKey) return undefined
  const explicit = cfg.apiKeyEnv?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return 'authEnv' in meta ? meta.authEnv : undefined
}

/**
 * 构造「从 harness 凭据服务解析密钥」的延迟解析器。
 *
 * 必需，因为桌面端把 key 存在 `$DSH_HOME/.credentials.yaml`（Web UI 的 Models
 * 页写入），而它**不**出现在启动环境里 —— 只用 launchEnvironmentOf 会让
 * DeepSeek 兜底引擎在已经配好内置搜索的机器上误判为不可用。
 *
 * 凭据服务可能晚于本插件挂载，所以每次调用都重新 `ctx.get`；
 * 服务不存在时返回 undefined，由适配器给出可读错误。
 *
 * @param ctx - 插件上下文。
 * @param envName - 凭据引用名（如 `DEEPSEEK_API_KEY`）。
 * @returns 解析器；envName 缺失时返回 undefined（该引擎只认字面量密钥）。
 */
export function credentialResolverFor(
  ctx: Context,
  envName: string | undefined,
): (() => Promise<string | undefined>) | undefined {
  if (envName === undefined || envName.length === 0) return undefined
  return async () => {
    const credentials = ctx.get('credentials') as
      | { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
      | undefined
    if (credentials?.resolve === undefined) return undefined
    try {
      const hit = await credentials.resolve(envName)
      const value = hit?.value
      return value !== undefined && value.length > 0 ? value : undefined
    } catch {
      // 凭据服务故障等价于「取不到 key」，由适配器决定如何失败。
      return undefined
    }
  }
}

/**
 * 同步判断 harness 凭据服务此刻是否已挂载。
 *
 * 供 `DeepSeekEngine.available()` 使用：凭据服务可能在本插件之后装载，
 * 所以每次判定都重新 `ctx.get`，而不是在装配时固化结论。
 */
export function credentialSourcePresentFor(ctx: Context): () => boolean {
  return () => {
    const credentials = ctx.get('credentials') as { resolve?: unknown } | undefined
    return typeof credentials?.resolve === 'function'
  }
}

/** 依据用户覆盖把引擎实例排成链顺序（优先级小者在前；无覆盖时用表默认）。 */
export function sortEngines(
  engines: readonly Engine[],
  overrides: Record<string, EngineConfig>,
  metas: readonly EngineMeta[] = ENGINE_METAS,
): Engine[] {
  const priorityOf = (engine: Engine): number => {
    const meta = metas.find((entry) => entry.id === engine.id)
    return overrides[engine.id]?.priority ?? meta?.defaultPriority ?? 0
  }
  return [...engines].sort((a, b) => priorityOf(a) - priorityOf(b))
}

/**
 * 从静态表 + 自定义定义推导「引擎 id → 每日请求上限」的默认预算。
 *
 * 只包含声明了 `dailyRequests > 0` 的引擎；`0` 表示不限制（故不进入预算表）。
 */
export function defaultDailyLimits(metas: readonly EngineMeta[] = ENGINE_METAS): Record<string, number> {
  const limits: Record<string, number> = {}
  for (const meta of metas) {
    if (meta.freeTier.dailyRequests > 0) limits[meta.id] = meta.freeTier.dailyRequests
  }
  return limits
}

// ─── 自定义引擎：把用户配置编译成引擎元数据行 ───────────────────────────────

/** 一条被跳过的自定义引擎定义，以及原因。 */
export interface EngineChainProblem {
  /** 出问题的引擎 id（id 本身非法时为原始键）。 */
  readonly id: string
  /** 面向人的一句话，带修复建议。 */
  readonly message: string
}

/** 自定义引擎编译结果。 */
export interface CustomEngineCompileResult {
  /** 通过校验、可直接进链的元数据行。 */
  readonly metas: EngineMeta[]
  /** 被跳过的条目及原因；由调用方告警。 */
  readonly problems: EngineChainProblem[]
}

/** 合法的自定义引擎 id：与配置键、`engines` 覆盖键一致，且能安全出现在日志里。 */
const CUSTOM_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 端点必须是绝对 http(s) URL（`scrape` 模板另需 `{query}` 占位符）。 */
function isAbsoluteHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** 从 URL 里取主机名，作为 vendor 兜底。 */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint.replace('{query}', 'q').replace('{count}', '1')).host
  } catch {
    return endpoint
  }
}

/**
 * 把 `config.customEngines` 编译成引擎元数据行。
 *
 * 校验失败**不抛异常**，而是把该条目记进 `problems` 并跳过：一个写错的
 * 自定义引擎不应该让整条链连免密钥 Bing 兜底都起不来。调用方负责把这些
 * 问题写进日志，让用户看得见。
 *
 * @param custom - 用户配置，键为引擎 id。
 * @returns 可进链的元数据行与被跳过的条目。
 */
export function customEngineMetas(custom: Record<string, CustomEngineConfig> = {}): CustomEngineCompileResult {
  const metas: EngineMeta[] = []
  const problems: EngineChainProblem[] = []
  const builtinIds = new Set(ENGINE_METAS.map((meta) => meta.id))

  for (const [id, raw] of Object.entries(custom)) {
    const fail = (message: string): void => {
      problems.push({ id, message })
    }
    const cfg = raw ?? ({} as CustomEngineConfig)

    if (!CUSTOM_ENGINE_ID.test(id)) {
      fail('引擎 id 只能由字母、数字、点、下划线和连字符组成，且以字母或数字开头')
      continue
    }
    if (builtinIds.has(id)) {
      fail(`与内置引擎 id 冲突；要调整内置引擎请用 config.engines.${id}，要新增请换个 id`)
      continue
    }

    const kind = cfg.kind ?? 'json-api'
    const endpoint = cfg.endpoint?.trim() ?? ''
    if (endpoint.length === 0) {
      fail('缺少 endpoint')
      continue
    }
    if (!isAbsoluteHttpUrl(endpoint)) {
      fail(`endpoint 必须是绝对 http(s) URL，实际是 ${JSON.stringify(endpoint)}`)
      continue
    }

    const auth = cfg.auth ?? (resolvedKey(cfg.apiKey?.trim()) !== undefined || cfg.apiKeyEnv !== undefined ? 'bearer' : 'none')
    if (auth === 'header' && (cfg.authHeader?.trim() ?? '').length === 0) {
      fail("auth: 'header' 时必须给出 authHeader（请求头名）")
      continue
    }
    if (auth === 'query' && (cfg.authParam?.trim() ?? '').length === 0) {
      fail("auth: 'query' 时必须给出 authParam（查询参数名）")
      continue
    }

    // requiresKey：显式声明优先；否则 'none' 之外都需要 key。
    const requiresKey = cfg.requiresKey ?? (auth !== 'none')
    const freeTier: EngineFreeTier = {
      dailyRequests: cfg.dailyRequests ?? DEFAULT_DAILY_LIMIT,
      note: cfg.note?.trim() ?? `自定义引擎：未声明免费额度，取保守默认值 ${DEFAULT_DAILY_LIMIT} 次/日。`,
    }
    const name = cfg.name?.trim() ?? id
    const vendor = cfg.vendor?.trim() ?? hostOf(endpoint)
    const priority = cfg.priority ?? CUSTOM_ENGINE_DEFAULT_PRIORITY

    if (kind === 'scrape') {
      if (!endpoint.includes('{query}')) {
        fail("kind: 'scrape' 的 endpoint 模板必须包含 {query} 占位符")
        continue
      }
      metas.push({
        kind: 'scrape',
        id,
        name,
        vendor,
        requiresKey: false,
        endpoint,
        defaultPriority: priority,
        freeTier,
        ...cfg.extraQuery !== undefined ? { extraQuery: cfg.extraQuery } : {},
      })
      continue
    }

    const resultsPath = cfg.resultsPath?.trim() ?? 'results'
    const urlField = cfg.fields?.url?.trim() ?? ''
    if (urlField.length === 0) {
      fail('缺少 fields.url：seam 的每条 source 都必须有 URL，没有它这条定义无法产出可引用结果')
      continue
    }

    metas.push({
      kind: 'json-api',
      id,
      name,
      vendor,
      requiresKey,
      auth,
      ...auth === 'header' ? { authHeader: cfg.authHeader?.trim() as string } : {},
      ...auth === 'query' ? { authParam: cfg.authParam?.trim() as string } : {},
      // 密钥环境变量名只有用户显式给出时才存在；凭据库里也用这个名字查。
      ...cfg.apiKeyEnv?.trim() !== undefined && cfg.apiKeyEnv.trim().length > 0
        ? { authEnv: cfg.apiKeyEnv.trim() }
        : {},
      endpoint,
      method: cfg.method ?? 'POST',
      defaultPriority: priority,
      freeTier,
      request: {
        queryField: cfg.queryField?.trim() ?? 'query',
        ...cfg.countField?.trim() !== undefined && cfg.countField.trim().length > 0
          ? { countField: cfg.countField.trim() }
          : {},
        ...cfg.extraBody !== undefined ? { extra: cfg.extraBody } : {},
        ...cfg.extraQuery !== undefined ? { extraQuery: cfg.extraQuery } : {},
      },
      response: {
        resultsPath,
        fields: {
          title: cfg.fields?.title?.trim() ?? 'title',
          url: urlField,
          ...cfg.fields?.snippet?.trim() !== undefined && cfg.fields.snippet.trim().length > 0
            ? { snippet: cfg.fields.snippet.trim() }
            : {},
          ...cfg.fields?.snippetFallback?.trim() !== undefined && cfg.fields.snippetFallback.trim().length > 0
            ? { snippetFallback: cfg.fields.snippetFallback.trim() }
            : {},
          ...cfg.fields?.publishedAt?.trim() !== undefined && cfg.fields.publishedAt.trim().length > 0
            ? { publishedAt: cfg.fields.publishedAt.trim() }
            : {},
        },
      },
    })
  }

  return { metas, problems }
}

/** 构造完整引擎链的输入。 */
export interface BuildChainInput {
  /** 按引擎 id 的部分覆盖。 */
  readonly overrides?: Record<string, EngineConfig>
  /** 顶层集中密钥区。 */
  readonly apiKeys?: Record<string, string>
  /** 用户自定义引擎定义。 */
  readonly custom?: Record<string, CustomEngineConfig>
}

/** 完整引擎链的构造结果。 */
export interface BuildChainResult {
  /** 已按优先级升序排序的引擎实例（内置 + 自定义）。 */
  readonly engines: Engine[]
  /** 被跳过的自定义条目（调用方应告警）。 */
  readonly problems: readonly EngineChainProblem[]
  /** 实际参与装配的全部元数据行（护栏推导默认预算时要与它一致）。 */
  readonly metas: readonly EngineMeta[]
}

/**
 * 把内置静态表 + 自定义引擎定义 + 用户覆盖合成为引擎链。
 *
 * 两类引擎走同一条装配路径：自定义引擎只是「用户在自己的配置里多写了几行
 * 元数据」，因此密钥解析、优先级排序、护栏预算、适配器选择全部与内置一致。
 */
export function buildEngineChain(ctx: Context, input: BuildChainInput = {}): BuildChainResult {
  const overrides = input.overrides ?? {}
  const apiKeys = input.apiKeys ?? {}
  const compiled = customEngineMetas(input.custom)
  const metas: EngineMeta[] = [...ENGINE_METAS, ...compiled.metas]

  const engines: Engine[] = []
  for (const meta of metas) {
    const cfg = overrides[meta.id] ?? {}
    if (cfg.enabled === false) continue
    const literalKey = resolvedKey(cfg.apiKey?.trim())
    // 字面量密钥已经解析到时就不必再挂凭据解析器；挂上也不会被用到
    // （resolveKey 先返回值），但会白白多一次服务查询。
    const wantsCredentialService = meta.kind === 'llm' && literalKey === undefined
    engines.push(instantiateEngine({
      meta,
      apiKey: resolveApiKey(ctx, meta, cfg, apiKeys),
      baseURL: resolveBaseURL(ctx, meta, cfg),
      credentialResolver: wantsCredentialService
        ? credentialResolverFor(ctx, keyEnvName(meta, cfg))
        : undefined,
      credentialSourcePresent: wantsCredentialService ? credentialSourcePresentFor(ctx) : undefined,
    }))
  }

  return { engines: sortEngines(engines, overrides, metas), problems: compiled.problems, metas }
}

/**
 * 把静态引擎表 + 用户覆盖合成为排序后的引擎链（{@link buildEngineChain} 的便捷形式）。
 * 未显式 `enabled: false` 的引擎都会进入链；需要密钥却缺 key 的引擎会在
 * available()（本地检查）阶段出局，链内其余引擎照常工作 —— 这正是「带 API 与
 * 不带 API 的后端统一在一条链上」的落点。
 *
 * @param ctx - 插件上下文，用于读取启动环境与凭据服务中的密钥。
 * @param overrides - 用户按引擎 id 提供的覆盖（缺省 {}）。
 * @param apiKeys - 顶层集中密钥区（缺省 {}），键为引擎 id。
 * @param custom - 用户自定义引擎定义（缺省 {}）。定义不合法者被跳过。
 * @returns 已按优先级升序排序的引擎实例。
 */
export function buildEngines(
  ctx: Context,
  overrides: Record<string, EngineConfig> = {},
  apiKeys: Record<string, string> = {},
  custom: Record<string, CustomEngineConfig> = {},
): Engine[] {
  return buildEngineChain(ctx, { overrides, apiKeys, custom }).engines
}