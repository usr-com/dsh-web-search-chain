# dsh-web-search-chain

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可插拔 Web 搜索提供者链：
把**有免费额度的 API** 与**免密钥抓取**统一到单一 `WebSearchProvider` 背后，自带每引擎请求预算、
自动降级，且不会在无声无息中把免费额度刷成账单。

[English](README.md)

---

## 为什么需要它

DeepSeek Harness 通过唯一的能力缝 `ctx.web` 访问网络，而这条缝**只选一个** provider。这是好设计，
但代价是你只能挑一个搜索后端（通常是内置那个），既无法决定它消耗了谁家的免费额度，也无法规定
「缺 key 时怎么办」「额度用尽时怎么办」。

`dsh-web-search-chain` 只注册**一个** provider（id 为 `web-search-chain`），在它内部跑一条有序的
**引擎链**：一次搜索会透明地在多个后端之间降级，而硬性的请求预算保证免费额度不会被悄悄耗尽后变成费用。

## 特性

- **一个 provider，多个后端。** 内置 Tavily、LangSearch、免密钥 Bing 抓取，以及 DeepSeek 原生服务端搜索。
- **自带 API 也能接。** 通过 `customEngines` 配置即可接入任何标准 JSON 搜索接口 —— 不改代码、不重新构建。
- **额度护栏。** 每引擎每日请求上限，跨重启保留；提供方返回 `429` / `432` / `433` 时该引擎进入冷却期。
  超出预算的请求**根本不会发出去**。
- **自动降级。** 缺 key 的引擎静默出局（不报错）；网络失败、HTTP 错误、超时都会顺延到下一个引擎。
- **聚合模式。** 可选并发查询全部可用引擎，并按 URL 去重合并。
- **配置文件里不放密钥。** 密钥从引擎配置、顶层密钥区，或 harness 凭据库
  （`$DSH_HOME/.credentials.yaml`，与模型密钥同一套 seam、被热监听、改完不用重启）解析。

## 环境要求

- Node.js >= 20
- DeepSeek Harness (dsh)，已在 `0.2.0-rc.2` 上开发与验证

## 安装

### 装进 dsh profile（推荐）

```sh
dsh plugin --profile <profile> add github:usr-com/dsh-web-search-chain
```

从本地目录安装也可以 —— `dsh plugin add` 接受绝对路径：

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-web-search-chain
```

两种方式都会自动把包内声明的 `dsh.bundle.patch` 挂进 profile 的 bundle 列表。

### 从源码构建

```sh
git clone https://github.com/usr-com/dsh-web-search-chain
cd dsh-web-search-chain
pnpm install
pnpm build
```

## 启用 —— 这一步不可省

**只注册 provider 是不够的。** `dsh-base` 里已经写着：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

而 dsh-web 的选择规则是「配置了 id 就用配置的 id」，**不会**因为多注册了一个 provider 就自动改选。
请在 profile patch（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里覆盖它：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: web-search-chain
    fetchProvider: http
```

patch 的语义是**替换整行 config**（不是合并），所以 `fetchProvider` 必须重述。
另一种方式是在启动环境里设 `DSH_WEB_SEARCH_PROVIDER=web-search-chain`。

## 内置引擎

