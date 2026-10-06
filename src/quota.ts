/**
 * 请求预算护栏：按引擎统计当日请求次数，并在提供方返回限额错误（429/432/433）
 * 时把该引擎置入冷却期。
 *
 * 存在两个目的：
 * 1. **不超额度** —— 免费额度（Tavily 1000 credits/月、LangSearch 的 TPM/TPD、
 *    DeepSeek 官方搜索按 token 计费）在链上是「静默消耗」的：没有护栏时，
 *    每一次联网提问都会真实扣减额度，超限后由提供方计费或直接拒绝。
 *    这里用「每引擎每日请求上限」作为与计费无关的兜底代理量。
 * 2. **可跨重启** —— 计数落盘到 harness home 下的一个 JSON 文件，否则重启
 *    DSH 会把当天的用量清零，护栏形同不存在。
 *
 * 计费周期以 **UTC 日** 为界（与 LangSearch TPD 的重置点一致；Tavily 的
 * 月度额度用每日上限做保守代理）。所有时间函数都可注入，便于单测。
 * @module dsh-web-search-chain/quota
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 守卫读取的当前时间（毫秒）。 */
export type Clock = () => number

/** 每个引擎在一个 UTC 日内的用量记录。 */
export interface QuotaUsage {
  /** 已发起的请求次数。 */
  used: number
  /** 被提供方以限额拒绝的次数。 */
  limited: number
  /** 冷却截止时间（epoch ms）；<= now 表示已恢复。 */
  cooldownUntil: number
}

/** 零用量：只读查询在未见过某引擎时返回的共享常量。 */
const ZERO_USAGE: QuotaUsage = Object.freeze({ used: 0, limited: 0, cooldownUntil: 0 })

/** 落盘的状态文档。 */
export interface QuotaState {
  /** 该文档所属的 UTC 日（`YYYY-MM-DD`）。 */
  day: string
  /** engineId → 用量。 */
  engines: Record<string, QuotaUsage>
}

/** 构造护栏所需的选项。 */
export interface QuotaGuardOptions {
  /** 总开关；false 时 allow 恒为 true 且不记录。 */
  readonly enabled: boolean
  /** engineId → 每日请求上限；0 或未声明表示不限制。 */
  readonly dailyLimits: Readonly<Record<string, number>>
  /** 提供方未给出 Retry-After 时的默认冷却时长（毫秒）。 */
  readonly cooldownMs: number
  /** 状态文件路径；省略则完全不落盘（纯内存）。 */
  readonly statePath?: string
  /** 注入时钟，便于单测。 */
  readonly now?: Clock
}

/** 每日上限默认值（引擎未声明时套用）。 */
export const DEFAULT_DAILY_LIMIT = 200

/** `YYYY-MM-DD`（UTC）。 */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** 一个引擎在「当日已用 / 上限 / 冷却」上的判定结果。 */
export interface QuotaVerdict {
  readonly allowed: boolean
  readonly reason?: 'disabled' | 'exhausted' | 'cooldown'
  /** 上限；undefined 表示不限制。 */
  readonly limit?: number
  readonly used: number
  /** 冷却或额度恢复的剩余毫秒（仅 exhausted / cooldown 时给出）。 */
  readonly retryAfterMs?: number
}

/**
 * 按引擎维护「当日请求预算 + 限额冷却」的守卫。实例是进程内单例，
 * 但状态会（可选地）持久化，使重启不清零。
 */
export class QuotaGuard {
  private readonly now: Clock
  private state: QuotaState
  private dirty = false
  private lastFlush = Number.NEGATIVE_INFINITY

  constructor(private readonly options: QuotaGuardOptions) {
    this.now = options.now ?? Date.now
    this.state = this.load()
  }

  /** 指定引擎此刻是否还能发起请求。纯查询，不产生状态。 */
  check(engineId: string): QuotaVerdict {
    const usage = this.peek(engineId)
    if (!this.options.enabled) {
      return { allowed: true, reason: 'disabled', used: usage.used }
    }
    const at = this.now()
    if (usage.cooldownUntil > at) {
      return {
        allowed: false,
        reason: 'cooldown',
        used: usage.used,
        retryAfterMs: usage.cooldownUntil - at,
      }
    }
    const limit = this.options.dailyLimits[engineId]
    if (limit !== undefined && limit > 0 && usage.used >= limit) {
      return {
        allowed: false,
        reason: 'exhausted',
        limit,
        used: usage.used,
        retryAfterMs: this.msUntilNextUtcDay(at),
      }
    }
    return { allowed: true, limit: limit !== undefined && limit > 0 ? limit : undefined, used: usage.used }
  }

