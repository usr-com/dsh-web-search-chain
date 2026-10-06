/**
 * 凭据服务适配：让引擎像模型适配器一样，从 harness 的凭据 seam
 * （`ctx.get('credentials')`）解析 API 密钥。
 *
 * 为什么要走这条 seam 而不是只看启动环境：`dsh-credentials-local` 已经把
 * 四层来源按信任度排好了 ——
 *
 * ```text
 * 继承的进程环境                    （只读，最高）
 * > $DSH_HOME/.credentials.yaml     （可写；Models 页写模型密钥就是写这里）
 * > <启动目录>/.env                 （只读兜底）
 * > $DSH_HOME/.env                  （只读兜底）
 * ```
 *
 * 于是把解析交给它，一次就同时得到：和模型密钥同一个文件、同一套优先级、
 * 以及**热重载**（该文件被 watch，外部编辑会即时生效），而 `.env` 依然可用。
 *
 * 难点在于 `WebSearchProvider.available()` 必须是**同步**的本地检查，而
 * 凭据解析是异步的。这里用「短负缓存 + 异步探针」解决：
 * 只有**确认**有密钥才放行，绝不乐观放行（否则没有 key 的引擎会白白发一次
 * 注定 401 的请求）；而「没有」只缓存 `negativeTtlMs`，超时就重探，
 * 因此在 `.credentials.yaml` 里补上密钥后无需重启即可被认到。
 * @module dsh-web-search-chain/credential
 */

/** 凭据 seam 暴露给本插件的两个能力。 */
export interface CredentialSource {
  /** 异步解析一个凭据引用（如 `TAVILY_API_KEY`）。 */
  readonly resolve?: () => Promise<string | undefined>
  /** 同步判断凭据服务此刻是否已挂载。 */
  readonly present?: () => boolean
}

/** 「没有密钥」结论的默认缓存时长（毫秒）。 */
export const DEFAULT_NEGATIVE_TTL_MS = 5000

/**
 * 单个引擎的密钥状态机：字面量 → 凭据服务，带同步判定与热重载友好的负缓存。
 */
export class CredentialKeyState {
  /** 最近一次已知结论；undefined 表示尚未探到。 */
  private known: boolean | undefined
  private probedAt = 0
  private probing = false

  constructor(
    private readonly source: CredentialSource | undefined,
    private readonly now: () => number = Date.now,
    private readonly negativeTtlMs: number = DEFAULT_NEGATIVE_TTL_MS,
  ) {}

  /**
   * 同步判定「此刻能否确认有密钥」。**从不乐观返回 true。**
   *
   * 返回 false 可能是「确实没有」，也可能是「还没探完」；两种情况都会在
   * `negativeTtlMs` 到期后重新探测，所以补上密钥不需要重启。
   */
  confirmed(): boolean {
    if (this.source?.resolve === undefined) return false
    if (this.known === true) return true
    if (this.known === false && this.now() - this.probedAt < this.negativeTtlMs) return false
    this.probe()
    return false
  }

  /**
   * 取本次请求要用的密钥：字面量优先，其次凭据服务；顺带刷新缓存。
   *
   * 每次搜索都重新解析，因此凭据库被改动后，下一次搜索就用新值。
   * @param literal - 已从配置/环境解析出的字面量密钥（可能为空）。
   * @returns 可用的密钥，或 undefined 表示取不到。
   */
  async resolve(literal?: string): Promise<string | undefined> {
    if (literal !== undefined && literal.length > 0) {
      this.refresh(true)
      return literal
    }
    const resolve = this.source?.resolve
    if (resolve === undefined) {
      this.refresh(false)
      return undefined
    }
    let value: string | undefined
    try {
      value = await resolve()
    } catch {
      // 凭据服务故障等价于「取不到」，由调用方给出可读错误。
      value = undefined
    }
    const usable = value !== undefined && value.length > 0
    this.refresh(usable)
    return usable ? value : undefined
  }

  /** 凭据来源此刻是否已挂载（未挂载时不应断言「没有密钥」）。 */
  sourcePresent(): boolean {
    if (this.source?.present !== undefined) return this.source.present()
    return this.source?.resolve !== undefined
  }

  private refresh(has: boolean): void {
    this.known = has
    this.probedAt = this.now()
  }

  /** 后台探一次，把结论写进缓存；服务未挂载时保持「未知」，下次再来。 */
  private probe(): void {
    if (this.probing) return
    const resolve = this.source?.resolve
    if (resolve === undefined) return
    if (this.source?.present?.() === false) return
    this.probing = true
    void resolve()
      .then((value) => {
        this.refresh(value !== undefined && value.length > 0)
      })
      .catch(() => {
        // 探针失败不算结论，留待 TTL 到期后重试。
      })
      .finally(() => {
        this.probing = false
      })
  }
}
