# manifest 与装配

`package.json` 的 `dsh` 块决定「这份包是不是一个可挂载插件」；`cordis.patch.yml` 决定「往合成树里加什么、改什么」。本册给字段权威、合成顺序、patch 语义与 `config` 语义。

## 字段的唯一权威

字段集合与必需性的唯一权威是 manifest 类型定义。现读，不抄快照：

```sh
gh api repos/deepseek-ai/deepseek-harness/contents/packages/util/package-manifest/src/types.ts --jq .content | base64 -d
```

本机侧的对等读法：`node "<skill-directory>/scripts/dsh-env.mjs" --list-packages` 列出宿主包，再读各自 `@deepseek-ai/dsh-package-manifest` 的 README 与导出。

| 字段 | 必需性 |
|---|---|
| `name` / `version` | 必需 |
| `dsh.bundle.patch` | 出现 `dsh.bundle` 时必需 |
| `dsh.client.platform` | 出现 `dsh.client` 时必需 |
| `dsh.manifestVersion` | 可选，且当前没有任何运行时读取点 |
| `engines.dsh` | 在**顶层**、与 `dsh` 平级；语义是「声明式」——在有人真的读它之前不生效 |

## 幽灵字段

`dsh.compatibility.dshReleases` 与 `dsh.install.*` 在上游**不存在**：前者在上游仓库全仓 code search 命中 0，是第三方插件自造后流传开的约定（流传那句「只存活约 13 小时」逐字复核后对不上——13 小时那个窗口属于 `dsh.engines` 从 `dsh` 块搬到顶层）；后者从来不是 manifest 字段，它是 CLI 输入形态 `ParsedInstallSpec`。配一条纪律：**manifest 字段从类型定义学，不从生态插件实例学**——本机装着的插件里就有把 `engines` 写在 `dsh` 块内的。

## 合成顺序：四层 + 条件性第五层

有效配置从一个空根出发，按顺序叠加，**后叠者胜**：

1. `dsh.profile.bundles` 列表里每个 bundle 的 patch，按列表顺序（`@deepseek-ai/dsh-base` 恒第一，其余按装入顺序）。
2. profile 自己的 `cordis.patch.yml`。
3. `$DSH_HOME/cordis.patch.yml`——机器级偏好，被所有 profile 共享。
4. 每个 `--patch <path>` overlay，按 argv 顺序。
5. 仅当 `DSH_TELEMETRY_DISABLED` 非空**且**组合里存在 telemetry 行时追加的那一条。

bundle 的解析锚点是「安装优先」：先查 dsh 安装锚点，再查 profile 目录，保证 in-box bundle 与运行中的 dsh 同源。

## 三条容易踩的

- 一个 bundle 层内部可以有**多个 patch 文件**：`dsh.bundle.patch` 是单个路径或有序文件列表，它们作为**同一层**按序应用。
- profile 的 `cordis.yml` **每次 boot 都被重写为 `[]`**，它不是内容源；内容源只有上面那几层 patch。原因是 Loader 的 tree write-back 会把组合后的行烘进该文件，下次 boot 就会重复插入。
- 空文件或只有注释的 `cordis.patch.yml` 会让 boot **失败**；要禁用该层，写 `[]`。

## patch 语义

- 顶层是数组。`- insert:` 块插入新行；其余条目按 `id` 命中既有行做覆写。
- 非 insert 条目没有非空 `id` 时，被当作 no-op 接受，并给一条 Loader warning。
- 用户层 `cordis.patch.yml` 要加新行，只能写 `- insert:`。
- 未命中 id 只 warn + skip，**exit 0**——判据是 stderr 的字符串，不是退出码。

## config 是整体替换

**结论**：patch 里的 `config` 是**整体替换**，既不是深合并，也不是浅合并。只写 `config.nested.x` 会让同级键与同层兄弟键一起消失。

**机制锚点**：`vendor/include/src/index.ts` 的 `applyEntryPatches` 对命中行做逐键赋值后整体替换，代码里没有任何 merge 步骤。

**两条互相独立的实测路**（自己复算时两条都走）：

- 组合层：`node "<cli>" --profile <profile> --dump-config --patch "<overlay>"`，看目标行的 `config` 是否只剩 overlay 里那一份。
- 加载层：在插件 `apply(ctx, config)` 里打一行标记，跑 `node "<cli>" --profile <profile> --help` 真 mount，看它收到的 config。

**三条补充实测**：替换粒度是整份 `config`，不是逐键；`--dump-config` 的层头会标出改过该行的 overlay；`!!js` 表达式的插值发生在加载期，晚于 patch 组合。

**唯一会让人误判成「深合并」的东西**：schema 默认值填充。缺失键在 Config 校验后会被 schema 默认值补上，看起来像「没被删」。

## !!js 允许出现的位置

`!!js` 只允许出现在两个字段的**值**上：插件行的 `config`（在声明的 inject 激活后、针对该插件自己的 ctx 求值）与行的 `disabled`（每次 mount 决策时针对 loader ctx 求值）。其余条目元数据（`id` / `name` / `group` / `inject`）保持字面量。Group 与 Include 自己的 `config` 不求值，因为里面装的是**别的行**的 config。

写法是 `!!js`，而不是 `!js`（后者是未注册的本地 tag）。

回显验证：`node "<cli>" --profile <profile> --dump-config` 逐字回显表达式；`--dump-config-schema` 以惰性形态（`__jsExpr` / `loaderExpression`）记录它而不求值。

## dsh.bundle.patch = 「是不是一个可挂载插件」的判据

- `dsh.bundle.patch` 的类型是 `string | string[]`，路径相对**声明包根**解析。
- 带 `./` 与不带的两种写法宿主都接受；本规格钉死其中一种，取值见 `references/build-a-package.md` 的钉死值清单。
- **不是插件**的判据：没有 `dsh.bundle`。后果：装成普通依赖，只给一次性 warning（`declares no dsh.bundle — installed as a plain dependency, not a profile layer`），不入层栈，合成树里看不到它。

## 就地校验

```sh
node "<cli>" --profile <profile> --dump-config
```

- 看层头 `# == <包名>` 与行 `- id: <行 id>`。层头语法：`# == <label>` 是「提供这些行的层」，被后续层改过则追加 `, patched by <层>`；bundle 层的 label 是包名，profile 用户层与 `--patch` 层的 label 是文件绝对路径。
- `--dump-default-config` **看不到** patch 未命中告警——它跳过 profile 用户层与 overlay，只打 bundle 层。

## 边界

- `applyEntryPatches` 是否被改写过（上游把它从私有方法提成导出纯函数）**只有一条旁证**，本次未逐行复核它的历史 ⇒ 标**残留风险**。自己确认的办法：按上面「两条互相独立的实测路」各跑一次，两路一致就说明当前实现仍是整体替换；单跑一条时用 `node "<cli>" --profile <profile> --dump-config` 对照层头。

## 相关

- 验证流程、证据分档与失败信号见 `references/verification-loop.md`。
- peer 闸门与发布前的兼容性声明见 `references/release-and-distribution.md`。
