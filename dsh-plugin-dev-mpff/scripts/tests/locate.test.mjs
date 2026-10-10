// 定位库的单测：候选顺序 / 「存在但不可用」/ 注册表解析 / 显式路径不回退 / Electron 判定。
//
// 运行命令（**显式文件列表**）：
//   node --test "<skill-directory>/scripts/tests/paths.test.mjs" "<skill-directory>/scripts/tests/locate.test.mjs"
//
// 纪律：一律用**假 io**（不改 process 全局）；只有「存在但不可用」那一路用真子进程。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REL_CLI,
  REL_NODE_RUNTIME,
  defaultIo,
  hostPackageDir,
  locateCli,
  locateInstall,
  locateNode,
  parseUninstallEntries,
  readProfileEnv,
} from '../lib/dsh-locate.mjs'

// 假路径一律拼接构造：成品文件里不许出现本机盘符路径。
// ROOT 走 resolve(sep, …)，与定位库里的 resolve() 结果同形（两端都用同一个值比较）。
const ROOT = resolve(sep, 'fake-root')
const p = (...parts) => join(ROOT, ...parts)

const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node'
const NODE_SHIM = process.platform === 'win32' ? 'node.cmd' : 'node'
const CLI_APP = p('resources', 'app', REL_CLI)
const CLI_ASAR = p('resources', 'app.asar', REL_CLI)
const CLI_ASAR_UNPACKED = p('resources', 'app.asar.unpacked', REL_CLI)
const NODE_RUNTIME = p(`${REL_NODE_RUNTIME}${process.platform === 'win32' ? '.exe' : ''}`)
const NODE_BIN_SHIM = p('resources', 'runtime', 'bin', NODE_SHIM)
const ELECTRON_EXE = p('DeepSeek Harness.exe')
const SHIM = p('runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')

/**
 * 假 io：`existing` 里的路径「存在」，`run` 决定子进程结果。
 * `dirs` 里的路径是目录（`statSync().isDirectory()` 为真）。
 */
function makeIo({ existing = [], dirs = [], run } = {}) {
  const files = new Set(existing)
  const directories = new Set(dirs.length > 0 ? dirs : existing)
  return {
    platform: process.platform,
    env: {},
    versions: { node: '24.0.0' },
    execPath: p('node', NODE_EXE),
    now: () => 0,
    fs: {
      existsSync: (path) => files.has(path),
      statSync: (path) => {
        if (!directories.has(path)) throw new Error('ENOENT')
        return { isDirectory: () => true }
      },
      readFileSync: () => {
        throw new Error('ENOENT')
      },
      readdirSync: () => [],
    },
    run: run ?? (() => ({ status: 1, stdout: '', stderr: '', timedOut: false })),
  }
}

const versionOk = (cmd, args) => {
  if (args.includes('-v')) return { status: 0, stdout: 'v24.0.0\n', stderr: '', timedOut: false }
  if (args.includes('--version')) return { status: 0, stdout: '0.2.0-rc.2\n', stderr: '', timedOut: false }
  return { status: 1, stdout: '', stderr: '', timedOut: false }
}

test('locateNode：显式 --node 命中（source = explicit）', () => {
  const explicit = p('other', NODE_EXE)
  const io = makeIo({ existing: [explicit], run: versionOk })
  const node = locateNode(io, explicit)
  assert.equal(node.source, 'explicit')
  assert.equal(node.path, explicit)
  assert.equal(node.version, 'v24.0.0')
})

test('locateNode：候选顺序 execPath → path → install-runtime → install-shim', () => {
  // 只有 execPath 可用
  const ioA = makeIo({ existing: [p('node', NODE_EXE)], run: versionOk })
  assert.equal(locateNode(ioA, undefined).source, 'execPath')

  // execPath 不存在 ⇒ 退到 PATH 上的 node
  const ioB = makeIo({ existing: [p('bin', NODE_EXE)], run: (cmd, args) => (cmd === 'where' || cmd === 'which' ? { status: 0, stdout: `${p('bin', NODE_EXE)}\n`, stderr: '', timedOut: false } : versionOk(cmd, args)) })
  assert.equal(locateNode(ioB, undefined).source, 'path')

  // PATH 上没有 node ⇒ 退到随发行版 Node（先 runtime/primary-runtime，再 runtime/bin）
  const ioC = makeIo({
    existing: [ROOT, NODE_RUNTIME, NODE_BIN_SHIM],
    dirs: [ROOT],
    run: (cmd, args) => (cmd === 'where' || cmd === 'which' ? { status: 1, stdout: '', stderr: '', timedOut: false } : versionOk(cmd, args)),
  })
  const nodeC = locateNode(ioC, undefined, { install: { path: ROOT, source: 'explicit' } })
  assert.equal(nodeC.source, 'install-runtime')
  assert.equal(nodeC.path, NODE_RUNTIME)
})

test('locateNode：全不可用 ⇒ undefined，且 tried 逐条留痕', () => {
  const io = makeIo({ existing: [] })
  assert.equal(locateNode(io, undefined), undefined)
  const tried = []
  locateNode(io, undefined, { collect: tried })
  assert.ok(tried.length >= 1)
  assert.ok(tried.every((entry) => entry.exists === false))
})

test('locateNode：Electron 运行时 ⇒ execPath 候选被跳过', () => {
  const pathNode = p('bin', NODE_EXE)
  const io = makeIo({
    existing: [pathNode],
    run: (cmd, args) => (cmd === 'where' || cmd === 'which'
      ? { status: 0, stdout: `${pathNode}\n`, stderr: '', timedOut: false }
      : versionOk(cmd, args)),
  })
  io.versions = { electron: '30.0.0', node: '20.0.0' }
  const tried = []
  const node = locateNode(io, undefined, { collect: tried })
  assert.ok(!tried.some((entry) => entry.source === 'execPath'), 'Electron 下不该出现 execPath 候选')
  assert.equal(node.source, 'path')
})

