/**
 * 链内引擎抽象：适配器与聚合提供方之间的最小契约。
 * 每个引擎只关心「自己可不可用」与「执行一次搜索」。
 * @module dsh-web-search-chain/engine
 */

import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

/** 链内单个搜索引擎。 */
export interface Engine {
  /** 引擎 id（与静态元数据表一致，用于配置覆盖匹配）。 */
  readonly id: string
  /** 人类可读名（用于错误摘要与诊断）。 */
  readonly name: string
  /** 该引擎当前是否可用 —— 必须是免网络调用的本地检查。 */
  available(): boolean
  /** 执行一次搜索；失败抛 {@link WebError}，并尊重 signal 取消。 */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}