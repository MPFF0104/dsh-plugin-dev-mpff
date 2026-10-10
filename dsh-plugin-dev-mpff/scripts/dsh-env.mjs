// 工具 1：环境发现 → 机器可读报告。
// 不猜、不改、不装、不联网；只报「这台机器上 dsh 的可用入口与观测版本」。
// 契约：stdout 恒为单份 JSON；退出码 0 通过 / 2 用法错误 / 3 前提不成立（本工具不产生 1）。
//
// 子进程白名单：`<node> -v`、`where` / `which`、`reg query`、`<cli> --version`。
// `--no-exec` 下**不启动任何子进程**（PATH 与注册表候选被跳过，usable / verified 一律 null）。

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  defaultIo,
  hostPackageDir,
  locateCli,
  locateInstall,
  locateNode,
  probe,
  readProfileEnv,
  readRuntimeVersions,
  whichSync,
} from './lib/dsh-locate.mjs'

const TOOL = 'dsh-env'
const CONTRACT_VERSION = 1

const problems = []
const next = []

function problem(code, severity, message, detail) {
  problems.push({ code, severity, message, detail })
}

function emit(doc) {
  const pretty = JSON.stringify(doc, undefined, 2)
  process.stdout.write(`${Buffer.byteLength(pretty, 'utf8') > 4096 ? JSON.stringify(doc) : pretty}\n`)
}

function help() {
  process.stdout.write(`dsh-env — dsh 环境发现（零依赖 ESM）

用法: node "<skill-directory>/scripts/dsh-env.mjs" [options]

选项:
  --dsh-cli <path>        显式指定 CLI 入口（给了就只验证它，其余候选只为诊断）
  --dsh-install <dir>     显式指定安装根
  --node <path>           显式指定独立 Node 可执行文件
  --host-package-dir <dir> 显式指定宿主包目录（@deepseek-ai）
  --no-exec               只列候选与存在性，不执行任何候选
  --list-packages         附带宿主包清单
  --timeout-ms <n>        单个候选探测的超时（默认 10000）
  -h, --help              显示本帮助
  -V, --version           显示契约版本

退出码: 0 通过 / 2 用法错误 / 3 前提不成立
stdout 恒为单份 JSON；stderr 是给人看的诊断。
`)
}

