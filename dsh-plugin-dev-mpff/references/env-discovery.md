# 环境发现

任何任务的第一步都是拿到四个值：这台机器上可用的 CLI 入口、安装根、独立 Node、以及宿主注入的 profile 变量。本册给取值办法与候选链，值本身一律现读。

## 占位符表

全文用五个尖括号占位符；值一律由 `scripts/dsh-env.mjs` 填，手写值会随机器失效。本册是这张表的唯一 owner，其余册照用、不重定义。

| 占位符 | 含义 | 取法 |
|---|---|---|
| `<cli>` | dsh CLI 入口 | `dsh.cliPath`；`cliKind` 为 `js` 时用 `node "<cli>"` 调用 |
| `<dsh-install>` | 安装根 | `dsh.installRoot` |
| `<dsh-home>` | 宿主 home | `home.dshHome` |
| `<profile>` | 当前 profile 名 | `home.profile` |
| `<skill-directory>` | 本 skill 目录 | 解析规则归入口的「指针与资源寻址」节 |

## 一条命令拿全部

```sh
node "<skill-directory>/scripts/dsh-env.mjs"
```

stdout 是单份 JSON（`tool` / `contractVersion` / `node` / `dsh` / `home` / `host` / `problems` / `ok` / `next`）。关键格：

| 格 | 读它做什么 |
|---|---|
| `node.{path,version,electron,source,usable}` | `electron: true` 表示这是 Electron 运行时，当独立 Node 用会出错 |
| `dsh.{cliPath,cliKind,version,verified,installRoot}` | `cliKind` 为 `js` 时用 `node "<cli>"`；`verified` 是「真跑过 `--version` 并拿到版本」 |
| `dsh.shim.{path,exists,usable,reason}` | **最有用的一格**：PATH 上那个 `dsh` 的实测结论，「存在但不可用」是常态 |
| `home.{dshHome,profile,profileDir,sessionId}` | 直读宿主注入变量，缺席一律 `null` |
| `host.packageDir` | 宿主包目录；`--list-packages` 与注入名检查的名字来源 |

参数：`--dsh-cli <path>` / `--dsh-install <dir>` / `--node <path>` 显式指定；`--no-exec` 只列候选不执行（`usable` 全为 `null`）；`--list-packages` 附带宿主包清单；`--timeout-ms <n>` 单候选探测超时（默认 10000，超时算不可用）。

## CLI 候选链（8 条，顺序即契约）

顺序即契约，唯一实现落在 `scripts/dsh-env.mjs`，其余位置只调用它。**每一级都必须执行验证**：存在性不是可用性判据。

