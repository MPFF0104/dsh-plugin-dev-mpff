// 工具 3：一次性 profile 上的装配验证（不安装任何插件）。
// 用宿主自己的组合器回答「这份 patch 在真实组合里成不成立」（层头 / 行 / config 整体替换）。
//
// 为什么只能用一次性 profile：`--dump-config` 会重写该 profile 的 `cordis.yml`，
// 这个宿主里不存在「只读地看别人的 profile」这条路径 ⇒ 一律自建，退出即删。
//
// 契约：stdout 恒为单份 JSON；退出码 0 通过 / 1 断言不通过 / 2 用法错误 / 3 前提不成立。
//
// 子进程白名单：`<node> -v`、`where` / `which`、`reg query`（定位库）、`<cli> --version`、
// `<cli> --profile <p> [--from-default-profile <name>] --dump-config [--patch <file>]`。
// 本脚本**不安装、不卸载、不 allow-version、不联网**；只用 `--patch` overlay。

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { cliInvocation, defaultIo, locateCli, locateNode, probe } from './lib/dsh-locate.mjs'
import { configKeys, rowBlock, shallowScanPatch } from './lib/skill-scan.mjs'

const TOOL = 'verify-assembly'
const CONTRACT_VERSION = 1

const problems = []
const next = []

function problem(code, severity, message, detail) {
  problems.push({ code, severity, message, detail })
}

function emit(doc, exitCode) {
  const pretty = JSON.stringify(doc, undefined, 2)
  process.stdout.write(`${Buffer.byteLength(pretty, 'utf8') > 4096 ? JSON.stringify(doc) : pretty}\n`)
  process.exitCode = exitCode
}

function help() {
  process.stdout.write(`verify-assembly — 一次性 profile 上的装配验证（零依赖 ESM）

用法: node "<skill-directory>/scripts/verify-assembly.mjs" [options]

选项:
  --plugin-dir <dir>              含 cordis.patch.yml 的包目录（默认 cwd）
  --patch <path>                  可重复；相对 --plugin-dir 或绝对（默认取 dsh.bundle.patch）
  --expect-row <id>               可重复；期望在组合结果里出现的行 id（默认从 patch 浅扫描推导）
  --expect-config <id>            触发「两跑差分」断言 config 整体替换
  --work-root <dir>               一次性 DSH_HOME 的落地根（默认 <os.tmpdir()>/dsh-skill-verify）
  --profile <name>                一次性 profile 名（默认 skill-verify；不接受 desktop）
  --from-default-profile <name>   组合起点（默认 web）
  --dsh-cli <path>                显式指定 CLI 入口
  --keep                          保留一次性目录
  --timeout-ms <n>                单次 CLI 调用超时（默认 60000）
  -h, --help / -V, --version

退出码: 0 通过 / 1 断言不通过 / 2 用法错误 / 3 前提不成立
`)
}

