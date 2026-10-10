# 前端插件

前端半边怎么写、为什么它什么都不显示。

## dsh.client 的完整语义

`dsh.client` 声明在 `package.json` 里，四个键：

| 键 | 语义 | 写错的后果 |
|---|---|---|
| `platform` | **必需，且必须是字面量 `'web'`** | 静默不进表，而且这条负面判定**被缓存** |
| `inject` | 信息性的包名依赖，**不是** Cordis 服务注入 | 由下面的自查三法抓 |
| `immediately` | 缺席表示与 application 共享 batch | — |
| `external` | 硬边 | — |

校验**只查形状、不查名字**：包名写错不会被拦下来，只会在运行期失效。所以「装上了」与「激活了」是两件事。

## 三层分工

1. **Definition**：把事件映射成 business State，再映射成 target Node。注册表是 `ctx.uiConversation.events` / `.views` / `.groups`。
2. **View**：挂在 `conversation.view` slot；ui-chat 以 `id: "chat"` 注册。
3. **Renderer**：`conversation.chat.node` 这个 **keyed 子槽**，key **就是 node 的 `kind`**。

## Definition 的完整契约

```js
ctx.uiConversation.events.register(definition)
```

- `target` 与 `buildViewNode` **必须同时声明**。
- `ctx.slots.inject` 声明自己依赖的槽位，`ctx.slots.register` 注册自己的槽位，两者分工不同。
- 注册是 effect：`register()` 返回 disposer，交给 `ctx.effect()` 收口。

## 数据来源两侧的字段级差异

持久事件走 `session/event`，信封外层是 `type: 'event'`；瞬态事件是 `'transient'`，浏览器侧叫 `assistant/live-chunk`。

**持久事件信封是白名单：多一个字段就抛错。** 两侧字段集合因此不对称，写 Definition 时按持久侧的字段表来。

## 把输入驱回 agent

浏览器半边**没有 `ctx.agents`**。对等物是 `ctx.sessions`：

```js
const submission = session.beginSubmission()
await session.prompt(...)
```

宿主侧的 `agent.followup()` / `agent.steer()` 只作对照——浏览器插件够不到它们。

## 前端专属自查三法

1. 判据是包**自报** `dsh.client.platform === 'web'`，而不是目录名前缀。
2. `./client` 导出存在：`exports['./client']` 与 `client.js` 同时在。
3. 设置页「插件清单」面板里看 `waiting for activation` 列表——自己的包在那儿就是没激活。

## hmr 的生效条件

传输默认已经挂上。**代码热替换需要另有 build watcher**：「图变更」与「代码重建」是两件事，只改源码不重建，页面不会跟着变。

## 边界

- 前端骨架只到 `node --check` + manifest 形状校验 + boot 期图组合不报错，**未做端到端渲染验证** ⇒ 渲染层的行为以你的实机回归为准。自己复算的办法：把包复制到 `--work-root`，在副本上跑 `node --check <副本>/client.js`，再按上面第三法看 `waiting for activation` 列表里是否还有自己的包。

## 相关

- 静默失效的条件式与大声失败模板见 `references/failure-modes.md`。
