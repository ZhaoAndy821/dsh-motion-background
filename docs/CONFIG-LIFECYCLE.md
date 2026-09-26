# DSH 配置的生命周期：什么时候需要重启、什么时候刷新就够

> 2026-09-25 源码查证 + 运行时实测（含一次**独立审核者做的对照实验**）。
> **回答一个反复出现的实际问题**：「我改了配置，要重启 DSH 吗？还是刷新页面就行？」
>
> ⚠️ **适用范围**：下文的「热生效」结论只对**当前这个 `web` profile** 有实证。
> `acp` / `headless` / `sdk` / `sdk-minimal` 四个模板的 `patchReload` 是 `"startup"`，
> 在那些 profile 上 **patch 文件也要重启**才生效（见 §2 末尾）。

---

## 一、四层，四种生命周期

DSH 的插件与配置分四层，**各层何时生效完全不同** —— 混为一谈必然误判。

| 层 | 存在哪 | 改它之后 | 源码依据 |
|---|---|---|---|
| **① 宿主半代码** | 插件包 `lib/index.js` | ❌ **要重启** | 宿主进程启动时 `import` 一次；HMR 只监控客户端 bundle 的路径（`ctx.clientModules.clientPath(row.id)`），**不碰宿主半** |
| **② 客户端半代码** | 插件包 `lib/client.js` | ✅ **自动热换**（约 500ms 内），连刷新都不用 | HMR 宿主半**轮询**该文件（`pollWatches`，`pollIntervalMs` 默认 **500**），`mtime`/`size` 变化即 `clientModules.rebuilt(id)` → 推 `rebuilt` 帧 → 浏览器侧 `reload(id)` 换 fiber |
| **③a profile patch** | `~/.dsh/profiles/<name>/cordis.patch.yml` | ✅ **热生效**（`web` profile） | `composeLive()` 每次**从磁盘重读**；`watchUserPatches()` 用 `hmr.registerConfig(path, cb)` 监听 |
| **③b home patch** | `~/.dsh/cordis.patch.yml` | ✅ **热生效**（同上，**同一条 `composeLive` 里也有它**） | 同上 —— `composeLive()` 里第二个 `loadOptionalPatches(NAME, homePatchPath())` |
| **④ 插件清单** | `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` | ❌ **要重启** | `composeLive()` 里是 `...composed.bundlePatches` —— **启动时的快照**，从不重读 |
| **⑤ `--patch` overlay** | 启动参数 `--patch <file>` 指定的文件 | ❌ **要重启** | 它在 `composed.overlays` 里，而该字段取自启动时的 `composeProfile()`，`composeLive` 只是把它原样带过来 |

**一句话**：
- 改 **patch 文件**（profile 的、home 的：停用插件、覆盖配置）⇒ **什么都不用做**。
- 改 **`bundles`** 或 **`--patch` overlay** ⇒ **重启宿主**。
- 改**插件自己的代码** ⇒ 宿主半要重启；**客户端半约 500ms 自动热换**。

> ⚠️ 上表把「③ 热 / ④⑤ 冷」分清了，但**③ 只在 `patchReload === "live"` 时成立**。
> 见 §2 末尾。

---

## 二、源码证据（③ 行）

### ③ 为什么 patch 文件热生效

`@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:305`：

```js
const composeLive = () => structuredClone([
  ...composed.bundlePatches,                                       // ← 启动快照，不重读（④）
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],  // ← 每次重读磁盘 ✓（③a）
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],             // ← 每次重读磁盘 ✓（③b）
  ...composed.overlays                                             // ← 启动快照，不重读（⑤）
]);
```

⇒ **这个 4 元组里，只有中间两项是「每次重读」的**。首尾两项都取自启动时的
`composeProfile()`（`profile.layer` 的 patches → `bundlePatches`；`--patch` 文件 →
`overlays`），`composeLive` 只是把它们原样带过来。

同文件 321–338 行（仅当 `patchReload === "live"`）：

```js
if (ctx.get("hmr") === void 0) {
  await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });   // 如需
  await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
}
await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(),         compose: composeLive });
```

`@deepseek-ai/dsh-app-boot/lib/index.js:1109` 的 `watchUserPatches()`：

```js
const register = hmr.registerConfig(filename, async () => {
  const { patches: _previousPatches, ...includeConfig } = entry.options.config;
  const patches = compose(loadOptionalPatches(binName, filename) ?? []);
  await entry.update({ config: { ...includeConfig, patches } });
});
```

