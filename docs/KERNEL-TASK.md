# 内核实现任务书

> 这份文档是**自包含**的：执行者不需要看任何其他上下文即可开工。
> 目标产物是一个**可公开分发**的 DSH 插件，其内核为原创代码。

---

## 0. 一句话目标

实现一个 DSH WebUI 的**动态背景插件内核**：底纹效果**可插拔**（往 `mods/` 里放一个文件夹就多一个效果），
**内核本身不含任何第三方着色器代码** —— 效果全部通过 mod 提供。

---

## 1. 背景（必须知道的全部）

**DSH** 是一个本地跑的 AI harness，WebUI 监听 `127.0.0.1:3080`。它的前端是一个 React 应用，
支持第三方**客户端插件**（浏览器里的 JS bundle，通过 `window.__ModuleLoader__.load({ id, factory })` 注册）
与**宿主插件**（Node 侧 cordis 插件，导出 `apply(ctx)`）。

**这个插件为什么必须有宿主半**：客户端插件是单文件 bundle、跑在浏览器里，**没有文件系统**。
而"读 `mods/` 目录"是实现可插拔的前提 ⇒ 由宿主读目录、经 HTTP 端点交给客户端。
（纯样式类插件可以不要宿主半；这个不行。）

**产物要能公开分发**：内核原创；mod 是否可公开取决于各 mod 自己的许可。
不得把任何第三方着色器代码写进内核。

---

## 2. 交付物

```
dsh-motion-background/
├── package.json          包清单（见 §3.1）
├── cordis.patch.yml      宿主半的 bundle patch
├── lib/
│   ├── index.js          宿主半：扫 mods/ + 注册 HTTP 端点
│   └── client.js         客户端半：内核（渲染 / mod 加载 / 设置面板 / 配置）
├── mods/                 效果目录（一个子文件夹 = 一个效果）
├── docs/
│   ├── MOD-FORMAT.md     mod 契约（必须随仓库交付）
│   └── KERNEL-TASK.md    本文档
├── verify.mjs            自检脚本（§7）
└── README.md
```

---

## 3. 硬性契约（**不可更改**）

这些是 mod 作者与设置面板依赖的东西。改了就破坏兼容。

### 3.1 `package.json` 的两个 inject 是**两回事**

```json
{
  "name": "dsh-motion-background",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings"],
      "platform": "web"
    }
  }
}
```

- `dsh.client.inject` 里是**包名**（管客户端加载顺序）。**改动这一项必须重启宿主**才生效。
- 客户端 `factory` 返回的 `inject` 里是**服务短名**（如 `['slots']`）。
- 宿主半用 `export const inject = ['webServer']`。
- **`./cordis.patch.yml` 必须出现在 `exports` 里**，否则加载器解析不到它。

### 3.2 客户端 bundle 协议

```js
window.__ModuleLoader__.load({
  id: 'dsh-motion-background',   // 必须 === package.json 的 name
  factory: (require) => {
    // ...
    return { inject: ['slots'], apply };
  },
});
```

注册键写错的后果是硬失败（整棵插件树加载失败）。

### 3.3 宿主端点

- `GET /motion-background/mods`
- 返回 JSON：`{ mods: Mod[], errors: {id, reason}[], dir: string }`
- **每次请求重新扫目录**（装/卸 mod 不需要重启宿主）
- 单个 mod 坏掉只进 `errors`，**不能让整次请求失败**

`Mod`：
```ts
{
  id: string;          // [a-z0-9-]，且全局唯一
  name: string;
  description: string;
  author: string;
  license: string;
  colors: 'front' | 'array';
  spec: Record<string, number | number[]>;   // uniform 默认值
  panel: { intensity?, softness?, noise?, shape? };   // 旋钮 → uniform 名，或 null
  fragment: string;    // GLSL ES 3.00
  vertex?: string;     // 可选
}
```

**宿主半必须做的校验**（每条都要能单独失败，进 `errors` 而不是抛）：
文件夹名白名单、`mod.json` 存在且是合法 JSON、`id` 非空**且过白名单**、`id` **不重复**、
`fragment.glsl` 存在、`colors` 必须是那两个字面量之一（**非法值不要静默兜底**）。

