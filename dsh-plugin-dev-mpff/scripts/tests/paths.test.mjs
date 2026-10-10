// 脚本自身的单测（纯函数面）：每个反引号裸路径引用都存在 + 防失效守卫 + 目录集合相等。
//
// 运行命令（**显式文件列表**；目录参数不可用、glob 零命中会静默通过）：
//   node --test "<skill-directory>/scripts/tests/paths.test.mjs" "<skill-directory>/scripts/tests/locate.test.mjs"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REF_PREFIXES, extractRefs } from '../lib/skill-scan.mjs'

const testsDir = import.meta.dirname
const skillDir = resolve(testsDir, '..', '..')

/** 扫描面 = SKILL.md + references/*.md（与 check-plugin.mjs 的 S3 同面）。 */
function scanTargets() {
  const targets = [join(skillDir, 'SKILL.md')]
  const refDir = join(skillDir, 'references')
  for (const entry of readdirSync(refDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) targets.push(join(refDir, entry.name))
  }
  return targets
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

test('每个反引号裸路径引用都存在', () => {
  const missing = []
  for (const file of scanTargets()) {
    for (const ref of extractRefs(readText(file))) {
      if (!existsSync(join(skillDir, ref.target))) missing.push(`${file} -> ${ref.target}`)
    }
  }
  assert.deepEqual(missing, [], `缺失的裸路径引用：\n${missing.join('\n')}`)
})

test('防失效守卫：四类前缀各自的抽取数必须 > 0', () => {
  const counts = Object.fromEntries(REF_PREFIXES.map((p) => [p, 0]))
  for (const file of scanTargets()) {
    for (const ref of extractRefs(readText(file))) counts[ref.prefix] += 1
  }
  for (const prefix of REF_PREFIXES) {
    assert.ok(counts[prefix] > 0, `${prefix}/ 前缀的抽取数为 0 —— 该类的抽取正则很可能失效`)
  }
})

test('scripts/tests/ 的条目集合相等（多一个 / 少一个都失败）', () => {
  const actual = readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(actual, ['locate.test.mjs', 'paths.test.mjs'])
})