let parsed
try {
  parsed = parseArgs({
    options: {
      'plugin-dir': { type: 'string' },
      patch: { type: 'string', multiple: true, default: [] },
      'expect-row': { type: 'string', multiple: true, default: [] },
      'expect-config': { type: 'string' },
      'work-root': { type: 'string' },
      profile: { type: 'string', default: 'skill-verify' },
      'from-default-profile': { type: 'string', default: 'web' },
      'dsh-cli': { type: 'string' },
      keep: { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '60000' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'V', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
} catch (error) {
  process.stderr.write(`${TOOL}: ${String(error?.message ?? error)}\n`)
  process.exitCode = 2
}

if (process.exitCode === undefined) {
  const values = parsed.values
  if (values.help) {
    help()
    process.exitCode = 0
  } else if (values.version) {
    process.stdout.write(`${TOOL} ${CONTRACT_VERSION}\n`)
    process.exitCode = 0
  } else {
    const timeoutMs = Number.parseInt(values['timeout-ms'], 10)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(`${TOOL}: --timeout-ms 需要一个正整数\n`)
      process.exitCode = 2
    } else if (values.profile === 'desktop') {
      problem('assembly.desktop-refused', 'error', '--profile desktop 由 Electron 应用独占，不接受。', {})
      emit({ tool: TOOL, contractVersion: CONTRACT_VERSION, assembly: null, problems, ok: false, next }, 2)
    } else {
      process.exitCode = main(values, timeoutMs)
    }
  }
}

function main(values, timeoutMs) {
  const io = defaultIo()
  const pluginDir = resolve(values['plugin-dir'] ?? process.cwd())

  // --- 前提：Node + CLI ---------------------------------------------------------------
  const node = locateNode(io, undefined, { timeoutMs })
  if (node === undefined) {
    problem('env.node-not-found', 'error', '没有可用的独立 Node（Electron 运行时不能当 node 用）。', {})
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
    return finish(values, null, 3)
  }
  const cli = locateCli(io, values['dsh-cli'], { nodePath: node.path, timeoutMs })
  if (cli.path === undefined) {
    problem('env.cli-not-found', 'error', '没找到可用的 dsh CLI 入口。', {
      explicitMissing: cli.explicitMissing ?? null,
      tried: cli.tried,
    })
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
    return finish(values, null, 3)
  }
  if (cli.verified === false) {
    problem('assembly.cli-unusable', 'error', 'CLI 存在但 --version 失败。', { path: cli.path })
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-cli <cli.js 绝对路径>`)
    return finish(values, null, 3)
  }

  // --- patch 解析 ---------------------------------------------------------------------
  let patchPaths = values.patch.map((p) => resolve(pluginDir, p))
  if (patchPaths.length === 0) {
    let declared
    try {
      declared = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).dsh?.bundle?.patch
    } catch {
      declared = undefined
    }
    if (declared !== undefined) patchPaths = (Array.isArray(declared) ? declared : [declared]).map((p) => resolve(pluginDir, p))
  }
  for (const patch of patchPaths) {
    if (!existsSync(patch)) {
      problem('assembly.patch-missing', 'error', `--patch 指向的文件不存在：${patch}`, { patch })
      next.push(`node "<skill-directory>/scripts/verify-assembly.mjs" --plugin-dir <包目录绝对路径> --patch <patch 绝对路径>`)
      return finish(values, null, 3)
    }
  }

  // --- 期望行（默认从 patch 浅扫描推导） ----------------------------------------------
  let expectRows = values['expect-row']
  if (expectRows.length === 0) {
    for (const patch of patchPaths) {
      for (const row of shallowScanPatch(readFileSync(patch, 'utf8')).rows) expectRows.push(row.id)
    }
  }
  const expectConfig = values['expect-config']

  // --- 一次性 DSH_HOME ---------------------------------------------------------------
  const workRoot = resolve(values['work-root'] ?? join(tmpdir(), 'dsh-skill-verify'))
  const scratchHome = join(workRoot, `${values.profile}-${process.pid}`)
  try {
    mkdirSync(scratchHome, { recursive: true })
  } catch (error) {
    problem('assembly.work-root-unwritable', 'error', '一次性目录建不起来。', { path: scratchHome, message: String(error?.message ?? error) })
    next.push(`node "<skill-directory>/scripts/verify-assembly.mjs" --work-root <可写目录绝对路径>`)
    return finish(values, null, 3)
  }
  const profileDir = join(scratchHome, 'profiles', values.profile)
  if (existsSync(profileDir)) {
    problem('assembly.profile-exists', 'warn', '一次性目录里已存在同名 profile（上一次 --keep 的残留）。', { profile: values.profile })
  }

  const invocation = cliInvocation(io, cli, node.path)
  const env = { ...invocation.env, DSH_HOME: scratchHome }
  const run = (args) => probe(io, invocation.cmd, [...invocation.args, ...args], { timeoutMs, env })

  const summary = {
    cli: { path: cli.path, kind: cli.kind, version: cli.version ?? null },
    node: { path: node.path, version: node.version },
    profile: values.profile,
    workRoot: scratchHome,
    patch: patchPaths,
    expectRow: expectRows,
    expectConfig: expectConfig ?? null,
    layer: false,
    rows: [],
    configKeys: { before: [], after: [] },
  }

  let primary
  let baseline
  try {
    if (expectConfig !== undefined) {
      // 两跑差分：先建 profile（不带 --patch），再打 overlay 跑一次。
      const initArgs = ['--profile', values.profile, '--dump-config']
      if (!existsSync(profileDir)) initArgs.splice(2, 0, '--from-default-profile', values['from-default-profile'])
      baseline = run(initArgs)
      if (baseline.status !== 0 && baseline.stdout.trim() === '') {
        problem('assembly.dump-failed', 'error', '不带 --patch 的 --dump-config 失败且没有可解析输出。', { exit: baseline.status, stderr: baseline.stderr.slice(0, 400) })
      }
      primary = run(['--profile', values.profile, ...patchArgs(patchPaths), '--dump-config'])
    } else {
      const args = ['--profile', values.profile]
      if (!existsSync(profileDir)) args.push('--from-default-profile', values['from-default-profile'])
      args.push(...patchArgs(patchPaths), '--dump-config')
      primary = run(args)
    }

    if (primary.status !== 0) {
      if (primary.stdout.trim() === '') {
        problem('assembly.dump-failed', 'error', '--dump-config 非零退出且没有可解析的组合结果。', { exit: primary.status, stderr: primary.stderr.slice(0, 400) })
      } else {
        problem('assembly.dump-nonzero-with-output', 'warn', '--dump-config 非零退出但有输出（退出码可能来自与本次检查无关的既有诊断，不可当判据）。', { exit: primary.status })
      }
    }

    const dump = `${primary.stdout}\n${primary.stderr}`
    const heads = dump.split(/\r?\n/u).filter((line) => /^# == /u.test(line))
    summary.layer = heads.some((line) => patchPaths.some((p) => line.includes(p)))
    if (!summary.layer) {
      problem('assembly.layer-absent', 'error', '组合结果里没有出现带本次 patch 路径的层头。', { heads: heads.slice(0, 8) })
    }

    for (const id of expectRows) {
      const present = new RegExp(`^- id: ${escapeRegExp(id)}\\s*$`, 'mu').test(primary.stdout)
      summary.rows.push({ id, present })
      if (!present) problem('assembly.row-absent', 'error', `期望的行没有出现：${id}`, { id })
    }

    const unmatched = [...primary.stderr.matchAll(/patch: entry "([^"]+)" not found/gu)].map((m) => m[1])
    const unexpected = unmatched.filter((id) => !expectRows.includes(id) && id !== expectConfig)
    if (unexpected.length > 0) {
      problem('assembly.unexpected-unmatched-id', 'error', '出现期望外的 not found id。', { ids: unexpected })
    }

    if (expectConfig === undefined) {
      problem('assembly.config-not-asserted', 'info', '本次没做 config 断言（不给 --expect-config 就不会验证整体替换语义）。', {})
    } else {
      const before = configKeys(rowBlock(baseline?.stdout ?? '', expectConfig))
      const after = configKeys(rowBlock(primary.stdout, expectConfig))
      summary.configKeys = { before, after }
      if (rowBlock(baseline?.stdout ?? '', expectConfig) === undefined) {
        problem('assembly.expect-config-row-absent', 'error', `--expect-config 的 id 在起点组合里不存在：${expectConfig}`, { id: expectConfig })
      } else if (after.length === 0 || before.some((key) => after.includes(key))) {
        problem('assembly.config-merged-not-replaced', 'error', 'config 不是整体替换（键集合 A ∩ B 非空或 B 为空）。', { before, after })
      }
    }
  } finally {
    if (values.keep !== true) {
      try {
        rmSync(scratchHome, { recursive: true, force: true })
      } catch {
        // 有进程占着文件就留着，不掩盖主结果
      }
    } else {
      process.stderr.write(`${TOOL}: 一次性目录保留在 ${scratchHome}\n`)
    }
  }

  const ok = !problems.some((p) => p.severity === 'error')
  if (!ok) next.push(`node "<skill-directory>/scripts/verify-assembly.mjs" --plugin-dir <包目录绝对路径> --expect-config <行 id>`)
  return finish(values, summary, undefined)
}

function patchArgs(patchPaths) {
  return patchPaths.flatMap((p) => ['--patch', p])
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function finish(values, summary, forcedExit) {
  const ok = !problems.some((p) => p.severity === 'error')
  emit(
    {
      tool: TOOL,
      contractVersion: CONTRACT_VERSION,
      assembly: summary,
      problems,
      ok,
      next,
    },
    forcedExit ?? (ok ? 0 : 1),
  )
  return forcedExit ?? (ok ? 0 : 1)
}
