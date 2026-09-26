# 验收检查清单（装好后逐条跑）

> 本文件是**任何人都能照做的验收流程**：从「插件是否真的加载了」到「媒体通道安不安全」再到「怎么回滚」。
>
> 下面命令里出现两个占位符，请先按自己的环境替换：
>
> | 占位符 | 含义 | 默认/示例 |
> |---|---|---|
> | `$REPO` | 本仓库在你机器上的绝对路径 | `~/dsh-motion-background`（clone 出来的目录名） |
> | `$DSH_PROFILE` | DSH profile 目录 | `~/.dsh/profiles/web` |
> | `$PORT` | DSH WebUI 端口 | `3080`（DSH 默认） |
>
> 装法与前置条件见 `README.md`。

---

## 0. 装配落点（改了什么、怎么回滚）

装上之后，profile 里有三处会变：

| 位置 | 内容 |
|---|---|
| `dependencies["dsh-motion-background"]` | `link:$REPO` |
| `dsh.profile.bundles` | 多一项 `dsh-motion-background` |
| `node_modules/dsh-motion-background` | 指向 `$REPO` 的 junction / symlink |

### ⚠️ 一个反直觉点：**手写 `dsh.profile.bundles` 是无效操作**

`reconcilePlugins()`（见 `@deepseek-ai/dsh/lib/plugin-*.js`）会在**每次 `dsh plugin`
命令之后**，把所有**声明了 `dsh.bundle` 的 dependency 重新追加回** `dsh.profile.bundles`。

⇒ 所以你**不能**靠手删 bundles 里的一行来停用某个插件 —— 它会被静默加回来。
**要停用就把该插件的 patch 行设 `disabled: true`**（见下）。

### 怎么停用另一个皮肤插件（如果你同时装了它）

若你机器上还有本插件的上游/旧版（同为「更好看一点」那一系），**两者不要同时启用**：
它们占用同一个 DOM 作用域、覆盖同一条 `--dsw-alias-bg-base`、**还注册同一个设置栏 id**，
同时开启时画面与面板浓度会互相干扰，结果不可解释。

停法是在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: <该插件自己 patch 里的 insert.id>   # 注意：是行 id，不是包名
  disabled: true
```

一条 `disabled` **就够**，因为它同时挡住两半：

- **宿主半**：`assertEntriesLoaded` 明确把 `entry.disabled` 排除在「加载失败」之外，
  所以停用不会让 boot 报错（`packages/boot/app-boot/src/index.ts`）。
- **客户端半**：客户端模块扫描器（`packages/client/modules/src/index.ts`）的判据是
  `entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled`
  —— **停用的条目根本不进客户端模块表**，它的 `client.js` 不会被浏览器加载。

离线自查（不用重启）：

```bash
dsh --profile web --dump-config
```

期望：目标条目下面多出 `disabled: true`，且行首注释标出它被哪个 patch 文件改过。

---

## 0.5 两层生命周期不同：哪个要重启、哪个不用

装配改动落在**两层**上，它们的热更新行为**不一样**：

| 层 | 是否热生效 | 依据 |
|---|---|---|
| profile 的 `cordis.patch.yml` | ✅ **热生效** | `composeLive()` 每次**从磁盘重读** `loadOptionalPatches(profile.patchPath)`；`watchUserPatches()` 用 `hmr.registerConfig(filename, …)` 注册监听，回调里 `entry.update({ config })` |
| `package.json` 的 `dsh.profile.bundles` | ❌ **需重启** | `composeLive()` 里是 `...composed.bundlePatches` —— **启动时的快照**，从不重读 |

（`web` 模板的 `patchReload` 是 `"live"`，且 `cordis.patch.yml` 与 `package.json`
都没显式覆盖 ⇒ 实际走 live。只有 acp / headless / sdk / sdk-minimal 是 `"startup"`。）

⇒ 结论：**改 `disabled` 不用重启；新增/卸载插件（动 bundles 层）必须重启。**

> 这条是怎么定下来的：曾观察到「一个长跑的宿主里，新旧插件都不在模块表」的怪现象，
> 一度被当成异常。后来用源码比对才确认它**不是异常**，而是两层生命周期叠加的必然结果
> —— patch 层的那次改动**当场**就生效了（宿主没重启过），而 bundles 层的改动在等下次启动。
> 详见 `docs/CONFIG-LIFECYCLE.md`。

---

## 1. 装好后先看这六条

**① 页面还活着**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/"
```
期望：`200`；若 DSH 开了认证，回 `401` 也说明**服务在跑**（只是没带令牌）。

**② 本插件进了客户端模块表**（最直接的「装上了」证据）

```bash
curl -s --max-time 8 -N "http://127.0.0.1:$PORT/plugins/events" \
  | grep -o '{"id":"dsh-motion-background"[^}]*}'
```
期望：能看到 `{"id":"dsh-motion-background","url":"…/client.js&rev=…","inject":[…]}`

**③ 被停用的那个已不在模块表里**

```bash
curl -s --max-time 8 -N "http://127.0.0.1:$PORT/plugins/events" \
  | grep -c '{"id":"<被停用插件的包名>",'
```
期望：`0`

