# dsh-web-search-chain

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

A pluggable web-search provider chain for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Free-tier APIs and keyless scraping sit behind a single `WebSearchProvider`, with
per-engine request budgets, automatic failover, and no silent overspending.

[中文说明](README.zh-CN.md)

---

## Why

DeepSeek Harness reaches the web through one capability seam (`ctx.web`), and that
seam selects exactly one provider. That is a good design, but it means picking a
single search backend — usually the built-in one — with no say in which free tiers
it consumes, what happens when a key is missing, or what happens when a quota runs
out.

`dsh-web-search-chain` registers **one** provider (`web-search-chain`) that runs an
ordered **chain of engines** inside it. A search degrades across backends
transparently, and a hard request budget keeps a free tier from being drained
silently and turning into a bill.

## Features

- **One provider, many backends.** Tavily, LangSearch, a keyless Bing scraper, and
  DeepSeek's native server-side search ship in the box.
- **Bring your own API.** A `customEngines` config section adds any standard JSON
  search API — no code, no rebuild.
- **Quota guard.** Per-engine daily request budgets, persisted across restarts,
  plus a cooldown when a provider answers `429` / `432` / `433`. Over-budget
  requests are never sent at all.
- **Automatic failover.** A missing key drops an engine out without an error;
  network failures, HTTP errors, and timeouts move on to the next engine.
- **Aggregate mode.** Optionally query every usable engine concurrently and merge
  results by URL.
- **No secrets in config files.** Keys resolve from per-engine config, a top-level
  key section, or environment variables.

## Requirements

- Node.js >= 20
- DeepSeek Harness (dsh). Developed and verified against `0.2.0-rc.2`.

## Installation

### Into a dsh profile (recommended)

```sh
dsh plugin --profile <profile> add github:usr-com/dsh-web-search-chain
```

Or from a local checkout — `dsh plugin add` accepts an absolute path:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-web-search-chain
```

Either way the package's `dsh.bundle.patch` is registered into the profile's
bundle list automatically.

### From source

```sh
git clone https://github.com/usr-com/dsh-web-search-chain
cd dsh-web-search-chain
pnpm install
pnpm build
```

## Enabling it — this step is required

Registering a provider is **not** enough. `dsh-base` ships with

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

and dsh-web honours a configured id — it does not opportunistically switch to
"the only other registered provider". Add this to your profile patch
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: web-search-chain
    fetchProvider: http
```

Patch semantics **replace** the whole `config` object, so `fetchProvider` must be
restated. Alternatively set `DSH_WEB_SEARCH_PROVIDER=web-search-chain` in the
launch environment.

## Built-in engines

