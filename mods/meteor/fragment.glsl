#version 300 es
/*
 * meteor —— 流星雨（程序化，无纹理）
 * ---------------------------------------------------------------------------
 * 契约：in vec2 v_uv（0..1，左下角原点）/ out vec4 fragColor
 *       内核可选注入 u_time / u_resolution / u_colorBack / u_colorFront
 *       另加 6 个自声明 uniform（见 mod.json 的 spec）
 *
 * 思路（全部自写，未参考任何第三方着色器库）：
 *   1. 把屏幕坐标旋转到"流星沿 +q.x 直线飞行"的坐标系，纵横比先校正，
 *      这样所有流星天然互相平行、粗细各向同性；
 *   2. 每层雨把 q.y 切成等距的"跑道"（lane），一条跑道同时只有一颗流星。
 *      每像素每层只算 1 条跑道 ⇒ 每像素共 2 次解析求值，没有嵌套循环；
 *   3. 单颗流星 = 「头部圆形高斯」+「身后指数衰减的窄带」，
 *      带宽随离头距离收束（彗尾形状），头部前方用一个短指数砍掉；
 *   4. 头部沿 q.x 从左屏外扫到右屏外，两端都不可见
 *      ⇒ 相位回绕的那一瞬间画面本就没有流星，天然无缝，不需要额外淡入淡出；
 *   5. 星点 = 网格里一格一颗、格内抖动 + 指数幅度分布 + 正弦闪烁，
 *      用自研 fract 折叠哈希，不依赖任何纹理。
 *
 * 颜色：只用 u_colorFront 派生（含逐通道高光软压缩，核心自然压白 —— 压白是
 *       achromatic 的，不引入任何新色相），底色直接取 u_colorBack。
 */

precision highp float;

in  vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec4  u_colorBack;
uniform vec4  u_colorFront;

uniform float u_intensity;  // 整体亮度增益          0.0 – 2.0
uniform float u_softness;   // 拖尾柔度（半宽 / 晕）  0.0 – 1.0
uniform float u_noise;      // 星点密度与亮度        0.0 – 1.0
uniform float u_shape;      // 拖尾长度（形态）      0.0 – 1.0
uniform float u_angle;      // 飞行倾角（弧度）      0.15 – 1.45
uniform float u_speed;      // 时间倍率              0.2  – 3.0

const float TAU  = 6.283185307179586;
const float GOLD = 0.618033988749894;

/* ------------------------------------------------------------------ 哈希 */
/* 自研：黄金比错开 + 两次 fract 大数散射 + 一次自乘折叠。
   不用 sin()（中低精度设备上 sin 有平台区，会产生条带）。 */
float rnd1(float n) {
  float s = fract(n * GOLD + 0.3719);
  s = fract(s * 371.1953 + 0.2147);
  s = fract(s * (s * 29.77 + 7.13));
  return s;
}

float rnd2(vec2 p) {
  float a = rnd1(p.x * 12.9898 + p.y * 4.1414);
  float b = rnd1(p.y * 39.3468 + p.x * 11.1351);
  return fract(a * 57.3127 + b * 13.7713);
}

/* -------------------------------------------------------------- 单层流星雨 */
/*
 * q      : 已旋转 + 纵横比校正的空间（流星沿 +q.x 前进）
 * laneH  : 相邻跑道的间距（q 单位），越小流星越密
 * period : 基准周期（秒），乘上每条跑道的随机系数后得到实际周期
 * len    : 拖尾基准长度；wid: 拖尾基准半宽
 * gain   : 该层亮度
 * span   : 头部越出画面的距离，必须 > 视野半宽 + 最长拖尾
 *          （满足后相位回绕瞬间整颗流星都在画面外 ⇒ 无缝）
 * seed   : 该层随机种子，避免两层跑道重合
 */
float meteorLayer(vec2 q, float t, float laneH, float period,
                  float len, float wid, float gain, float span, float seed) {
  float laneId = floor(q.y / laneH);
  float lid    = laneId + seed;

  /* 每条跑道五个独立随机量：位置抖动 / 周期 / 相位 / 拖尾长度 / 亮度 */
  float h1 = rnd1(lid * 1.7 + 3.1);
  float h2 = rnd1(lid * 2.9 + 11.7);
  float h3 = rnd1(lid * 5.3 + 27.3);
  float h4 = rnd1(lid * 7.1 + 41.9);
  float h5 = rnd1(lid * 11.3 + 57.1);

  /* 跑道线在带内抖动，避免整齐的网格感 */
  float laneY = (laneId + 0.10 + 0.80 * h1) * laneH;

  float per = period * mix(0.55, 1.90, h2);
  float ph  = fract(t / per + h3);

  /* 头部从左屏外扫到右屏外 */
  float headX = mix(-span, span, ph);
  float L     = len * mix(0.75, 1.35, h4);
  float g     = gain * mix(0.62, 1.15, h5);

  float dx = q.x - headX;
  float dy = q.y - laneY;

  float behind = max(-dx, 0.0);
  float ahead  = max( dx, 0.0);

  /* 头部高光半径（先算，尾部收束与前沿截断都要用） */
  float hr = wid * mix(1.9, 3.4, h1);

  /* 拖尾：身后指数衰减 + 末端平滑收尾 + 身前紧贴头部截断。
     两个指数合并成一个 exp（exp(a)·exp(b) ≡ exp(a+b)，数学上完全等价）——
     全屏每像素省下 2 次 exp，画面一模一样。 */
  float fade = exp(-behind / L - ahead / (hr * 1.2))
             * (1.0 - smoothstep(L * 1.5, L * 3.2, behind));

  /* 贴近头部处把拖尾撑宽，和头部圆斑平滑接上，避免"圆球插在细棍上" */
  float w = wid * (0.22 + 1.08 * exp(-behind / (L * 1.5)));

  /* 垂直于飞行方向的窄带横截面 */
  float band = exp(-(dy * dy) / (w * w));

  /* 头部：比拖尾宽的圆斑 */
  float head = exp(-(dx * dx + dy * dy) / (hr * hr));

  return (band * fade + head * 1.05) * g;
}

