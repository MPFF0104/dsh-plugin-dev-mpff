# 失效模式

为什么它静默什么都不做？怎么让它大声说？

## 本册怎么用

首选册：先按现象查下面的条件式表，再回对应册看正例写法。

- 建包与逐文件写法见 `references/build-a-package.md`。
- 前端半边见 `references/frontend-plugin.md`。

## 静默六处条件式

| # | 条件式 | 观察面 | 自查方式 |
|---|---|---|---|
| ① | Cordis `inject` 里写了一个没有 Provider 的服务名 | fiber 停在 PENDING，`apply` 不跑，无异常也无日志；唯一自动面是宿主 stderr 的 `pending (waiting for service: X)` | 看 stderr，再按服务名对 Provider 包 |
| ② | 前端 `dsh.client.inject` 写了死名字 | 静默跳过 | 设置页「插件清单」面板的 `waiting for activation` 列表 |
| ③ | 前端依赖判空跳过：`if (dependency !== void 0) { … }`，没有 else、没有日志 | 什么都不发生 | 记条件式本身，行号会漂 |
| ④ | `dsh.client.platform !== 'web'` | `return null`，且这条负面判定被缓存 | 自查三法第 1 条：包自报的 `platform` 是不是字面量 `'web'` |
| ⑤ | **事件名 / waterfall 名写错**（**最危险的一处**） | 没有注册表校验、没有白名单、没有警告；名字写错永不触发；waterfall 不调 `next()` 会静默截断整链 | 把名字与宿主版本一起钉住，靠回归验证 |
| ⑥ | 走 logger 的告警 | 默认 level 过滤把 `warn` / `debug` 丢掉；patch 未命中在 `--dump-config` 可见、在 `--dump-default-config` 不可见 | 换 `--dump-config` 再看一遍 |

## 宿主会大声说的四条通道 + 两条拒绝面

1. **pending 表**：装配期把没顶上的 inject 名字打出来。
2. **可选失败 warning**：只写 stderr，不落盘。
3. **必需条目失败 `StartupError`**：唯一落盘的通道，写 `<dsh-home>/logs/startup-<timestamp>-<uuid>.log`。
4. **fail loud**：自包含的错配在加载期就抛。

两条拒绝面：bundle 级 `skipping profile bundle`；peer 不匹配的 `incompatible-version` 加一条精确救济命令。

## 落痕边界

第三方插件**进不了** `requiredStartupEntryIds` ⇒ 默认留不下痕迹。`logger.warn` 在正常启动时**完全不可见**（没有 console exporter）。要留痕就自己写：自己的日志文件，或 `ctx.logger.exporter()` 自装 exporter。

## 大声失败模板

服务半边——加载期探测，缺了就抛：

```js
export function apply(ctx) {
  if (ctx.get('someService') === undefined) {
    throw new Error('someService is missing: no provider is mounted')
  }
}
```

前端半边——`dsh.client.inject` 缺失是静默的，自己探（示例形态，按你的注入面调整）：

```js
if (typeof window.__DSH_BOOT__ === 'undefined') {
  console.error('[my-plugin] frontend half not activated')
}
```

事件名——只能探宿主服务与版本，再靠回归验证：

```js
ctx.on('agent/pre-step', () => { console.log('[my-plugin] hook fired') })
```

## 三条容易误判的

- `await fiber` 会 **RESOLVE 而不是 reject**：装配失败未必让 await 抛错。
- `ctx.foo` 直接访问抛 `cannot get property "foo" without inject`——这是「有没有声明 inject」的检查，不是「服务在不在」的探测。
- 用户层 patch 加新行只能写 `- insert:`；少了它，那一行是 no-op 加一条 warning。

## 诊断面的边界

`dsh plugin` **只截获三个非 pnpm 动词** ⇒ 没有 `plugin why` 这种契约诊断面，也没有用户级 debug 开关。所以上面那张条件式表就是主要手段。

## 边界

- 上表有三条来自**第三方自述**，不是本次实测（②的跳过行为、③的判空写法、⑤的「无警告」）。自己复算的办法：装配一次后看 `node "<cli>" --profile <profile> --help` 的 stderr 是否出现 pending 表；前端那两条按前端册的自查三法确认。

## 相关

- 前端专属自查三法在 `references/frontend-plugin.md`。
