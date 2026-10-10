# 发布与分发

怎么发出去、兼容性怎么声明、破坏了什么要公告。

## npm 的三条硬规则

1. 包名**不含大写字母**——npm 服务端直接拒。
2. scoped 包要 `publishConfig.access: "public"`，或发布时带 `--access public`。
3. 发布账号须满足 2FA，或使用带 bypass-2FA 的 granular access token。

**不是规则的三项**（常见误解）：`dsh-<name>` 前缀不是 npm 要求；kebab-case 不是 npm 要求；provenance 不是发布前提。

## files 必须覆盖什么

`files` 要覆盖 patch 引用的**每一个**运行时文件：`index.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`，带前端半边时再加 `client.js`。本地 `link:` 安装不过滤 `files`，所以这条只能靠 `npm pack --dry-run` 或逐个核对打出来的 tarball 证明。逐文件写法与静态自检见 `references/build-a-package.md`。

## 可发现性

`dsh-plugin` GitHub topic 是官方**唯一**约定的可发现性手段：给插件仓打上它。产品内**没有第三方市场**——唯一的目录是两个第一方 bundle。

## 三条分发通道与安装形态

- **registry**：`node "<cli>" plugin --profile <profile> add <包名>`。
- **path / tarball**：本地路径（当前目录与上一级目录的各种写法及其 `file:` / `link:` 形态会被锚定到调用目录）与打出来的 tarball。
- **git**：`github:<owner>/<repo>` 形态；作者要自包含 `prepare`，用户侧要加 `allowBuilds`。

`ParsedInstallSpec` 是 **CLI 输入**形态，不是 manifest 字段——它只描述「怎么装」，不描述「包是什么」。

装完之后 bundle 调和三条：有 `dsh.bundle.patch` ⇒ 追加进 `dsh.profile.bundles`；没有 `dsh.bundle` ⇒ 只装依赖 + 一次性 warning；被移除 ⇒ 同时离开层栈。

## 兼容性声明

- **真闸门**是 `peerDependencies` 上的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 那族；`@deepseek-ai/cordis` 那族**不在**闸门内。区间不满足时宿主报 `incompatible-version` 并给出精确救济命令。
- `engines.dsh` 在**顶层**、与 `dsh` 平级，语义是声明式：在有人真的读它之前不生效。
- profile 目录级 `compatibility.json` 是**豁免面**（精确 `包@版本` → 放行的宿主版本列表），且**不跨升级继承**——升一次 dsh 就要重新确认。
- 多段并列区间只在「跨 0.x minor 且两段都真跑过」时用，并且不写显式上界。

## 破坏性变更与公告

以下是**本仓库建议，非上游事实**：走 SemVer 主版本；旧行 `id` 保留一个版本；先用 `-alpha.N` / `-rc.N` 发预发布验证通道。另外，`config` 是整体替换，改 patch 里某个键时，公告要点明「同级键会一起消失」。

## 无门槛三连

没有收录申请、没有审核、没有插件签名。npm 侧 2FA 是**发布者账号**的门槛，不是插件准入的门槛。

## 边界

- 真实 `github:` 远端安装、zip 安装路径、`plugin update` 后的调和**均未实测**；这三条给的是形态与命令，不是实测输出。自己复算的办法：三条各跑一遍 `node "<cli>" plugin --profile <profile> add "<spec>"`，只看 exit 0 与 `--dump-config` 的层头，不把推断当结论。

## 相关

- 本地安装、卸载与残留归 `references/verification-loop.md`。