1. `--dsh-cli <path>` 显式指定；指了路却不存在就报 `explicitMissing`，不回退自动探测。
2. PATH 上的 `dsh`。必须真跑 `--version`；本机这条 shim 的启动行指向 `resources/app.asar/…`，而发行版已展开成目录，所以它存在却报 `MODULE_NOT_FOUND`。
3. `<dsh-install>/resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`。桌面发行版的实际入口；它给 CLI 注入发行版自带的 pnpm 与 Electron-as-node 环境。
4. **Electron-as-node**：`"<dsh-install>/DeepSeek Harness.exe"` + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals` + 同一条 `cli.js`。桌面发行版里唯一不依赖系统 Node 的通道。
5. `<dsh-install>/resources/app.asar/<rel>`：归档形态的候选，只列作诊断线索——本机发行版是目录形态，这一条通常不存在。
6. `<dsh-install>/resources/app.asar.unpacked/<rel>`：显式尝试并留痕，不静默跳过。
7. 从 PATH shim 所在目录向上找 `resources/`，再试 `resources/app/<rel>`。
8. 全不可用 ⇒ `undefined`，调用方记 `env.cli-not-found`。

## Node 候选链（6 条）

1. `--node <path>` 显式指定。
2. `process.execPath`：仅当 `process.versions.electron === undefined`；打包环境里它是 Electron 可执行文件。
3. PATH 上的 `node`（`where` / `which` 取第一行）。
4. `<dsh-install>/resources/runtime/primary-runtime/dependencies/node/bin/node{.exe}`：随发行版的独立 Node，实测无 Electron。
5. `<dsh-install>/resources/runtime/bin/node{.cmd}`：依赖宿主注入的 `DSH_DESKTOP_NODE_EXECUTABLE`，普通 shell 里必须执行验证才知道能不能用。
6. 全不可用 ⇒ `undefined`，调用方记 `env.node-not-found`。

命中判据是执行结果而不是文件存在：真跑 `<path> -v` 且 stdout 匹配 `^v\d+\.\d+\.\d+` 才算命中。

## <dsh-install> 怎么来（5 条）

1. `--dsh-install <dir>` 显式指定。
2. 注册表：`HKCU` / `HKLM` / `HKLM\Software\WOW6432Node` 下 `…\CurrentVersion\Uninstall`，取 `DisplayName` 含 `DeepSeek Harness` 且同键有 `InstallLocation` 的那条。Windows 上唯一不依赖猜测的权威值；`DisplayName` 带版本后缀（`DeepSeek Harness <版本>`），所以要模糊匹配。
3. 任一命中的 CLI / Node 候选路径反推。
4. PATH shim 的 `%~dp0`（POSIX 用 `which dsh` 的目录）向上反推。
5. 都拿不到 ⇒ `host.packageDir: null` 并记 `env.host-package-dir-unknown`。

## profile 变量：读而不猜

`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` 由宿主注入，`readProfileEnv` 只读这四个变量；缺席一律输出 `null`，默认值不进字段。「无 profile 启动」是合法状态，所以 `env.profile-vars-absent` 是 `info`。profile 目录的完整纪律见 `references/verification-loop.md`。

## 稳定 code 枚举

| code | severity | 触发 |
|---|---|---|
| `env.node-not-found` | error | 所有 Node 候选都不可用 |
| `env.node-too-old` | error | 唯一可用 Node 低于自报下限（下限现读 `<dsh-install>/resources/runtime/versions.json` 的 `node` 字段） |
| `env.node-lower-bound-unknown` | warn | 那份 `versions.json` 读不到 ⇒ 跳过下限判定并如实报出 |
| `env.node-is-electron` | error | 唯一可用候选是 Electron 运行时 |
| `env.cli-not-found` | error | 所有 CLI 候选都不可用 |
| `env.cli-unverified` | warn | 找到了入口，但 `--no-exec` 下无法验证 |
| `env.shim-broken` | warn | PATH 上的 shim 存在但执行失败（`detail` 带原始 stderr 首行） |
| `env.profile-vars-absent` | info | `DSH_PROFILE` / `DSH_PROFILE_DIR` 缺席 |
| `env.host-package-dir-unknown` | warn | 宿主包目录不可得 |
| `env.probe-timeout` | warn | 某候选探测超时 |

## 失败信号 → 下一步

- `env.cli-not-found`：按候选链第 1 条显式指路，跑 `node "<skill-directory>/scripts/dsh-env.mjs" --dsh-cli <绝对路径>`；同时给 `--dsh-install`，才能反推随发行版的 Node。
- `env.node-not-found`：给 `--node <绝对路径>`，或先定 `<dsh-install>` 再走候选 4。
- `env.node-is-electron`：换 PATH 上的 `node`，或候选 4 的随发行版 Node。
- `env.shim-broken`：按报告里 `reason` 的原样 stderr 判定入口形态，改走候选 3 或 4；shim 本身交给发行版处理。
- `env.cli-unverified`：去掉 `--no-exec` 复跑一次，让 `dsh.verified` 从 `null` 变成实测结论。
- `env.host-package-dir-unknown`：`--list-packages` 与注入名检查都会降级；按 `dsh.cliPath` 向上找 `node_modules`，补 `--host-package-dir`。

`next` 数组给可跑命令，典型两条：`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-cli <绝对路径>`、`node "<skill-directory>/scripts/check-plugin.mjs" --host-package-dir <绝对路径>`。

## 边界

- `npx @deepseek-ai/dsh` 与源码 `pnpm dsh` 两条候选**未真跑**（前者会拉依赖闭包，后者要上游 checkout）⇒ 它们是推断可用，不是实测可用。自己把它升级成已证实：`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-cli <候选入口>`，看 `dsh.verified` 与 `dsh.version`。
- 注册表 `InstallLocation` 命中只在 **Windows 一台机器**上验过，未验 `HKCU` 与 `HKLM` 的差别、多版本共存、绿色解压版与非 Windows 的对等物 ⇒ 未证实。换机器时按候选 3、4 复算：`node "<skill-directory>/scripts/dsh-env.mjs" --dsh-install <安装根>`。

## 相关

- 装配与层序、`config` 语义见 `references/package-and-assembly.md`（本册不重述）。
