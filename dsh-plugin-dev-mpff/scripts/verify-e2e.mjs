// 工具 4：端到端验证闭环（E0–E12）——证明「装上了 / mount 了 / 卸干净了」。
// 唯一允许 `plugin add` / `remove` 的脚本，且只对**自建的一次性 profile** 与
// `--work-root` 下的**副本**动作；绝不碰任何既有 profile，绝不就地安装。
//
// 契约：stdout 恒为单份 JSON；退出码 0 通过 / 1 断言不通过 / 2 用法错误 / 3 前提不成立。
//
// 子进程白名单（本脚本**直接**启动的子进程；白名单之外一律不启动）：
//   `<node> -v`、`where node` / `which node`、`where dsh` / `which dsh`、`reg query <hive> /s`（定位库）
//   `<node> --check <副本里的 .js>`
//   `<cli> --version`
//   `<cli> --profile <p> --from-default-profile <name> --dump-default-config`
//   `<cli> --profile <p> --dump-config [--patch <file>]`
//   `<cli> --profile <p> --help [--patch <file>]`
//   `<cli> plugin --profile <p> add <副本绝对路径>`      ← 只有本脚本有这个口子
//   `<cli> plugin --profile <p> remove <包名>`           ← 只有本脚本有这个口子
// 一律禁止：plugin update、allow-version、revoke-version、npm/pnpm 的任何动词、
// 上表之外的任何安装/卸载、`--profile desktop`、联网、改 PATH shim、改宿主安装目录。
// 注：宿主 `plugin add` 内部自己会调 pnpm —— 那不属于本脚本启动的子进程，不违反白名单。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { cliInvocation, defaultIo, hostPackageDir, locateCli, locateNode, probe } from './lib/dsh-locate.mjs'
import { rowBlock } from './lib/skill-scan.mjs'

const TOOL = 'verify-e2e'
const CONTRACT_VERSION = 1

// --- 夹具钉死的常量（与 examples/hello-plugin/ 共享，改一处必须同步） ----------------
const PLUGIN_NAME = 'dsh-hello-plugin'
const ROW_ID = 'hello-plugin'
const MARK = '[hello-plugin]'
const CONFIG_FULL = `${MARK} config = {"greeting":"hello","nested":{"x":1,"y":2}}`
const CONFIG_PATCHED = `${MARK} config = {"nested":{"x":9}}`
const PROFILE = 'e2e'
const DEFAULT_FROM_PROFILE = 'web'
const OVERLAY_NAME = 'overlay-one-key.yml'