⇒ **文件一变 → 回调重读磁盘 → `entry.update` 重新组合**。不需要重启，也不需要刷新页面。

### `patchReload` 的取值（⚠️ 这决定 ③ 成不成立）

`PROFILE_TEMPLATES`（`dsh-app-boot/lib/index.js` 约 328–352 行）：

| profile | patchReload | ③ 是否热生效 |
|---|---|---|
| `web` | **`"live"`** | ✅ 是 |
| `acp` / `headless` / `sdk` / `sdk-minimal` | `"startup"` | ❌ **否，要重启** |

**`?? "live"` 兜底的实际路径**（`loadProfileDirectory`，约 848 行）：

```js
const rawPatchReload = manifest.dsh?.profile?.patchReload;
if (rawPatchReload !== void 0 && rawPatchReload !== "live" && rawPatchReload !== "startup")
  throw new Error(`… must be "live" or "startup"`);
const patchReload = rawPatchReload ?? "live";          // ← 本机走的就是这一行
```

**本机实测**：`web` 的 `package.json` 里 `dsh.profile` **只有 `bundles` 一个键**，
没有 `patchReload` ⇒ 走 `?? "live"` ⇒ **实际就是 live**。

> 📌 **不要拿 `--dump-config` 去查 `patchReload`** —— 实测它**不输出**该字段
> （`dsh --profile web --dump-config | grep -i patchreload` 命中 0 行）。
> 想确认只能读源码路径或直接看 profile 的 `package.json`。

> 📌 **所以别把这条结论推广成「dsh 的 patch 都热生效」** —— 只有在
> `patchReload` 解析为 `"live"` 的 profile 上才成立。`web` 是本机唯一在用的 profile，
> 但这个边界必须写清楚。（独立审核者 2026-09-25 指出我初版把 `web` 的结论
> 当成了 dsh 的通则，这条修正是对的。）

### ② 客户端半：改代码后约 500ms 自动热换

**宿主半 HMR**（`packages/client/hmr/lib/index.js`）对每个客户端 bundle 建一条监控：

```js
const syncWatches = () => {
  const rows = new Map();
  for (const row of ctx.clientModules.graph().entries) {
    const path = ctx.clientModules.clientPath(row.id);   // ← 只盯 client.js
    if (path !== void 0) rows.set(row.id, path);
  }
  …增量增删监控项…
};
ctx.effect(() => {
  syncWatches();
  const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches);
  const timer = setInterval(pollWatches, pollIntervalMs);   // ← 轮询，默认 500ms
  timer.unref();
  return () => { unsubscribe(); clearInterval(timer); watched.clear(); };
}, "client-hmr: bundle watches");
```

`pollWatches` 比较 `mtimeMs` 与 `size`，变了就 `rehash()` → `ctx.clientModules.rebuilt(id)`
→ `onRebuilt` 回调用 `sseData({type:"rebuilt", id, rev})` **推给所有已连接的页面**
（`/plugins/events`，`kind: "exact"` 路由）。

**客户端半**（`lib/client.js:38`）收到就换：

```js
async function reload(id) {
  const entry = findEntry(loader, id);
  if (entry === void 0) { …warn: not in the loader tree…; return; }
  modLoader.invalidate(id);
  await modLoader.prefetch(id);
  …卸旧 fiber（等 inertia 归零）…
  removeOwnedStyles(id);       // 清掉该插件注册的 <style data-plugin>
  await entry.refresh();       // 挂新 fiber
}
```

⇒ **改 `lib/client.js` 保存后，已打开的页面约 500ms 内自动换成新代码，不用刷新。**
（注意 `removeOwnedStyles`：HMR 会把该插件注册的 `<style data-plugin="<id>">` 一并清掉，
所以纯 CSS 插件也能靠这条路热更，不会残留旧样式。）

**bundle 响应头另有一条**：`/plugins/??<id>/client.js&rev=<rev>` 带
`cache-control: public, max-age=31536000, immutable`（一年强缓存、不可变）。
所以**唯一**的失效手段就是 URL 里的 `rev` —— 重建后 `rev` 变化，首页清单
（`window.__DSH_BOOT__`）也就指向新 URL。**首页本身是 `no-store`**，每请求重新渲染
（`frontend-static` 的 `renderIndex` 在 `serveStatic` 里**每请求调用**），所以刷新一定能拿最新清单。

