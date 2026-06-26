/**
 * Scene 类型定义（状态依赖检索）
 *
 * 三层场景架构：
 *   Layer 1 认知模式（5 种预设，神经科学固定）
 *   Layer 2 领域场景（数据驱动进化）
 *   Layer 3 当前情境（运行时）
 *
 * @module @co-engram/core/types
 */

import type { CognitiveMode, EngramId, SceneId } from "./engram.js";

/** Layer 2 领域场景 */
export interface Scene {
  readonly id: SceneId;
  readonly name: string;
  readonly description: string;
  readonly discoveredFrom: "manual" | "auto-clustered";
  readonly affinityEngrams: readonly EngramId[];
  readonly preferredCognitiveModes: readonly CognitiveMode[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Layer 3 当前情境（运行时，隐式） */
export interface CurrentContext {
  readonly recentlyRetrieved: readonly {
    readonly engramId: EngramId;
    readonly retrievedAt: string;
    readonly effectiveness?: number;
  }[];
  readonly activeTags: readonly string[];
  readonly activeDomains: readonly string[];
  readonly cognitiveMode: CognitiveMode;
  readonly activeScene?: SceneId;
}

/** PrimingContext（启动效应） */
export interface PrimingContext {
  readonly recentlyRetrieved: readonly {
    readonly engramId: EngramId;
    readonly retrievedAt: string;
    readonly effectiveness?: number;
  }[];
  readonly activeTags: readonly string[];
  readonly activeDomains: readonly string[];
  readonly halfLife: number; // 默认 5 分钟
}

/** 场景亲和度统计（派生缓存） */
export interface SceneAffinity {
  readonly sceneId: SceneId;
  readonly engramCounts: Record<string, number>;
  readonly lastActivatedAt: string;
}
