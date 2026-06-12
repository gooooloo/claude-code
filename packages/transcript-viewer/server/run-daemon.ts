#!/usr/bin/env bun
/**
 * Daemon 启动器 —— 给 bridge-daemon.ts 注入 MACRO defines + feature flags 后再跑。
 *
 * bridge-daemon.ts 用内部 QueryEngine 跑真实会话（canUseTool 在此路径才真正触发），
 * 而 QueryEngine 依赖 MACRO.* 编译期常量和 feature() 门控——和 CLI 一样必须在启动时
 * 用 `bun -d` 注入（参考 scripts/dev.ts）。直接 `bun run bridge-daemon.ts` 会因
 * `MACRO is not defined` 失败。
 *
 * 用法：bun run server/run-daemon.ts --token <密钥> --port 19860 [--mock] [--ask-all]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BUILD_FEATURES,
  getMacroDefines,
} from '../../../scripts/defines.ts'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..', '..', '..')
const daemonPath = join(here, 'bridge-daemon.ts')

const defines = {
  ...getMacroDefines(),
  'process.env.NODE_ENV': JSON.stringify('production'),
}
const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
  '-d',
  `${k}:${v}`,
])

const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith('FEATURE_'))
  .map(([k]) => k.replace('FEATURE_', ''))
const featureArgs = [
  ...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures]),
].flatMap(name => ['--feature', name])

const result = Bun.spawnSync(
  [
    'bun',
    'run',
    ...defineArgs,
    ...featureArgs,
    daemonPath,
    ...process.argv.slice(2),
  ],
  { stdio: ['inherit', 'inherit', 'inherit'], cwd: projectRoot },
)
process.exit(result.exitCode ?? 0)
