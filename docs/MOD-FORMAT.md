# Mod 格式规范

> 本仓库的动态背景**由 mod 提供**。内核只负责：加载 mod、编译着色器、驱动绘制、
> 渲染设置面板。**内核不含任何第三方着色器代码。**
>
> 装一个效果 = 往 `mods/` 里丢一个文件夹；卸一个效果 = 删掉那个文件夹。
> 改完刷新页面即可（不需要重启宿主）。

**mod 有两大类**：

| 类型 | 靠什么出画 | 必需文件 | 适用 |
|---|---|---|---|
| **着色器型** | WebGL2 + GLSL（程序化生成） | `mod.json` + `fragment.glsl` | 流星雨、极光…需要实时演算的效果 |
| **媒体型** | 浏览器原生 `<video>` / `<img>` | `mod.json`（含 `media` 字段） | 现成的 MP4 / GIF / 图片当背景 |

两类**可以混装**在同一个 `mods/` 里，扫描、下拉框、回落逻辑一视同仁。
媒体型的存在意义之一是**在没有 WebGL2 的环境里照样能跑**（它完全不碰 WebGL）。

---

## 1. 目录结构

### 着色器型

```
mods/
└── <mod-id>/                 文件夹名建议与 id 一致
    ├── mod.json              必需。元数据 + 默认参数
    ├── fragment.glsl         必需。片元着色器（GLSL ES 3.00）
    ├── vertex.glsl           可选。缺省用内核自带的全屏 quad 顶点着色器
    └── README.md             可选。给人看的说明
```

### 媒体型

```
mods/
└── <mod-id>/
    ├── mod.json              必需。含 "media" 字段（不需要 "colors"）
    ├── bg.mp4                必需（名字由 media.src 指定）。mp4/webm/gif/webp/png/jpg/jpeg
    └── README.md             可选
```

> **媒体型不需要** `fragment.glsl`，也**不需要** `colors` —— 它不走 WebGL，这两项对它是无意义的。
> 反过来，着色器型**必须有** `fragment.glsl` 和合法的 `colors`。

`mod-id` 只允许 `[a-z0-9-]`。**去重按 `id`（不是文件夹名）**：两个文件夹声明同一个 `id` 时，
**按文件夹名升序排在最前的那个生效，其余的进 `errors`**（顺序是确定的）。
文件夹名建议与 `id` 一致，但两者是**两件事**：文件夹名要过同一套白名单，`id` 取自 `mod.json`。

---

## 2. `mod.json`

### 着色器型

```json
{
  "id": "meteor",
  "name": "流星雨",
  "description": "斜向划过的流星与拖尾",
  "author": "your-name",
  "license": "MIT",
  "order": -10,
  "colors": "front",
  "spec": {
    "u_density": 0.5,
    "u_speed": 1.0
  },
  "panel": {
    "intensity": "u_density",
    "softness": null,
    "noise": null,
    "shape": null
  }
}
```

### 媒体型

```json
{
  "id": "aurora-video",
  "name": "极光",
  "description": "直接用浏览器原生 <video> 播放一段视频当背景",
  "author": "your-name",
  "license": "CC0-1.0",
  "order": 10,
  "media": { "src": "bg.mp4", "fit": "cover", "opacity": 1, "blend": false, "playMode": "pingpong" },
  "panel": {}
}
```

> `name` 里**不要**写类型词（别写「极光（视频）」）—— 面板会自己按扩展名加标注，
> 自己再写一次就成了「极光（视频）（MP4 视频）」。见 §2.2 末尾的说明。

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | ✅ | 效果标识，同时是设置面板里的取值；只允许 `[a-z0-9-]`，全局唯一 |
| `name` | ✅ | 面板上显示的名字（**缺了会回落到 `id`**，但不建议依赖这个兜底） |
| `description` | | 面板上的副标题 |
| `author` / `license` | | 来源与许可；**若你的 mod 内含第三方素材，必须在此声明** |
| `order` | | 排序权重，数字越小越靠前，缺省 `0`；见 §2.1 |
| `colors` | 着色器型 ✅ | 颜色注入模式，见下；**非法值直接判该 mod 不可用**（不静默兜底）。**媒体型不需要也不该写** |
| `media` | 媒体型 ✅ | 媒体素材声明，见 §2.2。**给了它就是媒体型** |
| `spec` | | 该效果的**默认参数**：`uniform 名 → 数值`（媒体型无意义） |
| `panel` | | 把面板的四个通用旋钮映射到你的 uniform |
| `range` | | 旋钮量程：`{ "<旋钮名>": [min, max] }` 或 `[min, max, step]`；不写就按 `0..1` |