| id | backend | protocol | credential | default priority |
| --- | --- | --- | --- | --- |
| `tavily` | [Tavily](https://tavily.com) | JSON search API | `TAVILY_API_KEY` | 10 |
| `langsearch` | [LangSearch](https://langsearch.com) | JSON search API | `LANGSEARCH_API_KEY` | 20 |
| `bing` | Microsoft Bing | keyless HTML scrape | none | 30 |
| `deepseek-official` | DeepSeek | Anthropic-compatible Messages + `web_search` tool | `DEEPSEEK_API_KEY` | 40 |

Engines are tried in ascending priority order. Because `bing` needs no key, the
chain is always available, and a completely unconfigured install still searches.

## Failover semantics

1. Keyed engines are tried in priority order (Tavily → LangSearch → DeepSeek).
2. An engine whose key is missing reports `available() === false` and is skipped
   **without an error** — no wasted round trip.
3. If every keyed engine fails (network, quota, timeout), the keyless Bing scraper
   produces results.
4. `failover` (default) returns the first success; `aggregate` runs every usable
   engine concurrently and merges by URL.
5. Any engine answered with `429` / `432` / `433` enters a cooldown and is skipped
   by later searches until it expires.

### On "fall back to the built-in search"

`ctx.web` selects exactly one provider, and a selected provider cannot hand a call
to another one (`ctx.web.search()` re-runs selection and would pick itself again —
infinite recursion). So the chain cannot invoke the built-in `deepseek-official`
provider object.

What it does instead is **replicate it**: the `deepseek-official` engine uses the
same endpoint (`https://api.deepseek.com/anthropic/v1/messages`), the same default
model, the same request body (`web_search_20250305`), and the same response
mapping, and it resolves `DEEPSEEK_API_KEY` from the harness credential store — the
same place the built-in reads it. The one difference is DeepSeek account sign-in
(`x-dsh-auth-token`), which this engine does not implement.

## Request budget (quota guard)

Free tiers are consumed silently. Without a guard, every web question really does
draw down a quota, and once a provider is in pay-as-you-go mode it really does cost
money. The plugin therefore enables this by default:

1. **Check before dispatch** — engines over budget or in cooldown are skipped, and
   the request is never sent.
2. **Count on dispatch** — every request that actually leaves is counted, whether
   it succeeds or fails.
3. **Cooldown on limits** — `429` / `432` / `433` puts the engine to sleep for
   `Retry-After`, or `cooldownMs` when absent, capped at the end of the UTC day.
4. **Persist** — usage is written to `$DSH_HOME/web-search-chain-quota.json`, so a
   restart does not reset today's budget.
5. **Fail loudly** — when every engine is over budget the chain raises
   `WEB_PROVIDER_RATE_LIMITED` and lists used / limit / reset per engine, instead
   of pretending all engines failed.

Default daily budgets (override with `quota.dailyLimits`; `0` disables the cap):

| engine | per day | rationale |
| --- | --- | --- |
| `tavily` | 30 | free "Researcher" plan is 1,000 credits/month at 1 credit per basic search; 30/day ≈ 900/month leaves headroom |
| `langsearch` | 200 | metered in tokens (currently $0/M); docs publish RPS/TPM/TPD but no numbers, so this is a conservative stand-in |
| `bing` | 200 | keyless and free; the cap only keeps the scraper polite |
| `deepseek-official` | 50 | every search is a full model request billed per token — the fallback most worth capping |

Some quotas are monthly or token-based while the guard counts requests per day.
That is a deliberate approximation: a client can only observe request counts.
Tavily exposes `GET /usage` but not reliably on free accounts; LangSearch exposes
nothing. Lower `quota.dailyLimits.tavily` if you want a stronger guarantee.

## Custom engines

Any provider offering an API key plus a standard query endpoint can join the chain
through configuration alone.

```yaml
config:
  customEngines:
    # Brave Search API: GET + custom header + nested result path
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
      note: free Developer tier — 1 req/s and 2,000 queries/month

    # Google Programmable Search: the key goes in the query string
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

    # self-hosted SearXNG: no key at all
    searxng:
      endpoint: https://searx.example.com/search
      method: GET
      auth: none
      extraQuery: { format: json }
      resultsPath: results
      fields: { title: title, url: url, snippet: content }
      dailyRequests: 0
```

Rules and gotchas:

1. **Ids must not collide with a built-in engine.** Use `engines.<id>` to tune a
   built-in one instead.
2. **An invalid definition is skipped, not fatal.** A missing `endpoint`, a
   non-absolute URL, a missing `fields.url`, `auth: 'header'` without
   `authHeader`, and similar problems are reported per entry, while every other
   engine — Bing included — keeps working.
3. **Default priority is 25**, i.e. after LangSearch and before Bing. Change it
   with `priority` or `engines.<id>.priority`.
4. **Declare `dailyRequests`** (default 200). The guard is the only thing standing
   between you and an overspent quota, and the plugin cannot know a third party's
   free tier.
5. **`fields.url` is required.** Every source on the seam must carry a URL, so a
   definition without it is rejected rather than silently returning nothing.
6. **`kind: 'scrape'` reuses Bing's HTML parser**, so it only fits Bing-shaped
   result pages (a mirror or a proxy). For DuckDuckGo, Google, or any other markup,
   put a thin proxy in front that returns JSON and use `kind: 'json-api'`.
7. **Key resolution** is `engines.<id>.apiKey` → `apiKeys.<id>` → the environment
   variable named by `apiKeyEnv`. The harness credential store is read by the
   built-in `deepseek-official` engine only; use config or environment variables
   for custom engines.

## Configuration reference

```ts
interface Config {
  strategy?: 'failover' | 'aggregate'   // default 'failover'
  timeoutMs?: number                    // per-engine timeout, default 15000
  maxResults?: number                   // default result cap, default 8
  apiKeys?: Record<string, string>      // top-level key section, rendered as a password field
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
  enabled?: boolean                     // default true
  dailyLimits?: Record<string, number>  // per-engine; 0 = unlimited
  cooldownMs?: number                   // default 600000 (10 min)
  persist?: boolean                     // default true
  statePath?: string                    // default $DSH_HOME/web-search-chain-quota.json
}
```

`CustomEngineConfig` extends `EngineConfig` with `kind`, `name`, `vendor`,
`endpoint`, `method`, `auth`, `authHeader`, `authParam`, `requiresKey`,
`queryField`, `countField`, `extraQuery`, `extraBody`, `resultsPath`, `fields`,
`dailyRequests`, and `note`. See [Custom engines](#custom-engines).

## API keys

Highest precedence first:

1. `engines.<id>.apiKey` — a literal key for one engine.
2. `apiKeys.<id>` — the top-level key section (rendered as a password field by the
   DSH settings UI).
3. The environment variable named by `engines.<id>.apiKeyEnv`, or the engine's
   default variable (`TAVILY_API_KEY`, `LANGSEARCH_API_KEY`, `DEEPSEEK_API_KEY`).

Put keys in a `.env` file rather than in a profile patch. Note that the launch
environment layers are *process environment → the launching directory's `.env` →
`$DSH_HOME/.env`*, so the directory you start `dsh` from decides which `.env` is
read. See [`.env.example`](.env.example) for the template.

`deepseek-official` additionally reads the harness credential store
(`$DSH_HOME/.credentials.yaml`), so a key saved through the DSH Models page is
picked up automatically.

## Development

```sh
pnpm build       # tsc -> lib/
pnpm typecheck   # types only
pnpm test        # node --test over test/*.test.mjs (94 cases)
```

If `node --test` fails with `spawn EPERM` under a restricted shell, run the files
directly instead — `node:test` executes in-process when the file is the entry
point: `node test/<file>.test.mjs`.

Adding a built-in engine means appending one row to `ENGINE_METAS` in
`src/engines.ts`: protocol kind, endpoint, auth, and the request/response field
mapping. Built-in and custom engines are assembled by the same
`buildEngineChain`, so key resolution, ordering, and budgets cannot drift apart.

## License

[MIT](LICENSE)
