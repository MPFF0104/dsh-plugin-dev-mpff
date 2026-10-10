// 共用库 2：量法与抽取（纯函数）。
// 只报事实（长度、命中、计数）；判据与稳定 code 归 check-plugin.mjs。
// 零依赖：只用 node:* 内置模块；零写入；不启动子进程。

/** references/ 的条目集合（单一真源，集合相等与长度上限都用它）。 */
export const REFERENCE_FILES = [
  'env-discovery.md',
  'package-and-assembly.md',
  'extension-points.md',
  'build-a-package.md',
  'frontend-plugin.md',
  'verification-loop.md',
  'release-and-distribution.md',
  'failure-modes.md',
  'drift-recheck.md',
  'skill-shipping.md',
]

/** 每册的 numbered 上限（单一真源）。 */
export const REFERENCE_LIMITS = {
  'env-discovery.md': 6000,
  'package-and-assembly.md': 7000,
  'extension-points.md': 7000,
  'build-a-package.md': 7000,
  'frontend-plugin.md': 7000,
  'verification-loop.md': 7000,
  'release-and-distribution.md': 7000,
  'failure-modes.md': 6000,
  'drift-recheck.md': 5000,
  'skill-shipping.md': 7000,
}

/** 入口正文（渲染后）上限与十册 numbered 合计上限。 */
export const ENTRY_LIMIT = 7000
export const ENTRY_HARD_LIMIT = 8192
export const REFERENCES_TOTAL_LIMIT = 59000

/** 反引号裸路径的四类前缀。 */
export const REF_PREFIXES = ['references', 'templates', 'examples', 'scripts']

/** 渲染外壳常数：shell = 289 + len(name) + len(<skill 目录绝对路径>)。 */
export const SHELL_BASE = 289