- **扫描顺序必须确定**：先按文件夹名升序排，再去重与返回。同 `id` 时"文件夹名靠前的生效、其余进 `errors`"，
  不允许依赖文件系统枚举顺序（否则同一份 `mods/` 在不同机器上结果不同）。返回的 `mods[]` 按 `id` 升序。
- **`errors` 的键**：拿不到 manifest 里的 `id` 时（缺文件/坏 JSON/id 非法）用**文件夹名**；
  客户端侧另开 `__render:<id>` 命名空间（编译/链接/契约体检失败）。两套命名空间不要混。
- **两层可用性别混为一谈**：宿主半判的是**结构合法**（能不能读出来），
  真正"能不能渲染"（编译/链接成功、保留 uniform 类型正确、不依赖纹理）只有浏览器里才知道 ——
  后者由客户端记进 `errors['__render:<id>']`，并触发 R3 的回落。

### 3.4 GLSL 契约

- 片元着色器首行 `#version 300 es`，必须 `out vec4 fragColor;`，用 `in vec2 v_uv;`（0..1，左下原点）
- 顶点缓冲固定为 4 个 `vec2` 的 `TRIANGLE_STRIP`
- 内核**保证提供**（声明了就有值）：`u_time`(float) `u_resolution`(vec2) `u_pixelRatio`(float)
  `u_colorBack`(vec4)；`colors="front"` 时另有 `u_colorFront`(vec4)；
  `colors="array"` 时另有 `u_colors[N]`(vec4[])
- **内核不提供任何纹理** ⇒ **mod 不得声明采样器**（`sampler2D`/`samplerCube`/`isampler*`/`usampler*`）；
  声明了即判该 mod 不可用（不是静默 GL error）
- **保留 uniform 的类型必须逐一匹配**（`u_time`/`u_pixelRatio` 是 `float`，`u_resolution` 是 `vec2`，
  `u_colorBack`/`u_colorFront` 是 `vec4`）；类型不符即判不可用并写明原因
- "声明了就有值"的**准确含义**：声明了、且它是 **active uniform**、且类型匹配。
  被 GLSL 编译器优化掉的 uniform（声明但没用）没有 active location，赋不上值 —— 这不违约

### 3.5 设置卡片

```js
slots.inject('settings.section', function* () {
  yield slots.register({ name: 'settings.section', id, order, label: () => label }, Card);
});
```

- **必须走 `inject` 声明路径**。直接 `slots.register` 会硬失败：
  `slot "settings.section" is not declared (a parent entry's children table must declare it)`
- `Card` 是 React 组件；`require('react')` 在 `factory` 里可用；**只能用内联样式**
  （官方类名是构建哈希）。
- **四个通用旋钮始终都渲染**（强度/柔度/颗粒/形态），缺一个就是契约违约。
  某个旋钮**置灰**的充要条件：`panel` 里没有映射、或映射到不存在的 uniform、或当前没有渲染面。
- **旋钮的默认值取 mod 自己的 `spec`** —— 内核**不得**提供自己的默认值去覆盖 mod 的设计。
- **旋钮量程**：默认 `0..1`；mod 可用 `range: { <旋钮>: [min,max] | [min,max,step] }` 声明自己的量程，
  内核必须采纳（不得硬编码 0..1 —— 实测踩过：mod 自述量程 0–2.0，用户只能拖到 1）。

---

## 4. 功能需求（逐条，均可验收）