test('locateCli：候选顺序 path-shim → install-app → electron-as-node → app.asar → app.asar.unpacked → shim-reverse', () => {
  const io = makeIo({
    existing: [SHIM, CLI_APP, ELECTRON_EXE, CLI_ASAR, CLI_ASAR_UNPACKED, ROOT],
    dirs: [ROOT],
    run: (cmd, args) => {
      if (cmd === 'where' || cmd === 'which') return { status: 0, stdout: `${SHIM}\n`, stderr: '', timedOut: false }
      // PATH shim 存在但执行失败（实测常态）⇒ 必须继续走后面的候选
      if (cmd === SHIM) return { status: 1, stdout: '', stderr: 'shim broken', timedOut: false }
      return versionOk(cmd, args)
    },
  })
  const cli = locateCli(io, undefined, { install: { path: ROOT, source: 'explicit' }, nodePath: p('node', NODE_EXE) })
  assert.equal(cli.path, CLI_APP)
  assert.equal(cli.kind, 'js')
  assert.equal(cli.verified, true)
  assert.deepEqual(cli.tried.map((entry) => entry.source), ['path-shim', 'install-app'])
})

test('locateCli：--dsh-cli 指向不存在的路径 ⇒ explicitMissing，且不回退自动探测', () => {
  const missing = p('nope', 'cli.js')
  const io = makeIo({ existing: [CLI_APP, SHIM], run: versionOk })
  const cli = locateCli(io, missing, { install: { path: ROOT, source: 'explicit' } })
  assert.equal(cli.explicitMissing, missing)
  assert.equal(cli.path, undefined)
  assert.deepEqual(cli.tried, [{ path: missing, source: 'explicit', exists: false }])
})

test('locateInstall：注册表命中（DisplayName 带版本后缀 ⇒ 模糊匹配）', () => {
  const registryText = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OTHER}',
    '    DisplayName    REG_SZ    Valkyrie Driver 2.1.91',
    `    InstallLocation    REG_SZ    ${join(ROOT, 'Valkyrie')}`,
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{DSH}',
    '    DisplayName    REG_SZ    DeepSeek Harness 0.2.0-rc.2',
    `    InstallLocation    REG_SZ    ${ROOT}`,
  ].join('\r\n')
  const io = makeIo({
    existing: [ROOT],
    dirs: [ROOT],
    run: (cmd) => (cmd === 'reg'
      ? { status: 0, stdout: registryText, stderr: '', timedOut: false }
      : { status: 1, stdout: '', stderr: '', timedOut: false }),
  })
  // 注册表分支只在 win32 走；这里把平台钉成 win32，让断言跨平台确定。
  io.platform = 'win32'
  const install = locateInstall(io, undefined)
  assert.equal(install.source, 'registry')
  assert.equal(install.path, ROOT)
})

test('parseUninstallEntries：命中与未命中两条分支（不真跑 reg）', () => {
  const text = [
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A}',
    '    DisplayName    REG_SZ    Something Else',
    'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B}',
    '    DisplayName    REG_SZ    DeepSeek Harness 0.2.0-rc.2',
    '    InstallLocation    REG_SZ    \\fake-root',
  ].join('\n')
  const entries = parseUninstallEntries(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].displayName, 'Something Else')
  assert.equal(entries[0].installLocation, undefined)
  assert.ok(entries[1].displayName.includes('DeepSeek Harness'))
  assert.equal(entries[1].installLocation, '\\fake-root')
  // 未命中：没有任何一条同时具备 DisplayName 命中与 InstallLocation
  const miss = parseUninstallEntries('HKEY_LOCAL_MACHINE\\...\\{C}\n    DisplayName    REG_SZ    DeepSeek Harness 0.2.0-rc.2\n')
  assert.equal(miss.filter((e) => e.displayName.includes('DeepSeek Harness') && e.installLocation).length, 0)
})

test('hostPackageDir：从 CLI 路径向上找 node_modules 下的 @deepseek-ai', () => {
  const scoped = p('resources', 'app', 'dsh', 'node_modules', '@deepseek-ai')
  const cli = join(scoped, 'dsh-desktop-host', 'lib', 'cli.js')
  const io = makeIo({ existing: [scoped], dirs: [scoped] })
  assert.equal(hostPackageDir(io, cli), scoped)
  assert.equal(hostPackageDir(io, undefined), undefined)
})

test('readProfileEnv：缺席一律 null，不猜默认值', () => {
  const io = makeIo()
  assert.deepEqual(readProfileEnv(io), { dshHome: null, profile: null, profileDir: null, sessionId: null })
  io.env = { DSH_HOME: ROOT, DSH_PROFILE: 'web' }
  assert.deepEqual(readProfileEnv(io), { dshHome: ROOT, profile: 'web', profileDir: null, sessionId: null })
})

test('候选存在但不可用：真跑一个必然失败的可执行文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-locate-'))
  const fake = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake.sh')
  try {
    if (process.platform === 'win32') writeFileSync(fake, '@exit /b 1\r\n')
    else {
      writeFileSync(fake, '#!/bin/sh\nexit 1\n')
      chmodSync(fake, 0o755)
    }
    const io = defaultIo()
    const cli = locateCli(io, fake, { timeoutMs: 20000 })
    assert.equal(cli.path, fake)
    assert.equal(cli.verified, false, '存在但执行失败必须落 verified=false，而不是当命中')
    assert.equal(cli.explicitMissing, undefined)
    assert.equal(cli.tried[0].usable, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
