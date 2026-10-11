// 反泄漏词表的单测（纯函数面）：机器形态必命中 + 合法形态不误伤 + URL 边界不误判。
//
// 运行命令（**显式文件列表**；目录参数不可用、glob 零命中会静默通过）：
//   node --test "<skill-directory>/scripts/tests/paths.test.mjs" "<skill-directory>/scripts/tests/locate.test.mjs" "<skill-directory>/scripts/tests/skill-scan.test.mjs"
//
// 用例里的机器形态一律由字符串拼接构造：单测文件虽不在门禁的自扫面内，
// 词表纪律（别写机器字面）在这里同样照守，免得日后有人拿它当范本。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REFERENCE_FILES, scanLeaks } from '../lib/skill-scan.mjs'

const skillDir = resolve(import.meta.dirname, '..', '..')
const repoRoot = resolve(skillDir, '..')

const SLASH = '/'
const BACKSLASH = '\\'
const DOLLAR = '$'
const PERCENT = '%'
const HOME_DIRS = ['home', 'root', 'opt', 'srv', 'mnt']
const WIN_DRIVE = ['C', ':'].join('')
const WIN_SEG = ['Users', 'bob', '.dsh'].join(BACKSLASH)

/** 机器字面形态：判据 1 点名的 5 条 + owner 拍板并入的两条 + 既有盘符形态。 */
const MACHINE_TEXTS = [
  ...HOME_DIRS.map((d) => [SLASH, d, SLASH, 'alice', SLASH, '.dsh', SLASH, 'skills'].join('')),
  [DOLLAR, 'HOME', SLASH, '.dsh', SLASH, 'skills'].join(''),
  [PERCENT, 'USER', 'PROFILE', PERCENT, BACKSLASH, '.dsh', BACKSLASH, 'skills'].join(''),
  [WIN_DRIVE, BACKSLASH, WIN_SEG].join(''),
]

/** 合法形态：占位符根、正文样本、相对路径 —— 一条都不许被判成命中。 */
const LEGIT_TEXTS = [
  '<root>',
  '<projectRoot>',
  '<dshHome>',
  ['<root>', 'dsh-plugin-dev-mpff', 'SKILL.md'].join(SLASH),
  ['<projectRoot>', '.dsh', 'skills', ''].join(SLASH),
  ['<dshHome>', 'skills', ''].join(SLASH),
  '放在任意被扫描根的顶层',
  '见 README 的「目录结构」节',
  '根目录与优先级',
]

/** 边界：URL 形态与相邻目录名 —— 加宽词表后仍须零命中。 */
const URL_TEXTS = [
  ['http', ':', SLASH, SLASH, 'host', SLASH, 'home', SLASH, 'x'].join(''),
  ['127.0.0.1', SLASH, 'mnt', SLASH, 'x'].join(''),
  ['', SLASH, SLASH, 'host', SLASH, 'opt', SLASH, 'x'].join(''),
  ['', SLASH, 'rooted', SLASH, 'x'].join(''),
  ['home', SLASH, 'x'].join(''),
]

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 收集某个文件面上的命中（文件不存在则跳过）。 */
function hitsOf(paths) {
  const hits = []
  for (const path of paths) {
    const text = readIfExists(path)
    if (text === undefined) continue
    for (const hit of scanLeaks(text, { isMarkdown: true })) hits.push(`${path} -> ${hit.code} ${hit.match}`)
  }
  return hits
}

test('机器字面形态必被查出（判据 1：全部非空）', () => {
  const missed = MACHINE_TEXTS.filter((text) => scanLeaks(text, { isMarkdown: true }).length === 0)
  assert.deepEqual(missed, [], `这些机器形态没被查出：\n${missed.join('\n')}`)
})

test('占位符与正文样本不被误伤（判据 2 的占位符侧）', () => {
  const wrong = LEGIT_TEXTS.filter((text) => scanLeaks(text, { isMarkdown: true }).length > 0)
  assert.deepEqual(wrong, [], `这些合法文本被判成命中：\n${wrong.join('\n')}`)
})

test('URL 与相邻目录形态不被误判（加宽词表的边界）', () => {
  const wrong = URL_TEXTS.filter((text) => scanLeaks(text, { isMarkdown: true }).length > 0)
  assert.deepEqual(wrong, [], `这些 URL / 相邻形态被判成命中：\n${wrong.join('\n')}`)
})

test('公开面 md 零命中（判据 2：README 与 GLOSSARY）', () => {
  const hits = hitsOf(['README.md', 'GLOSSARY.md'].map((name) => join(repoRoot, name)))
  assert.deepEqual(hits, [], `公开面 md 出现泄漏模式：\n${hits.join('\n')}`)
})

test('skill 面 md 零命中（成品束内全部 markdown）', () => {
  const paths = [join(skillDir, 'SKILL.md'), ...REFERENCE_FILES.map((name) => join(skillDir, 'references', name))]
  const hits = hitsOf(paths)
  assert.deepEqual(hits, [], `skill 面 md 出现泄漏模式：\n${hits.join('\n')}`)
})
