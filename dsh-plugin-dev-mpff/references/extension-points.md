# 扩展点

「这件事能挂哪儿」与「挂上去怎么就地确认它被声明了」。宿主侧的流水线与 seam 在本册；前端槽位与 renderer 归前端册。

## 本册不承诺穷尽

上游不存在一份扩展点穷尽清单：`docs/capability-seams.md` 是上游 `gen-doc-graphs.ts` 这个脚本的**生成物**，只能当线索，不能当手写权威。本册是**已证实清单 + 就地校验方式**，不是全集。

要自己扩展这份清单，用这两条读法：

```sh
node "<skill-directory>/scripts/dsh-env.mjs" --list-packages
rg -n "ctx\.tools\.register|ctx\.slots\.register|\.events\.register" <宿主包目录>
```

第一条给宿主包清单（`host.packageDir` 下每个包的 `dsh.client` 与 `dsh.bundle.patch`），第二条按符号在装好的包里找注册点。

## 工具执行流水线

每次工具调用都跑同一条固定流水线：

`tools/pre-execute`（可重排的 allow/deny/ask 门）→ 注册的**单调** guards → `tools/execute`（around-dispatch 包装）→ `tools/post-execute`（检视/替换、附加上下文）→ definition 自己的 `finalizeContent` → 只观察的 `tools/result`。

四点必须记住：

- `tools/execute` 的可变面**只有 `exec.signal`**；registry 会在 body 前重新融合调用方 signal。
- definition 自己的 `projectContent` 是执行期 content 的装入点，`finalizeContent` 是最后一个 content-only 不变式。
- `tools/post-execute` 能替换 content/value、block 结果并给反馈、附加 model-facing context；`tools/result` 只观察冻结后的权威结果。
- 插件注册工具走 `ctx.tools.register()`，schema 自动流进 prompt 装配。

## 与流水线相邻但不在流水线里

- `ctx.tools.restrict(filter)`：**注册表可见性 / 作用域遮罩**。对一个 agent 继承的全局工具集套 allow/deny 遮罩，遮罩取交集，作用域注册仍可见，dispose 时解除。它不在上面那条流水线里；适用边界是「过滤必须在展示、查找、执行三者之间保持对齐」。
- `ctx.tools.guard()`：位置在 `pre-execute` 之后、`execute` 之前，同步且单调——后面的 listener 翻不了它的案。
- `ctx.approval`：在单调 guards **之前**解决 asks。

把这三条与流水线平铺，会丢掉「遮罩决定模型看到什么，pre-execute 决定一次调用是否放行」这条分工。

## capability seam 的三角

一个 capability seam 由三个角色构成，缺一不成：Service Definition（谁声明服务）+ Service Provider（一个或多个实现）+ Consumer（一个或多个消费者）。

- Service Definition 必须是 Cordis 的 `Service` 类——抽象类或具体注册表，而不是 TypeScript `interface`。
- 角色与包**不是一一对应**：一个包可以同时持有多个角色，只在角色独立演进时才拆包。
- 「seam」专指服务四分类里的第二类（core spine service / swappable capability seam / bundle-composition point / standalone service），不是所有服务的泛称。

## 前端槽位（一行指针）

前端半边（三层分工、key 语义、Definition 契约）见 `references/frontend-plugin.md`，本册不重述。

## 事件信封与事件名

宿主侧事件面分两层：信封外层带 `type`；持久与瞬态的区分只在「它是不是持久侧」这一层。事件名**没有注册表校验、没有白名单、没有警告**——写错的名字永远不触发，waterfall 不调 `next()` 会静默截断整链。症状与自查见 `references/failure-modes.md`。

## 每条扩展点的就地校验方式

本册的交付核心：每条扩展点都给一条能就地跑出结论的探测。

| 扩展点 | 探测 |
|---|---|
| 工具流水线 / guard / restrict | 在插件里 `ctx.get('<service>')`，命中 `undefined` 就是没声明；再跑 `node "<cli>" --profile <profile> --help` 看 stderr |
| capability seam 的服务 | 同上，服务名取自 Provider 包的注册名 |
| 事件名 | 探宿主服务与版本：`node "<skill-directory>/scripts/dsh-env.mjs"` 拿 `dsh.version`，把名字与版本一起钉住 |

装配期的统一观察面：用一次性 profile 装配后，看 stderr 是否出现 `pending (waiting for service:`——出现说明某条 inject 的服务名没有 Provider 顶上。

## 类型权威的缺口

前端 Definition 的类型权威不存在（发行物里没有 `.d.ts`），扩展点事件名也没有校验 ⇒ 校验只能靠「就地探测 + 回归验证」两条腿。所以本册给的每条扩展点都配了探测，而不是只给名字。

## 边界

- 上游**不存在**扩展点穷尽清单，`docs/capability-seams.md` 是上游 `gen-doc-graphs.ts` 的生成物、只能当线索：本册**不承诺穷尽**，它是已证实清单 + 就地校验方式。自己扩展这份清单的办法就是上面那两条读法，起手跑 `node "<skill-directory>/scripts/dsh-env.mjs" --list-packages`。

## 相关

- 选完形态去 `references/build-a-package.md` 逐文件落盘。