> 若**不是 0**，说明 `disabled: true` 没生效 —— 别继续往下测，先查
> `$DSH_PROFILE/cordis.patch.yml` 里那条是否存在、`id` 是否确实等于
> 该插件 patch 里的 `insert.id`。两个皮肤同时加载时，设置页会同时出现两块同义面板。

**④ mod 端点通了**（宿主半的活儿，也是「可插拔」的命脉）

```bash
curl -s "http://127.0.0.1:$PORT/motion-background/mods" | head -c 400
```
期望：`{"mods":[{"id":"meteor",…},{"id":"aurora-video",…,"media":{…}}],"errors":[],"dir":"…"}` ——
**`errors` 必须是空数组**。

**⑤ 媒体端点通了（含 Range 支持）**

```bash
curl -s -D- -o /dev/null "http://127.0.0.1:$PORT/motion-background/media/aurora-video/bg.mp4"
```
期望：`200` + `content-type: video/mp4` + `accept-ranges: bytes`

```bash
curl -s -D- -o /dev/null -H "Range: bytes=0-99" \
  "http://127.0.0.1:$PORT/motion-background/media/aurora-video/bg.mp4"
```
期望：`206` + `content-range: bytes 0-99/<总长>` + `content-length: 100`
（**浏览器播放 mp4 就靠这个**；若这里回 `200` 而不是 `206`，页面里视频会不播或不能循环。）

**⑥ 媒体端点的路径校验拦得住**（安全边界 —— 任何一条回 `200` 都是任意文件读取）

```bash
for u in "../package.json" "aurora-video/../meteor/mod.json" "aurora-video/bg.mp4.txt" "aurora-video/bg.mp4/extra"; do
  printf '%-42s → ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/motion-background/media/$u"
done
```
期望：**全部 `404`**。

---

## 2. 页面上该看到什么（自动化测不到，需人眼）

**① 底纹 = 流星雨**（`order:-10`，默认效果）
- 斜向划过的流星 + 收束拖尾 + 亮头，深色底上有细星点
- 颜色只从主色派生（与「统一色系」一致）

**② 效果下拉里应有两个**：`流星雨`、`极光（MP4 视频）`
- ⚠️ 「极光」后面的 **`（MP4 视频）`是面板自己加的**（按素材扩展名派生），不是 `mod.json` 里写的
  —— 它用来区分「程序化效果」与「播放一段素材」，两者共用同一套控制栏
- 选「极光（MP4 视频）」⇒ 背景换成一段蓝紫调极光视频
- **默认是「往返」**（`mod.json` 声明了 `playMode: "pingpong"`）：
  正放一遍（约 6 秒）到结尾后**倒着放回来**，两端同一帧折返、无跳变
- **倒放段要顺**（这是往返的全部意义，也是最容易被将就过去的一条）——
  倒播时画面应**连续、不卡顿、无明显跳帧**，流畅度与正放段相当。
  想量化确认，在控制台贴这段（数 seek 的**落位率**）：

  ```js
  (() => { const v = document.querySelector('video[data-mb-surface]'); if (!v) return '没有视频';
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    let a = 0, l = 0, on = false;
    Object.defineProperty(v, 'currentTime', { configurable: true,
      get() { return d.get.call(this); },
      set(x) { if (on) a++; d.set.call(this, x); } });
    v.addEventListener('seeked', () => { if (on) l++; });
    console.log('等它进入倒放后再回车打印结果');
    globalThis.__stop = () => { on = false; return { 发出: a, 落位: l, 落位率: a ? +(l / a).toFixed(3) : null }; };
    on = true; return '已开始计数（等 ~2 秒后执行 __stop()）'; })()
  ```
  期望 `落位率` ≈ **1.0**。
  若在 **0.05 量级**，说明每帧都在发新 seek、把在途解码掐掉了 —— 那是「幻灯片化」的典型特征，
  应当回报（这种情况 `verify.mjs` 的 E19b 会直接变红）。
- 把「播放」下拉切到「**循环**」⇒ 变成播完立刻跳回开头（接缝处会有一跳，这正是往返要解决的）
- 同时确认**画布数变 0**（视频背景不占 WebGL）：
  `document.querySelectorAll('canvas[data-mb-surface]').length`
- 选媒体型时，**强度/柔度/颗粒/形态四个旋钮置灰**，「播放」与「面板浓度」仍可调
- 切回「流星雨」⇒ 视频元素应被**彻底摘掉**（不只是隐藏）：
  `document.querySelectorAll('video[data-mb-surface]').length` 应为 `0`
  （摘掉 ≠ 隐藏：`el.remove()` 让元素离开文档，`pause()` + 清 `src` + `load()`
  才回收它持有的缓冲与在途请求）

**③ 设置页多了一栏「动态背景」**
- 左侧导航里应当有「动态背景」
- 若你还装着旧版皮肤，它的那一栏应当**消失**（已被 `disabled` 停用）