---

## 三、「已打开的页面」会怎样
宿主侧**有**一套推给已打开页面的机制（`packages/client/hmr`），走 SSE `/plugins/events`：

```js
// packages/client/hmr/lib/client.js:38
async function reload(id) {
  const entry = findEntry(loader, id);
  if (entry === void 0) {
    ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`);
    return;                                       // ← 条目不在树里 ⇒ 只警告，不加载
  }
  modLoader.invalidate(id);
  await modLoader.prefetch(id);
  const oldFiber = entry.fiber;
  if (oldFiber !== void 0) { …卸旧 fiber… }
  removeOwnedStyles(id);
  await entry.refresh();                          // ← 挂新 fiber
}
```

**要点**：`reload()` 是先 `findEntry` **在已加载的 loader 树里找**，找到才换。
⇒ **它能做到「换掉已存在的插件」，做不到「加载一个原本不在树里的插件」**。

| 场景 | 已打开的页面 | 需要做什么 |
|---|---|---|
| 改 patch（停用/改配置，条目**已在**树里） | 宿主侧重新组合 | **通常不用动**（见下注） |
| 插件客户端半被改（在树里） | 收到 `rebuilt` 帧 ⇒ 自动热换 | **不用动** |
| **新增一个插件**（条目**不在**树里） | 只 warn：`not in the loader tree` | **必须重启宿主 + 刷新页面** |

> **注**：`disabled: true` 的条目是**从模块表里消失**（而不只是 fiber 变化），
> 它会不会让已打开页面里的那份 JS「卸掉」，我没有对这条路径做实测。
> 保守说法：**停用后刷新一次页面**最稳。运行时观测到的稳态事实是
> 「模块表里不再有该条目」（本次实测命中 `0`）。

---

## 四、⭐ 关键区分：热更走的是**两套独立机制**

这一点极易混淆（我自己第一版就写错过：拿 bundle 的证据去证 patch 的结论）。
**它们不是同一条链路**：

| | ③ patch 文件热生效 | ② 客户端 bundle 热换 |
|---|---|---|
| 监听什么 | `cordis.patch.yml` / home patch | 每个插件的 `lib/client.js` |
| **用什么机制** | **chokidar `watch()`**（文件系统事件） | **`setInterval` + `statSync` 轮询**（默认 500ms） |
| 谁提供 | `@deepseek-ai/cordis-plugin-hmr@1.0.17`（第一方包，`lib/index.js:3` `import { watch } from "chokidar"`） | `@deepseek-ai/dsh-client-hmr` 的**宿主半** `lib/index.js` |
| 触发后做什么 | `refreshConfig()` → 回调 → `entry.update({config})` 重新组合 | `clientModules.rebuilt(id)` → 推 `rebuilt` 帧 → 浏览器 `reload(id)` 换 fiber |
| 启用条件 | 仅 `patchReload === "live"` 时注册 | `dsh-client-hmr` 自己起，与 `patchReload` 无关 |

```js
// cordis-plugin-hmr/lib/index.js:118  registerConfig —— patch 文件走这条
async registerConfig(filename, refresh) {
  const watcher = watch(root, { … });            // ← chokidar，不是轮询
  const onChange = (path) => { …; this.refreshConfig(registration, filename, refresh); };
  watcher.on("add", onChange);
  watcher.on("change", onChange);               // ← 文件事件驱动
  watcher.on("unlink", onChange);
  …
}
```

⇒ **两者的证据不能互相替代**。下面三个实证各自独立，谁也不能替谁。

---

## 五、证据等级（三个实证，各管各的）

先说清**证据强度**，避免后来者拿弱证据当强的用：

| 编号 | 支撑哪一行 | 强度 | 说明 |
|---|---|---|---|
| **① 直接对照实验** | ③ patch 热生效 | 🟢 **主证据** | 活进程上「加 → 观察 → 删 → 再观察」 |
| ② 自然实验 | ③ patch 热生效 | 🟡 **仅供参照** | 事后推断，替代解释**无法完全排除**（详见下） |
| ③ 主动实验 | ② bundle 热换 | 🟢 直接证据 | 改文件 → 观察 `rev` 变化 → 还原 |

### 实证 ①：patch 层热生效 —— **直接对照实验（主证据）**

由**独立审核者**在**同一个正在运行的宿主**上做的，**全程未重启**：

| | 实验前 | 往 profile patch 里加 `disabled` 后 | 删掉该条目后 |
|---|---|---|---|
| 被停用的那个插件在模块表里的命中数 | 5 | **0** | 4 |
| 模块表条目总数 | 63 | **62** | 63 |
| graph `rev` | `f3299dd4e40b` | `158084f8249c` | `efb528c73f60` |

其他插件的计数**全部不变**；恢复后该条目从第 46 位变成 **第 63 位**（末尾重新挂载）
⇒ 排除了"浏览器侧缓存造成的假象"。

**这条是本结论的主要依据** —— 它是在活着的进程上做的真对照实验（加 → 观察 → 删 → 再观察）。

### 实证 ②：我的自然实验（**仅供参照，不作为依据**）

| 时刻 | 事件 |
|---|---|
| 11:55:23 | 宿主启动（当时 patch 里**没有**那个插件的 `disabled`） |
| 16:46:03 | 往 `cordis.patch.yml` 写入 `- id: <该插件 patch 行的 id>` / `disabled: true` |
| ~17:30 | 查该宿主模块表 ⇒ **该插件已不在**（命中 0） |

当时我据此推断"只能是热生效"，并称"已排除替代解释：bundles 至今仍含那个包"。

> ⚠️ **独立审核者指出这条论证有缺陷，我接受**：
> `reconcilePlugins` 只在 `dsh plugin` 命令跑时执行，而该 profile 在 15:18→15:46
> 确实发生过 bundles 改写 ——「**现在** bundles 里有它」证明不了「**当时**有它」。
> 且那个宿主已退出、`dsh plugin` 不留日志，**这条替代解释无法再排除**；
> 该宿主启动时刻的 `cordis.patch.yml` mtime 后来也被覆盖（见下）。
> ⇒ 结论仍成立，但**靠的是实证 ①，不是这条**。

> 📌 **审核者留下的一个副作用（如实记录）**：它用 `cp` 恢复 patch 文件时，把该文件的
> mtime 从 `16:46:03` 改成了 `19:00:08`。**内容未变**（md5 与空 diff 均可证），
> 但上表那个 mtime 证据已不可再核。它当时留下的那份 patch 文件备份保留未删。

### 实证 ③：客户端 bundle 被改后自动换 `rev`（主动实验，支撑 ② 行）

⇒ 支撑「500ms 轮询 bundle」这条。**注意：它不构成 patch 热生效的证据**（机制不同）。

在 `lib/client.js` 末尾追加一行注释并保存，**不做任何其他操作**，等 3 秒后观察：

| 阶段 | 该插件的 `rev` | 说明 |
|---|---|---|
| 初始 | `208e41d4ad74eee9-48` | 规范形态 `<hash>-<idx>` |
| 追加注释后 | **`1865af7e9980`** | **退化为裸 hash = rebuilt 的标志** |
| 还原后 | `88cd3255d8e5` | 再变一次 ⇒ 轮询持续工作 |

全程**零重启**。且下载服务端下发的 bundle 与本地文件比对：
本地 55015 B **逐字节一致**（`cmp` 通过），服务端为 55113 B = 本地 + 宿主追加的
`;\n//# sourceMappingURL=…`（98 B）。

⇒ 改客户端代码 → 保存 → 已打开的页面约 500ms 内自动热换。**这条让我能自己验证效果，
不必每次都请用户重启。**

> ⚠️ 但**宿主半**（`lib/index.js`）不在这条路径上 —— HMR 只盯
> `ctx.clientModules.clientPath(row.id)`（即客户端 bundle）。改宿主半**仍需重启**。

---

## 六、由此得到的两条操作纪律

1. **想改配置 / 临时停用插件** ⇒ 直接改 `cordis.patch.yml`，**不必请用户重启**。
   验证：改完等 1–2 秒，`curl -s -N "http://127.0.0.1:3080/plugins/events"` 看模块表是否已变。
2. **想新增 / 卸载插件** ⇒ 动的是 `bundles`，**必须重启**；并记得同时刷新页面
   （新条目的 `client.js` 得由首页清单带进来）。

> **反过来的坑**：知道「patch 热生效」之后，容易把它过度推广成「改什么都热生效」。
> `bundles` 不是 —— 它是启动快照。判断口诀不需要，只记**分层**：
> 改 `cordis.patch.yml` → 热；改 `package.json` → 冷。
