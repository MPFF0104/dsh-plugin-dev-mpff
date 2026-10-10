// 工具 2：静态自检。三面三选一 —— plugin（插件检出目录）/ skill（= --self，本仓库自己的上线前门禁）
// / assets（templates/ + examples/ 的工作副本）。
// 契约：stdout 恒为单份 JSON；退出码 0 通过 / 1 校验不通过 / 2 用法错误 / 3 前提不成立。
// 边界：绝不执行被检查的代码（不 import、不跑 build/prepare、不调 npm/pnpm）；零写入；不联网。
//
// 子进程白名单：`<node> -v`、`where` / `which`、`reg query`（定位库，仅用于反推安装根）、
// `<node> --check <file>`（plugin 面与 assets 副本面）。**不安装、不卸载、不联网**。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve, matchesGlob } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { defaultIo, hostPackageDir, isInside, locateCli, locateNode } from './lib/dsh-locate.mjs'
import {
  ENTRY_HARD_LIMIT,
  ENTRY_LIMIT,
  REFERENCE_FILES,
  REFERENCE_LIMITS,
  REFERENCES_TOTAL_LIMIT,
  bodyOf,
  codePointLength,
  commentLineCount,
  commandSpans,
  configKeys,
  extractRefs,
  frontmatterOf,
  markdownLinkHits,
  negationCount,
  numberedLines,
  refCounts,
  scanAssetLeaks,
  scanLeaks,
  sectionsOf,
  shellLength,
  shellReadHits,
  shallowScanPatch,
  specificCountHits,
} from './lib/skill-scan.mjs'

const TOOL = 'check-plugin'
const CONTRACT_VERSION = 2
const SEVERITY_RANK = { info: 0, warn: 1, error: 2 }

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
  process.stdout.write(`check-plugin — dsh 插件 / skill / 资产的静态自检（零依赖 ESM）

用法:
  node "<skill-directory>/scripts/check-plugin.mjs" [--plugin-dir <dir>]
  node "<skill-directory>/scripts/check-plugin.mjs" --self [--skill-dir <dir>]
  node "<skill-directory>/scripts/check-plugin.mjs" --assets-dir <工作副本>

选项:
  --plugin-dir <dir>       插件检出目录（默认 cwd）；必须含 package.json
  --self                   跑 skill 面（本仓库自己的上线前门禁，S1–S7 + 资产文本级子集）
  --skill-dir <dir>        只与 --self 同用（默认脚本上一级）
  --assets-dir <dir>       跑资产面 T1–T8；拒绝该目录落在 <skill-dir> 内
  --host-package-dir <dir> 显式指定宿主包目录（缺省则内部再探一次）
  --entry <glob>           可重复；追加要 node --check 的文件
  --no-syntax              跳过 node --check
  --severity-floor <error|warn|info>  只影响输出，不影响 ok 与退出码（默认 info）
  -h, --help / -V, --version

退出码: 0 通过 / 1 校验不通过 / 2 用法错误 / 3 前提不成立
`)
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function listFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

function listEntries(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }))
  } catch {
    return []
  }
}

// --- 反泄漏 -----------------------------------------------------------------

function leakScanFile(relPath, text) {
  const hits = scanLeaks(text, { isMarkdown: relPath.endsWith('.md') })
  for (const hit of hits) {
    problem(hit.code, 'error', `成品文件里出现泄漏模式：${hit.match}`, { file: relPath })
  }
}

// --- 资产面（T1–T8；--self 只跑文本级子集） ----------------------------------

const ASSET_SETS = [
  { key: 'hostOnlyFiles', dir: 'templates/host-only', expected: 5, template: true, name: '@local/my-plugin', rowId: 'my-plugin' },
  { key: 'frontendFiles', dir: 'templates/frontend', expected: 6, template: true, name: '@local/my-plugin', rowId: 'my-plugin' },
  { key: 'fixtureFiles', dir: 'examples/hello-plugin', expected: 6, template: false, name: 'dsh-hello-plugin', rowId: 'hello-plugin' },
]