| id | 后端 | 协议 | 密钥 | 默认优先级 |
| --- | --- | --- | --- | --- |
| `tavily` | [Tavily](https://tavily.com) | JSON 搜索 API | `TAVILY_API_KEY` | 10 |
| `langsearch` | [LangSearch](https://langsearch.com) | JSON 搜索 API | `LANGSEARCH_API_KEY` | 20 |
| `bing` | Microsoft Bing | 免密钥 HTML 抓取 | 无 | 30 |
| `deepseek-official` | DeepSeek | Anthropic 兼容 Messages + `web_search` 工具 | `DEEPSEEK_API_KEY` | 40 |

引擎按优先级升序尝试。因为 `bing` 不需要密钥，整条链恒可用 —— 完全没配置的环境也能直接搜索。

## 降级规则

1. 带 key 的引擎按优先级顺次尝试（Tavily → LangSearch → DeepSeek）。
2. 缺 key 的引擎 `available()` 为 false，**直接跳过且不报错**，不浪费一次往返。
3. 全部带 key 的引擎都失败（网络 / 额度 / 超时）时，由免密钥 Bing 兜底出结果。
4. `failover`（默认）返回第一个成功结果；`aggregate` 并发跑全部可用引擎并按 URL 去重合并。
5. 任何引擎被返回 `429` / `432` / `433`，都会进入冷却期，后续搜索直接跳过它直到冷却结束。

### 关于「降级回 DSH 自带的搜索」

`ctx.web` 只选一个 provider，而被选中的 provider **无法把调用转交给另一个**（`ctx.web.search()` 会
重新走选择逻辑，只会再次选中自己，变成无限递归）。所以本链无法调用内置 `deepseek-official` 那个对象。

它采取的做法是**等价复刻**：`deepseek-official` 引擎使用同一个端点
（`https://api.deepseek.com/anthropic/v1/messages`）、同一套默认模型、同一个请求体
（`web_search_20250305`）、同一套响应映射，并且同样从 harness 凭据库解析 `DEEPSEEK_API_KEY` ——
也就是内置 provider 读取的同一个位置。唯一的差异是 DeepSeek 账号登录态（`x-dsh-auth-token`），本引擎未实现。

## 请求预算（额度护栏）

免费额度是**静默消耗**的。没有护栏时，每一次联网提问都会真实扣减额度；而一旦提供方进入按量付费区间，
就是真金白银。因此插件默认启用：

1. **发出前先判定** —— 超额或处于冷却期的引擎直接跳过，请求根本不发出去。
2. **发出即计数** —— 每一次真正离开本机的请求都记入当日用量，与成功失败无关。
3. **限额即冷却** —— `429` / `432` / `433` 让该引擎休眠 `Retry-After` 指定的时长，缺省用 `cooldownMs`，
   并被收敛到当日剩余时间。
4. **落盘** —— 用量写入 `$DSH_HOME/web-search-chain-quota.json`，重启不会把当天预算清零。
5. **失败要响亮** —— 全部引擎都触顶时抛 `WEB_PROVIDER_RATE_LIMITED`，并逐条列出「已用 / 上限 / 何时重置」，
   而不是伪装成「全部引擎失败」。

默认每日上限（可用 `quota.dailyLimits` 覆盖，`0` 表示不限制）：

| 引擎 | 默认/日 | 依据 |
| --- | --- | --- |
| `tavily` | 30 | 免费 Researcher 计划 1000 credits/月、basic 搜索 1 credit/次；30/日 ≈ 900/月，留有余量 |
| `langsearch` | 200 | 按 token 计量（当前 $0/百万 token）；官方只公布 RPS/TPM/TPD 而不公布数值，取保守值 |
| `bing` | 200 | 免密钥、无费用；上限只为对搜索引擎保持礼貌 |
| `deepseek-official` | 50 | 每次搜索都是一次完整的模型请求（按 token 计费），最需要设防的兜底路径 |

部分提供方的额度是**月**度或按 **token** 计的，而护栏按**请求次数/日**计数。这是刻意的近似 ——
客户端只能观测到请求次数。Tavily 有 `GET /usage`，但不保证对免费账号开放；LangSearch 完全没有用量接口。
想要更强的保证，请调低 `quota.dailyLimits.tavily`。

## 自定义引擎

只要对方提供 API key 和一套标准查询接口，写几行配置就能进链。

```yaml
config:
  customEngines:
    # Brave Search API：GET + 自定义请求头 + 嵌套结果路径
    brave:
      name: Brave Search
      endpoint: https://api.search.brave.com/res/v1/web/search
      method: GET
      auth: header
      authHeader: X-Subscription-Token
      apiKeyEnv: BRAVE_API_KEY
      queryField: q
      countField: count
      resultsPath: web.results
      fields:
        title: title
        url: url
        snippet: description
        publishedAt: page_age
      priority: 15
      dailyRequests: 60
      note: 免费 Developer 档 1 次/秒、2000 次/月

    # Google Programmable Search：密钥走查询串
    google-cse:
      endpoint: https://www.googleapis.com/customsearch/v1
      method: GET
      auth: query
      authParam: key
      queryField: q
      countField: num
      extraQuery:
        cx: 0123456789abcdef0
      resultsPath: items
      fields: { title: title, url: link, snippet: snippet }
      dailyRequests: 90

    # 自建 SearXNG：无密钥
    searxng:
      endpoint: https://searx.example.com/search
      method: GET
      auth: none
      extraQuery: { format: json }
      resultsPath: results
      fields: { title: title, url: url, snippet: content }
      dailyRequests: 0
```

规则与坑：

1. **id 不能和内置引擎重名**（`tavily` / `langsearch` / `bing` / `deepseek-official`）。要调内置引擎请用 `engines.<id>`。
2. **定义不合法只跳过自己**，不会致命：缺 `endpoint`、端点不是绝对 http(s)、缺 `fields.url`、
   `auth: 'header'` 没给 `authHeader` 等，都会逐条报告，其余引擎（含 Bing 兜底）照常工作。
3. **默认优先级 25**，排在 LangSearch 之后、Bing 之前。用 `priority` 或 `engines.<id>.priority` 改。
4. **请声明 `dailyRequests`**（缺省 200）。护栏是防止超额付费的唯一手段，而插件无从得知第三方的免费额度。
5. **`fields.url` 是必填**：seam 的每条 source 都必须有 URL，缺它会被直接判为非法，而不是静默返回空。
6. **`kind: 'scrape'` 复用 Bing 的 HTML 解析器**，因此只适用于 **Bing 同构的结果页**（镜像或代理）。
   想接 DuckDuckGo、Google 等结构不同的网页，请自己套一层返回 JSON 的代理，再用 `kind: 'json-api'`。
7. **密钥解析顺序**：`engines.<id>.apiKey` → `apiKeys.<id>` → harness 凭据 seam。
   该 seam 会按自己的信任顺序去取 `apiKeyEnv`（或引擎默认变量）指定的名字：
   继承的进程环境 > `$DSH_HOME/.credentials.yaml` > 项目 `.env` > `$DSH_HOME/.env`。
   自定义引擎与内置引擎走的是同一条路径。

## 配置项

```ts
interface Config {
  strategy?: 'failover' | 'aggregate'   // 默认 'failover'
  timeoutMs?: number                    // 单引擎超时，默认 15000
  maxResults?: number                   // 默认结果上限，默认 8
  apiKeys?: Record<string, string>      // 顶层密钥区，UI 以密码框渲染
  engines?: Record<string, EngineConfig>
  customEngines?: Record<string, CustomEngineConfig>
  quota?: QuotaConfig
}

interface EngineConfig {
  enabled?: boolean
  priority?: number
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
}

interface QuotaConfig {
  enabled?: boolean                     // 默认 true
  dailyLimits?: Record<string, number>  // 按引擎覆盖；0 = 不限制
  cooldownMs?: number                   // 默认 600000（10 分钟）
  persist?: boolean                     // 默认 true
  statePath?: string                    // 默认 $DSH_HOME/web-search-chain-quota.json
}
```

`CustomEngineConfig` 在 `EngineConfig` 之外增加：`kind`、`name`、`vendor`、`endpoint`、`method`、
`auth`、`authHeader`、`authParam`、`requiresKey`、`queryField`、`countField`、`extraQuery`、
`extraBody`、`resultsPath`、`fields`、`dailyRequests`、`note`。详见上一节。

## 密钥放在哪

优先级从高到低：

1. `engines.<id>.apiKey` —— 单引擎字面密钥。
2. `apiKeys.<id>` —— 顶层密钥区。
3. **harness 凭据 seam**（`ctx.credentials`），每次搜索时解析一次。

第 3 层就是模型适配器用的那套机制，所以密钥和模型密钥放在同一个地方。该 seam
自己排好了来源顺序，插件完全继承：

```text
继承的进程环境                    （只读，最高）
> $DSH_HOME/.credentials.yaml     （可写 —— DSH 的 Models 页写模型密钥就是写这里）
> <启动目录>/.env                 （只读兜底）
> $DSH_HOME/.env                  （只读兜底）
```

**推荐把 API 密钥写进 `$DSH_HOME/.credentials.yaml`。** 它正是 Models 页管理的那个文件；
它压过任何 `.env`（所以不会被仓库里夹带的旧 key 顶掉）；而且它**被热监听** ——
改完下一次搜索就生效，**不用重启**。格式是严格的「引用名 → 字符串」映射：

```yaml
refs:
  TAVILY_API_KEY: tvly-xxxxxxxx
  LANGSEARCH_API_KEY: xxxxxxxx
```

`.env` 依然可用，但它在**启动时只读一次** —— 改完要重启 harness。另外「项目层」指的是
**启动目录**的 `.env`，而桌面端的启动目录不一定是你的项目目录，所以 `$DSH_HOME/.env`
比它更可预期。模板见 [`.env.example`](.env.example)。

> ⚠️ **不要把引导变量写进 `.env`。** `DSH_` 开头的名字（包括 `DSH_WEB_SEARCH_PROVIDER`）、
> `DEEPSEEK_SEARCH_BASE_URL`、`DEEPSEEK_BASE_URL`、代理变量、`SSL_CERT_*` 系列，
> 都只能来自启动环境 —— `.env` 里出现其中之一，harness 会**直接拒绝启动**。

`DEEPSEEK_API_KEY` 不需要额外配置：只要你在 DSH 的 Models 页登录过或填过 key，
凭据库里就已经有了。

### 密钥缺失时的行为

取不到密钥的引擎会报告 `available() === false` 并被跳过，**一个请求都不会发出去**
—— 链不会去打一次注定 401 的请求。密钥每次搜索都重新解析，所以往
`.credentials.yaml` 里补上 key 之后，下一次搜索该引擎就可用。

另外，装配链时会顺带预热各引擎的凭据状态，因此那次异步查询在第一次搜索之前
早就落定了。

## 开发

```sh
pnpm build       # tsc 编译到 lib/
pnpm typecheck   # 仅类型检查
pnpm test        # node --test 跑 test/*.test.mjs（106 个用例）
```

若在受限 shell 里 `node --test` 报 `spawn EPERM`，请逐个文件直接运行 —— 入口文件里的
`node:test` 会就地执行：`node test/<file>.test.mjs`。

新增**内置**引擎 = 在 `src/engines.ts` 的 `ENGINE_METAS` 追加一行：协议种类、端点、鉴权、
请求/响应字段映射。内置引擎与自定义引擎由同一个 `buildEngineChain` 装配，因此密钥解析、
排序与预算行为不会分叉。

## 许可证

[MIT](LICENSE)