/** 渲染形状（仅用于把外壳常数写清楚；实际渲染由宿主完成）。 */
export function renderShape(name, absPath, body) {
  return [
    `<skill_content name="${name}">`,
    '<skill_resources>',
    `Base directory for this skill: ${absPath}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** code point 长度（不是 UTF-16 长度）。 */
export function codePointLength(text) {
  return [...text].length
}

/** 渲染外壳长度（精确式，不是估算）。 */
export function shellLength(name, absPath) {
  return SHELL_BASE + codePointLength(name) + codePointLength(absPath)
}

/**
 * frontmatter 闭分隔符定位（CRLF 容忍）。
 * 返回 `{ blockEnd, bodyStart }`：`blockEnd` = 闭分隔符起始（与旧的 `indexOf('\n---\n', 4)` 同值），
 * `bodyStart` = 闭分隔符之后（正文起点）。找不到时两者皆为 -1。
 */
export function frontmatterBounds(raw) {
  const m = /\r?\n---\r?\n/u.exec(raw.slice(4))
  if (m === null) return { blockEnd: -1, bodyStart: -1 }
  return { blockEnd: 4 + m.index, bodyStart: 4 + m.index + m[0].length }
}

/** 官方 body() 同形：从第 4 个字符后找第一个闭分隔符。 */
export function bodyOf(raw) {
  const { bodyStart } = frontmatterBounds(raw)
  return bodyStart === -1 ? '' : raw.slice(bodyStart)
}

/**
 * 逐行编号渲染（分册长度量法）。
 * 末尾换行会产出一个空行，空行同样占一行编号 —— 与逐行读取同形。
 */
export function numberedLines(text) {
  return text.split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join('\n')
}

/** 浅扫描 frontmatter（只认两键形态，不引 YAML 解析器）。 */
export function frontmatterOf(raw) {
  const firstLine = raw.slice(0, raw.indexOf('\n')).replace(/\r$/u, '')
  const { blockEnd } = frontmatterBounds(raw)
  const block = blockEnd === -1 ? '' : raw.slice(4, blockEnd)
  const keys = []
  const values = {}
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(line)
    if (!m) continue
    keys.push(m[1])
    values[m[1]] = m[2]
  }
  const description = values.description ?? ''
  return {
    bom: raw.charCodeAt(0) === 0xfeff,
    firstLine,
    crlf: raw.includes('\r\n'),
    keys,
    values,
    descriptionQuoted: description.length >= 2 && description.startsWith("'") && description.endsWith("'"),
  }
}

/**
 * 抽取反引号裸路径引用。
 * 形态与官方门禁同形（只认四类前缀），返回 `{ prefix, target, index }`。
 */
export function extractRefs(text) {
  const re = /`((?:references|templates|examples|scripts)\/[^`]+)`/gu
  const out = []
  for (const m of text.matchAll(re)) {
    const target = m[1].replace(/\/+$/u, '')
    out.push({ prefix: m[1].split('/')[0], target, index: m.index ?? -1 })
  }
  return out
}

/** 四类前缀各自的抽取计数（防失效守卫的判定面）。 */
export function refCounts(text) {
  const counts = Object.fromEntries(REF_PREFIXES.map((p) => [p, 0]))
  for (const ref of extractRefs(text)) counts[ref.prefix] += 1
  return counts
}

/** 官方 G7 同形禁令：反引号里以 `cat` / `cp` / `ls` 开头的 shell 命令。 */
export function shellReadHits(text) {
  return [...text.matchAll(/`(cat|cp|ls) /gu)].map((m) => m[0])
}

/** markdown 链接（引用一律反引号裸路径；skill 面把它判为 error，code 见 check-plugin.mjs 的 skill.markdown-link）。 */
export function markdownLinkHits(text) {
  return [...text.matchAll(/\]\(/gu)].map((m) => m[0])
}

// --- 反泄漏词表 -------------------------------------------------------------
// 词表一律「拼接构造」：让检查器自扫时不自触发（自扫面含 scripts/**）。
const SPEC_REPO = ['dsh-plugin-dev-mpff', 'spec'].join('-')
const SPEC_READ = ['_spec', 'read'].join('-')
const TEMP_VAR = ['%TEMP', '%'].join('')
const LOCALAPPDATA_VAR = ['%LOCALAPPDATA', '%'].join('')
const FILE_URL = ['file', '://'].join('')
const PARENT_TRAVERSAL = ['\\.', '\\.', '/'].join('')
const USERS_DIR = ['', 'Users', ''].join('/')
const DSH_HOME_TILDE = ['~', '.dsh'].join('/')
const DRIVE_PATH = '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]'
const ASAR_ARCHIVE = ['app', '.asar'].join('')
const GITHUB_SLUG = new RegExp(`${['github', '\\.com/'].join('')}([\\w.-]+)\\/([\\w.-]+)`, 'gu')
const ALLOWED_REPO_SLUG = ['deepseek-ai', 'deepseek-harness'].join('/')

const MACHINE_PATTERNS = [
  DRIVE_PATH,
  USERS_DIR,
  DSH_HOME_TILDE,
  SPEC_READ,
  TEMP_VAR,
  LOCALAPPDATA_VAR,
]

function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'gu')
  return [...text.matchAll(re)].map((m) => m[0])
}

/**
 * 反泄漏扫描。`isMarkdown` 为真时额外查上跳引用（`../`）——
 * 脚本自身的 `import` 不受此限。
 */
export function scanLeaks(text, options = {}) {
  const hits = []
  for (const pattern of MACHINE_PATTERNS) {
    for (const match of countMatches(text, pattern)) hits.push({ code: 'leak.machine-path', match })
  }
  for (const match of countMatches(text, SPEC_REPO)) hits.push({ code: 'leak.spec-repo-url', match })
  for (const match of countMatches(text, FILE_URL)) hits.push({ code: 'leak.file-url', match })
  for (const match of text.matchAll(GITHUB_SLUG)) {
    if (`${match[1]}/${match[2]}` !== ALLOWED_REPO_SLUG) hits.push({ code: 'leak.external-repo', match: match[0] })
  }
  if (options.isMarkdown) {
    for (const match of countMatches(text, PARENT_TRAVERSAL)) hits.push({ code: 'leak.parent-traversal', match })
  }
  if (options.includeAsar) {
    for (const match of countMatches(text, ASAR_ARCHIVE)) hits.push({ code: 'leak.external-repo', match })
  }
  return hits
}

/** 资产面额外词表（`app.asar` 只进资产面，不进 skill 面）。 */
export function scanAssetLeaks(text) {
  return scanLeaks(text, { isMarkdown: false, includeAsar: true })
}

/** 注释行数（`//` / `/*` / `*` / `<!--` 起头）。 */
export function commentLineCount(text) {
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')) count += 1
  }
  return count
}

// --- patch 浅扫描 -----------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * patch 浅扫描（零依赖，不做完整 YAML 解析）。
 * 返回事实：首个有效行形态 / `insert` 块数 / 行 id 与 name / 空 id / 无 name 的行 /
 * `!!js` 出现在 config、disabled 之外的位置。
 */
export function shallowScanPatch(text) {
  const lines = text.split(/\r?\n/)
  const significant = lines.filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
  const firstRow = significant.length > 0 && significant[0].trimStart().startsWith('- ')
  const insertBlocks = lines.filter((l) => /^\s*(?:-\s+)?insert:\s*$/u.test(l)).length

  const rows = []
  const emptyIds = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)-\s+id:\s*(.*)$/u.exec(lines[i])
    if (!m) continue
    const indent = m[1].length
    const id = m[2].trim().replace(/^['"]|['"]$/gu, '')
    if (id === '') {
      emptyIds.push({ line: i + 1 })
      continue
    }
    let name
    const body = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') continue
      if (indentOf(line) <= indent) break
      body.push(line)
      const nm = /^\s*name:\s*(.*)$/u.exec(line)
      if (nm && name === undefined) name = nm[1].trim().replace(/^['"]|['"]$/gu, '')
    }
    rows.push({ id, name, line: i + 1, body })
  }

  const jsOutside = []
  const stack = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = /^(\s*)([^:#\s][^:]*):\s*(.*)$/u.exec(line)
    if (m) {
      const indent = m[1].length
      const key = m[2].trim()
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const inConfig = stack.some((s) => s.key === 'config')
      if (m[3].includes('!!js') && key !== 'config' && key !== 'disabled' && !inConfig) {
        jsOutside.push({ line: i + 1, key })
      }
      stack.push({ indent, key })
    } else if (line.includes('!!js') && !stack.some((s) => s.key === 'config')) {
      jsOutside.push({ line: i + 1, key: null })
    }
  }

  return { firstRow, insertBlocks, rows, emptyIds, jsOutside }
}

/** 行块抽取：从 `- id: <id>` 起，到下一个 `- ` / `# ` 列首行为止。 */
export function rowBlock(text, id) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^- id: ${id}\\s*$`, 'u').test(l))
  if (start === -1) return undefined
  const block = []
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^(-\s|#)/u.test(lines[i])) break
    block.push(lines[i])
  }
  return block.join('\n')
}

/**
 * 行块里的 config 键集合。
 * 排除 `id` / `name` / `disabled`（规格逐字）**外加 `config`**：`config` 是容器键，
 * 两侧都必然出现；不排除它会让 `A ∩ B = ∅` 这条断言恒假。
 */
export function configKeys(block) {
  if (block === undefined) return []
  const keys = new Set()
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s+([A-Za-z_][\w-]*):/u.exec(line)
    if (!m) continue
    if (m[1] === 'id' || m[1] === 'name' || m[1] === 'disabled' || m[1] === 'config') continue
    keys.add(m[1])
  }
  return [...keys].sort()
}

/** 按 `##` 分节（S7 的「同节内」判定面）。 */
export function sectionsOf(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = { heading: '(前言)', body: [] }
  for (const line of lines) {
    if (/^##\s/u.test(line)) {
      sections.push(current)
      current = { heading: line, body: [] }
      continue
    }
    current.body.push(line)
  }
  sections.push(current)
  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n') }))
}

/** 反引号包裹的命令形态（S7 的「同节内有读法/命令」判定面）。 */
export function commandSpans(text) {
  const out = []
  for (const m of text.matchAll(/`([^`\n]+)`/gu)) {
    const value = m[1]
    if (/[ \t]/u.test(value) || value.includes('--')) out.push(value)
  }
  return out
}

/** 否定式短语计数（D 表 owner.negation-count）。 */
export function negationCount(text) {
  return [...text.matchAll(/不许|不要|禁止|never/gu)].length
}

/** 稳定计数模式的命中数（D 表 owner.specific-count）。 */
export function specificCountHits(text) {
  return [...text.matchAll(/\b(71|289|16183|16136)\b/gu)].map((m) => m[0])
}