### 2.1 `order` —— 谁是"默认效果"

`mods[0]` 就是**用户第一次打开时看到的效果**。没有 `order` 的话，这件事完全由**文件夹起名**决定 ——
往 `mods/` 里丢一个 `aurora-video` 就会把原本精心调的 `meteor` 挤成第二个。

排序规则：**`order` 升序 → `id` 字典序兜底**。

```json
"order": -10     // 想让它当默认，就给个比其它 mod 更小的数
```

> 兜底那一级**不能省**：所有 mod 的 `order` 都是 `0` 时，仍然必须有确定顺序，
> 否则"同 id 时哪个生效"就不确定了。

### 2.2 `media` —— 媒体型声明

```json
"media": { "src": "bg.mp4", "fit": "cover", "opacity": 1, "blend": false }
```

| 键 | 缺省 | 说明 |
|---|---|---|
| `src` | — | **必需**。素材文件名，**只能是本 mod 目录下的文件名**：不许含路径分隔符、不许含 `..` |
| `fit` | `"cover"` | `"cover"`（铺满、可能裁切）或 `"contain"`（完整可见、可能留白）→ CSS `object-fit` |
| `opacity` | `1` | `0..1`，超出会被夹到范围内 |
| `blend` | `false` | `true` ⇒ CSS `mix-blend-mode: screen`（浅色素材叠在界面上更自然） |
| `playMode` | `"loop"` | **仅视频型**（`.mp4` / `.webm`）有意义。`"loop"` = 播完跳回开头；`"pingpong"` = 正放到底再**倒放**回来。它只是**建议值** —— 用户在面板里选过之后以用户的选择为准 |

**也接受简写**：`"media": "bg.mp4"`（等价于只给 `src`，其余取缺省）。

**关于 `playMode`**：申报 `"pingpong"` 适合**头尾不衔接**的素材（循环时接缝处会"跳一下"），
代价是倒放段由脚本逐帧驱动（浏览器不支持负的 `playbackRate`，见根 README），比正放略耗 CPU。
面板里的「播放」下拉框**只在视频型出现** —— 静态图片没有时间轴、GIF 的循环由解码器自驱
（`pause()` / `currentTime` 都控制不了它），给它们显示这个控件等于给一个点了没反应的开关。

> ⚠️ mod 作者不需要管这件事，但值得知道：倒放**不是**"每帧发一个 seek"——
> 那样做会让每次新赋值掐掉在途的 seek，落位率只剩 5%、画面退化成 2~3 fps 的幻灯片。
> 现在的驱动有 seek 闸门（在途不重发 + 攒时间 + 250ms 兜底），落位率 100%、满帧。
> 细节与数据见根 README 的「视频的播放模式」一节。

**效果名的显示**：媒体型在设置面板的下拉框里会带一个**类型标注**，形如「极光（MP4 视频）」。
标注由宿主半按扩展名派生（`media.label`，见 `MEDIA_LABEL`），**不需要**写进 `mod.json` 的 `name` ——
所以 `name` 保持纯净（就叫「极光」），换素材时标注会自动跟着变，不会出现"标着 MP4、实际是 WebM"。

> ⚠️ **别在 `name` 里自己写类型词**（例如 `"name": "极光（视频）"`）。内核会再追加一次标注，
> 面板里就显示成「极光（视频）（MP4 视频）」双重标注。`verify.mjs` 的 E19f 有一条回归断言钉住它。

**允许的扩展名（白名单，不是黑名单）**：

| 扩展名 | MIME | 用哪个元素 |
|---|---|---|
| `.mp4` | `video/mp4` | `<video>` |
| `.webm` | `video/webm` | `<video>` |
| `.gif` | `image/gif` | `<img>` |
| `.webp` | `image/webp` | `<img>` |
| `.png` | `image/png` | `<img>` |
| `.jpg` / `.jpeg` | `image/jpeg` | `<img>` |

不在表里的扩展名 ⇒ **该 mod 判不可用**并进 `errors`（所以别想用 `../` 或绝对路径读别的文件：
`src` 里出现分隔符或 `..` 会直接被拒，整个 mod 不加载）。

**媒体文件怎么被送出去**（`/motion-background/media/<id>/<file>`）由宿主半负责，要点：

- **只服务白名单扩展名**，且路径必须是 `/media/<id>/<文件名>` 这个**固定两段**形状；
  文件名不许含 `..` 或任何分隔符 —— 不合格一律 404（且**不泄漏**目录内容）。
