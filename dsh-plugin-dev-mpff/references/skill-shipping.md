# 随包分发 skill

把一份 skill 放进你自己的插件包，让装了包的人真的拿到它。两条链：**投递**（skill 目录进发布产物）与**认领**（把那个位置报给发现机制）—— 两者可以各自单独失效。

## 先分清两件事

包里放了 skill 目录，只是文件到了磁盘；宿主扫到那个位置，skill 才进会话目录。**包里放了 skill 目录不等于它会被发现** —— 阴性判据的可执行形态见下「否定面」。

## 链 1：投递 + 用 `bundledSkillDir` 认领（主线）

### 最小形态（三个文件）

1. `package.json`：`files` 覆盖 skill 目录，`dsh.bundle.patch` 指向 patch 文件 —— 这是 manifest 里唯一跟 skill 有关的开关。
2. `cordis.patch.yml`：插一行 `@deepseek-ai/dsh-skill-filesystem`，给它 `bundledSkillDir`。
3. `skills/<name>/SKILL.md`：skill 本体，frontmatter 带 `name` 与 `description`。

```json
{
  "name": "@local/my-skill-pack",
  "version": "1.0.0",
  "private": true,
  "files": ["skills", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: my-skill-filesystem
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: my-pack
        includeDefaultRoots: false
        bundledSkillDir: !!js ctx.get('profileContext').dir + '/node_modules/@local/my-skill-pack/skills'
```

- **`config` 是整体替换，不是合并**：同一行本来若还有别的键，你写下的 `config` 会顶掉它，把需要的键一次写全。
- **`bundledSkillDir` 必须是启动期能解析的绝对路径**：相对路径按宿主进程的启动目录解析（既不是包目录，也不是 profile 目录），所以用 patch 里的内联表达式现算。`ctx.get('profileContext').dir` 是当前 profile 的目录，包就装在它的 `node_modules` 下。表达式在 loader 的作用域里求值，`ctx` 与 `process` 可读；`process.env.DSH_PROFILE_DIR` 会从父进程继承，未必指向当前 profile，所以位置从 `ctx` 现算。
- **`providerName` 是注册进 skill 注册表的唯一名**：同进程里两个 provider 同名会互相顶掉。
- **想只看见自己那一根，就显式写 `includeDefaultRoots: false`**（默认是 `true`）：它掐掉项目根、用户根与那条默认随包根的回退路，而显式 `config.bundledSkillDir` 不受它门控。不写也照样被发现，只是那些根会一起被扫。
- 这条链**不需要写 provider 模块**：没有 JS 文件，只有上面三个文件加一行内联表达式。

### 打包证明

本地 `link:` 安装不过滤 `files`，「本地看起来在」不算证据。

```text
npm pack --dry-run
```

实测输出（一次性工作目录里的最小包）：

```text
npm notice package: @local/my-skill-pack@1.0.0
npm notice 282B cordis.patch.yml
npm notice 210B package.json
npm notice 254B skills/probe-skill/SKILL.md
npm notice total files: 3
```

判据：`skills/<name>/SKILL.md` 出现在 Tarball Contents 里。失败信号：它不在列表里 ⇒ `files` 没覆盖到那个目录。

### 装包证明

```text
npm pack
node "<cli>" plugin --profile <临时 profile> add <tarball>
node "<cli>" --profile <临时 profile> --dump-config
```

实测输出：装包 `exit 0`，且 `--dump-config` 里出现该包的层头与行（本机路径已略）：

```text
+ @local/my-skill-pack file:<tarball>
# == @local/my-skill-pack
- id: my-skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: my-pack
    includeDefaultRoots: false
    bundledSkillDir: !!js >-
      ctx.get('profileContext').dir +
      '/node_modules/@local/my-skill-pack/skills'
```

**失败信号（不是退出码）**：stderr 上出现