let parsed
try {
  parsed = parseArgs({
    options: {
      'dsh-cli': { type: 'string' },
      'dsh-install': { type: 'string' },
      node: { type: 'string' },
      'host-package-dir': { type: 'string' },
      'no-exec': { type: 'boolean', default: false },
      'list-packages': { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '10000' },
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
    } else {
      process.exitCode = main({ ...values, timeoutMs })
    }
  }
}

function main(values) {
  const io = defaultIo()
  const noExec = values['no-exec'] === true
  const options = { dshInstall: values['dsh-install'], noExec, timeoutMs: values.timeoutMs }

  const install = locateInstall(io, values['dsh-install'], { noExec })
  const nodeTried = []
  const node = locateNode(io, values.node, { ...options, install, collect: nodeTried })
  const cli = locateCli(io, values['dsh-cli'], { ...options, install })

  for (const entry of [...(node?.tried ?? []), ...(cli?.tried ?? [])]) {
    if (entry.timedOut === true) {
      problem('env.probe-timeout', 'warn', '某个候选探测超时，按不可用处理。', { path: entry.path, source: entry.source })
    }
  }

  // --- Node 下限：只从本机 <dsh-install>/resources/runtime/versions.json 现读 -------------
  const lowerBound = readRuntimeVersions(io, install?.path)
  if (node === undefined) {
    problem('env.node-not-found', 'error', '所有 Node 候选都不可用。', { tried: nodeTried })
  } else {
    if (node.electron === true) {
      problem('env.node-is-electron', 'error', '唯一可用候选是 Electron 运行时，不能当独立 Node 用。', { path: node.path })
    }
    if (lowerBound === undefined) {
      problem('env.node-lower-bound-unknown', 'warn', '读不到本机 versions.json，跳过 Node 下限判定。', {
        expected: '<dsh-install>/resources/runtime/versions.json',
      })
    } else if (node.version !== null && compareVersions(node.version, lowerBound) < 0) {
      problem('env.node-too-old', 'error', `Node 低于随发行版下限 ${lowerBound}。`, { path: node.path, version: node.version })
    }
  }

  // --- CLI -------------------------------------------------------------------------------
  if (cli.path === undefined) {
    problem('env.cli-not-found', 'error', '没找到可用的 dsh CLI 入口。', {
      explicitMissing: cli.explicitMissing ?? null,
      tried: cli.tried,
      noExecHint: noExec === true
        ? '--no-exec 下不启动任何子进程 ⇒ PATH shim 与注册表候选被跳过；用 --dsh-install 显式给安装根。'
        : null,
    })
  } else if (noExec === true) {
    problem('env.cli-unverified', 'warn', '--no-exec 下无法验证 CLI 入口。', { path: cli.path })
  }

  // --- PATH 上的 shim（存在但不可用是常态） ------------------------------------------------
  const shimPath = whichSync(io, 'dsh', { noExec })
  const shim = { path: shimPath ?? null, exists: shimPath !== undefined, usable: null, reason: null }
  if (shimPath !== undefined && noExec !== true) {
    const out = probe(io, shimPath, ['--version'], { timeoutMs: values.timeoutMs })
    const version = (out.stdout ?? '').split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0]
    shim.usable = out.status === 0 && /^\d+\.\d+\.\d+/u.test(version ?? '')
    if (!shim.usable) {
      shim.reason = (out.stderr ?? '').split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0] ?? `exit=${out.status}`
      problem('env.shim-broken', 'warn', 'PATH 上的 dsh shim 存在但执行失败。', { path: shimPath, reason: shim.reason })
    }
  }

  // --- profile 变量（直读；缺席是合法状态） ------------------------------------------------
  const home = readProfileEnv(io)
  if (home.profile === null || home.profileDir === null) {
    problem('env.profile-vars-absent', 'info', 'DSH_PROFILE / DSH_PROFILE_DIR 缺席；无 profile 启动是合法状态。', home)
  }

  // --- 宿主包目录 -------------------------------------------------------------------------
  const packageDir = values['host-package-dir'] ?? hostPackageDir(io, cli.path)
  const packages = []
  if (packageDir === undefined) {
    problem('env.host-package-dir-unknown', 'warn', '宿主包目录不可得；注入名检查与包清单会因此降级。', {
      cliPath: cli.path ?? null,
    })
  } else if (values['list-packages'] === true) {
    for (const entry of safeReaddir(io, packageDir)) {
      const manifest = join(packageDir, entry, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8'))
        packages.push({
          name: json.name ?? entry,
          version: json.version ?? null,
          hasClient: json.dsh?.client !== undefined,
          hasBundlePatch: json.dsh?.bundle?.patch !== undefined,
        })
      } catch {
        // 读不动或不是包：跳过（不是本工具要报的失败）
      }
    }
  }

  const ok = !problems.some((p) => p.severity === 'error')
  if (!ok) {
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-cli <cli.js 绝对路径>`)
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-install <安装根绝对路径>`)
  } else if (cli.verified === null) {
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
  }

  emit({
    tool: TOOL,
    contractVersion: CONTRACT_VERSION,
    node: node === undefined
      ? { path: null, version: null, electron: false, source: null, usable: false }
      : {
          path: node.path,
          version: node.version,
          electron: node.electron === true,
          source: node.source,
          usable: noExec === true ? null : true,
        },
    dsh: {
      cliPath: cli.path ?? null,
      cliKind: cli.kind ?? null,
      version: cli.version ?? null,
      verified: noExec === true ? null : cli.verified ?? null,
      installRoot: install?.path ?? null,
      shim,
    },
    home,
    host: { packageDir: packageDir ?? null, packageCount: packages.length, packages },
    problems,
    ok,
    next,
  })

  return ok ? 0 : 3
}

function safeReaddir(io, dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** 比较 `v1.2.3` 形态的版本号（忽略预发布后缀，够用即止）。 */
function compareVersions(a, b) {
  const parse = (v) => (v ?? '').replace(/^v/u, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  }
  return 0
}