/* ------------------------------------------------------------------ 星点 */
float starField(vec2 p, float t, float amt) {
  const float SCALE = 27.0;

  vec2 g  = p * SCALE;
  vec2 id = floor(g);
  vec2 f  = fract(g) - 0.5;

  float r1 = rnd2(id + 0.13);
  float r2 = rnd2(id + 19.31);
  float r3 = rnd2(id + 73.77);
  vec2  r4 = vec2(rnd2(id + 5.51), rnd2(id + 41.09));

  /* 只有一部分格子真的有星，密度随 u_noise 上升 */
  float live = step(r2, 0.18 + 0.50 * amt);

  /* 格内抖动（幅度 0.31，远小于半格 0.5，星点不会被格子边界切掉） */
  vec2  off = (r4 - 0.5) * 0.62;
  float d   = length(f - off);

  /* 幅度分布：暗星多、亮星少 */
  float mag = mix(0.18, 1.0, pow(r1, 2.4));
  /* 缓慢闪烁 —— 正弦对 t 严格周期，天然无缝 */
  float twk = 0.58 + 0.42 * sin(t * 1.35 + r3 * TAU);
  /* 半径压在亚像素级，避免星点糊成光斑 */
  float rad = mix(0.030, 0.052, r3);

  return live * mag * twk * exp(-(d * d) / (rad * rad)) * amt;
}

/* ------------------------------------------------------------------ 主函数 */
void main() {
  /* 两个 max 兜底：万一内核没注 u_resolution（默认 (0,0)），aspect 会变成 0
     导致整幅画塌成一条线；这里退化成 1.0（可按方屏处理）而不是 0。
     对任何合法分辨率，这两次 max 都是恒等变换，不影响正常路径。 */
  float aspect = max(u_resolution.x, 1.0) / max(u_resolution.y, 1.0);
  vec2  half_  = vec2(aspect * 0.5, 0.5);
  vec2  p      = (v_uv - 0.5) * vec2(aspect, 1.0);

  float ca = cos(u_angle);
  float sa = sin(u_angle);
  /* 列主序：mat2(c0.x,c0.y,c1.x,c1.y)，即逆时针旋转 u_angle */
  vec2  q  = mat2(ca, sa, -sa, ca) * p;

  /* 视野矩形在 q 空间里的 x 半宽（用于把流星甩到画面外） */
  float qxMax = abs(ca) * half_.x + abs(sa) * half_.y;

  float t = u_time * max(u_speed, 0.001);

  /* 旋钮 -> 形态参数 */
  float lenA = mix(0.13, 0.50, u_shape);
  /* 长拖尾略收细（免得糊成色带），但只收一点：拖尾变长时流星本来就会
     因为要飞出画面而变稀，再猛收宽度会让这个旋钮变成"变暗旋钮" */
  float widA = mix(0.0020, 0.0088, u_softness) * mix(1.18, 0.86, u_shape);

  const float KLEN = 1.35;    /* meteorLayer 里 L 的随机浮动上限 */
  float spanA = qxMax + lenA * KLEN * 3.2 + 0.12;
  float spanB = qxMax + lenA * 0.62 * KLEN * 3.2 + 0.12;

  /* 主雨 + 远景小雨（每像素各 1 次解析求值，不是逐跑道循环） */
  float m = meteorLayer(q, t, 0.175, 2.35, lenA,        widA,        1.00, spanA, 0.0);
  m += meteorLayer(q, t, 0.290, 3.90, lenA * 0.62, widA * 0.62, 0.42, spanB, 31.7);
  m = max(m, 0.0);

  float st = 0.0;
  if (u_noise > 0.002) st = starField(p, t, u_noise);   /* 一致分支，无 warp 发散 */

  vec3 tint = u_colorFront.rgb;
  vec3 add  = tint * (m * 1.25 * u_intensity) + tint * (st * 0.55);

  /* 高光逐通道软压缩：核心自然压白，永远不会硬裁切出纯色块；
     背景色本身不参与压缩，保持与主题令牌逐位一致 */
  vec3 amt = vec3(1.0) - exp(-add * 1.5);

  /* ⚠️ 方向按底色亮度选：浅色底上"加亮"会直接饱和到纯白 ——
     实测（2026-09-25 离线审核）：浅色主题下整帧 uniqueColors=1，画面恒等于底色。
     浅色底改成**按比例压暗**，深色底维持加亮；两条都让 amt=0 时精确等于底色。 */
  float baseLuma = dot(u_colorBack.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 lit = baseLuma > 0.5
    ? u_colorBack.rgb * (1.0 - amt * 0.92)
    : u_colorBack.rgb + amt;

  fragColor = vec4(lit, 1.0);
}