| 编号 | 需求 | 验收方式 |
|---|---|---|
| R1 | 启动时从宿主端点拉 mod 清单并注册成可选效果 | `__bs.mods.loaded` 含全部合法 mod |
| R2 | 把当前效果渲染成全屏底纹（`position:fixed; z-index:-1`） | 截图/像素统计：非背景色像素 > 0 |
| R3 | 效果切换后重建渲染面，**失败则回落到下一个可用 mod** | 故意放一个坏 mod 在当前位 ⇒ 仍能出画面；**且要区分两类失败**（见下） |
| R4 | 设置卡片注册成功，**始终四个**旋钮；映射有效则可用、无映射/映射到不存在的 uniform 则置灰 | `__bs.settings === 'ok'`；**行为级**：调用组件树得到恰好四个 range 控件，其 enabled/disabled 与 panel 映射一致 |
| R5 | 配置持久化（localStorage），改动**即时生效** | 改旋钮 ⇒ 运行时 spec 变 + 重画（drawArrays 计数 +1），无需刷新；**切换效果也要落盘**，刷新后仍生效 |
| R6 | **关键机制**：把 `--dsw-alias-bg-base` 覆盖成半透明 | 计算样式里含 `color-mix(...)`，且画面真的透出来；关掉后回到不透明 |
| R7 | 自检入口：`__bs.mods` / `__bs.spec` / `probeMods()` | 见 §7 |
| R8 | 降级：无 WebGL2 / 无 mod / 端点不可用 ⇒ 静默跳过，不影响功能 | 各项单独构造并确认不抛，**且面板保持不透明**（没有画面就不该改半透明） |
| R9 | `prefers-reduced-motion: reduce` ⇒ **不跑连续 rAF**；初始化与每次参数变化各允许按需画一帧 | 帧计数在静置时不再增长（与 R5 的"改动即时重画"并不冲突：动一次画一帧） |
| R10 | 卸载时清理：画布、样式表、作用域属性、**内联 `--mb-veil`**、rAF、observer、**WebGL context** | 卸载后 DOM 干净 **且** `loseContext` 被调用过 |

### R3 的两类失败**必须分开**（`__render:` vs `__transient:`）

- **内容坏了**（编译/链接/契约体检失败）⇒ 记 `__render:<id>`：这个 mod 真的不可用
  ⇒ 从下拉框摘掉、并把生效 id 写回配置**是对的**。
- **这次环境不给上下文**（`getContext` 返回 null：GPU 驱逐 / 上下文配额耗尽）⇒ 记 `__transient:<id>`：
  **不得**动用户的选择、**不得**落盘、该 mod 仍留在下拉框里，刷新即可重试。
  把两者混在一起，会让一次瞬时故障**静默改写用户的设置**（离线审核实测过）。

配套两条：

- **`data-mb-live` 门控必须随「启用」开关一起变**：用户取消勾选 ⇒ 立刻撤销半透明
  （否则"没有画面却仍然半透明"，正是 R6 要消灭的场景）。
- **切换效果要回收旧上下文**（`loseContext`），并监听 `webglcontextlost`：丢了就停帧、摘画布、
  恢复不透明、把原因记进 `errors` —— 不能留下"面板半透明、背后没有画面"的状态。

### R6 的原理（**别改这个数字的推导方式**）

DSH 的 `html`/`body` **都没有 background**，页面底色来自 `AppFrame` 与 `ConversationRoot`
**两处** `background: var(--dsw-alias-bg-base)`。每层不透明度 `α` 时：

- 两层叠加后的**累计遮挡率** = `1-(1-α)²`
- 底层背景真正的**透出率** = `(1-α)²`

`α = 52%` ⇒ **遮挡 ≈ 77%、透出 ≈ 23%**（2026-09-25 实测：预测合成色 (225,229,252) vs 实测 (224,228,252)，误差 1/255）。

> ⚠️ 两个容易被说反的点，写文档/注释时别再犯：
> ① `1-(1-α)² ≈ 77%` 是**遮挡率**，不是"透出率"——透出只有 23%；
> ② 想让背景**透出 77%**，每层 α 应取 `1-√0.77 ≈ 12%`，那是另一组参数（会明显影响面板可读性，需实测后再定）。

---

## 5. 已验证的技术事实（直接用，别自己猜）