  /** 记录一次即将发出的请求（调用方在真正发起前调用）。 */
  noteAttempt(engineId: string): void {
    if (!this.options.enabled) return
    this.usageOf(engineId).used += 1
    this.dirty = true
    this.flush()
  }

  /**
   * 记录提供方返回的限额错误，把该引擎置入冷却期。
   * @param engineId - 引擎 id。
   * @param retryAfterMs - 提供方给出的等待时间；缺省套用 `cooldownMs`。
   */
  noteRateLimited(engineId: string, retryAfterMs?: number): void {
    if (!this.options.enabled) return
    const usage = this.usageOf(engineId)
    usage.limited += 1
    const wait = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.options.cooldownMs
    // 429 只是短期限流，冷却上限收敛到当日剩余时间，避免把引擎永久关掉。
    const capped = Math.min(wait, this.msUntilNextUtcDay(this.now()))
    usage.cooldownUntil = Math.max(usage.cooldownUntil, this.now() + capped)
    this.dirty = true
    this.flush()
  }

  /**
   * 当前状态的只读快照（诊断/日志用）。
   *
   * 跨日后返回空状态而不是上一日的陈旧计数 —— 否则诊断会显示一个
   * 当天其实已经不生效的用量。
   */
  snapshot(): QuotaState {
    const today = utcDay(this.now())
    if (this.state.day !== today) return { day: today, engines: {} }
    return { day: this.state.day, engines: { ...this.state.engines } }
  }

  /** 强制落盘（进程退出前的最后机会；一般由 noteAttempt 触发）。 */
  flush(force = false): void {
    const path = this.options.statePath
    if (path === undefined || !this.dirty) return
    const at = this.now()
    if (!force && at - this.lastFlush < 1000) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(this.state)}\n`, 'utf8')
    } catch {
      // 护栏落盘失败时降级为纯内存：绝不让统计故障影响搜索本身；
      // 保持 dirty，下一次尝试再写。
      return
    }
    this.dirty = false
    this.lastFlush = at
  }

  /** 读取状态；跨日或损坏时以空状态重建。 */
  private load(): QuotaState {
    const fresh: QuotaState = { day: utcDay(this.now()), engines: {} }
    const path = this.options.statePath
    if (path === undefined) return fresh
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as QuotaState
      if (parsed.day !== fresh.day) return fresh
      if (parsed.engines === null || typeof parsed.engines !== 'object') return fresh
      return parsed
    } catch {
      return fresh
    }
  }

  /**
   * 只读地取引擎当日记录：跨日或未见过时返回零值，**不写入状态**。
   *
   * `check()` 必须无副作用，否则一次纯查询就会在快照里留下
   * `{used: 0}` 的空记录，「关闭护栏后不计数」也就无从断言。
   */
  private peek(engineId: string): QuotaUsage {
    if (this.state.day !== utcDay(this.now())) return ZERO_USAGE
    return this.state.engines[engineId] ?? ZERO_USAGE
  }

  /** 取引擎的当日记录用于自增，必要时跨日重置并落盘标记。 */
  private usageOf(engineId: string): QuotaUsage {
    const today = utcDay(this.now())
    if (this.state.day !== today) {
      this.state = { day: today, engines: {} }
      this.dirty = true
    }
    const existing = this.state.engines[engineId]
    if (existing !== undefined) return existing
    const created: QuotaUsage = { used: 0, limited: 0, cooldownUntil: 0 }
    this.state.engines[engineId] = created
    return created
  }

  /** 距下一个 UTC 日 00:00 的毫秒数。 */
  private msUntilNextUtcDay(at: number): number {
    const next = new Date(at)
    next.setUTCHours(24, 0, 0, 0)
    return Math.max(0, next.getTime() - at)
  }
}
