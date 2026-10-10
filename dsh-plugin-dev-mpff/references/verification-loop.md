# 验证闭环

怎么证明它真的生效了？失败信号是什么？

## 证据三档

| 档 | 观察面 | 能证明什么 |
|---|---|---|
| A 组合层 | `--dump-config` 的层头与行 | 行进了合成树 |
| B 加载层 | 插件 `apply()` 自己打的日志出现在 boot 输出 | 插件真的被加载并执行了 |
| C 能力层 | 扩展点真被用上（工具出现在工具列表 / 钩子拦到一次调用） | 行为真的接上了 |

写死纪律：**A 不能代替 B 与 C**——被拒的插件行照样出现在 `--dump-config` 里。

## 一次性 profile 纪律

- `$env:DSH_HOME` 指向自建临时目录，**只改子进程环境**。
- `node "<cli>" --profile <profile> --from-default-profile web --dump-config` 会在 `<dsh-home>/profiles/<profile>/` 下落 **4 个文件**：`package.json`（`dsh.profile.bundles` 是层序真源）、`cordis.patch.yml`（用户层，默认 `[]`）、`pnpm-workspace.yaml`、`cordis.yml`（空根 `[]`，每次 boot/dump 都被重写）。
- **`--dump-config` 也是写**：它会重写 `<profile>/cordis.yml`。所以「只读地看别人的 profile」在这个宿主里不存在，闭环一律只碰自建 profile。
- `--profile desktop` 被 Electron 应用独占，直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。
- `plugin add` 会**自动初始化**缺失的 profile，但它只抄 `@deepseek-ai/dsh-base` ⇒ 这种 profile 启动后不返回（没有 app）。

## 9 步命令序列 + 每步失败信号

| # | 命令 | 预期 | 失败信号 |
|---|---|---|---|
| 0 | `node "<cli>" --version` | 单行纯 semver，exit 0 | `MODULE_NOT_FOUND` ⇒ 入口路径错；`'node' is not recognized` ⇒ 没有可用 Node |
| 1 | 建一次性 `DSH_HOME`，只改子进程环境 | 目录存在 | — |
| 2 | `node "<cli>" --profile <profile> --from-default-profile web --dump-default-config` | exit 0 + 完整组合树；profile 目录下 4 个文件 | `already exists at …` / `is shipped and cannot be a custom profile target` / `unknown default profile …` |
| 3 | `node "<cli>" plugin --profile <profile> add "<plugin-dir>"` | exit 0；`Done in … using pnpm v…`；`bundles` 追加 | `pnpm was not found`（exit 127）⇒ 用了不带 packageManager 的入口；`declares no dsh.bundle` ⇒ 该包不是插件；`installation rejected:` ⇒ peer 区间不满足 |
| 4 | `node "<cli>" --profile <profile> --dump-config` | exit 0；出现 `# == <包名>` 与 `- id: <行 id>` | 层头没有 ⇒ `dsh.bundle.patch` 路径写错；`profile "<p>" does not exist` ⇒ 第 2/3 步没成 |
| 5 | `node "<cli>" --profile <profile> --dump-config --patch "<overlay>"`（**`--patch` 写在 app 参数之前**） | 目标行的 `config` 变成 overlay 里那一份 | 目标行 config 没变 ⇒ overlay 被静默忽略（位置错）；stderr `patch: entry "<id>" not found` ⇒ id 拼错（**exit 仍 0**） |
| 6 | `node "<cli>" --profile <profile> --help` | app 用法 + 插件自己的标记行 | 标记不出现 ⇒ 包没被加载；命令不返回 ⇒ 该 profile 没有 app bundle |
| 7 | 静态自检三连（语法 / JSON / patch 目标存在） | 全部通过 | 见建包册 |
| 8 | `node "<cli>" plugin --profile <profile> remove <pkg>` 后再 `--dump-config` | 行与层头都消失 | 行还在 ⇒ `remove` 没成（看退出码与 pnpm 输出） |
| 9 | 清理：删掉一次性 `DSH_HOME` | 目录不存在 | 有进程仍占着文件 |

**必须记住的一条坑**：`--patch` 要写在 app 参数**之前**，否则被静默忽略。

## 一条断言 + code：config 整体替换

断言：overlay 只写 `config.nested.x` 时，组合结果里该行的 `config` 只剩 `{nested:{x:9}}`。code：`assembly.config-merged-not-replaced`。语义与两条独立实测路归 `references/package-and-assembly.md`。

## 一对可区分的信号

`node "<cli>" --profile <profile> --help` **真的 mount**（会执行插件 `apply()`）；三个 `--dump-*` **不 mount**。所以「标记行出现」是 B 档证据，「层头出现」只是 A 档。

## 卸载与残留

- 组合层**零残留**：`remove` 后 `--dump-config` 里提到该包的行与层头都是 0 条。
- 后续 patch 引用已删 id 会**大声报**（`patch: entry "<id>" not found`），但 **exit 0**——判据是 stderr 的字符串。
- 文件系统有残留：`node_modules/<包名>` 的 junction 还在，`.plugin-manager/logs/` 也保留。「卸干净了」只指组合层。

## 脚本化

```sh
node "<skill-directory>/scripts/verify-e2e.mjs"
```

- 退出码：`0` 通过 / `1` 断言不通过 / `2` 用法错误 / `3` 前提不成立（找不到 Node、CLI 或夹具）。
- stdout 是单份 JSON，顺序为 `steps` → `problems` → `ok` → `next`；进度在 stderr。
- 它报告三条：「装上了 / mount 了 / 卸干净了」。
- 上线前的形态门是 `node "<skill-directory>/scripts/check-plugin.mjs" --self`；长度量法与官方门禁同形——把正文按行渲染后取 `renderSkillContent` 的长度，用 `codePointLength`（`[...s].length`）比对，常数从脚本输出读。

## 边界

- C 档（工具真的出现在工具列表、钩子真的拦到一次调用）**未跑通**：本机没有模型凭据，只拿到 `MISSING_CREDENTIAL` 失败信号 ⇒ 本册对 C 档只写命令、观察面与失败信号，不写实测输出。自己复算的办法：跑 `node "<skill-directory>/scripts/verify-e2e.mjs"` 看 `problems[]`，再把与 C 档对应的步骤单独跑一遍。

## 相关

- profile 变量的读法与 `dsh-env.mjs` 的字段归 `references/env-discovery.md`。
