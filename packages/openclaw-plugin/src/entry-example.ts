/**
 * 示例：如何在 openclaw 项目里注册 Co-Engram
 *
 * 这个文件不导出任何东西，仅作为使用文档。
 * 用户在自己的 openclaw 扩展里复制下面的代码即可。
 *
 * @module @co-engram/openclaw/example
 */

// 用户在自己项目里的代码（仅供参考）：
//
// import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
// import { registerCoEngramTools } from '@co-engram/openclaw'
//
// export default definePluginEntry({
//   id: 'co-engram',
//   name: 'Co-Engram',
//   description: 'Team memory with neuroscience-inspired plasticity',
//   register(api) {
//     registerCoEngramTools(api, {
//       dataRoot: process.env.CO_ENGRAM_DATA_ROOT ?? `${process.env.HOME}/team-memory`,
//     })
//   },
// })

export {};