- **支持 HTTP Range**（`206` + `content-range`）。这不是可选项：浏览器播 mp4 时会先发
  `Range: bytes=0-` 探测，不支持 Range 的响应在部分浏览器上会让 `<video>` 直接不播或不能循环。
- **不缓存**（`cache-control: no-store`）：媒体随 mod 走，改了就该立刻生效。
- 单个媒体请求失败**不会**打崩宿主进程（流错误有处理）。

**媒体型在设置面板里的行为**：四个通用旋钮对它是**置灰**的（它们映射的是 uniform，媒体型没有 uniform）；
「面板浓度」（整体透明度）**仍然有效**。**视频型**额外多一个「播放」下拉框（循环 / 往返）。
跑不了的时候原因会记进 `errors`，键名前缀同样是 `__mediaplay:<id>`（自动播放被拒等）。


### `colors` 模式

| 值 | 内核会注入 | 适用 |
|---|---|---|
| `"front"` | `u_colorFront`（主色，vec4）、`u_colorBack`（不透明背景，vec4） | 单色系效果 |
| `"array"` | `u_colors[]`（多个色团，vec4 数组）、`u_colorBack` | 多色渐变类效果 |

内核注入的颜色**来自 DSH 主题令牌**，所以深浅主题各自成立、切主题自动跟随。
`vec4` 的 alpha 一律为 1。

### `panel` 映射

面板上有**固定四个**通用旋钮。把它们指到你的 uniform 上，用户就能在设置里调：

```json
"panel": { "intensity": "u_amplitude", "softness": "u_softness", "noise": null, "shape": null },
"range": { "intensity": [0, 2] }
```

- 值为 uniform 名 ⇒ 该旋钮生效
- 值为 `null`（或映射到一个**不存在的 uniform**）⇒ **该旋钮置灰**（不会误导用户去拖一个没反应的滑块）
- **四个旋钮始终都渲染**（内核不因你没映射就少画一个），只是没映射的置灰
- 旋钮初始值取你 `spec` 里写的值；**内核不提供自己的默认值**（否则会拿内核的假设盖掉你的设计）
- 量程默认 `0..1`；要别的范围就写 `range`：`[min, max]` 或 `[min, max, step]`
  - 写坏了（`[2,0]` 这种 `min ≥ max`、非数字、`null`）内核会**兜底成合法区间**，不会把滑块搞成
    `min>max`、负 `step` 的非法控件；
  - 若你的 `spec` 初值**超出**自己声明的 `range`，内核会**把初值夹进 range**（面板显示什么就渲染什么）。
    两者本应一致，不一致时以 `range` 为准。

---

## 3. GLSL 契约

### 片元着色器（必需）

```glsl
#version 300 es
precision highp float;

uniform float u_time;        // 秒（可选）
uniform vec2  u_resolution;  // 画布像素（可选）
uniform vec4  u_colorFront;  // 若 colors="front"（可选）
uniform vec4  u_colorBack;   // 若 colors 任意（可选）

in vec2 v_uv;                // 0..1，左下为原点
out vec4 fragColor;

void main() {
  fragColor = mix(u_colorBack, u_colorFront, v_uv.y);
}
```

**硬性要求**

1. 首行必须是 `#version 300 es`（WebGL2 / GLSL ES 3.00）。
2. 必须声明 `out vec4 fragColor;` 并写入它（**注释里写不算** —— 自检会剥掉注释后再判）。
3. 用 `in vec2 v_uv;` 拿坐标 —— 内核保证提供。
4. **不复用第三方着色器代码。** 若必须引用，请在 `mod.json` 的 `author`/`license`
   与 `README.md` 里写清来源，并遵守其许可。
5. 纯程序化优先：内核**不提供噪点贴图**。要随机就自己写 hash。
6. **不得声明采样器**（`sampler2D` / `samplerCube` / 各种 `isampler` / `usampler`）——
   内核不绑定任何纹理。口径是"禁止**活跃** sampler"：真的用它（例如 `texture(u_tex, v_uv)`）会被判
   **不可用**并回落；声明了但从不采样，会被 GLSL 编译器优化掉、也就不在禁止之列（无害）。
7. **保留 uniform 的类型必须与契约一致**（见 §4 表）：例如把 `u_time` 声明成 `vec2`，
   内核用 `uniform1f` 赋值会得到静默的 GL error，所以这种 mod 同样会被判不可用（并在 `errors` 里说明原因）。

### 顶点着色器（可选）