| 事实 | 出处 |
|---|---|
| `ctx.webServer.register({ kind, path, handler })`，返回 disposer；`kind` 为 `'exact'\|'prefix'`；`handler` 自己管响应生命周期 | `packages/host/webserver/src/index.ts:28` 的 `WebRoute` |
| 宿主插件 `inject: ['webServer']` 后即可 `ctx.webServer` | 同类第三方插件的宿主半 |
| `factory(require)` 里 `require('react')` 可用 | 同上（实测） |
| `getActiveUniform` 只列出**程序里真实使用**的 uniform | WebGL 规范；本项目实测过踩坑 |

---

## 6. 已踩过的坑（**照着避开，别重踩**）

1. **`locs` 只含真实存在的 uniform**。尺寸类（`u_resolution` 等）如果你的顶点着色器也声明了，
   每个程序里都会有；但只被片元着色器用的（如 `u_time`）在**静态效果**里可能不存在 ⇒
   `locs.u_time.l` 会抛 `Cannot read properties of undefined (reading 'l')`。**访问前判存在**。
2. **"重画一帧"不能顺手 `cancelAnimationFrame`** —— 那会取消循环却不重启，
   表现为"改一次参数动画就永久静止"。
3. **游离 canvas 没有布局尺寸**（`clientWidth === 0`）。自检里给它真实 `width/height`，
   否则 `u_resolution=(0,0)`，你只能证明"能编译"、证明不了"画得出" —— **典型的假绿**。
   自检完还要**释放 WebGL context**（`WEBGL_lose_context`），否则累积到浏览器上限就崩。
4. **内核不得给旋钮设默认值**。内核的假设会覆盖 mod 的设计（实测：内核默认 `shape=2`
   灌给了一个自述区间 `0–1` 的 mod，越界）。
5. 如果实现用模板字符串内联 GLSL：**注释里一个裸反引号就会提前终止字符串**，且报错位置
   离真正的问题很远。用 `JSON.stringify` 或外部文件规避。
6. 宿主端点里，**坏 mod 必须被单点兜住**；整次扫描抛异常会让所有效果一起消失。

---

## 7. 验收标准（**必须可执行**）

交付时必须附 `verify.mjs`，`node verify.mjs` 可复跑。要求：

1. **五组覆盖**：宿主半（含各类坏 mod）、mod 解析健壮性、客户端真实渲染、mod 报错时内核不崩、
   **行为级断言**（真调用设置卡片组件树、真驱动 onChange 再看运行时 spec 与 drawArrays 计数、
   真读浅色/深色两种主题下的像素、真数 `loseContext`）。
2. **断言必须真的可能失败** —— 附一个可复跑的**反证驱动器**（本仓库是 `mutations.mjs`），
   每条都是"注入已知坏实现 → 断言必须变红"，并把**执行记录**（退出码 + 具体哪条断言变红）
   写进交付说明（本仓库是 `FALSIFICATION-<date>.md`）。至少覆盖：只输出底色 / 宿主半不隔离 /
   不绘制 / 无回落 / 绕开 slot 声明路径 / 报告中途抛错。**做不到这一条等于没验证。**
3. 客户端部分必须**真跑**（headless Chromium + 真 WebGL2 + 真数像素），不能只做静态检查。
   **不允许把"源码里出现了某个字符串"当作行为证据**（离线审核实测：Card 一个旋钮都不渲染、
   `gl.clear` 完全不跑 mod 着色器，都能骗过纯文本/弱像素断言）。
4. **报告器必须 fail-closed**：任何阶段抛错都要非零退出并明确打印"未完成"，
   **绝不**在中断后打印成功标志。
5. 报告里要**诚实列出没能验证的部分**。

参考量级：宿主半 ~20 条、健壮性 ~20 条、客户端 ~25 条、行为级 ~30 条、反证 ~7 条。

---

## 8. 明令禁止

- ❌ 引入任何第三方着色器库的代码（含"参考着改写"）。需要数学就自己写。
- ❌ 引入网络请求（除读本机端点外）、遥测、`eval`、`new Function`。
- ❌ 把用户凭据、文件内容上传到任何地方。
- ❌ 让内核在缺少 webServer / slots / react 时**抛错**（必须静默降级）。
- ❌ 修改 `mods/` 里已有 mod 的文件。
