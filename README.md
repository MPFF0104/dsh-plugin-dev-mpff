# dsh-plugin-dev-mpff

## 这是什么

一个给「dsh（DeepSeek Harness）第三方插件作者」用的 skill —— 覆盖从零写出一个插件、证明它真的生效、把它发出去的全过程。

## 覆盖什么（任务清单）

- **找 CLI / 安装根 / Node / profile** —— 先确认这台机器上的 dsh 环境在哪，再动手
- **写 manifest 与 patch** —— `package.json` 的 `dsh` 块、bundle patch 与层序
- **挑扩展点** —— 决定挂工具流水线、前端槽位还是事件
- **从零建包** —— 逐文件写出一个能跑的插件包
- **写前端半边** —— `dsh.client` 与 `client.js`
- **验证真的生效** —— 装上、mount、卸干净，每一步都有判据
- **发布与兼容性声明** —— 发到 npm 时要说清的兼容性面
- **排查静默失效** —— 插件装上了却什么都不做，从哪开始查
- **升级后重新核对** —— dsh 升级之后，哪些事实必须重新确认

## 边界在哪（不覆盖什么）

- 不覆盖「使用或配置一个已装插件」—— 那是使用者的事，不是作者的事
- 不覆盖「改 shipped preset」—— 官方发行版自带的组合不在第三方扩展点里
- 不覆盖「dsh 宿主本身开发」—— 宿主主循环与官方自带插件不在范围内
- 不覆盖「安装或放置这个 skill 本身」—— 落点与优先级由宿主自己的 skill 发现规则决定，本仓库不写安装步骤

## 怎么被触发

本 skill 靠 frontmatter 的 `description` 被模型发现与触发：读者不必记路径，说清「我在写 / 装 / 发 / 查一个 dsh 插件」就够了。

- **触发面**（`description` 里的中文触发词）：dsh 插件开发、新建插件、插件包骨架、bundle patch、cordis.patch.yml、cordis 组合、宿主插件、client manifest、前端/UI 插件、扩展点选择、本地安装与验证、npm 发布、插件静默失效排查
- **排除面**（`description` 的 `Do not use for …` 一段）：使用或配置一个已装插件、改 shipped preset、dsh 宿主本身开发

`description` 是触发词与排除面的唯一真源，本节只是它的索引。被触发之后，`SKILL.md` 是唯一入口：路由表与 5 步流程在那里，其余内容（9 册分册、两套模板、闭环夹具、脚本）按需加载。

## 目录结构

```text
README.md
LICENSE
.gitignore
dsh-plugin-dev-mpff/
├── SKILL.md
├── references/
│   ├── env-discovery.md
│   ├── package-and-assembly.md
│   ├── extension-points.md
│   ├── build-a-package.md
│   ├── frontend-plugin.md
│   ├── verification-loop.md
│   ├── release-and-distribution.md
│   ├── failure-modes.md
│   └── drift-recheck.md
├── templates/
│   ├── host-only/
│   │   ├── package.json
│   │   ├── cordis.patch.yml
│   │   ├── index.js
│   │   ├── icon.svg
│   │   └── locale/
│   │       └── en.json
│   └── frontend/
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── index.js
│       ├── client.js
│       ├── icon.svg
│       └── locale/
│           └── en.json
├── examples/
│   └── hello-plugin/
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── index.js
│       ├── client.js
│       ├── icon.svg
│       └── locale/
│           └── en.json
└── scripts/
    ├── dsh-env.mjs
    ├── check-plugin.mjs
    ├── verify-assembly.mjs
    ├── verify-e2e.mjs
    ├── lib/
    │   ├── dsh-locate.mjs
    │   └── skill-scan.mjs
    └── tests/
        ├── paths.test.mjs
        └── locate.test.mjs
```