**④ 面板里的控件**
- 启用（勾选框）
- 效果（下拉，两个选项，媒体型带 `（MP4 视频）`标注）
- **播放**（下拉：`循环（播完跳回开头）` / `往返（正放到底再倒放回来）`）
  —— ⚠️ **只在选中视频型时出现**；切回「流星雨」它应当**消失**（着色器型没有播放方向）
- 强度 / 柔度 / 颗粒 / 形态（**四个都渲染**；mod 没映射的会**置灰**）
- 面板浓度
- **没有**「发光巡游描边」那一组 —— 本插件还没有描边功能（那是旧版皮肤的东西）

**⑤ 关掉底纹时输入框描边仍清晰**
- 把「面板浓度」拉到 0 或关闭底纹 ⇒ 输入框的描边/效果**不应跟着消失**

---

## 3. 控制台自查（出问题时最有用）

```js
__betterSkin.mods
// { loaded:['meteor','aurora-video'], errors:{}, dir:'…/mods', current:'meteor', uniforms:[…] }

__betterSkin.health
// { watchdogRunning:true, backdrop:{ idleMs, attached } }

__betterSkin.settings      // 'ok' 才算设置卡片注册成功
__betterSkin.surfaceKind   // 'shader' | 'media' —— 当前渲染面是哪种
await __betterSkin.probeMods()   // { meteor: true, 'aurora-video': true } 才算两个 mod 都真能出画
```

**媒体型专属排查**：若视频不出画，看 `__betterSkin.mods.errors` 里有没有 `__mediaplay:<id>`：
- 有 ⇒ 素材加载成功但**播不动**（多半是自动播放策略）—— 检查 `muted` 是否为 `true`
- 没有、但画面空白 ⇒ 检查宿主半的媒体端点（上面第 ⑤ 条）与素材扩展名白名单

---

## 4. 拖一个 mod 试试（验收「可插拔」）

**着色器型**：

```bash
mkdir -p "$REPO/mods/my-test"
cp "$REPO/mods/meteor/fragment.glsl" "$REPO/mods/my-test/"
# 再写一个 mod.json，id 填 my-test（可照抄 meteor 的）
```
刷新页面 ⇒ 效果下拉里应多出 `my-test`。
**删掉文件夹 ⇒ 刷新后应消失。** 两个方向都要试。

**媒体型**（顺手验一下媒体通道）：

```bash
mkdir -p "$REPO/mods/my-video"
cp "$REPO/mods/aurora-video/bg.mp4" "$REPO/mods/my-video/"
# mod.json 里给 "media": "bg.mp4"（注意：不要写 colors，也不需要 fragment.glsl）
```
刷新 ⇒ 下拉里应多出 `my-video`，且**选中后能循环播放**。

**⚠️ 宿主不用重启** —— 端点每次请求都重新扫目录。

---

## 5. 与「含第三方着色器的那一版」的差异

| 功能 | 旧版皮肤 | 本插件 |
|---|---|---|
| 底纹效果 | 6 个（含第三方着色器源码） | **2 个**（自研流星雨 + 媒体型极光视频） |
| 媒体型 mod（MP4/GIF/图片） | ❌ 无 | ✅ **有**（`media` 字段 + Range 支持） |
| 发光巡游描边（输入框） | ✅ 有 | ❌ **还没有** |
| 面板名 | 「更好看一点」 | 「动态背景」 |
| mod 机制 | ❌ 无 | ✅ **可拖文件夹扩展** |
| 可公开分发 | ❌ 含第三方源码 | ✅ 内核原创 |

**这是刻意的取舍**：本仓库为「能公开上线」而干净 —— 内核里**零第三方着色器代码**
（判据与边界见 `README.md` 顶部与 `docs/KERNEL-REVIEW.md`）。

旧版那 6 个效果**可以逐个改造成 mod** 搬过来（那是下一步）；描边则是新功能，要重新做。

---

## 6. 回滚

```bash
cd "$DSH_PROFILE"

# ① 恢复 patch 层（把停用的那个重新启用）
cp cordis.patch.yml.bak-<你备份时的时间戳> cordis.patch.yml

# ② 恢复 profile 清单（可选 —— 注意 bundles 会自动对齐，见 §0）
cp package.json.bak-<你备份时的时间戳> package.json

# 再重启宿主即可回到原状态
```

> **动手前先备份**这两个文件，文件名带上时间戳 —— 回滚全靠它。
> （`node_modules` 下各插件目录若都还在，无需重建。）

**只想临时禁用本插件、不碰别的**：在本插件自己的 patch 行上加 `disabled: true`
（行 id 见仓库根目录的 `cordis.patch.yml`），而不是去动上游那一版。

---

## 7. 仍未闭合的（诚实清单）

- **GPU 帧率**：所有验证都跑在软件光栅（SwiftShader）上，没有真实 GPU 数据
- **真 React 渲染**：自检用的是不含渲染的桩 ⇒ 面板的真实交互只有靠人眼看
- **真实 `slots.inject` 语义**：按官方源码契约与同类型插件推定
- **`ctx.effect` 的 fiber 回收**：卸载路径未在真机验证
