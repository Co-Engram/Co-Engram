# AGENTS.md

Co-Engram 是独立插件，兼容 OpenClaw 与 Claude Code。设计文档见 `docs/`。

## 核心约束（不可妥协）

1. **核心逻辑零宿主依赖**：`@co-engram/core` 不依赖 OpenClaw 或 Claude Code API
2. **代码/数据完全分离**：插件代码在本仓库；记忆数据在独立的 `~/team-memory/` Git 仓库
3. **权威源 vs 派生缓存分离**：`engrams/{content,meta,synapses}` 提交 Git；`.co-engram/` gitignore
4. **三文件分离 + 动态自适应披露**：每个 engram 拆为 content.md / meta.yaml / synapses.yaml
5. **不增加字段，只深化语义**：业界调研后的硬约束

## 命令

- 安装：`pnpm install`
- 构建：`pnpm build`
- 测试：`pnpm test`
- 类型检查：`pnpm tsgo`
- 格式化：`pnpm format`

## 代码风格

- TS ESM strict，禁用 `any`（用 `unknown` + narrow）
- Zod 在所有外部边界（工具输入、配置文件、YAML 加载）
- 禁止 `@ts-nocheck`
- 简短注释，只解释非显而易见的逻辑

## 测试

- Vitest colocated `*.test.ts`
- 每个 core 模块单测覆盖
- E2E 测试在 `test/e2e/`

## 数据仓库

`~/team-memory/` 是独立的 Git 仓库（不嵌入本项目）。结构：

```
~/team-memory/
├── engrams/{content,meta,synapses}/   # 三文件镜像
├── skills/
├── intentions/
├── config/
└── .co-engram/                         # 运行时缓存（gitignore）
```