/** 顺序本身是契约：E12 必须在 E10 的 remove 之前跑。 */
const STEP_PLAN = ['E0', 'E1', 'E1b', 'E1c', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E12', 'E8', 'E9', 'E10', 'E11']

const steps = []
const problems = []
const next = []

function step(id, title, ok, detail) {
  steps.push({ id, title, ok, detail })
  process.stderr.write(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}\n`)
  if (detail) process.stderr.write(`      ${detail}\n`)
}

function problem(code, severity, message, detail) {
  problems.push({ code, severity, message, detail })
}

function emit() {
  const ok = !problems.some((p) => p.severity === 'error')
  const doc = {
    tool: TOOL,
    contractVersion: CONTRACT_VERSION,
    steps,
    stepPlan: STEP_PLAN,
    problems,
    ok,
    next,
  }
  const pretty = JSON.stringify(doc, undefined, 2)
  process.stdout.write(`${Buffer.byteLength(pretty, 'utf8') > 4096 ? JSON.stringify(doc) : pretty}\n`)
  return ok
}

function help() {
  process.stdout.write(`verify-e2e — dsh 端到端验证闭环（E0–E12，零依赖 ESM）

用法: node "<skill-directory>/scripts/verify-e2e.mjs" [options]

选项:
  --dsh-cli <path>    显式指定 dsh CLI 入口（默认按候选链探测）
  --work-root <dir>   一次性 DSH_HOME 的落地根（默认 <os.tmpdir()>/dsh-skill-e2e）
  --keep              保留一次性目录，便于人工检查
  --timeout-ms <n>    单次 CLI 调用的超时（默认 120000）
  -h, --help / -V, --version

退出码: 0 通过 / 1 断言不通过 / 2 用法错误 / 3 前提不成立
stdout 恒为单份 JSON；stderr 是给人看的进度与诊断。

子进程白名单：<node> -v、where/which、reg query、node --check、<cli> --version、
<cli> --profile <p> …（dump-config / dump-default-config / help）、
<cli> plugin --profile <p> add|remove <副本绝对路径或包名>。
一律禁止：plugin update、allow-version、revoke-version、npm/pnpm 的任何动词、--profile desktop、联网。
`)
}

let parsed
try {
  parsed = parseArgs({
    options: {
      'dsh-cli': { type: 'string' },
      'work-root': { type: 'string' },
      keep: { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '120000' },
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
      process.exitCode = main(values, timeoutMs)
    }
  }
}

function main(values, timeoutMs) {
  const io = defaultIo()
  const skillDir = resolve(import.meta.dirname, '..')
  const fixtureDir = join(skillDir, 'examples', 'hello-plugin')

  const node = locateNode(io, undefined, { timeoutMs })
  if (node === undefined) {
    problem('e2e.node-not-found', 'error', '没有可用的独立 Node（Electron 运行时不能当 node 用）。', {})
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
    emit()
    return 3
  }
  const cli = locateCli(io, values['dsh-cli'], { nodePath: node.path, timeoutMs })
  if (cli.path === undefined) {
    problem('e2e.cli-not-found', 'error', '没找到可用的 dsh CLI 入口。', {
      explicitMissing: cli.explicitMissing ?? null,
      tried: cli.tried,
    })
    next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
    emit()
    return 3
  }
  if (cli.verified === false) {
    problem('e2e.cli-unusable', 'error', 'CLI 存在但 --version 失败。', { path: cli.path })
    next.push(`node "<skill-directory>/scripts/verify-e2e.mjs" --dsh-cli <cli.js 绝对路径>`)
    emit()
    return 3
  }
  if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
    problem('e2e.fixture-missing', 'error', '夹具不存在：examples/hello-plugin/ 必须随 skill 分发。', { fixtureDir })
    emit()
    return 3
  }

  const workRoot = resolve(values['work-root'] ?? join(tmpdir(), 'dsh-skill-e2e'))
  const scratch = join(workRoot, `${PROFILE}-${process.pid}`)
  const fixtureCopy = join(scratch, 'fixture', PLUGIN_NAME)
  const overlayFile = join(scratch, OVERLAY_NAME)
  const profileDir = join(scratch, 'profiles', PROFILE)

  let exit = 1
  try {
    mkdirSync(scratch, { recursive: true })
    // V1：先复制到 --work-root 的**真目录**，再从副本安装（绝不就地 link:）。
    cpSync(fixtureDir, fixtureCopy, { recursive: true })
    // V2：overlay 是脚本产物，由脚本生成到 --work-root（不进仓库）。
    writeFileSync(overlayFile, ['- id: hello-plugin', '  config:', '    nested:', '      x: 9', ''].join('\n'))

    const invocation = cliInvocation(io, cli, node.path)
    const env = { ...invocation.env, DSH_HOME: scratch }
    const run = (args) => probe(io, invocation.cmd, [...invocation.args, ...args], { timeoutMs, env })
    const combined = (result) => `${result.stdout}\n${result.stderr}`

    process.stderr.write(`\n${TOOL}  (node ${node.version} via ${node.source})\n`)
    process.stderr.write(`  CLI      : ${cli.path}\n  version  : ${cli.version ?? '(未验证)'}\n  Scratch  : ${scratch}\n\n`)

    // E0
    step('E0', 'CLI 入口可用，--version 是单行纯 semver', cli.verified === true, `--version='${cli.version ?? ''}'`)

    // E1
    const init = run(['--profile', PROFILE, '--from-default-profile', DEFAULT_FROM_PROFILE, '--dump-default-config'])
    const expectedFiles = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']
    const present = expectedFiles.filter((f) => existsSync(join(profileDir, f)))
    step('E1', `自建 profile：--from-default-profile ${DEFAULT_FROM_PROFILE} 落 4 个文件`,
      init.status === 0 && present.length === expectedFiles.length,
      `exit=${init.status}；落盘 ${present.length}/${expectedFiles.length}：${present.join(', ')}`)

    // E1b
    const again = run(['--profile', PROFILE, '--from-default-profile', DEFAULT_FROM_PROFILE, '--dump-default-config'])
    step('E1b', '已存在的 profile 拒绝再初始化（exit 1，不覆盖）',
      again.status === 1 && combined(again).includes('already exists'),
      `exit=${again.status}；含 'already exists'=${combined(again).includes('already exists')}`)

    // E1c
    const bad = run(['--profile', 'zzz-nope', '--from-default-profile', '__nope__', '--dump-default-config'])
    step('E1c', '未知模板名列出可选值（exit 1）',
      bad.status === 1 && combined(bad).includes('unknown default profile') && combined(bad).includes(`"${DEFAULT_FROM_PROFILE}"`),
      `exit=${bad.status}；含模板清单=${combined(bad).includes('expected one of')}`)

    // E2
    const add = run(['plugin', '--profile', PROFILE, 'add', fixtureCopy])
    let inBundles = false
    try {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      inBundles = (manifest.dsh?.profile?.bundles ?? []).includes(PLUGIN_NAME)
    } catch {
      inBundles = false
    }
    step('E2', 'plugin add：本地副本装得进去，bundles 自动追加',
      add.status === 0 && inBundles, `exit=${add.status}；bundles 含 ${PLUGIN_NAME}=${inBundles}`)

    // E3
    const dump = run(['--profile', PROFILE, '--dump-config'])
    const hasHead = combined(dump).includes(`# == ${PLUGIN_NAME}`)
    const hasRow = new RegExp(`^- id: ${ROW_ID}\\s*$`, 'mu').test(dump.stdout)
    step('E3', '--dump-config 出现层头 # == <包名> 与 - id: <行 id>',
      dump.status === 0 && hasHead && hasRow, `exit=${dump.status}；层头=${hasHead}；行=${hasRow}`)

    // E4
    const dumpPatched = run(['--profile', PROFILE, '--dump-config', '--patch', overlayFile])
    const block = rowBlock(dumpPatched.stdout, ROW_ID) ?? ''
    const replaced = block.includes('nested:') && block.includes('x: 9') && !block.includes('greeting')
    step('E4', 'patch 的 config = 整体替换（组合层：只剩 overlay 写的那份）', replaced,
      `行块 = ${block.trim().replace(/\n/gu, ' | ')}`)

    // E5
    const bootPatched = run(['--profile', PROFILE, '--patch', overlayFile, '--help'])
    const bootReplaced = combined(bootPatched).includes(CONFIG_PATCHED)
    step('E5', 'patch 的 config = 整体替换（真实 boot：apply() 收到的 config）', bootReplaced,
      `apply() 收到的 config 行 = ${(combined(bootPatched).split(/\r?\n/u).find((l) => l.includes(`${MARK} config`)) ?? '(缺)').trim()}`)

    // E6
    const bootPlain = run(['--profile', PROFILE, '--help'])
    const mounts = combined(bootPlain).includes(`${MARK} apply() ran`)
    const fullConfig = combined(bootPlain).includes(CONFIG_FULL)
    step('E6', '--help 真的 mount：插件 apply() 的标记出现在输出里', mounts && fullConfig,
      `apply() 标记=${mounts}；未打补丁的 config 完整=${fullConfig}`)

    // E7
    const dumpsMount = combined(dump).includes(`${MARK} apply() ran`)
    step('E7', '--dump-config 不 mount（与 E6 构成一对可区分信号）', !dumpsMount,
      `dump 输出里出现 apply() 标记=${dumpsMount}（期望 false）`)

    // E12
    const misordered = run(['--profile', PROFILE, '--help', '--patch', overlayFile])
    const overlayIgnored = combined(misordered).includes(CONFIG_FULL)
    step('E12', '反向断言：--patch 写在 app 参数之后会被静默忽略（exit 0，无警告）',
      misordered.status === 0 && overlayIgnored,
      `exit=${misordered.status}；overlay 未生效（config 仍是完整原始值）=${overlayIgnored}`)

    // E8
    const packageDir = hostPackageDir(io, cli.path)
    const clientPackages = []
    if (packageDir !== undefined) {
      for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifest = join(packageDir, entry.name, 'package.json')
        if (!existsSync(manifest)) continue
        try {
          const json = JSON.parse(readFileSync(manifest, 'utf8'))
          if (json.dsh?.client) clientPackages.push(json.name)
        } catch {
          // 不是包或读不动：跳过，不算失败
        }
      }
    }
    step('E8', '宿主版本可读 + 真实注入名集合非空', clientPackages.length > 0,
      `宿主版本='${cli.version ?? ''}'；声明 dsh.client 的宿主包 = ${clientPackages.length} 个（真实注入名集合）`)

    // E9（V4：副本里的每个 .js，先 statSync 再 --check；V5：前端半边静态断言）
    const syntaxResults = []
    let manifestOk = true
    let patchOk = false
    let clientHalf = false
    try {
      const manifest = JSON.parse(readFileSync(join(fixtureCopy, 'package.json'), 'utf8'))
      patchOk = typeof manifest.dsh?.bundle?.patch === 'string' && existsSync(join(fixtureCopy, manifest.dsh.bundle.patch))
      clientHalf = manifest.exports?.['./client'] === './client.js' && existsSync(join(fixtureCopy, 'client.js'))
    } catch {
      manifestOk = false
    }
    const jsFiles = collectJs(fixtureCopy)
    for (const rel of jsFiles) {
      const abs = join(fixtureCopy, rel)
      if (!existsSync(abs)) {
        syntaxResults.push({ rel, exists: false, ok: false })
        continue
      }
      const check = spawnSync(node.path, ['--check', abs], { encoding: 'utf8' })
      syntaxResults.push({ rel, exists: true, ok: check.status === 0 })
    }
    step('E9', '静态自检（副本面）：每个 .js 过 node --check / JSON 合法 / patch 文件存在 / 前端半边齐全',
      manifestOk && patchOk && clientHalf && syntaxResults.every((r) => r.ok),
      `node --check=${syntaxResults.map((r) => `${r.rel}:${r.ok}`).join(' ')}；JSON=${manifestOk}；patch 存在=${patchOk}；exports['./client']+client.js=${clientHalf}`)

    // E10
    const remove = run(['plugin', '--profile', PROFILE, 'remove', PLUGIN_NAME])
    const dumpAfter = run(['--profile', PROFILE, '--dump-config'])
    const residue = dumpAfter.stdout.split(/\r?\n/u).filter((line) => line.includes('hello')).length
    step('E10', 'remove 后组合层零残留（行与层头都不再出现；文件系统层 junction 残留不在断言面）',
      remove.status === 0 && residue === 0,
      `remove exit=${remove.status}；dump 里提到 hello 的行数=${residue}`)

    // E11
    const dangling = run(['--profile', PROFILE, '--dump-config', '--patch', overlayFile])
    const loud = combined(dangling).includes(`patch: entry "${ROW_ID}" not found`)
    step('E11', '卸载后引用已删 id：stderr 大声报 not found（注意 exit 0）',
      dangling.status === 0 && loud,
      `exit=${dangling.status}（期望 0）；含 not found=${loud}`)

    // V6：计划表逐位相等（删一个 step / 改名 / 调序都大声失败）
    const actualPlan = steps.map((s) => s.id)
    const planEqual = actualPlan.length === STEP_PLAN.length && actualPlan.every((id, i) => id === STEP_PLAN[i])
    if (!planEqual) {
      problem('e2e.step-plan-mismatch', 'error', '实际步骤序列与脚本内 STEP_PLAN 不逐位相等。', { actual: actualPlan, plan: STEP_PLAN })
    }

    const failed = steps.filter((s) => !s.ok)
    for (const s of failed) {
      problem(`e2e.step-${s.id.toLowerCase()}-failed`, 'error', `${s.id} 未通过：${s.title}`, {
        detail: s.detail,
        signalTable: '失败信号表见 `references/verification-loop.md`',
      })
    }
    if (failed.length > 0 || !planEqual) {
      next.push(`node "<skill-directory>/scripts/verify-e2e.mjs" --keep`)
      next.push(`node "<skill-directory>/scripts/dsh-env.mjs"`)
    }
    exit = emit() ? 0 : 1
    process.stderr.write(`\n${exit === 0 ? 'PASS' : 'FAIL'} ${steps.filter((s) => s.ok).length}/${steps.length}\n`)
  } catch (error) {
    problem('e2e.unexpected', 'error', '脚本自身抛出异常。', { message: String(error?.message ?? error) })
    exit = emit() ? 0 : 1
  } finally {
    if (values.keep !== true) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        // 有进程占着文件就留着，不掩盖主结果
      }
    } else {
      process.stderr.write(`\n一次性目录保留在：${scratch}\n`)
    }
  }
  return exit
}

function collectJs(root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else if (entry.name.endsWith('.js')) out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}