```text
dsh: warning: <包名> declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

这时包被降级成普通依赖，而 CLI 下 `exit` 依然是 0 ⇒ 判据只能是那条字符串。另一条入口的后果不同：服务 / Web 侧缺 `dsh.bundle` 抛 `not-bundle`，不是 warning。

### 发现证明与加载证明

在一次性 `DSH_HOME` + 临时 profile 下**新开一个会话**，看宿主自己的两份输出：

1. **被发现** —— 会话里那条目录消息（`<available_skills>` 块，宿主在首个请求前写入的持久消息）。判据 = 你的 `name` 出现在列表里；失败信号 = 名字**完全不出现**（不是出现 error）。
2. **被加载** —— `skill` 工具返回的 `<skill_content>` 块。headless 会话加 `--json`，事件流里能看到这一对：

```text
{"type":"tool_call","callId":"call_1","tool":"skill","input":{"name":"my-skill"}}
{"type":"tool_result","callId":"call_1","status":"completed","result":"<skill_content name=\"my-skill\">\n<skill_resources>\nBase directory for this skill: <profile>/node_modules/@local/my-skill-pack/skills/my-skill\n…"}
```

实测（本机，一次性 profile）：两条都成立，`Base directory for this skill:` 指向包内那个目录 —— 这就是「认领」接上的证据。

### 否定面（两条，各自独立 PASS/FAIL）

- **移除之后不再出现**：`node "<cli>" plugin --profile <临时 profile> remove <包名>` 之后再开会话，目录消息里不含该名字（实测命中数 0）。
- **只投递、不认领时本来就不出现**：包照常装上、`skills/<name>/SKILL.md` 也在磁盘上，但 patch 不把那个位置报给任何根 ⇒ 目录消息里没有它。这就是「只做链 1、不做链 2」的后果（实测：包已安装、文件在盘、命中数 0）。

## 链 2：位置不在默认根里时，自己写一个 provider

链 1 只能报「磁盘上的一个目录」。位置没法用 `bundledSkillDir` 表达时，自己写 provider 注册进 skill 服务：patch 里插一行，`name` 指向你自己的模块。

```js
export const inject = ['skills']

export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name: 'my-pack',
    async list(options) { /* 返回候选数组 */ },
    async get(candidate, options) { /* 返回 definition */ },
  }))
}
```

**provider 契约（纯事实）**：

- 注册面三个成员：`name`、`list(options)`、`get(candidate, options)`。**只有 `name` 必须同步可读**（注册期就读）；`list` / `get` 会被 `await`，写成 `async` 是正常的。
- **工厂本身必须同步**：异步工厂会注册成一个 `name` 为 `undefined` 的 provider —— 首次注册不报错，到 `list()` 才降级成一条 warning。
- `control` 恰两键 `{ signal, invalidate }`：`list` / `get` 由它拿中止信号，并在自己的目录变化时调 `invalidate()`。
- **候选必需 5 个字段**：`name`、`description`、`source`、`rank`（有限数）、`provider`；其中 `provider` 必须逐字等于 provider 自己的 `name`。
- **loaded definition 必需 5 个字段**：`name`、`description`、`source`、`provider`、`content`。`rank` 是候选专有，definition 上不校验。
- 注册名为 `runtime` 的 provider 在注册期抛错。
- **释放**：注册契约里没有 `dispose` 这个成员，释放信号是 `control.signal`；第一方实现另外自带 `dispose()` 并由自己的 effect 与 signal 监听调用 —— 照抄那份 `dispose` 是多余的。

## 另一种投递方式：改 composition 的额外 skill 根

宿主组合里也能加一个额外的 skill 根，但**只有当你的包本身发 preset、或者你的包是别人 composition 里的一行时才用得上**；普通第三方插件包装不了自己那一行，这条路通常与你无关。做法与适用面以宿主 skill 提供方包自己的文档为准（见下节读法），本册不给例子。

## 读宿主，不抄值

根清单、优先级、认领的两种目录形态、发现深度这些随 rc 变的事实，一律现场读：

```text
node "<skill-directory>/scripts/dsh-env.mjs"
```

从输出里的 `host.packageDir` 找到宿主包目录，再读其中 skill 提供方包文档的「根目录与优先级」一节。本册只写配置键名（`customSkillDirs`、`bundledSkillDir`、`includeDefaultRoots`、`list`、`get`），优先级数值与根清单不抄。

## 排障：skill 明明在包里，为什么模型看不到

| 症状 | 先看哪一步 |
|---|---|
| 装包输出里有 `declares no dsh.bundle` | manifest 没声明成 bundle ⇒ 被降级成普通依赖 |
| `--dump-config` 里没有你的层头 | 包没成为 profile 的一层 |
| 层与行都在，目录消息里没有名字 | 那个位置没被任何根覆盖 ⇒ 认领没接上 |
| 名字在，但 `skill` 工具报未知 | 加载期会重新校验定义：`name` 或 `provider` 不合契约 |

## 形态取舍（一句话）

随包 skill 收的是「装了包就跟着到」这个耦合；只有 skill、没有包要发的场景，直接 clone 那个目录就够 —— 两条路各自成立，按场景挑一条。

## 出界

- 从网络或数据库取 skill 属宿主开发，本册不覆盖。
- 本册只讲第三方插件作者够得着的手段；改宿主自己的发现逻辑不在范围内。本册的判据在一次性 profile 里跑，正在用的那个 profile 保持不动。

## 参考

- 包形态与 patch 层序：`references/package-and-assembly.md`、`references/build-a-package.md`
- 一次性 profile 与失败信号表：`references/verification-loop.md`、`references/failure-modes.md`
- 升级后重新核对：`references/drift-recheck.md`
