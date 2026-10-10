---
name: dsh-plugin-dev-mpff
description: 'Build, modify, publish, or debug a dsh (DeepSeek Harness) plugin: dsh 插件开发、新建插件、插件包骨架、bundle patch、cordis.patch.yml、cordis 组合、宿主插件、client manifest、前端/UI 插件、扩展点选择、本地安装与验证、npm 发布、插件静默失效排查。Use when authoring, packaging, installing, verifying, publishing, or debugging a third-party dsh plugin. Do not use for using or configuring an already installed plugin, for editing a shipped preset, or for dsh host development.'
---

# dsh 第三方插件开发

从零写出一个 dsh 插件、证明它生效、把它发出去。第三方插件只挂已文档化的扩展点；宿主主循环与官方发行版自带插件不在范围内。

## 硬约束

1. 环境值一律经 `scripts/dsh-env.mjs` 解析（`<cli>` / `<dsh-home>` / `<profile>` / `<dsh-install>`），解析不到就大声失败。—— 理由：占位符表归 `references/env-discovery.md`。
2. 安装与验证只在自建的一次性 profile 里做；别人的 profile 只读变量。—— 理由：一次性 profile 的完整纪律见 `references/verification-loop.md`。
3. 发现逻辑只有一处实现：CLI 候选链住在 `scripts/dsh-env.mjs`，其余位置只调用它。—— 理由：单一真源。
4. 产物一律落 `--work-root`（默认 OS 临时目录）；skill 目录是只读资源。—— 理由：Desktop 下 skill 目录可能落在 `app.asar` 内，只有宿主进程自己的文件读取能打开它。
5. 断言失败就 `FAIL` 并给出 code。—— 理由：失败信号表见 `references/verification-loop.md`。
6. 指针一律写反引号裸路径：`references/` 或 `templates/` 前缀加文件名。—— 理由：官方门禁与 `scripts/check-plugin.mjs` 只认这种形态，markdown 链接不被校验。
7. 版本号、bundle 列表、包数只写读取命令。—— 理由：易变状态，读法归各册。

## 先看这里：任务 → 文件

| 你要做的事 | 读哪一份 |
|---|---|
| 找到可用的 CLI / 安装根 / Node / profile | `references/env-discovery.md` |
| 写 `package.json` 的 `dsh` 块、理解 patch 与层序 | `references/package-and-assembly.md` |
| 决定挂哪个扩展点（工具流水线 / 前端槽位 / 事件） | `references/extension-points.md` |
| 从零建一个包，逐文件写法 | `references/build-a-package.md` |
| 写前端 / UI 半边（`dsh.client`、`client.js`） | `references/frontend-plugin.md` |
| 证明它真的生效了 | `references/verification-loop.md` |
| 发到 npm / 说清兼容性 | `references/release-and-distribution.md` |
| 它没生效，或静默什么都不做 | `references/failure-modes.md` |
| 升级 dsh 之后重新核对 | `references/drift-recheck.md` |
| 复制一个能跑的起点 | `templates/host-only/` 或 `templates/frontend/` |
| 端到端跑一遍闭环 | `examples/hello-plugin/` + `scripts/verify-e2e.mjs` |
| 用脚本做环境发现 / 静态自检 / 装配验证 | `scripts/dsh-env.mjs`、`scripts/check-plugin.mjs`、`scripts/verify-assembly.mjs` |

## 流程（5 步，每步带完成判据）

1. **定位环境** —— 判据：`node "<skill-directory>/scripts/dsh-env.mjs"` 输出单份 JSON 且 `ok: true`，`<cli>` 与 `<dsh-home>` 非空。
2. **定形态** —— 判据：写下一行决定（纯宿主 / 宿主 + 前端），并给出所选扩展点的就地校验命令与它的输出。
3. **建包** —— 判据：`node "<skill-directory>/scripts/check-plugin.mjs" --plugin-dir <包目录>` 输出 `ok: true`。
4. **证明生效** —— 判据：`node "<skill-directory>/scripts/verify-e2e.mjs"` 退出码 0，且它报告了「装上了 / mount 了 / 卸干净了」三条。
5. **发布** —— 判据：`references/release-and-distribution.md` 的三条硬规则与 peer 闸门逐条核过，破坏性变更已写进公告。

## 指针与资源寻址

- base directory 由 `skill` 工具报出（渲染块里的 `Base directory for this skill: …`），所有相对路径按它解析。
- 分册用文件读工具读取；skill 目录可能落在 `app.asar` 内，只有宿主进程自己的文件读取能打开它。
- 复制模板：先读、再写进工作区，在工作区里检查与安装。
- 脚本调用写成 `node "<skill-directory>/scripts/…"`。
- 长度纪律：入口正文与每一册都按 ≤7000 code point 写（硬上限 8192，量法含渲染外壳与 base directory 绝对路径）。