仅在需要自定义坐标变换时才提供。必须输出 `v_uv`（或你自己声明的 `out`），
并把 `a_position` 写到 `gl_Position`：

```glsl
#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * .5 + .5;
  gl_Position = vec4(a_position, 0., 1.);
}
```

顶点缓冲固定：**4 个 vec2 的 TRIANGLE_STRIP**（`-1,-1 → 1,-1 → -1,1 → 1,1`）。

---

## 4. 内核提供的 uniform

| 名字 | 类型 | 何时提供 | 说明 |
|---|---|---|---|
| `u_time` | float | 常驻 | 秒，从挂载起单调增长 |
| `u_resolution` | vec2 | 常驻 | 画布像素尺寸（已含 DPR） |
| `u_pixelRatio` | float | 常驻 | `min(devicePixelRatio, DPR_MAX)` —— **上限由内核算**，不要假定它等于 `devicePixelRatio`。当前 `DPR_MAX = 1`，见根 README「资源占用」一节 |
| `u_colorBack` | vec4 | 所有模式 | 不透明背景色（来自主题令牌） |
| `u_colorFront` | vec4 | `colors="front"` | 主色 |
| `u_colors[N]` | vec4[] | `colors="array"` | 色团；**实际条数 = 内核从主题令牌读到的条数**（当前实现 3–4 条，上限 8）。你写的 `N` 大于实际条数时，多出来的元素不会被赋值（读到 0） |
| 你自己 `spec` 里的键 | 任意 | 你声明了就有 | 内核按 `gl.getActiveUniform` 的类型赋值 |

**赋值规则**：内核遍历**程序中真实存在**的 uniform，按名字去 `spec` 取默认值，没有的跳过。

> ⚠️ 三条例外，都是 GLSL 的语义决定的：
> ① "声明了就有值"的准确含义是"**声明了、且它是 active uniform、且类型匹配**"——
>    被 GLSL 编译器优化掉的 uniform（声明但没用）没有 active location，内核自然也赋不上值；
> ② 保留 uniform（`u_time` 等）类型必须与上表一致，否则该 mod 判不可用（见 §3 硬性要求 7）；
> ③ 纹理采样器一律不可用（见 §3 硬性要求 6）。
>
> 实践建议：**用不到的 uniform 就别写进 `spec`**（写了但着色器里没声明，内核忽略，不报错也不生效）。

---

## 5. 安装 / 卸载

```bash
# 装：把一个 mod 文件夹放进去
cp -r my-effect mods/

# 卸：删掉它
rm -rf mods/my-effect
```

然后**刷新 DSH 页面**即可。宿主半每次请求都会重新扫目录，所以不需要重启宿主。

**验证你的 mod**：打开页面控制台，看 `__betterSkin.mods`：

```js
__betterSkin.mods
// { loaded: ['meteor', ...], errors: { ... }, dir: '...' }
```

编译失败的 mod **不会**让整页挂掉 —— 它会被记进 `errors`（键名形如 `__render:<id>`）
并从效果下拉框里摘掉（面板下方会列出"未能使用"的 mod）。

`errors` 的键名有约定，看前缀就知道是哪一层的问题：

| 键名 | 含义 |
|---|---|
| `<文件夹名>` | 宿主半扫目录时的结构问题（缺 `mod.json`、JSON 坏、id 非法/重复、缺 `fragment.glsl`、`colors` 非法…）。**拿不到 `mod.json` 里的 id 时，键就是文件夹名** |
| `__render:<id>` | **内容坏了**：客户端编译/链接/契约体检失败（GLSL 语法错、保留 uniform 类型不符、活跃 sampler…）。这类 mod 会**从效果下拉框摘掉** |
| `__mediaplay:<id>` | **媒体型专用**：素材加载出来了但**播不动**（自动播放被浏览器策略拒绝、解码失败…）。画面可能停在首帧或空白，**不属于"内容坏"**，不会把 mod 从下拉框摘掉 |
| `__transient:<id>` | **这次环境不给上下文**（`getContext` 返回 null：GPU 驱逐、上下文配额耗尽…）。**不动用户的选择**、也不落盘，刷新可重试；该 mod 仍留在下拉框里 |
| `__contextlost:<id>` | 跑着的时候 WebGL 上下文丢了。内核会停帧、摘画布、把面板恢复成不透明，并把原因记在这里 |
| `__endpoint` | mods 端点整体不可用（网络/HTTP 错） |
| `__dir` / `__scan` | 目录读不了 / 整次扫描抛错（理论上不该出现，出现即宿主半有 bug） |
