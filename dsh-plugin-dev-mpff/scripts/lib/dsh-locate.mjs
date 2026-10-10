// 共用库 1：CLI / Node / <dsh-install> / 宿主包目录 / profile 变量的定位。
// 纯函数 + 可注入接缝（io），零依赖、零写入、不联网。
// 「存在 ≠ 可用」：候选必须真跑一次（`-v` / `--version`）才算命中。

import { spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** 宿主 CLI 相对安装根的路径（单一真源）。 */
export const REL_CLI = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
/** 随发行版 Node 相对安装根的路径（单一真源，Windows 加 `.exe`）。 */
export const REL_NODE_RUNTIME = 'resources/runtime/primary-runtime/dependencies/node/bin/node'
/** 安装根下的 Electron 可执行文件名（Electron-as-node 通道用）。 */
export const ELECTRON_EXE = 'DeepSeek Harness.exe'

/** 默认 io 接缝（生产路径；测试一律传假 io，不改 process 全局）。 */
export function defaultIo() {
  return {
    platform: process.platform,
    env: process.env,
    versions: process.versions,
    execPath: process.execPath,
    fs: nodeFs,
    now: () => Date.now(),
    run(cmd, args, opts = {}) {
      // `.cmd` / `.bat` 在 Windows 上必须经 shell 启动；用单条命令行避免 DEP0190。
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(cmd)
      const quote = (value) => (/[ \t]/u.test(value) ? `"${value}"` : value)
      const command = useShell ? [quote(cmd), ...args.map(quote)].join(' ') : cmd
      const child = spawnSync(command, useShell ? [] : args, {
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 10000,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
        shell: useShell,
      })
      return {
        status: child.status,
        stdout: child.stdout ?? '',
        stderr: child.stderr ?? '',
        timedOut: child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM',
      }
    },
  }
}

/** 统一的子进程探针（永不抛出；超时与启动失败都落成字段）。 */
export function probe(io, cmd, args, opts = {}) {
  try {
    const result = io.run(cmd, args, opts)
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut === true,
    }
  } catch (error) {
    return { status: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false }
  }
}

function exists(io, path) {
  try {
    return io.fs.existsSync(path)
  } catch {
    return false
  }
}

