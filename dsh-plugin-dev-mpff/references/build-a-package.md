# 从零建包

最小可跑的包长什么样、逐文件怎么写、怎么自检。

## 宿主半边最小文件树

```text
<包目录>/
├── package.json
├── cordis.patch.yml
├── index.js
├── locale/en.json
└── icon.svg
```

五个文件、扁平一层。`templates/host-only/` 就是这一套的可复制形态。

## 前端半边的增补

在上面五个文件之外加 `client.js`，并在 `package.json` 里声明 `dsh.client` 与 `exports['./client']`——两者必须配套。前端写法见 `references/frontend-plugin.md`。

## 逐文件写法

| 文件 | 必写 | 可选 | 常见写错 |
|---|---|---|---|
| `package.json` | `name` / `version` / `private: true` / `type: "module"` / `exports["."]` / `files` 覆盖每个运行时资源 / `dsh.bundle.patch` | `exports['./locale/*.json']` 与 `exports['./icon']`（展示面路由） | 写 `main`（第二个真源）；顶层 `icon`；把 `engines` 写进 `dsh` 块 |
| `cordis.patch.yml` | 顶层数组 + 恰好一个 `insert` 块 + 行 `id` 与 `name` | `config` / `disabled` / `!!js` | 空文件或只有注释（boot 会失败）；`name` 不逐字等于 `package.json` 的 `name` |
| `index.js` | `export function apply(ctx, config) {}`，形参写出来 | `inject` / `Config` / 具名导出 `name` | 混用默认导出；在 `apply` 里抛错（模板要在任意机器上能 mount） |
| `locale/en.json` | `{"meta": {"title": …, "description": …}}`，两值都非空 | 兄弟语言文件（语言名匹配 `^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`） | `meta` 为空串（宿主报 `must be a non-empty string`） |
| `icon.svg` | `xmlns` 与 `viewBox`；自包含 | 任意矢量图形 | `<script>` / 外部 `href="http…"` / `<image>`；超过 256 KiB |

三条硬关系：

- 声明了 `dsh.client` 就**必须**有 `./client` 导出：缺失会大声抛错。
- `icon.svg` 要在 `exports` 与 `files` 里同时出现。
- `files` 必须覆盖 patch 引用的**每一个**运行时文件；本地 `link:` 安装不过滤 `files`，所以这条只能靠 `npm pack --dry-run` 或逐个核对 tarball 来证明。

## 规格钉死项（本规格决定）

同一件事生态里有多写法，本规格各取一种并钉死：

| 项 | 钉死值 | 理由 |
|---|---|---|
| `dsh.bundle.patch` 写法 | `"./cordis.patch.yml"`（带 `./`） | 上游官方模板、上游教程、base bundle 都带 `./`；两种写法宿主都接受，而官方推荐写法**无证据**，所以取与官方模板一致的那一种 |
| patch 行 `id` | 包名去 scope（`@local/my-plugin` → `my-plugin`） | 生态里 `id` 与包名不可互推，规则必须写死，否则同一 profile 会抢同一个 id |
| 行 `name` | `package.json` 的 `name` 逐字 | 它是 Node 解析用的包 specifier |
| 包名（模板） | `@local/my-plugin` + `"private": true` | 脚手架标识、防误发布；`private` 不阻碍本地 `link:` 安装 |
| 入口声明 | 只写 `exports["."]` | 生态一致；实测无 `main` 也能装能 mount |
| `peerDependencies` | 它是真闸门，策略与区间形状归发布册 | 缺 peer 等于闸门无约束；写了错区间反而随宿主升版硬拒装 |
| `dsh.client` 三字段 | `platform: "web"` / `immediately: true` / `inject: []` | `platform` 必须是字面量 `web`；`inject` 取空数组等价于不写，且不引入会漂的包名 |

## 静态自检三连（不启动 dsh）

```sh
node --check <包目录>/index.js
node -e "JSON.parse(require('node:fs').readFileSync('<包目录>/package.json','utf8'))"
```

第三连是「patch 指向的文件存在」：读 `dsh.bundle.patch` 的值，在包根下逐个核对文件在。三连过了再接一条形态门：

```sh
node "<skill-directory>/scripts/check-plugin.mjs" <包目录>
```

判据是 `ok: true` 且 `problems[]` 里 `severity === 'error'` 的条数为 0。

## 从模板起手

读 `templates/host-only/`（纯宿主）或 `templates/frontend/`（带前端半边），把文件**写进工作区**，在工作区的副本里做上面那三连与安装。skill 目录是只读资源，产物一律落 `--work-root`。

## 边界

- 宿主半边最小文件树的完整形态由本规格的 `templates/host-only/` 补上——上游只有参考形态，没有一份「最小文件树」成文。
- `bundle.patch` 与行 `id` 的官方推荐写法**无证据**，上面那张表给的是**本规格决定**，不是上游规则。自己确认的办法：`node "<skill-directory>/scripts/check-plugin.mjs" <包目录>` 会把包名、patch 路径与行 `id` 一起报出来，再对照宿主 `node "<cli>" --profile <profile> --dump-config` 的层头与行。

## 相关

- 运行期验证、证据分档与失败信号见 `references/verification-loop.md`。
- `bundle.patch` 的语义与「是不是插件」判据见 `references/package-and-assembly.md`。