function checkManifest(relDir, dir, spec, textOnly) {
  const manifestPath = join(dir, 'package.json')
  const raw = readText(manifestPath)
  if (raw === undefined) {
    problem('assets.file-set', 'error', `缺少 package.json：${relDir}`, { file: `${relDir}/package.json` })
    return undefined
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    problem('assets.manifest', 'error', `package.json 解析失败：${relDir}`, { message: String(error?.message ?? error) })
    return undefined
  }
  const fail = (message, detail) => problem('assets.manifest', 'error', message, detail)
  if (manifest.exports?.['.'] !== './index.js') fail(`${relDir}：exports["."] 必须是 './index.js'`, { actual: manifest.exports?.['.'] ?? null })
  if (manifest.exports?.['./locale/*.json'] !== './locale/*.json') fail(`${relDir}：exports['./locale/*.json'] 缺失或不等`, {})
  if (manifest.exports?.['./icon'] !== './icon.svg') fail(`${relDir}：exports['./icon'] 必须是 './icon.svg'`, {})
  const wantsClient = spec.template === false || spec.key === 'frontendFiles'
  if (wantsClient && manifest.exports?.['./client'] !== './client.js') fail(`${relDir}：exports['./client'] 必须是 './client.js'`, {})
  if (spec.key === 'hostOnlyFiles' && manifest.exports?.['./client'] !== undefined) fail(`${relDir}：host-only 不得导出 ./client`, {})
  if (Object.hasOwn(manifest, 'icon')) fail(`${relDir}：不得有顶层 icon`, {})
  if (manifest.private !== true) fail(`${relDir}：private 必须是 true`, { actual: manifest.private ?? null })
  if (manifest.name !== spec.name) fail(`${relDir}：name 必须是 ${spec.name}`, { actual: manifest.name ?? null })
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail(`${relDir}：dsh.bundle.patch 必须是 './cordis.patch.yml'`, {})
  if (!existsSync(join(dir, 'cordis.patch.yml'))) fail(`${relDir}：dsh.bundle.patch 指向的文件不存在`, {})
  if (spec.key === 'hostOnlyFiles' && manifest.dsh?.client !== undefined) fail(`${relDir}：host-only 不得有 dsh.client`, {})

  // T3：files 覆盖
  const patterns = Array.isArray(manifest.files) ? manifest.files : []
  const required = []
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (key.includes('*')) continue
    if (typeof value === 'string' && !value.includes('*')) required.push(value.replace(/^\.\//u, ''))
  }
  for (const entry of listEntries(dir)) {
    if (entry.dir && entry.name === 'locale') {
      for (const file of listEntries(join(dir, 'locale'))) required.push(`locale/${file.name}`)
    }
  }
  required.push('cordis.patch.yml')
  for (const target of [...new Set(required)]) {
    const covered = patterns.some((pattern) => {
      try {
        return matchesGlob(target, pattern)
      } catch {
        return false
      }
    })
    if (!covered) problem('assets.files-coverage', 'error', `${relDir}：files 未覆盖 ${target}`, { file: target })
  }

  // T4：patch 浅扫描
  const patchRaw = readText(join(dir, 'cordis.patch.yml'))
  if (patchRaw !== undefined) {
    const scan = shallowScanPatch(patchRaw)
    if (!scan.firstRow) problem('assets.patch-shape', 'error', `${relDir}：patch 首个非注释非空行不是 '- ' 起头`, {})
    if (scan.insertBlocks !== 1) problem('assets.patch-shape', 'error', `${relDir}：insert 块必须恰好 1 个`, { actual: scan.insertBlocks })
    if (scan.rows.length !== 1) problem('assets.patch-shape', 'error', `${relDir}：patch 行必须恰好 1 行`, { actual: scan.rows.length })
    for (const row of scan.rows) {
      if (row.id !== spec.rowId) problem('assets.patch-shape', 'error', `${relDir}：patch 行 id 必须是 ${spec.rowId}`, { actual: row.id })
      if (row.name !== manifest.name) problem('assets.patch-shape', 'error', `${relDir}：patch 行 name 必须逐字等于 manifest name`, { actual: row.name ?? null })
    }
  }

  // T6：locale meta
  const localeRaw = readText(join(dir, 'locale/en.json'))
  if (localeRaw === undefined) {
    problem('assets.locale-meta', 'error', `${relDir}：缺少 locale/en.json`, {})
  } else {
    try {
      const locale = JSON.parse(localeRaw)
      if (!/\S/u.test(locale?.meta?.title ?? '')) problem('assets.locale-meta', 'error', `${relDir}：locale meta.title 为空`, {})
      if (!/\S/u.test(locale?.meta?.description ?? '')) problem('assets.locale-meta', 'error', `${relDir}：locale meta.description 为空`, {})
    } catch (error) {
      problem('assets.locale-meta', 'error', `${relDir}：locale/en.json 解析失败`, { message: String(error?.message ?? error) })
    }
  }

  // T7：icon
  const iconRaw = readText(join(dir, 'icon.svg'))
  if (iconRaw === undefined) {
    problem('assets.icon', 'error', `${relDir}：缺少 icon.svg`, {})
  } else {
    let size = 0
    try {
      size = statSync(join(dir, 'icon.svg')).size
    } catch {
      size = Buffer.byteLength(iconRaw, 'utf8')
    }
    if (size > 256 * 1024) problem('assets.icon', 'error', `${relDir}：icon.svg 超过 256 KiB`, { size })
    if (!iconRaw.includes('viewBox')) problem('assets.icon', 'error', `${relDir}：icon.svg 缺 viewBox`, {})
    if (iconRaw.includes('<script')) problem('assets.icon', 'error', `${relDir}：icon.svg 含 <script`, {})
    if (iconRaw.includes('href="http')) problem('assets.icon', 'error', `${relDir}：icon.svg 含外部 href`, {})
    if (iconRaw.includes('<image')) problem('assets.icon', 'error', `${relDir}：icon.svg 含 <image`, {})
  }

  // T8：反泄漏 + 注释行数
  for (const rel of listFiles(dir)) {
    const text = readText(join(dir, rel)) ?? ''
    for (const hit of scanAssetLeaks(text)) {
      problem('assets.leak', 'error', `${relDir}/${rel}：命中泄漏词表 ${hit.match}`, { file: `${relDir}/${rel}` })
    }
    if (rel.endsWith('.js')) {
      const limit = spec.template ? 1 : 0
      const count = commentLineCount(text)
      if (count > limit) {
        problem('assets.comment-lines', 'error', `${relDir}/${rel}：注释行数 ${count} 超过上限 ${limit}`, { file: `${relDir}/${rel}` })
      }
    }
  }

  // T5：语法（只在副本面执行；就地一律推迟）
  if (!textOnly && manifest.exports !== undefined) {
    const nodePath = process.execPath
    for (const rel of listFiles(dir).filter((f) => f.endsWith('.js'))) {
      const abs = join(dir, rel)
      let exists = true
      try {
        statSync(abs)
      } catch {
        exists = false
      }
      if (!exists) {
        problem('entry.missing', 'error', `${relDir}/${rel}：文件不存在`, { file: abs })
        continue
      }
      const check = spawnSync(nodePath, ['--check', abs], { encoding: 'utf8' })
      if (check.status !== 0) {
        problem('entry.syntax-error', 'error', `${relDir}/${rel}：node --check 失败`, {
          file: abs,
          stderr: (check.stderr ?? '').split(/\r?\n/u).slice(0, 3).join(' | '),
        })
      }
    }
  }
  return manifest
}

/**
 * 「先复制到 --work-root，再在副本上跑」的两条**可跑命令**。
 * 复制动作走 node 自己的 fs（不生成 `cp` / `cat` / `ls` 形态的 shell 命令）。
 */
function copyNextCommands(sourceDir) {
  const toPosix = (value) => String(value).replace(/\\/gu, '/')
  const dest = join(tmpdir(), 'dsh-skill-assets', 'assets-copy')
  return [
    `node -e "require('node:fs').cpSync('${toPosix(sourceDir)}','${toPosix(dest)}',{recursive:true})"`,
    `node "<skill-directory>/scripts/check-plugin.mjs" --assets-dir "${toPosix(dest)}"`,
  ]
}

function assetsFace(rootDir, textOnly) {
  const summary = { hostOnlyFiles: 0, frontendFiles: 0, fixtureFiles: 0 }
  for (const spec of ASSET_SETS) {
    const dir = join(rootDir, spec.dir)
    const files = listFiles(dir)
    summary[spec.key] = files.length
    const expected = spec.expected
    if (files.length !== expected) {
      problem('assets.file-set', 'error', `${spec.dir}：文件数必须是 ${expected}`, { actual: files.length, files })
    }
    const nested = listEntries(dir).some((e) => e.dir && e.name !== 'locale')
    if (nested) problem('assets.file-set', 'error', `${spec.dir}：不得有多余目录`, { entries: listEntries(dir).map((e) => e.name) })
    if (files.length > 0) checkManifest(spec.dir, dir, spec, textOnly)
  }
  if (textOnly) {
    problem(
      'assets.syntax-deferred',
      'info',
      'T5（node --check）就地被推迟：skill 目录可能落在归档内，只有副本面能跑。',
      { deferredTo: '--assets-dir <副本>', why: '就地只做文本级断言，执行级一律在副本上' },
    )
  }
  return summary
}

// --- skill 面（S1–S7） ------------------------------------------------------

const BOUNDARY_MARKERS = [
  { file: 'env-discovery.md', word: '未真跑' },
  { file: 'extension-points.md', word: '不承诺穷尽' },
  { file: 'build-a-package.md', word: '本规格决定' },
  { file: 'frontend-plugin.md', word: '未做端到端渲染验证' },
  { file: 'release-and-distribution.md', word: '未实测' },
]

function skillFace(skillDir) {
  const entryPath = join(skillDir, 'SKILL.md')
  const raw = readText(entryPath)
  if (raw === undefined) {
    problem('skill.entry-missing', 'error', 'skill 目录里没有 SKILL.md。', { path: entryPath })
    return { entry: null, references: [], referencesTotal: 0, refCounts: {}, assets: null }
  }

  // S1 形态与 frontmatter
  const fm = frontmatterOf(raw)
  if (fm.bom) problem('skill.bom', 'error', 'SKILL.md 以 U+FEFF 起头。', {})
  if (fm.firstLine !== '---') problem('skill.first-line-not-frontmatter', 'error', 'SKILL.md 第 1 行不是逐字 ---', { actual: fm.firstLine })
  if (fm.crlf) problem('skill.crlf', 'warn', 'SKILL.md 含 CRLF（宿主 skill 发现不受影响，只提示行尾规范）。', {})
  const keySet = [...fm.keys].sort().join(',')
  if (keySet !== 'description,name') problem('skill.frontmatter-keys', 'error', 'frontmatter 键集合必须恰好是 name + description。', { actual: fm.keys })
  if (!fm.descriptionQuoted) problem('skill.description-unquoted', 'error', 'description 值必须被单引号整体包裹。', {})
  const name = fm.values.name ?? ''
  if (name !== basename(skillDir)) problem('skill.name-mismatch', 'error', 'frontmatter name 必须逐字等于目录名。', { name, dir: basename(skillDir) })

  // S2 长度
  const body = bodyOf(raw)
  const shell = shellLength(name, skillDir)
  const rendered = shell + codePointLength(body)
  if (rendered > ENTRY_LIMIT) {
    problem('skill.entry-too-long', 'error', `入口渲染后 ${rendered} code point，超过 ${ENTRY_LIMIT}。`, {
      rendered,
      shell,
      hardLimit: ENTRY_HARD_LIMIT,
      margin: ENTRY_HARD_LIMIT - rendered,
    })
  }

  const referenceTexts = {}
  const references = []
  let referencesTotal = 0
  const refDir = join(skillDir, 'references')
  const entries = listEntries(refDir)
  const dirNames = entries.filter((e) => !e.dir).map((e) => e.name)
  const badEntries = entries.filter((e) => e.dir || !e.name.endsWith('.md')).map((e) => e.name)
  const setEqual = badEntries.length === 0
    && dirNames.length === REFERENCE_FILES.length
    && REFERENCE_FILES.every((f) => dirNames.includes(f))
  if (!setEqual) {
    problem('skill.references-set-mismatch', 'error', 'references/ 条目集合不等于 9 册（或有子目录 / 非 .md）。', {
      actual: dirNames,
      extra: badEntries,
    })
  }

  for (const file of REFERENCE_FILES) {
    const text = readText(join(refDir, file))
    if (text === undefined) continue
    referenceTexts[file] = text
    const numbered = codePointLength(numberedLines(text))
    referencesTotal += numbered
    const limit = REFERENCE_LIMITS[file]
    if (numbered > limit) {
      problem('skill.reference-too-long', 'error', `${file} numbered ${numbered}，超过该册目标 ${limit}。`, { file, numbered, limit })
    }
    references.push({ file, numbered, limit })
  }
  if (referencesTotal > REFERENCES_TOTAL_LIMIT) {
    problem('skill.references-total-too-long', 'error', `九册合计 ${referencesTotal}，超过 ${REFERENCES_TOTAL_LIMIT}。`, { referencesTotal })
  }

  // S3 引用存在
  const scanTargets = [['SKILL.md', raw], ...Object.entries(referenceTexts)]
  const counts = { references: 0, templates: 0, examples: 0, scripts: 0 }
  for (const [file, text] of scanTargets) {
    for (const ref of extractRefs(text)) {
      counts[ref.prefix] += 1
      if (!existsSync(join(skillDir, ref.target))) {
        problem('skill.ref-missing', 'error', `${file} 引用的裸路径不存在：${ref.target}`, { file, target: ref.target })
      }
    }
    for (const hit of shellReadHits(text)) {
      problem('skill.shell-read-skill-file', 'error', `${file} 出现官方禁止的 shell 读形态：${hit}`, { file })
    }
  }
  for (const [prefix, count] of Object.entries(counts)) {
    if (count === 0) {
      problem('skill.ref-extractor-empty', 'error', `防失效守卫：${prefix}/ 前缀的抽取数为 0。`, { prefix })
    }
  }

  // S4 结构
  for (const [file, text] of scanTargets) {
    for (const hit of markdownLinkHits(text)) {
      problem('skill.markdown-link', 'error', `${file} 出现 markdown 链接 ]( ；引用一律反引号裸路径。`, { file })
    }
  }
  const entryTargets = new Set(extractRefs(raw).map((r) => r.target))
  for (const [file, text] of Object.entries(referenceTexts)) {
    const pointerLines = text.split(/\r?\n/u).filter((line) => /`references\/[^`]+\.md`/u.test(line))
    if (pointerLines.length > 3) {
      problem('skill.pointer-lines', 'error', `${file} 的指针行 ${pointerLines.length} 行，超过 3 行。`, { file, lines: pointerLines.length })
    }
    for (const ref of extractRefs(text)) {
      if (!entryTargets.has(ref.target)) {
        problem('skill.pointer-chain', 'error', `${file} 指向入口没有一跳给出的册：${ref.target}`, { file, target: ref.target })
      }
    }
  }

  // S5 反泄漏（自扫面 = 全部成品文件，无例外）
  for (const rel of listFiles(skillDir)) {
    const text = readText(join(skillDir, rel))
    if (text === undefined) continue
    leakScanFile(rel, text)
  }

  // S6 D 表禁止面
  const refEntries = Object.entries(referenceTexts)
  const withPlaceholder = refEntries.filter(([, text]) => text.includes('占位符')).map(([f]) => f)
  if (withPlaceholder.length !== 1 || withPlaceholder[0] !== 'env-discovery.md') {
    problem('owner.placeholder-table-outside-r1', 'error', '含「占位符」的册必须恰好是 env-discovery.md。', { actual: withPlaceholder })
  }
  const lengthMethodFiles = []
  let lengthMethodLines = 0
  for (const [file, text] of refEntries) {
    // 「1 处」= 命中的**行数**为 1（同一行里两个词算同一处）。
    const lines = text.split(/\r?\n/u).filter((line) => /renderSkillContent|codePointLength/u.test(line))
    if (lines.length > 0) lengthMethodFiles.push({ file, lines: lines.length })
    lengthMethodLines += lines.length
  }
  if (lengthMethodLines !== 1 || lengthMethodFiles[0]?.file !== 'verification-loop.md') {
    problem('owner.length-method-duplicated', 'error', 'renderSkillContent / codePointLength 在 references/ 里必须恰好 1 处（1 行）且落在 verification-loop.md。', { actual: lengthMethodFiles })
  }
  const ghostFiles = []
  for (const [file, text] of refEntries) {
    for (const line of text.split(/\r?\n/u)) {
      if (!/dshReleases|dsh\.install\./u.test(line)) continue
      const okLine = file === 'package-and-assembly.md' && line.includes('上游') && line.includes('不存在')
      ghostFiles.push({ file, ok: okLine })
    }
  }
  if (ghostFiles.some((g) => !g.ok)) {
    problem('owner.ghost-field-outside-r2', 'error', 'dshReleases / dsh.install. 只允许出现在 package-and-assembly.md，且命中行同句含「上游」与「不存在」。', { actual: ghostFiles })
  }
  const pendingFiles = []
  for (const [file, text] of refEntries) {
    const hits = [...text.matchAll(/pending \(waiting for service/gu)].length
    for (let i = 0; i < hits; i += 1) pendingFiles.push(file)
  }
  const allowedPending = ['extension-points.md', 'failure-modes.md', 'drift-recheck.md']
  const pendingOk = pendingFiles.length === 3 && allowedPending.every((f) => pendingFiles.includes(f))
  if (!pendingOk) {
    problem('owner.pending-marker-outside-allowed', 'error', 'pending (waiting for service 只允许 3 处，落在 extension-points / failure-modes / drift-recheck。', { actual: pendingFiles })
  }
  for (const [file, text] of refEntries) {
    const hits = specificCountHits(text)
    if (hits.length > 0) {
      problem('owner.specific-count', 'error', `${file} 写死了量法数字：${hits.join(', ')}`, { file, hits })
    }
  }
  const entryNegations = negationCount(raw)
  if (entryNegations !== 0) {
    problem('owner.negation-count', 'error', `入口的否定式短语必须 0 处，实际 ${entryNegations} 处。`, { actual: entryNegations })
  }
  for (const [file, text] of refEntries) {
    const count = negationCount(text)
    if (count > 1) problem('owner.negation-count', 'error', `${file} 的否定式短语 ${count} 处，每册上限 1 处。`, { file, actual: count })
  }

  // S7 边界标注
  for (const marker of BOUNDARY_MARKERS) {
    const text = referenceTexts[marker.file]
    if (text === undefined) continue
    if (!text.includes(marker.word)) {
      problem('skill.boundary-marker-missing', 'error', `${marker.file} 缺强制边界标注词：${marker.word}`, { file: marker.file, word: marker.word })
      continue
    }
    const section = sectionsOf(text).find((s) => s.body.includes(marker.word))
    const spans = section === undefined ? [] : commandSpans(section.body)
    if (spans.length === 0) {
      problem('skill.boundary-evidence-missing', 'error', `${marker.file} 的边界标注同节内没有读法或命令。`, { file: marker.file, word: marker.word, section: section?.heading ?? null })
    }
  }

  // 资产文本级子集
  const assets = assetsFace(skillDir, true)

  return {
    entry: { rendered, shell, body: codePointLength(body), limit: ENTRY_LIMIT },
    references,
    referencesTotal,
    refCounts: counts,
    assets,
    name,
  }
}

// --- plugin 面 ---------------------------------------------------------------

function collectSyntaxTargets(pluginDir, manifest, patchTexts, extraEntries) {
  const targets = new Set()
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (key.includes('*')) continue
    if (typeof value !== 'string' || value.includes('*')) continue
    if (/\.(js|mjs)$/u.test(value)) targets.add(value.replace(/^\.\//u, ''))
  }
  for (const extra of extraEntries) targets.add(extra)
  const pathShaped = []
  for (const text of patchTexts) {
    for (const row of shallowScanPatch(text).rows) {
      if (row.name === undefined) continue
      if (/^(\.{0,2}\/|[A-Za-z]:[\\/])/u.test(row.name) && /\.(js|mjs)$/u.test(row.name)) pathShaped.push(row.name)
      else problem('patch.name-not-a-file', 'info', `patch 行的 name 不是文件路径形态，跳过语法检查：${row.name}`, { name: row.name })
    }
  }
  for (const target of pathShaped) targets.add(target.replace(/^\.\//u, ''))
  return [...targets]
}

function pluginFace(pluginDir, values) {
  const manifestPath = join(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) {
    problem('plugin.not-a-package', 'error', '目录里没有 package.json。', { path: manifestPath })
    return { manifest: null }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    problem('plugin.not-a-package', 'error', 'package.json 解析失败。', { message: String(error?.message ?? error) })
    return { manifest: null }
  }

  const patchDecl = manifest.dsh?.bundle?.patch
  const patchRel = []
  if (patchDecl === undefined) {
    problem('plugin.no-bundle-patch', 'warn', '没有 dsh.bundle.patch ⇒ 该包不是 bundle，装上不会成为 profile 层。', {})
  } else {
    for (const value of Array.isArray(patchDecl) ? patchDecl : [patchDecl]) {
      if (typeof value !== 'string') continue
      if (!existsSync(join(pluginDir, value))) {
        problem('patch.file-missing', 'error', `dsh.bundle.patch 指向的文件不存在：${value}`, { file: value })
        continue
      }
      patchRel.push(value)
    }
  }

  const patchTexts = patchRel.map((rel) => readText(join(pluginDir, rel)) ?? '')
  for (const text of patchTexts) {
    const scan = shallowScanPatch(text)
    problem('patch.shallow-scan', 'info', '本次 patch 检查是浅扫描（权威解析在 verify-assembly.mjs）。', {})
    for (const empty of scan.emptyIds) problem('patch.empty-id', 'error', `第 ${empty.line} 行的 id 为空。`, empty)
    for (const row of scan.rows) {
      if (row.name === undefined) problem('patch.insert-row-without-name', 'error', `第 ${row.line} 行的 insert 行没有 name。`, { id: row.id })
    }
    for (const hit of scan.jsOutside) {
      problem('patch.js-expression-outside-config-or-disabled', 'error', `第 ${hit.line} 行的 !!js 出现在 config / disabled 之外。`, hit)
    }
  }

  const platform = manifest.dsh?.client?.platform
  if (platform !== undefined && platform !== 'web') {
    problem('client.platform-not-web', 'error', `dsh.client.platform 必须是字面量 'web'，实际 ${JSON.stringify(platform)}。`, { actual: platform })
  }

  const io = defaultIo()
  const packageDir = values['host-package-dir'] ?? hostPackageDir(io, locateCli(io, values['dsh-cli'], { noExec: true })?.path)
  const inject = manifest.dsh?.client?.inject
  if (Array.isArray(inject) && inject.length > 0) {
    if (packageDir === undefined) {
      problem('host-package-dir-unknown', 'warn', '拿不到宿主包目录 ⇒ 注入名检查降级。', {})
    } else {
      const available = new Set(listEntries(packageDir).map((e) => e.name))
      const local = join(pluginDir, 'node_modules')
      for (const entry of listEntries(local)) available.add(entry.name)
      for (const dep of inject) {
        const bare = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0]
        if (!available.has(bare)) {
          problem('client.inject-name-missing', 'warn', `dsh.client.inject 里的名字在宿主包目录与 profile node_modules 里都找不到：${dep}`, { name: dep })
        }
      }
    }
  }

  const files = Array.isArray(manifest.files) ? manifest.files : undefined
  if (files !== undefined) {
    for (const rel of patchRel) {
      // `files` 里的 pattern 是包内相对路径；patch 声明带 `./`，比较前先归一。
      const target = rel.replace(/^\.\//u, '')
      if (!files.some((p) => safeGlob(target, p))) {
        problem('files.missing-patch', 'error', `files 里没有 pattern 覆盖 patch 路径：${rel}`, { file: rel })
      }
    }
    const resources = []
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (key.includes('*')) continue
      if (typeof value === 'string' && !value.includes('*')) resources.push(value.replace(/^\.\//u, ''))
    }
    for (const entry of listEntries(join(pluginDir, 'locale'))) resources.push(`locale/${entry.name}`)
    for (const rel of resources) {
      if (!files.some((p) => safeGlob(rel, p))) {
        problem('files.missing-resource', 'warn', `exports / locale 资源未被 files 覆盖：${rel}`, { file: rel })
      }
    }
  }

  if (Array.isArray(manifest.peerDependencies)) {
    if (!manifest.peerDependencies.some((d) => String(d).startsWith('@deepseek-ai/dsh'))) {
      problem('peer.range-absent', 'info', 'peerDependencies 里没有任何 @deepseek-ai/dsh* 区间（只报事实）。', {})
    }
  } else if (manifest.peerDependencies === undefined) {
    problem('peer.range-absent', 'info', '没有 peerDependencies（只报事实，不评估区间）。', {})
  }

  if (values['no-syntax'] !== true) {
    const nodePath = locateNode(io, values.node)?.path ?? process.execPath
    const targets = collectSyntaxTargets(pluginDir, manifest, patchTexts, values.entry ?? [])
    for (const rel of targets) {
      if (/\.ts$/u.test(rel)) {
        problem('entry.typescript-skipped', 'info', `.ts 入口被跳过（--check 不是 TS 感知的）：${rel}`, { file: rel })
        continue
      }
      const abs = resolve(pluginDir, rel)
      let present = true
      try {
        statSync(abs)
      } catch {
        present = false
      }
      if (!present) {
        problem('entry.missing', 'error', `语法检查集合里的文件不存在：${rel}`, { file: rel })
        continue
      }
      const check = spawnSync(nodePath, ['--check', abs], { encoding: 'utf8' })
      if (check.status !== 0) {
        problem('entry.syntax-error', 'error', `node --check 失败：${rel}`, {
          file: rel,
          stderr: (check.stderr ?? '').split(/\r?\n/u).slice(0, 3).join(' | '),
        })
      }
    }
  }

  return { manifest }
}

function safeGlob(target, pattern) {
  try {
    return matchesGlob(target, pattern)
  } catch {
    return false
  }
}

// --- 入口 --------------------------------------------------------------------

const scriptDir = import.meta.dirname

let parsed
try {
  parsed = parseArgs({
    options: {
      'plugin-dir': { type: 'string' },
      self: { type: 'boolean', default: false },
      'skill-dir': { type: 'string' },
      'assets-dir': { type: 'string' },
      'host-package-dir': { type: 'string' },
      'dsh-cli': { type: 'string' },
      node: { type: 'string' },
      entry: { type: 'string', multiple: true, default: [] },
      'no-syntax': { type: 'boolean', default: false },
      'severity-floor': { type: 'string', default: 'info' },
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
    run(values)
  }
}

function run(values) {
  const given = [
    values['plugin-dir'] !== undefined ? 'plugin' : null,
    values.self ? 'skill' : null,
    values['assets-dir'] !== undefined ? 'assets' : null,
  ].filter(Boolean)
  if (given.length > 1) {
    problem('usage.conflicting-modes', 'error', '三面三选一：--plugin-dir / --self / --assets-dir 不能同时给两个。', { modes: given })
    return finish(values, { mode: null, target: null }, 2)
  }
  if (values['skill-dir'] !== undefined && !values.self) {
    problem('usage.skill-dir-without-self', 'error', '--skill-dir 只与 --self 同用。', {})
    return finish(values, { mode: null, target: null }, 2)
  }
  if (values['severity-floor'] !== undefined && SEVERITY_RANK[values['severity-floor']] === undefined) {
    problem('usage.severity-floor', 'error', '--severity-floor 只接受 error / warn / info。', { actual: values['severity-floor'] })
    return finish(values, { mode: null, target: null }, 2)
  }

  const skillDir = resolve(values['skill-dir'] ?? join(scriptDir, '..'))

  if (values.self) {
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
      problem('skill.dir-missing', 'error', 'skill 目录不存在。', { path: skillDir })
      return finish(values, { mode: 'skill', target: skillDir }, 3)
    }
    const summary = skillFace(skillDir)
    for (const command of copyNextCommands(skillDir)) next.push(command)
    return finish(values, {
      mode: 'skill',
      target: skillDir,
      skill: {
        name: summary.name ?? null,
        entry: summary.entry,
        references: summary.references,
        referencesTotal: summary.referencesTotal,
        refCounts: summary.refCounts,
      },
      assets: summary.assets,
    })
  }

  if (values['assets-dir'] !== undefined) {
    const assetsDir = resolve(values['assets-dir'])
    if (!existsSync(assetsDir)) {
      problem('assets.dir-missing', 'error', '资产工作副本不存在。', { path: assetsDir })
      return finish(values, { mode: 'assets', target: assetsDir }, 3)
    }
    if (isInside(skillDir, assetsDir)) {
      problem('assets.in-place-refused', 'error', '--assets-dir 落在 <skill-dir> 内：就地只做文本级断言，执行级一律在副本上。', { path: assetsDir })
      for (const command of copyNextCommands(assetsDir)) next.push(command)
      return finish(values, { mode: 'assets', target: assetsDir }, 3)
    }
    const summary = assetsFace(assetsDir, false)
    return finish(values, { mode: 'assets', target: assetsDir, assets: summary })
  }

  const pluginDir = resolve(values['plugin-dir'] ?? process.cwd())
  const result = pluginFace(pluginDir, values)
  const exit = result.manifest === null ? 3 : undefined
  return finish(values, { mode: 'plugin', target: pluginDir }, exit)
}

function finish(values, specific, forcedExit) {
  const floor = SEVERITY_RANK[values['severity-floor'] ?? 'info'] ?? 0
  const ok = !problems.some((p) => p.severity === 'error')
  const filtered = { error: 0, warn: 0, info: 0 }
  const kept = []
  for (const p of problems) {
    if (SEVERITY_RANK[p.severity] < floor) filtered[p.severity] += 1
    else kept.push(p)
  }
  const doc = {
    tool: TOOL,
    contractVersion: CONTRACT_VERSION,
    mode: specific.mode,
    target: specific.target,
  }
  if (specific.skill !== undefined) doc.skill = specific.skill
  if (specific.assets !== undefined) doc.assets = specific.assets
  doc.filtered = filtered
  doc.problems = kept
  doc.ok = ok
  doc.next = next
  const exit = forcedExit ?? (ok ? 0 : 1)
  emit(doc, exit)
}