function isDirectory(io, path) {
  try {
    return io.fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

function firstLine(text) {
  return (text ?? '').split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0]
}

/**
 * PATH 上的可执行文件（按平台选 `where` / `which`，取输出第一行）。
 * `--no-exec` 下不启动任何子进程 ⇒ 直接返回 undefined。
 */
export function whichSync(io, name, options = {}) {
  if (options.noExec === true) return undefined
  const cmd = io.platform === 'win32' ? 'where' : 'which'
  const out = probe(io, cmd, [name], { timeoutMs: 10000 })
  if (out.status !== 0) return undefined
  return firstLine(out.stdout)
}

/** `reg query <hive> /s` 输出的纯解析（供单测，不真跑 `reg`）。 */
export function parseUninstallEntries(text) {
  const entries = []
  let current
  for (const line of (text ?? '').split(/\r?\n/u)) {
    if (/^HKEY_/u.test(line)) {
      if (current) entries.push(current)
      current = { key: line.trim(), displayName: undefined, installLocation: undefined }
      continue
    }
    if (!current) continue
    const display = /^\s*DisplayName\s+REG_SZ\s+(.*)$/u.exec(line)
    if (display) current.displayName = display[1].trim()
    const install = /^\s*InstallLocation\s+REG_SZ\s+(.*)$/u.exec(line)
    if (install) current.installLocation = install[1].trim()
  }
  if (current) entries.push(current)
  return entries
}

const UNINSTALL_HIVES = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** 从一个已知路径向上反推安装根（找到名为 `resources` 的祖先）。 */
export function inferInstallFromPath(io, knownPath) {
  if (!knownPath) return undefined
  let up = dirname(resolve(knownPath))
  while (up && up !== dirname(up)) {
    if (up.split(/[\\/]/u).pop() === 'resources') return dirname(up)
    up = dirname(up)
  }
  return undefined
}

/**
 * `<dsh-install>` 定位。候选链（顺序即契约）：
 * ① `--dsh-install`；② Windows 注册表 Uninstall 项（`DisplayName` 模糊匹配）；
 * ③ 从任一 CLI / Node 候选路径反推；④ PATH shim 所在目录向上反推；⑤ 全不可用 ⇒ undefined。
 */
export function locateInstall(io, explicit, options = {}) {
  if (explicit !== undefined && isDirectory(io, explicit)) return { path: resolve(explicit), source: 'explicit' }

  if (io.platform === 'win32' && options.noExec !== true) {
    for (const hive of UNINSTALL_HIVES) {
      const out = probe(io, 'reg', ['query', hive, '/s'], { timeoutMs: 20000 })
      if (out.status !== 0) continue
      for (const entry of parseUninstallEntries(out.stdout)) {
        if (!entry.installLocation) continue
        if (!(entry.displayName ?? '').includes('DeepSeek Harness')) continue
        if (isDirectory(io, entry.installLocation)) {
          return { path: resolve(entry.installLocation), source: 'registry' }
        }
      }
    }
  }

  const seeds = [whichSync(io, 'dsh', options), whichSync(io, 'node', options)]
  for (const seed of seeds) {
    const inferred = inferInstallFromPath(io, seed)
    if (inferred && isDirectory(io, inferred)) return { path: inferred, source: 'reverse' }
  }

  return undefined
}

function nodeFileName(io) {
  return io.platform === 'win32' ? 'node.exe' : 'node'
}

function nodeShimName(io) {
  return io.platform === 'win32' ? 'node.cmd' : 'node'
}

/**
 * Node 定位。候选链（顺序即契约）：
 * ① `--node`；② `io.execPath`（**仅当**不是 Electron 运行时）；③ PATH 上的 `node`；
 * ④ `<dsh-install>/resources/runtime/primary-runtime/dependencies/node/bin/node{.exe}`；
 * ⑤ `<dsh-install>/resources/runtime/bin/node{.cmd}`；⑥ 全不可用 ⇒ undefined。
 */
export function locateNode(io, explicit, options = {}) {
  const tried = []
  const candidates = []
  if (explicit !== undefined) candidates.push({ path: explicit, source: 'explicit', electron: false })
  if (io.versions?.electron === undefined) {
    candidates.push({ path: io.execPath, source: 'execPath', electron: false })
  }
  const onPath = whichSync(io, 'node', options)
  if (onPath) candidates.push({ path: onPath, source: 'path', electron: false })

  const install = options.install ?? locateInstall(io, options.dshInstall, options)
  if (install) {
    candidates.push({ path: join(install.path, `${REL_NODE_RUNTIME}${io.platform === 'win32' ? '.exe' : ''}`), source: 'install-runtime', electron: false })
    candidates.push({ path: join(install.path, 'resources', 'runtime', 'bin', nodeShimName(io)), source: 'install-shim', electron: false })
  }

  for (const candidate of candidates) {
    if (!candidate.path || !exists(io, candidate.path)) {
      tried.push({ path: candidate.path ?? null, source: candidate.source, exists: false, usable: false })
      continue
    }
    if (options.noExec === true) {
      // 只列候选与存在性：不执行任何候选，usable 一律 null。
      tried.push({ path: candidate.path, source: candidate.source, exists: true, usable: null, version: null })
      if (Array.isArray(options.collect)) options.collect.push(...tried)
      return { path: candidate.path, version: null, source: candidate.source, electron: candidate.electron, tried }
    }
    const out = probe(io, candidate.path, ['-v'], { timeoutMs: options.timeoutMs ?? 20000 })
    const version = firstLine(out.stdout)
    const usable = out.status === 0 && /^v\d+\.\d+\.\d+/u.test(version ?? '')
    tried.push({ path: candidate.path, source: candidate.source, exists: true, usable, version: version ?? null, timedOut: out.timedOut })
    if (usable) return { path: candidate.path, version, source: candidate.source, electron: candidate.electron, tried }
  }
  if (Array.isArray(options.collect)) options.collect.push(...tried)
  return undefined
}

function cliKindOf(path) {
  if (/\.(cmd|bat|ps1|sh)$/iu.test(path)) return 'shim'
  if (/\.exe$/iu.test(path)) return 'exe'
  return 'js'
}

function verifyCli(io, record, nodePath, options) {
  if (options.noExec === true) return { verified: null, version: null, timedOut: false }
  if (record.kind === 'js' && !nodePath) return { verified: false, version: null, timedOut: false }
  const invocation = cliInvocation(io, record, nodePath)
  const out = probe(io, invocation.cmd, [...invocation.args, '--version'], {
    timeoutMs: options.timeoutMs ?? 20000,
    env: invocation.env,
  })
  const version = firstLine(out.stdout)
  const ok = out.status === 0 && /^\d+\.\d+\.\d+/u.test(version ?? '')
  return { verified: ok, version: ok ? version : null, timedOut: out.timedOut }
}

/** 把 CLI 记录翻译成一次可跑调用（`js` 用 node，`exe` 走 Electron-as-node 通道）。 */
export function cliInvocation(io, record, nodePath) {
  if (record.kind === 'exe') {
    return {
      cmd: record.path,
      args: ['--expose-internals', record.jsPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  if (record.kind === 'js') return { cmd: nodePath, args: [record.path], env: {} }
  return { cmd: record.path, args: [], env: {} }
}

/**
 * CLI 定位。候选链（顺序即契约）：
 * ① `--dsh-cli`（**指了路却不存在 ⇒ `explicitMissing`，不回退自动探测**）；
 * ② PATH 上的 `dsh`；③ `<dsh-install>/resources/app/<REL_CLI>`；
 * ④ Electron-as-node 通道；⑤ `<dsh-install>/resources/app.asar/<REL_CLI>`；
 * ⑥ `<dsh-install>/resources/app.asar.unpacked/<REL_CLI>`；
 * ⑦ 从 PATH shim 所在目录向上找 `resources/` 再试 `resources/app/<REL_CLI>`；
 * ⑧ 全不可用 ⇒ undefined。
 */
export function locateCli(io, explicit, options = {}) {
  const tried = []
  const install = options.install ?? locateInstall(io, options.dshInstall, options)
  const shim = whichSync(io, 'dsh', options)

  const push = (candidate) => {
    const entry = {
      path: candidate.path,
      source: candidate.source,
      exists: exists(io, candidate.path),
    }
    tried.push(entry)
    return entry
  }

  if (explicit !== undefined) {
    if (!exists(io, explicit)) {
      return {
        path: undefined,
        kind: undefined,
        tried: [{ path: explicit, source: 'explicit', exists: false }],
        explicitMissing: explicit,
      }
    }
    // 显式传入只验证它：不可用也照实回报，不回退自动探测。
    const path = resolve(explicit)
    const kind = cliKindOf(path)
    const record = { path, kind, jsPath: undefined, source: 'explicit' }
    const nodePath = options.nodePath ?? locateNode(io, options.node, { noExec: options.noExec })?.path
    const check = verifyCli(io, record, nodePath, options)
    tried.push({ path, source: 'explicit', exists: true, usable: check.verified, version: check.version })
    return { ...record, version: check.version, verified: check.verified, tried, explicitMissing: undefined }
  }

  const candidates = []
  if (shim) candidates.push({ path: shim, source: 'path-shim', kind: 'shim' })
  if (install) {
    candidates.push({ path: join(install.path, 'resources', 'app', REL_CLI), source: 'install-app', kind: 'js' })
    candidates.push({
      path: join(install.path, ELECTRON_EXE),
      source: 'install-electron-as-node',
      kind: 'exe',
      jsPath: join(install.path, 'resources', 'app', REL_CLI),
    })
    candidates.push({ path: join(install.path, 'resources', 'app.asar', REL_CLI), source: 'install-asar', kind: 'js' })
    candidates.push({ path: join(install.path, 'resources', 'app.asar.unpacked', REL_CLI), source: 'install-asar-unpacked', kind: 'js' })
  }
  if (shim) {
    let up = dirname(resolve(shim))
    while (up && up !== dirname(up)) {
      if (up.split(/[\\/]/u).pop() === 'resources') {
        candidates.push({ path: join(up, 'app', REL_CLI), source: 'shim-reverse', kind: 'js' })
        break
      }
      up = dirname(up)
    }
  }

  const nodePath = options.nodePath ?? locateNode(io, options.node, { noExec: options.noExec, timeoutMs: options.timeoutMs })?.path
  for (const candidate of candidates) {
    const entry = push(candidate)
    if (!entry.exists) continue
    const kind = candidate.kind ?? cliKindOf(candidate.path)
    const full = { path: candidate.path, kind, jsPath: candidate.jsPath, source: candidate.source }
    const check = verifyCli(io, full, nodePath, options)
    entry.usable = check.verified
    entry.version = check.version
    entry.timedOut = check.timedOut
    if (check.verified === false) continue
    return { ...full, version: check.version, verified: check.verified, tried, explicitMissing: undefined }
  }
  if (Array.isArray(options.collect)) options.collect.push(...tried)
  return { path: undefined, kind: undefined, tried, explicitMissing: undefined }
}

/** 宿主包目录：从 CLI 路径向上找名为 `node_modules` 的目录，取其下的 `@deepseek-ai`。 */
export function hostPackageDir(io, cliPath) {
  if (!cliPath) return undefined
  let up = dirname(resolve(cliPath))
  while (up && up !== dirname(up)) {
    if (up.split(/[\\/]/u).pop() === 'node_modules') {
      const scoped = join(up, '@deepseek-ai')
      return isDirectory(io, scoped) ? scoped : undefined
    }
    up = dirname(up)
  }
  return undefined
}

/** 宿主注入的 profile 变量：直读，缺席一律 `null`（不猜默认值）。 */
export function readProfileEnv(io) {
  const env = io.env ?? {}
  return {
    dshHome: env.DSH_HOME ?? null,
    profile: env.DSH_PROFILE ?? null,
    profileDir: env.DSH_PROFILE_DIR ?? null,
    sessionId: env.DSH_SESSION_ID ?? null,
  }
}

/** 读 `<dsh-install>/resources/runtime/versions.json` 的 `node` 字段（下限的权威来源）。 */
export function readRuntimeVersions(io, installRoot) {
  if (!installRoot) return undefined
  const file = join(installRoot, 'resources', 'runtime', 'versions.json')
  if (!exists(io, file)) return undefined
  try {
    const parsed = JSON.parse(io.fs.readFileSync(file, 'utf8'))
    return typeof parsed?.node === 'string' ? parsed.node : undefined
  } catch {
    return undefined
  }
}

/** 路径是否落在某个根内（就地拒跑的判据面）。 */
export function isInside(root, target) {
  const a = resolve(root).replace(/[\\/]+$/u, '')
  const b = resolve(target).replace(/[\\/]+$/u, '')
  if (a === b) return true
  return b.startsWith(a + sep)
}
