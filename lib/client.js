/**
 * dsh-motion-background · 客户端半 —— **效果内核**
 *
 * ⚠️ 本文件是**本仓库原创代码**，不含任何第三方着色器：
 *   · 渲染层（全屏 quad、编译、uniform 赋值、绘制循环）—— 自己写
 *   · 不依赖任何噪点贴图；需要随机由 mod 自己写 hash
 *   · 效果（GLSL）一律来自 `mods/`，由宿主半扫描后经 HTTP 交给这里
 *
 * 因此本文件可以公开分发；效果是否可公开，取决于**对应 mod 自己的许可**。
 *
 * 唯一"非原创"的机制性知识（不是代码）：覆盖 `--dsw-alias-bg-base` 为半透明，
 * 让底纹能从面板底下透上来 —— 这是本项目的设计结论，见 README。
 */

window.__ModuleLoader__.load({
  id: 'dsh-motion-background',
  factory: (require) => {
    /** 宿主半注册的 mod 清单端点。 */
    const MODS_ENDPOINT = '/motion-background/mods';
    /** 皮肤作用域属性（CSS 全挂在它下面）。 */
    const SCOPE_ATTR = 'data-motion-background';
    /** "真的有渲染面" 的门控属性：面板半透明只在它存在时生效。 */
    const MB_LIVE_ATTR = 'data-mb-live';
    const STYLE_TAG_ID = 'dsh-motion-background/backdrop.css';
    const CONFIG_KEY = 'dsh-motion-background.config';
    /** 一个 mod 最多能用几个色团。 */
    const MAX_COLORS = 8;

    /* ════════════════ 渲染层（原创） ════════════════ */

    /** 缺省顶点着色器：一个全屏 quad，只把位置映射成 0..1 的 UV。 */
    const VERTEX_QUAD = [
      '#version 300 es',
      'precision highp float;',
      'layout(location = 0) in vec2 a_position;',
      'out vec2 v_uv;',
      'void main() {',
      '  v_uv = a_position * .5 + .5;',
      '  gl_Position = vec4(a_position, 0., 1.);',
      '}',
    ].join('\n');

    /** TRIANGLE_STRIP 的四个角（vec2）。 */
    const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

    /**
     * 用户是否要求减弱动效。
     *
     * ⚠️ 定义在**工厂作用域**（不是某个 createSurface 的闭包内）：
     *    着色器型与媒体型都要用它，关进任一个闭包里另一个就用不到了。
     */
    function prefersReduce() {
      try {
        return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      } catch { return false; }
    }

    /**
     * 造一个渲染面。
     *
     * @param {HTMLCanvasElement} canvas
     * @param {object} mod - 已解析的 mod（fragment / vertex? / spec / colors）
     * @param {object} palette - 主题颜色（由调用方从令牌读出）
     * @returns {object} { boot, frame, paint, stop, spec, info }
     */
    /**
     * 全屏背景的**帧率上限**（fps）。
     *
     * ⚠️ 为什么必须有上限（实测定位）：`requestAnimationFrame` 会跟着**显示器
     *    刷新率**跑 —— 在 240Hz 屏上就是 240 次/秒的**全屏** shader 重绘。实测把 dsh 页面
     *    放在前台时 rAF 跑到 96 fps（窗口 1600×1000）、被别的窗口遮挡后**仍有 79 fps**：
     *    切到别的窗口后它照样把 GPU 吃满，而鼠标移动/点击都要经桌面合成 ⇒ **整个桌面卡顿**。
     *    （浏览器的自动节流只在"标签页不可见"或"窗口被完全遮挡"时生效，"失焦但仍可见"
     *      这一档不节流 —— 而这恰好是最常见的情形。）
     *
     * 取值理由：流星雨这类效果是**慢速氛围动画**，30 fps 在观感上足够；
     * 相比 240Hz 的满速，GPU 负担降到 1/8。想要更顺滑就调大这个数（60 也行），
     * 但**不要去掉上限** —— 那会把用户的桌面一起拖慢。
     */
    const FPS_ACTIVE = 30;
    /**
     * 窗口**失焦**（你在用别的窗口）时的帧率上限。
     *
     * ⚠️ 这一档是"别的窗口为什么卡"的直接解药：窗口失焦但还可见时，浏览器**不会**停
     *    rAF，于是背景继续全屏重绘、和前台的操作抢 GPU。分档之后，前台窗口才有 GPU 可用。
     *
     * 取值理由（实测后调整 5 → 15）：最初取 5 fps 太保守 —— 用户把两个窗口
     * **并排**时能明显看出流星雨"变顿"（那不是 bug，是这一档在生效；但观感确实差）。
     * 而同一轮里 `DPR_MAX` 已把像素量压到 44%，**GPU 余量足够**：
     * 前台 30 fps 实测只占 17.4% ⇒ 15 fps 约 9%、5 fps 约 3%。
     * ⇒ 用 9% 换"并排时看着顺"是划算的；仍远低于不分档时的饱和。
     */
    const FPS_BLURRED = 15;
    /**
     * **渲染分辨率的 devicePixelRatio 上限**（画布实际像素 = CSS 尺寸 × 本值）。
     *
     * ⚠️ 为什么必须限（实测定位）：限了帧率**还不够**。用户机 2560×1600、
     *    Windows 缩放 150% ⇒ `devicePixelRatio = 1.5` ⇒ 全屏画布 **3840×2400 = 920 万像素**；
     *    按 30 fps 就是 **2.76 亿像素/秒**。实测那一档时 Chrome 的 GPU 进程占到 **86.9%**
     *    （而 dwm / 其它窗口被挤到个位数）—— 桌面合成仍被拖慢。
     *
     * 取值理由：这是**慢速氛围背景**，降分辨率几不可见（不像降帧率那样看得出顿）。
     *    1.5 → 1.0 让像素量降到 **44%**（920 万 → 410 万），预计把 GPU 从 ~87% 压到 ~38%。
     *    想让画面更锐可以调到 1.25/1.5，但你得接受相应比例的 GPU 占用。
     */
    const DPR_MAX = 1;

    function createSurface(canvas, mod, palette) {
      let gl = null, prog = null, locs = null, quadBuf = null;
      let t0 = 0, raf = 0, ready = false;
      /** 上一次**真正绘制**的墙上时间（节流用；0 = 还没画过 ⇒ 首帧必画）。 */
      let lastDrawnAt = 0;
      let error = null;

      /** 把 spec 与主题颜色合成一份"本实例实际使用的参数"。 */
      const spec = Object.assign({}, mod.spec);
      if (mod.colors === 'array') {
        spec.u_colors = palette.colors.slice(0, MAX_COLORS).map((c) => [c[0], c[1], c[2], 1]);
      } else {
        spec.u_colorFront = palette.front;
      }
      spec.u_colorBack = palette.back;

      /* 量程夹取：mod 自己的 spec 初值若超出**它自己声明的** range，按 range 夹一次 ——
         否则面板显示被夹后的值、渲染却用未夹的初值（"看到的不是跑的"）。
         只有"panel 里映射了、且声明了 range"的旋钮会被夹，其它一律不动。 */
      for (const knob of ['intensity', 'softness', 'noise', 'shape']) {
        const name = mod.panel?.[knob];
        if (typeof name !== 'string' || typeof spec[name] !== 'number') continue;
        const rg = knobRange(mod, knob);
        spec[name] = clampToRange(spec[name], rg) ?? spec[name];
      }

      function compileShader(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
          const log = gl.getShaderInfoLog(sh) || '(无日志)';
          gl.deleteShader(sh);
          throw new Error('着色器编译失败：' + String(log).slice(0, 300));
        }
        return sh;
      }

      /** 收集程序里**真实存在**的 uniform：名字 → {loc, type}。 */
      function collectUniforms() {
        const map = {};
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
          const u = gl.getActiveUniform(prog, i);
          if (u === null) continue;
          // 数组 uniform 报出来是 `u_colors[0]`，统一去掉下标
          const name = u.name.replace(/\[0\]$/, '');
          map[name] = { loc: gl.getUniformLocation(prog, u.name), type: u.type };
        }
        return map;
      }

      /** 按类型把一个值写进 uniform；类型不认识就跳过（不抛）。 */
      function writeUniform(entry, value) {
        if (value === null || value === undefined) return;
        const { loc, type } = entry;
        if (type === gl.FLOAT) gl.uniform1f(loc, +value);
        else if (type === gl.FLOAT_VEC2 && Array.isArray(value)) gl.uniform2f(loc, value[0], value[1]);
        else if (type === gl.FLOAT_VEC3 && Array.isArray(value)) gl.uniform3f(loc, value[0], value[1], value[2]);
        else if (type === gl.FLOAT_VEC4) {
          if (Array.isArray(value) && Array.isArray(value[0])) gl.uniform4fv(loc, value.flat());
          else if (Array.isArray(value)) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
        } else if (type === gl.INT || type === gl.BOOL) gl.uniform1i(loc, value ? 1 : 0);
      }

      /** 契约要求这五个保留 uniform 的类型（声明了就必须是这个类型）。 */
      const RESERVED_TYPES = () => ({
        u_time: [gl.FLOAT, 'float'],
        u_resolution: [gl.FLOAT_VEC2, 'vec2'],
        u_pixelRatio: [gl.FLOAT, 'float'],
        u_colorBack: [gl.FLOAT_VEC4, 'vec4'],
        u_colorFront: [gl.FLOAT_VEC4, 'vec4'],
      });

      /**
       * 契约体检（**行为级**，不是文本 grep）：
       *   ① 保留 uniform 若被声明，类型必须与契约一致 —— 否则内核用 uniform1f 去写一个
       *      `uniform vec2 u_time` 只会得到静默的 GL error（内核以为赋了值，mod 拿到 0）；
       *   ② **不允许声明采样器** —— 契约说"内核不提供任何纹理"，那就必须真的没有纹理可绑，
       *      否则 mod 会依赖一个永远不存在的绑定。
       * 两类都当作"这个 mod 不可用"（抛错 ⇒ 进 errors + 回落），而不是静默半死。
       */
      function checkContract() {
        const want = RESERVED_TYPES();
        for (const [name, [type, label]] of Object.entries(want)) {
          const entry = locs[name];
          if (entry !== undefined && entry.type !== type) {
            throw new Error(name + ' 的类型与契约不符：要求 ' + label + '，实得 0x' + entry.type.toString(16));
          }
        }
        const samplers = new Set([
          gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_ARRAY,
          gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D, gl.INT_SAMPLER_CUBE, gl.INT_SAMPLER_2D_ARRAY,
          gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D, gl.UNSIGNED_INT_SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY,
        ]);
        for (const [name, entry] of Object.entries(locs)) {
          if (samplers.has(entry.type)) throw new Error(name + ' 是纹理采样器，但内核不提供任何纹理（契约禁止 sampler）');
        }
      }

      function resize() {
        const dpr = Math.min(globalThis.devicePixelRatio || 1, DPR_MAX);
        // ⚠️ 游离 canvas（不在 DOM 里）**没有布局尺寸**：`clientWidth` 是 0。
        //    回落到显式的 width/height 属性 —— 否则探测会把画布算成 0×0，
        //    于是 `u_resolution = (0,0)`，只能证明"能编译"、
        //    证明不了"在真实分辨率下画得出"（这正是本项目最怕的假绿）。
        const w = canvas.clientWidth || canvas.width || 0;
        const h = canvas.clientHeight || canvas.height || 0;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        return dpr;
      }

      function draw(now) {
        const dpr = resize();
        if (locs.u_time !== undefined) gl.uniform1f(locs.u_time.loc, (now - t0) / 1000);
        if (locs.u_resolution !== undefined) gl.uniform2f(locs.u_resolution.loc, canvas.width, canvas.height);
        if (locs.u_pixelRatio !== undefined) gl.uniform1f(locs.u_pixelRatio.loc, dpr);
        for (const name of Object.keys(locs)) {
          if (name === 'u_time' || name === 'u_resolution' || name === 'u_pixelRatio') continue;
          writeUniform(locs[name], spec[name]);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      return {
        get error() { return error; },
        get ready() { return ready; },
        get spec() { return spec; },
        /** 供自检：这个效果实际用到哪些 uniform。 */
        get uniforms() { return locs === null ? [] : Object.keys(locs); },
        get linked() {
          return prog !== null && gl !== null && gl.getProgramParameter(prog, gl.LINK_STATUS) === true;
        },

        async boot() {
          gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false });
          if (gl === null || gl === undefined) { error = 'no-webgl2'; return false; }
          try {
            const vs = compileShader(gl.VERTEX_SHADER, mod.vertex || VERTEX_QUAD);
            const fs2 = compileShader(gl.FRAGMENT_SHADER, mod.fragment);
            prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs2);
            gl.linkProgram(prog);
            if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
              throw new Error('程序链接失败：' + String(gl.getProgramInfoLog(prog) || '').slice(0, 300));
            }
            gl.useProgram(prog);
            locs = collectUniforms();
            checkContract();
            quadBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
            gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(0);
            gl.clearColor(0, 0, 0, 0);
            t0 = performance.now();
            ready = true;
            return true;
          } catch (e) {
            error = String(e?.message ?? e);
            return false;
          }
        },

        /** 画一帧并在需要时续帧。`freeze` 为真则只画这一帧（**不受节流影响**）。 */
        frame(now = performance.now(), freeze = false) {
          if (!ready) return;
          /* 节流：只有当帧还没画过、或距上次绘制已超过目标间隔时才真的绘制。
             ⚠️ 跳过绘制时**仍要续 rAF** —— 这样窗口重新获得焦点后能立刻恢复满速，
                不需要额外的 focus/visibilitychange 监听（少一个"停了醒不过来"的风险）。
             ⚠️ `freeze` 路径（自检/改参数用）**不走节流**：调用方要的是"立刻画这一帧"。 */
          if (freeze !== true) {
            const hidden = typeof document !== 'undefined' && document.hidden === true;
            const blurred = !hidden
              && typeof document.hasFocus === 'function'
              && document.hasFocus() === false;
            const target = hidden ? 0 : (blurred ? FPS_BLURRED : FPS_ACTIVE);
            if (target === 0 || now - lastDrawnAt < (1000 / target) - 1) {
              cancelAnimationFrame(raf);
              raf = requestAnimationFrame((n) => this.frame(n, false));
              return;
            }
            lastDrawnAt = now;
          }
          try { draw(now); } catch (e) { error = String(e?.message ?? e); ready = false; return; }
          if (freeze !== true && !prefersReduce()) {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame((n) => this.frame(n, false));
          }
        },

        /** 只重画一帧 —— **不动帧循环**（改参数用；要停用 stop()）。 */
        paint() { if (ready) { try { draw(performance.now()); } catch (e) { error = String(e?.message ?? e); } } },

        stop() { cancelAnimationFrame(raf); raf = 0; },

        /**
         * 彻底释放：停循环 + 主动丢弃 WebGL 上下文 + **把元素摘出 DOM**。
         *
         * ⚠️ 探测会为每个 mod 造一块画布 —— 不释放会累积 context，
         *    撞到浏览器上限（约 16 个）后连主画布都拿不到上下文。
         * ⚠️ `el.remove()` 也在这一层：与 `createMediaSurface.release()` 保持**同一个契约**
         *    （「release 负责让元素从 DOM 消失」）。早先这里只丢上下文、不摘元素，而调用方
         *    以为 release 会摘 —— 结果切换/卸载后残留游离画布（E7/E8/E15 实测抓到 2 块）。
         *    对游离元素调 remove() 是空操作，所以探测路径不受影响。
         */
        release() {
          this.stop();
          try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 忽略 */ }
          try { canvas.remove(); } catch { /* 可能已经被摘掉 */ }
          gl = null; prog = null; locs = null; quadBuf = null; ready = false;
        },
      };
    }

    /* ════════════════ 媒体层（原创） ════════════════ */

    /** 媒体加载超时（毫秒）。超时按"这个 mod 不可用"处理，而不是无限等。 */
    const MEDIA_BOOT_TIMEOUT = 10000;

    /**
     * 造一个**媒体**渲染面（`<video>` / `<img>`）。
     *
     * ⚠️ 刻意返回与 `createSurface` **完全同一套接口**（boot/frame/paint/stop/release/
     *    spec/uniforms/error/ready/linked）。理由是"路径分叉必然漏"：只要 mountSurface、
     *    applyConfig、switchTo、卸载清理各自去写两套分支，就一定有一条路径忘了处理其中一种
     *    （本项目已经因为这类分叉踩过好几轮审核的坑）。
     *
     * 与着色器型的根本差别：**完全不碰 WebGL**。浏览器原生解码，因此在拿不到 WebGL2
     * 的环境里媒体型照样能跑 —— 这本身构成一层天然的降级冗余。
     */
    function createMediaSurface(el, mod, playMode) {
      const m = mod.media;
      let ready = false, error = null, released = false;
      /** 媒体没有 uniform —— 面板的四个通用旋钮会因此全部置灰（不是"能拖但没反应"）。 */
      const spec = Object.assign({}, mod.spec);

      /* 视觉参数全部来自 `mod.json` 的 media 段 —— 内核不写死观感。
         ⚠️ 用**内联样式**：它比皮肤 CSS 里那条共用的 `object-fit: cover` 优先级高，
            于是 `fit: "contain"` 之类的声明真的盖得掉默认值。 */
      el.style.objectFit = m.fit === 'contain' ? 'contain' : 'cover';
      if (m.opacity !== 1) el.style.opacity = String(m.opacity);
      if (m.blend === true) el.style.mixBlendMode = 'screen';

      const isVideo = m.kind === 'video';

      /* ── 播放模式（仅视频型有意义）──
         · `'loop'`     ：播到结尾立刻跳回开头（原生 `<video loop>`）
         · `'pingpong'` ：正着放一遍、再**倒着**放回来 —— 两端都在同一帧折返，没有接缝

         ⚠️⚠️ 「倒放」**没有原生实现**，必须手动驱动时间轴。这不是取舍，是被规范挡死的：
            `el.playbackRate = -1` 在 Chromium 上直接抛 `NotSupportedError`
            （实测原文：`Failed to set the 'playbackRate' property on 'HTMLMediaElement':
            The provided playback rate (-1) is not in the supported range`），
            HTML 规范里 playbackRate 就只接受非负值。
            ⇒ 唯一可行路径：**暂停元素**，每个动画帧把 `currentTime` 往回挪
              「距上一帧的墙上时间」那么多。实测（640×360 / 6s / Chromium，真跑过）：
              · 逐帧递减**真的会换画面**（不是只改了时间标量）—— 10 步 10 个不同像素指纹；
              · 速度 ~0.99×（1.50s 墙上时间走了 1.486s 媒体时间）；
              · 落点精确（设 1.234 得 1.234，误差 0，不退化成"只对齐关键帧"）。
              代价：倒放这半程是 seek 驱动，比解码器原生播放更耗 CPU；
              但页面隐藏时 rAF 会自动停（不白烧），且只有往返模式才走这条路。

            ⚠️⚠️ 还有一条**不能想当然**的：**不许每个动画帧都发 seek**。
              "每帧挪一格"听着最自然，实际会把画面搞得更卡 —— 每一次新的 `currentTime`
              赋值都会**掐掉上一次还没解完的 seek**，解码器永远从头开始。
              三路对照实测（各 1.2s）：
                · 每拍无条件 seek：发 156 次，**只有 6~14 次真的落位**（落位率 5%），
                  可见画面只更新 5~7 次 ⇒ **≈2~3 fps 的幻灯片**；
                · 在途时不发新 seek：发 23 次、**23 次全部落位**，画面 12/12 全变
                  ⇒ **满帧 25 fps**，速度仍是 0.97~1.0×。
              ⇒ 闸门见 tickReverse：`seeking` 为真时跳过本次（但要把墙上时间攒着，见那里的注释）。 */
      let mode = playMode === 'pingpong' ? 'pingpong' : 'loop';
      let dir = 'forward';
      let rafId = null;
      let lastTick = 0;
      /** 上一次**真的发出** seek 的时刻 —— 只为"在途不重发"的兜底超时用（见 tickReverse）。 */
      let lastIssue = 0;
      /**
       * "此刻**应当**在播" —— 由 `stop()` / `resume()` 开关。
       *
       * ⚠️ 为什么需要一个显式标志，而不是只看 `el.paused`：
       *    倒放段里元素**本来就是 paused 的**（我们只是手动挪 `currentTime`），
       *    所以 `paused` 根本区分不出"正在倒放"与"已被用户停用"。
       *    没有这个标志会有一个真实的竞态：用户在正放即将结束时取消勾选「启用」，
       *    而 `ended` 恰好在同一瞬间触发 ⇒ 倒放驱动照跑，跑到 0 之后
       *    **把用户刚停用的视频又播了起来**（画面重新动起来，且不受"启用"控制）。
       */
      let running = false;

      const cancelDrive = () => {
        if (rafId !== null) { try { cancelAnimationFrame(rafId); } catch { /* 已停 */ } rafId = null; }
      };

      /** 倒放一拍：把时间轴往回挪一格。 */
      /**
       * 安全地调 `play()` —— **不许漏出未处理的 promise 拒绝**。
       *
       * ⚠️ 为什么不用 `void el.play()`：`play()` 返回的是 promise，它的失败是**异步**的，
       *    `try { void el.play() } catch {}` **抓不到** —— 拒绝会冒到 window 上成为
       *    `unhandledrejection`（审核指出；自检页把它们记进 `__winErrors`，
       *    但当时的 E19 组没读那一项，于是这个泄漏一直没被断言覆盖）。
       *    自动播放被策略拒绝是最常见的触发点，而它**必须**被说出来 ——
       *    否则用户只会看到"视频不动"而没有任何线索（boot() 里那条注释是同一个道理）。
       */
      const safePlay = (where) => {
        const note = (e) => { state.errors['__mediaplay:' + mod.id] = where + '：' + String(e?.message ?? e); };
        try {
          const p = el.play();
          if (p !== undefined && p !== null && typeof p.catch === 'function') p.catch(note);
        } catch (e) { note(e); }   // 同步抛（元素已被摘掉 / 状态非法）
      };

      const tickReverse = () => {
        rafId = null;
        /* 被 release / stop / 换模式打断后，这个回调可能仍在队列里 —— 必须自己再判一次。 */
        if (released === true || running !== true || dir !== 'reverse') return;
        /* ⚠️ 逐拍复查 reduce-motion：用户在倒放**进行中**打开系统开关时，必须立刻停住。
           不查的话这一轮倒放会照跑到底（它是我们自己的 rAF 驱动的，浏览器不会替我们停）。
           与 WebGL 帧循环 `frame()` 里每帧查 prefersReduce、以及 `boot()` / `resumeInternal()`
           开头的早退**同一套语义**：reduce ⇒ 不动。
           停在当前帧是正确的收尾（画面仍是一张可用的背景），而不是硬跳回开头。 */
        if (prefersReduce()) return;
        const now = performance.now();

        /* ⚠️⚠️ **seek 闸门**：上一拍发出的 seek 还没落位时**不要**再发一个。
           每个新的 `currentTime` 赋值都会**掐掉在途的那次 seek**，解码器于是永远从头开始 ——
           越"努力"越卡。实测（见 createMediaSurface 顶部的长注释）：
           每拍无条件 seek 只有 5% 落位、画面 ≈2~3 fps；本闸门让落位率 100%、画面 25 fps。

           ⚠️ 跳过时**不能动 `lastTick`**：那段墙上时间要攒着，等下一拍真的发 seek 时
              一次性补回来。否则倒放会整体变慢（跳过的每一拍都白丢 16ms 媒体时间）。
           ⚠️ 兜底超时（250ms）不可省：元素在 `seeking` 上卡住时（解码器报错、
              数据损坏、seek 到不可解码区域），没有它就会**永久停摆** ——
              宁可发一个可能丢帧的 seek，也不能让画面彻底不动。 */
        if (el.seeking === true && (now - lastIssue) < 250) { rafId = requestAnimationFrame(tickReverse); return; }

        /* ⚠️ 必须夹住 dt：标签页被切走时 rAF 会被浏览器暂停，回来时 dt 可能是几十秒
           ⇒ 不夹的话 `currentTime` 会**一步跳回 0**，看起来像"卡一下直接结束"。
           ⚠️ 已知取舍：夹到 0.25s 意味着"某一拍等了超过 250ms"的那部分时间会被丢掉
              ⇒ 那种情形下倒放会略慢于 1×（正常情况 seek ~33ms，远不到夹子，实测 0.97~1.0×）。
              不夹的话代价更大（后台回来一步跳到 0），所以保留夹子。 */
        const dt = Math.min(0.25, (now - lastTick) / 1000);
        lastTick = now;
        const next = el.currentTime - dt;
        if (next <= 0) {
          /* 走到头 ⇒ 转向正放。**先归零再播**：`currentTime` 可能停在 0.00x 上，
             不归零的话下一轮正放会从一个非零位置起，来回累积漂移。 */
          try { el.currentTime = 0; } catch { /* 元素可能已被摘掉 */ }
          dir = 'forward';
          /* 二次确认 running：这一拍与用户点"停用"可能撞在一起。 */
          if (running === true && !prefersReduce()) safePlay('倒放到头后重新正放');
          return;
        }
        try { el.currentTime = next; lastIssue = now; } catch { /* seek 失败：这一帧不动，下一帧再试 */ }
        rafId = requestAnimationFrame(tickReverse);
      };

      const startDrive = () => {
        if (rafId === null && running === true) { lastTick = performance.now(); lastIssue = 0; rafId = requestAnimationFrame(tickReverse); }
      };

      /**
       * 正放**到头** ⇒ 转向倒放。
       *
       * ⚠️ `ended` 是唯一可靠的"正放到头"信号，而它**只在 `loop === false` 时才会触发**
       *    —— 这正是上面 `el.loop = mode !== 'pingpong'` 那行的原因：
       *    loop 若还是 true，视频会自己跳回开头，`ended` 永不触发，倒放支路根本不会启动。
       */
      const onEnded = () => {
        if (released === true || running !== true || mode !== 'pingpong' || dir !== 'forward') return;
        /* ⚠️ 运行中打开「减少动态效果」必须**立刻**生效：不进入倒放段。
           否则用户点了系统开关之后还会看到一整轮倒放动画（正放已被浏览器播完，
           倒放是**我们自己**驱动的 —— 这段动画要不要跑，由我们负责判断）。
           与 `resumeInternal()` 开头的 prefersReduce 早退保持同一条语义。 */
        if (prefersReduce()) return;
        dir = 'reverse';
        startDrive();
      };
      if (isVideo) el.addEventListener('ended', onEnded);

      /** 恢复播放（**模式感知**）—— 让调用方不必知道当前是循环还是往返。 */
      const resumeInternal = () => {
        if (isVideo !== true || prefersReduce()) return;
        /* ⚠️ `running` 必须在早退**之前**置位。倒放段的元素本来就 `paused === true`
           （我们只是手动挪 currentTime），若把它当成"已经在播、无需插手"而早退，
           驱动器会因为 `running !== true` 停住，视频就卡在半空 ——
           这个门控的语义是"**应当**播放"，不是"**正在**播放"。 */
        running = true;
        /* ⚠️⚠️ 这里**不能**用 `readyState < 2` 当早退条件 —— 这是一个真实的用户可见缺陷，
           用对照实验定位到（正放中途切模式正常、倒放中途切模式卡死）：

           倒放段是**连续 seek** 驱动的，元素频繁处于 `seeking` 状态、`readyState` 掉到 1。
           而"从往返切到循环"恰恰最常发生在倒放段（用户看到它在倒着播，想去掉这行为）
           ⇒ 旧条件在这里恰好命中早退 ⇒ `play()` 从未被调用 ⇒ **视频停在半空不动**：
           既不再倒放（驱动器已被 setMode 取消）、也没被播起来（被早退挡住）。

           为什么"等它准备好再播"这个直觉在这里是错的：文件早就缓冲完了（网络层没事），
           `readyState` 掉到 1 只是**seek 在途**的瞬时状态，下一拍就会回到 4。
           而"到下一拍再补播"这件事**没人做** —— 早退之后没有任何人回来调 `play()`。
           ⇒ 正确做法是**直接调 `play()`**：`play()` 本身就会在数据就绪后开始播
             （它返回的 promise 会等到能播时才 resolve），不需要我们先替它把关。
             真播不了的（没数据 / 策略拒绝）由 catch 兜住，不影响别的路径。 */
        if (el.paused === false) return;                    // 已经在播 ⇒ 不必插手
        if (mode === 'pingpong' && dir === 'reverse') { startDrive(); return; }
        safePlay('恢复播放');
      };

      /**
       * 原地换播放模式。
       *
       * ⚠️ **不重建元素**：重建会让整段素材重新下载 + 重新解码（背景会黑一下）。
       *    改的是"之后怎么播"，不是"换成哪个素材"。
       * ⚠️ 也**不重置播放位置**：用户改的是播放方式，不是要求重播 ——
       *    把人家正在看的位置拉回开头是另一种语义（"从头播放"），不是这一项。
       */
      const setModeInternal = (next) => {
        const want = next === 'pingpong' ? 'pingpong' : 'loop';
        if (want === mode) return;
        mode = want;
        cancelDrive();
        dir = 'forward';
        /* ⚠️ 从往返切回循环时若正在倒放，`el.paused` 仍是 true ⇒ 必须显式续播，
           否则视频会**停在半空中不动**（既不再倒放、也没被播起来）。 */
        if (isVideo) { el.loop = mode !== 'pingpong'; resumeInternal(); }
      };

      /* ── 可见性门控：**标签页切走 ⇒ 暂停视频**（加）──────────────────
         ⚠️ 为什么媒体型要单独做这一层：它的 `frame()` 是**空实现**（"媒体由浏览器自己驱动
            帧"，内核不驱动它），所以着色器型那套三档帧率节流（FPS_ACTIVE / FPS_BLURRED）
            **完全管不到它**。而我们的视频是 `muted` ⇒ Chromium 对**静音**视频在后台标签页
            **不会自动暂停** ⇒ 切走后它继续解码、继续占 GPU —— 那正是"切到别的窗口就卡"的
            另一半来源（着色器型已管住，媒体型原本无人管）。
         ⚠️ 只处理 `document.hidden`（标签页切走 / 窗口最小化），**不处理"窗口失焦但可见"**：
            并排显示时视频是**看得见的**，把它暂停比让它继续播更突兀；而硬解全屏 MP4 的
            开销远小于全屏 shader 重绘，留着播是更合理的取舍（这也是与着色器型的分档差异）。
         ⚠️ `running` 是"**应当**播放"的门（不是"正在播放"）—— 暂停时**绝不能动它**，
            否则切回来时 `resumeInternal()` 会因为早退条件而不播（视频永久停住）。
         ⚠️ 倒放驱动器也要一并停：标签页隐藏时浏览器的 rAF 本来就会被暂停，但 `rafId`
            不清零的话，切回来会有一拍悬空（且状态机以为自己还在跑）。 */
      let pausedByHidden = false;
      const onVisibilityChange = () => {
        const hidden = typeof document !== 'undefined' && document.hidden === true;
        if (hidden === true) {
          if (running === true) {
            pausedByHidden = true;
            cancelDrive();
            if (isVideo) { try { el.pause(); } catch { /* 已经停了 */ } }
          }
          return;
        }
        if (pausedByHidden === true && released !== true) {
          pausedByHidden = false;
          if (running === true) resumeInternal();
        }
      };
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibilityChange);
      }

      return {
        get error() { return error; },
        get ready() { return ready; },
        get spec() { return spec; },
        get uniforms() { return []; },
        get linked() { return ready; },
        /** 供自检区分两种渲染面。 */
        get kind() { return 'media'; },
        get el() { return el; },
        /** 当前播放模式（'loop' | 'pingpong'）与方向（'forward' | 'reverse'）—— 供自检读取。 */
        get playMode() { return mode; },
        get direction() { return dir; },
        /** 原地换播放模式（面板切「播放」时调用）—— 不重建元素、不重置位置。 */
        setMode: setModeInternal,
        /** 模式感知的恢复播放（`applyConfig` 从"停用"切回"启用"时调用）。 */
        resume: resumeInternal,

        async boot() {
          const okEvent = isVideo ? 'loadeddata' : 'load';
          const settled = new Promise((resolve) => {
            let hit = false;
            const fin = (v) => { if (!hit) { hit = true; resolve(v); } };
            el.addEventListener(okEvent, () => fin(true), { once: true });
            el.addEventListener('error', () => fin(false), { once: true });
            setTimeout(() => fin(false), MEDIA_BOOT_TIMEOUT);
          });

          if (isVideo) {
            /* ⚠️ `muted` 不是可选项：未静音的视频会被浏览器的自动播放策略直接拒绝，
               画面**永远停在第一帧**却没有任何报错 —— 典型的静默失败。
               `playsInline` 同理（iOS Safari 不加会强制全屏播放）。 */
            el.muted = true;
            el.defaultMuted = true;
            /* ⚠️ `loop` 由**播放模式**决定，不能写死 true：
               · 「循环」⇒ true（播到尾自动回头，不解码器停顿）
               · 「往返」⇒ **必须 false**，否则视频会在到达尾部时自动跳回 0，
                 我们永远等不到 `ended`（往返的转向触发器），倒放支路根本不会启动。 */
            el.loop = mode !== 'pingpong';
            el.playsInline = true;
            el.setAttribute('playsinline', '');
            el.setAttribute('aria-hidden', 'true');
            el.preload = 'auto';
          } else {
            el.setAttribute('aria-hidden', 'true');
            el.decoding = 'async';
          }
          el.src = m.url;

          if (await settled !== true) { error = '媒体加载失败：' + m.url; return false; }
          /* 二次核验：`loadeddata` 已经蕴含「解出了首帧」，但把结论**再验一遍**，
             免得将来有人把上面的事件监听改坏而这里毫无察觉（断言要能真的失败）。 */
          if (isVideo && el.readyState < 2) { error = 'readyState=' + el.readyState + '（没有可解码的帧）'; return false; }
          if (!isVideo && el.naturalWidth === 0) { error = '图片解码后宽度为 0'; return false; }

          if (isVideo && !prefersReduce()) {
            /* ⚠️ 这里**刻意不用 `safePlay()`**：boot 需要**同步得知**播放成功与否来置 `running`
               （见下面的说明），所以必须 `await`。`safePlay()` 是"发出去就不管"的形态，
               只在"播放结果不影响后续控制流"的两处用（倒放转向 / 恢复播放）。 */
            try { await el.play(); running = true; }
            catch (e) {
              /* 播不动 = 停在首帧（仍然是一张可用的背景，不该判失败、也不该回落），
                 但要**说出来**，否则用户只会觉得"视频怎么不动"。 */
              state.errors['__mediaplay:' + mod.id] = '自动播放被拒绝，画面停在首帧：' + String(e?.message ?? e);
            }
          }
          /* ⚠️ 这里**刻意不启动倒放驱动器**：boot() 之后一律是「从头正放」，
             倒放要等到 `ended` 事件（正放到头）才会开始 —— 见 onEnded。
             元素是新建的、`currentTime` 为 0，所以"启动时就在倒放"这种状态不可能出现。
             ⚠️ 但 `running` 要在**播放真的成功**之后才置位（见上面的 try）：播放被拒时
             仍置 true 的话，`ended` 可能被误触发（部分浏览器在拒绝播放时会派发 ended），
             倒放驱动器就会在没有画面的情况下空转。 */
          ready = true;
          return true;
        },

        /* 媒体由浏览器自己驱动帧，内核不需要（也不能）驱动它。
           留这两个空实现是为了接口一致，让 applyConfig 里的 `surface.paint()` 不必分支。 */
        frame() {},
        paint() {},

        stop() {
          /* ⚠️ 顺序要紧：**先停驱动器再 pause**。倒放支路此刻并没有在"播放"
             （元素是 paused 的，我们只是手动挪 currentTime），只调 `el.pause()` 
             对它完全无效 —— 不停掉 rAF 的话，元素被隐藏/卸载之后
             `currentTime` 仍在被后台改写，白白吃 CPU（且释放后再 seek 会抛 InvalidStateError）。
             `running = false` 一并关掉"应当播放"的门 —— 否则在途的 `ended` 会让驱动器重新启动。 */
          running = false;
          cancelDrive();
          if (isVideo) { try { el.pause(); } catch { /* 已经停了 */ } }
        },

        /**
         * 彻底释放。
         *
         * ⚠️ 媒体与 WebGL 不同：**把元素摘出 DOM 并不会释放它持有的媒体资源**。
         *    已缓冲的数据仍挂在元素上，在途的网络请求也仍在跑 —— 元素离开文档
         *    既不等于暂停加载、也不等于资源被回收。必须 `pause()` + 清 `src` + `load()`：
         *    最后这个 `load()` 走的是 HTML 规范的 media element load algorithm，
         *    它会**中断在途请求**并把元素重置回空状态（缓冲丢弃、`readyState` 归 0）。
         *
         * 📌 校正（审核指出）：本条初版写的是「光把元素从 DOM 摘掉
         *    不等于停止解码 / 已缓冲的 video 会继续占用解码器」。那个因果**不成立** ——
         *    实测元素离开文档后 Chromium 会停掉解码；真正没被释放的是**缓冲与在途请求**。
         *    结论（必须 pause + 清 src + load）不变，但**理由要说对**，
         *    否则后来者会照着一个错的模型去改这里的代码。
         */
        release() {
          if (released === true) return;
          released = true;
          this.stop();
          /* 摘掉可见性监听（同 `ended` 的理由：监听器持有闭包引用，显式摘掉不留悬挂）。 */
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          }
          /* 摘掉监听：`ended` 上挂着 onEnded，元素虽然会被 remove()，
             但监听器持有闭包引用（含 el 与 mode/dir 状态）—— 显式摘掉不留悬挂引用。 */
          if (isVideo) el.removeEventListener('ended', onEnded);
          try { el.removeAttribute('src'); el.load?.(); } catch { /* 元素可能已被摘掉 */ }
          el.remove();
          ready = false;
        },
      };
    }

    /**
     * 媒体型的自检：**真的把媒体加载一遍**，证明它能解码出画面。
     *
     * ⚠️ 只检查"元素建出来了"是假绿 —— 一个 404 的 URL 也能建出元素。
     *    必须等到 `loadeddata` / `load`，并核验 `readyState` / `naturalWidth`。
     */
    async function probeMedia(mod, timeout = 8000) {
      const m = mod.media;
      const isVideo = m.kind === 'video';
      const el = document.createElement(isVideo ? 'video' : 'img');
      const done = new Promise((resolve) => {
        let hit = false;
        const fin = (v) => { if (!hit) { hit = true; resolve(v); } };
        el.addEventListener(isVideo ? 'loadeddata' : 'load', () => fin(true), { once: true });
        el.addEventListener('error', () => fin(false), { once: true });
        setTimeout(() => fin(false), timeout);
      });
      if (isVideo) { el.muted = true; el.preload = 'auto'; }
      el.src = m.url;

      let err = null;
      if (await done !== true) err = '媒体加载失败：' + m.url;
      else if (isVideo && el.readyState < 2) err = 'readyState=' + el.readyState + '（没有可解码的帧）';
      else if (!isVideo && el.naturalWidth === 0) err = '图片解码后宽度为 0';

      try { el.pause?.(); el.removeAttribute('src'); el.load?.(); } catch { /* 忽略 */ }
      return err === null ? true : err;
    }

    /* ════════════════ 主题颜色（原创：从官方令牌派生） ════════════════ */

    /** 把 `rgb(...)` / `#rgb` / `#rrggbb` 解析成 [r,g,b,a]（0..1）。 */
    function parseColor(raw) {
      const s = String(raw ?? '').trim();
      if (s === '') return null;
      const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
      if (fn !== null) return [+fn[1] / 255, +fn[2] / 255, +fn[3] / 255, 1];
      let h = s.replace('#', '');
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      if (!/^[0-9a-fA-F]{6}$/.test(h.slice(0, 6))) return null;
      const n = parseInt(h.slice(0, 6), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }

    /**
     * 色团配方：**统一在「紫红 → 蓝」一族内**（相邻色相，不跳色）。
     * 令牌全部是官方静态色阶 —— 深浅主题各自成立。
     */
    const RECIPE = [
      { mix: ['--dsw-static-red-400', '--dsw-static-blue-400'], ratio: 0.66 },
      { token: '--dsw-static-deepseek-300' },
      { token: '--dsw-static-blue-300' },
      { token: '--dsw-static-deepseek-500' },
    ];

    function readPalette(el) {
      const cs = getComputedStyle(el);
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      const colors = [];
      let shortfall = 0;
      for (const r of RECIPE) {
        if (typeof r.token === 'string') {
          const c = parseColor(cs.getPropertyValue(r.token));
          if (c === null) { shortfall++; continue; }
          colors.push([c[0], c[1], c[2]]);
        } else {
          const a = parseColor(cs.getPropertyValue(r.mix[0]));
          const b = parseColor(cs.getPropertyValue(r.mix[1]));
          if (a === null || b === null) { shortfall++; continue; }
          const t = r.ratio;
          colors.push([a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t)]);
        }
      }
      if (colors.length === 0) return null;             // 一个都读不到 ⇒ 宁可不着色
      const back = parseColor(cs.getPropertyValue(
        dark ? '--dsw-static-neutral-bluish-950' : '--dsw-static-neutral-bluish-00',
      )) || (dark ? [0.082, 0.082, 0.09, 1] : [1, 1, 1, 1]);
      const front = colors[Math.floor((colors.length - 1) / 2)];
      return { colors, back, front: [front[0], front[1], front[2], 1], shortfall };
    }

    /* ════════════════ 样式（原创） ════════════════ */

    const CSS = [
      /* 底纹渲染面：垫在最底层。三种形态共用同一套定位 ——
         · canvas ⇒ 着色器型 mod
         · video / img ⇒ **媒体型 mod**（mp4/webm/gif/png…，浏览器原生解码，完全不碰 WebGL） */
      'body[' + SCOPE_ATTR + '] > canvas[data-mb-surface],',
      'body[' + SCOPE_ATTR + '] > video[data-mb-surface],',
      'body[' + SCOPE_ATTR + '] > img[data-mb-surface] {',
      '  position: fixed; inset: 0; z-index: -1;',
      '  width: 100vw; height: 100vh;',
      '  object-fit: cover;',
      '  display: block; pointer-events: none;',
      '}',
      /* ⚠️ 关键机制：面板底色改半透明，底纹才透得上来。
       *    真机里 AppFrame 与 ConversationRoot 都铺这个底色，两层叠加后
       *    **累计遮挡率**是 1-(1-α)²，背景真正的**透出率**是 (1-α)²。
       *    α=52% ⇒ 遮挡 ≈77%、透出 ≈23%（实测：预测 (225,229,252) vs 实测 (224,228,252)）。
       *    ⚠️ 这两条只在**真的有渲染面**时才生效：挂不上画面时改半透明只会让面板发灰、
       *    背后什么都没有（实测踩过），所以整段用 [data-mb-live] 门控。 */
      'body[' + SCOPE_ATTR + '][data-mb-live] {',
      '  --mb-veil: 52%;',
      '  --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--mb-veil), transparent);',
      '}',
      'body[' + SCOPE_ATTR + '][data-mb-live][data-ds-dark-theme] {',
      '  --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) var(--mb-veil), transparent);',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  body[' + SCOPE_ATTR + '] > canvas[data-mb-surface] { transition: none; }',
      '}',
    ].join('\n');

    /* ════════════════ 注册表 / 配置 ════════════════ */

    const state = {
      mods: [],            // 已解析且可用的 mod
      errors: {},          // mod-id → 出错原因（含"宿主端点不可用"）
      dir: null,           // 宿主报上来的目录（便于排查）
      surface: null,
      canvas: null,
      currentId: null,
      /** 回落发生时，用户原本想要的那个 id（只用于提示，不改写用户的选择）。 */
      fallbackFrom: null,
      settingsState: 'unset',
      paletteShortfall: 0,
    };

    const CONFIG_DEFAULT = {
      enabled: true,
      effect: null,            // null ⇒ 用第一个可用效果
      veil: 52,
      /** 只存**用户显式调过**的旋钮；没调过的从 mod 自己的 spec 取默认值。 */
      panel: {},
      /**
       * 视频播放模式：`'loop'`（循环）| `'pingpong'`（往返：正放一遍再倒着放回来）。
       *
       * ⚠️ 语义是「**用户的选择**」而不是「某个 mod 的设置」——
       *    与 `veil` 同类（全局偏好），与 `panel` 不同（后者按 mod 各自记录）。
       *    理由：用户对"我讨厌视频突然跳回开头"的偏好是**跨效果**的，
       *    换一个视频还得再设一次的体验是错的。
       *    `null` ⇒ 还没选过 ⇒ 用**当前 mod 自己声明的建议值**。
       */
      playMode: null,
    };

    /** 播放模式白名单 —— 配置来自 localStorage，可能是手改的或旧版本留下的。 */
    const PLAY_MODES = ['loop', 'pingpong'];

    function readConfig() {
      const out = JSON.parse(JSON.stringify(CONFIG_DEFAULT));
      try {
        const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          for (const k of Object.keys(out)) {
            if (k === 'panel') continue;
            if (saved[k] !== undefined) out[k] = saved[k];
          }
          if (saved.panel !== null && typeof saved.panel === 'object') {
            Object.assign(out.panel, saved.panel);
          }
        }
      } catch { /* 坏数据 ⇒ 用默认 */ }
      /* ⚠️ 白名单校验：配置是 **localStorage 里的自由 JSON**（可能被手改、也可能是旧版本写的）。
         非法值必须在**入口**就归一成 null（"没选过"），不能让一个 'xxx' 流到渲染层去 ——
         否则 `mode = playMode === 'pingpong' ? ... : 'loop'` 会把它**悄悄当成 loop**，
         而这与"用户从没选过"在行为上无法区分，排查时看不出是配置坏了。 */
      if (out.playMode !== null && PLAY_MODES.includes(out.playMode) !== true) out.playMode = null;
      return out;
    }

    /**
     * 当前该生效的播放模式：**用户选过的优先**，否则用当前 mod 自己声明的建议值。
     *
     * 与 `knobValue()` 完全同一套哲学：内核不替 mod 决定观感，
     * 但用户的显式选择永远压过 mod 的建议。
     */
    function effectivePlayMode(mod) {
      if (config.playMode !== null && PLAY_MODES.includes(config.playMode)) return config.playMode;
      return mod?.media?.playMode === 'pingpong' ? 'pingpong' : 'loop';
    }

    function writeConfig(cfg) {
      try { globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ }
    }

    let config = readConfig();

    /** 当前效果（取不到就第一个）。 */
    function currentMod() {
      if (state.mods.length === 0) return null;
      return state.mods.find((m) => m.id === config.effect) ?? state.mods[0];
    }

    /* ════════════════ 挂载 ════════════════ */

    function injectStyle() {
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-motion-background';
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 等样式表就绪 —— 令牌在样式表算出之前读到的是**空串**（真机实测），
     * 那时颜色一个都解析不出来。
     */
    function waitForTokens(tries = 80, interval = 50) {
      return new Promise((resolve) => {
        let n = 0;
        const tick = () => {
          const cs = getComputedStyle(document.body);
          if (cs.getPropertyValue('--dsw-static-neutral-bluish-950').trim() !== '') return resolve(cs);
          if (++n >= tries) return resolve(null);
          setTimeout(tick, interval);
        };
        tick();
      });
    }

    /** 向宿主半要 mod 清单。 */
    async function fetchMods() {
      const res = await fetch(MODS_ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('mods 端点返回 ' + res.status);
      const body = await res.json();
      return body;
    }

    async function mountSurface() {
      /* ⚠️ 令牌/调色板只对着色器型是必需的，**不能让它挡住媒体型**。
         这里刻意不做"早退"：先等到样式表就绪（真机实测：太早读到的是空串），
         但**即使读不出颜色也继续往下走** —— 媒体型不消费任何主题色，
         若在开头 `return`，一个纯媒体环境（或令牌缺失的兜底场景）就会整个挂不上画面。
         调色板为 null 时只把 palette 记为 null，由着色器型那一支自己判失败。 */
      const cs = await waitForTokens();
      const palette = cs === null ? null : readPalette(document.body);
      state.paletteShortfall = palette === null ? 0 : palette.shortfall;

      // 依次尝试：想要的那个失败就退到下一个可用的。
      // （否则会出现"面板有设置项、画布却不在"的半死状态 —— 实测踩过。）
      const want = currentMod();
      const order = want === null ? [] : [want];
      for (const m of state.mods) if (m !== want) order.push(m);

      let transientFailures = 0;
      for (const mod of order) {
        /* ── 两种渲染面：着色器型（canvas）与媒体型（video/img）──
           ⚠️ 媒体型**不需要 WebGL**，所以它天然是"WebGL 不可用时的兜底效果"。
              顺序仍按用户选择 + mods 声明序，不特殊优待谁。 */
        const isMedia = mod.media !== null && mod.media !== undefined;
        /* 着色器型必须有调色板：读不出颜色就不该硬着头皮建面（会拿到 null 崩在
           createSurface 里）。这里显式记一条错误并跳过，让下落链继续找下一个可用的
           —— 媒体型正好能接住这个位置。
           ⚠️ 必须是 `__transient:` 而不是 `__render:`：令牌读不到是**环境问题**，
              不是这个 mod 的内容坏了。用 `__render:` 会把它从效果下拉框里摘掉
              （冤枉一个完全正常的 mod），而且面板会给出"已摘掉"的错误说法。 */
        if (isMedia !== true && palette === null) {
          state.errors['__transient:' + mod.id] = '主题令牌读不到，着色器型无法取色';
          transientFailures += 1;
          continue;
        }
        const el = document.createElement(isMedia ? (mod.media.kind === 'video' ? 'video' : 'img') : 'canvas');
        el.setAttribute('data-mb-surface', '');
        document.body.appendChild(el);

        const surface = isMedia ? createMediaSurface(el, mod, effectivePlayMode(mod)) : createSurface(el, mod, palette);
        const ok = await surface.boot();
        if (!ok) {
          const reason = surface.error ?? 'boot 失败';
          /* ⚠️ 分两类，别混（第五轮审核实测的坑）：
             · **内容坏了**（编译/链接/契约体检失败）⇒ `__render:<id>`：这个 mod 真的不可用
               ⇒ 从下拉框摘掉、并把生效 id 写回配置是合理的。
             · **这次环境不给上下文**（`no-webgl2`：GPU 驱逐/上下文配额耗尽/显卡驱动重置）
               ⇒ `__transient:<id>`：**不能**动用户的选择、也**不写回配置**，否则一次瞬时故障
               就把用户选的 mod 静默改掉并落盘、还从下拉框消失（要刷新才能重选）。 */
          if (reason === 'no-webgl2') { state.errors['__transient:' + mod.id] = reason; transientFailures += 1; }
          else state.errors['__render:' + mod.id] = reason;
          surface.release();
          continue;
        }
        state.canvas = el;
        state.surface = surface;
        state.currentId = mod.id;
        state.fallbackFrom = (config.effect !== null && config.effect !== mod.id) ? config.effect : null;
        if (config.effect !== mod.id && transientFailures === 0) { config.effect = mod.id; writeConfig(config); }
        // 只有真的挂上了渲染面，才允许把面板改成半透明（否则面板会发灰、背后什么都没有）
        document.body.setAttribute(MB_LIVE_ATTR, '');
        if (isMedia !== true) watchContextLoss(el, surface, mod);
        surface.frame();
        applyConfig(config);
        return;
      }

      state.surface = null;
      state.canvas = null;
      state.currentId = null;
      state.fallbackFrom = null;
      document.body.removeAttribute(MB_LIVE_ATTR);
    }

    /**
     * 监听 WebGL 上下文丢失。
     *
     * 为什么需要：浏览器在上下文数量超限/驱动重置时会**静默丢弃**当前上下文 ——
     * 不处理的话画面没了、面板却还半透明（`data-mb-live` 仍在），用户看到一块灰面板
     * 却不知道发生了什么。这里至少把状态收干净：停帧、摘画布、关掉半透明、并把原因记进 errors。
     */
    function watchContextLoss(canvas, surface, mod) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();                     // 允许浏览器后续恢复；这里只保证状态一致
        surface.stop();
        state.errors['__contextlost:' + mod.id] = 'WebGL 上下文丢失（GPU 驱逐或上下文数量超限）';
        if (state.canvas === canvas) {
          canvas.remove();
          state.surface = null;
          state.canvas = null;
          state.currentId = null;
        }
        applyConfig(config);                    // live 随之为假 ⇒ 面板回到不透明
      }, false);
    }

    /** 换效果 ⇒ 着色器不同 ⇒ 重建渲染面。 */
    async function switchTo(id) {
      // ⚠️ 必须 **release()** 而不是只 stop()：release 会顺带丢掉 WebGL 上下文
      //    （只 stop() 的话，每切一次就泄漏一个上下文，撞上浏览器上限后当前画面会被静默丢弃
      //    —— 第五轮审核实测：连切 20 次 ⇒ 21 个 context、loseContext 累计 0）。
      //    对媒体型同理：release 会 pause + 清 src + load()，真的放掉解码器。
      //    release() 自己负责把元素摘出 DOM，这里不再重复 remove。
      state.surface?.release();
      state.surface = null;
      state.canvas = null;
      // 切换必须**落盘**：否则刷新就回到第一个效果（离线审核实测：localStorage.effect 仍为 null）
      config.effect = id;
      writeConfig(config);
      await mountSurface();
    }

    /** 面板上的四个通用旋钮（顺序即渲染顺序）。 */
    const KNOBS = ['intensity', 'softness', 'noise', 'shape'];

    /**
     * 某个旋钮**当前该显示的数值**。
     *
     * ⚠️ 取值优先级：用户调过的 > mod 自己在 spec 里写的默认值。
     *   内核**不提供**任何旋钮的默认值 —— 否则会拿内核的假设去盖 mod 的设计
     *   （实测踩过：内核默认 shape=2 灌给了一个自述 0–1 的 mod，越界）。
     */
    function knobValue(cfg, mod, knob) {
      const name = mod?.panel?.[knob];
      if (typeof name !== 'string') return null;
      const rg = knobRange(mod, knob);
      if (cfg.panel[knob] !== undefined) return clampToRange(cfg.panel[knob], rg);
      const fromMod = mod.spec?.[name];
      return typeof fromMod === 'number' ? clampToRange(fromMod, rg) : null;
    }

    /** 该旋钮是否可用：映射到了名字，且 mod 的 spec 里确实有这个 uniform。 */
    function knobUsable(mod, knob) {
      const name = mod?.panel?.[knob];
      return typeof name === 'string' && mod?.spec !== undefined && mod.spec[name] !== undefined;
    }

    /**
     * 该旋钮的滑块范围。
     *
     * mod 可以在 `mod.json` 里用 `range: { intensity: [min, max] }` 或 `[min, max, step]`
     * 声明自己的量程（文档承诺过这个字段，但内核一直没实现 —— 离线审核抓到：
     * 四个旋钮硬编码 0..1，meteor 自述 u_intensity 到 2.0，上半段用户根本拖不到）。
     * 没声明就回落 0..1。
     */
    function knobRange(mod, knob) {
      const raw = mod?.range?.[knob];
      const nums = Array.isArray(raw) ? raw.map(Number) : [];
      const min = Number.isFinite(nums[0]) ? nums[0] : 0;
      let max = Number.isFinite(nums[1]) ? nums[1] : 1;
      /* 退化输入（作者写成 `[2,0]` 之类）必须兜住：否则滑块拿到 min>max、
         step=(max-min)/100 还会是**负数**（HTML 要求 step>0，区间直接退化）。
         第五轮审核实测过这条。 */
      if (!(max > min)) max = min + 1;
      const step = Number.isFinite(nums[2]) && nums[2] > 0 ? nums[2] : (max - min) / 100;
      return { min, max, step };
    }

    /** 把数值夹进旋钮量程；非数字返回 null。 */
    function clampToRange(v, rg) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      return Math.min(rg.max, Math.max(rg.min, v));
    }

    /**
     * 把配置套到正在跑的渲染面上（立即生效，不用刷新）。
     * 只覆盖**用户显式调过**的旋钮 —— 其余保持 mod 自己的默认。
     *
     * ⚠️ 两条都按"**真的有渲染面**"来判：
     *   · 面板半透明（`--dsw-alias-bg-base` 覆盖）只在有画面时才有意义 ——
     *     挂不上画面还改半透明，只会让面板发灰、背后什么都没有（离线审核实测 (21,22,28)→(75,76,80)）；
     *   · 旋钮作用在**当前真正在渲染的那个 mod** 上（回落之后就是备用 mod），
     *     否则会出现"拖了没反应"。
     */
    function applyConfig(cfg) {
      const live = state.surface !== null && cfg.enabled === true;
      const mod = live ? (state.mods.find((m) => m.id === state.currentId) ?? currentMod()) : null;

      // ⚠️ 门控属性必须**每次都跟着 live 走**，不能只在挂载时置位：
      //    用户取消勾选「启用」后画面没了，若属性还留着，CSS 里那条
      //    `body[data-motion-background][data-mb-live]{--dsw-alias-bg-base: color-mix(...)}` 照样生效
      //    ⇒ 又回到"没有画面却仍然半透明"（第五轮审核实测抓到的洞）。
      document.body.toggleAttribute(MB_LIVE_ATTR, live);
      if (live) document.body.style.setProperty('--mb-veil', String(cfg.veil) + '%');
      else document.body.style.removeProperty('--mb-veil');
      if (state.canvas !== null) {
        state.canvas.style.display = cfg.enabled ? '' : 'none';
        /* ⚠️ `display:none` 只让元素不可见，**不会停止解码** —— 一个被隐藏的 <video>
           照样在后台吃 CPU 与解码器。要真的停下来，得显式 pause（恢复时再 play）。 */
        const s = state.surface;
        if (s !== null && s.kind === 'media' && cfg.enabled !== true) {
          s.stop();
        } else if (s !== null && s.kind === 'media' && cfg.enabled === true) {
          /* 播放模式可能刚被改过 ⇒ 先同步到渲染面（原地换，不重建元素、不重置位置），
             再走**模式感知**的恢复：倒放中的往返效果不是靠 `play()` 驱动的，
             直接 `play()` 会让它一边倒放一边正着播（两股力互相拉）。 */
          s.setMode?.(effectivePlayMode(mod ?? currentMod()));
          s.resume?.();
        }
      }

      if (live && mod !== null) {
        const spec = state.surface.spec;
        for (const knob of KNOBS) {
          if (!knobUsable(mod, knob)) continue;
          if (cfg.panel[knob] === undefined) continue;
          // 夹进量程：否则"面板显示 1、实际按 5 渲染"（第五轮审核实测过初值越界的情形）
          const v = clampToRange(cfg.panel[knob], knobRange(mod, knob));
          if (v === null) continue;
          spec[mod.panel[knob]] = v;
        }
        state.surface.paint();
      }
      return 'ok';
    }

    /* ════════════════ 设置面板 ════════════════ */

    const SECTION = { id: 'motion-background', order: 41, label: '动态背景' };

    function registerSettingsCard(ctx, require) {
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
      if (slots === undefined || typeof slots.register !== 'function') return 'no-slots';
      let React = null;
      try { React = require('react'); } catch { React = null; }
      if (React === null || typeof React.createElement !== 'function') return 'no-react';

      const h = React.createElement;
      const LINE = 'var(--dsw-alias-border-l2, rgba(128,128,128,.25))';
      const FILL = 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.12))';
      const ACCENT = 'var(--dsw-alias-brand-primary, #4176e6)';
      const S = {
        wrap: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 },
        head: { margin: 0, fontSize: 14.5, fontWeight: 600 },
        hint: { margin: 0, fontSize: 12.5, lineHeight: 1.7, opacity: .6 },
        group: { display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px', border: '1px solid ' + LINE, borderRadius: 12 },
        gtitle: { fontSize: 13, fontWeight: 600, opacity: .92 },
        row: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, minHeight: 26 },
        lab: { flex: '0 0 84px', opacity: .78 },
        val: { flex: '0 0 52px', textAlign: 'right', opacity: .6, fontSize: 12, fontVariantNumeric: 'tabular-nums' },
        slider: { flex: 1, accentColor: ACCENT },
        check: { width: 15, height: 15, accentColor: ACCENT },
        sel: { flex: 1, padding: '4px 8px', borderRadius: 8, fontSize: 13, color: 'inherit', background: FILL, border: '1px solid ' + LINE },
        mono: { fontSize: 12, opacity: .6, margin: 0, lineHeight: 1.6 },
        foot: { display: 'flex', justifyContent: 'flex-end' },
        btn: { padding: '5px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: 'inherit', background: FILL, border: '1px solid ' + LINE },
      };

      const off = (on) => (on ? S.row : { ...S.row, opacity: .38 });

      const Slider = (label, value, min, max, step, onInput, fmt, dim) => h('label', { style: off(!dim), key: label },
        h('span', { style: S.lab }, label),
        h('input', { type: 'range', min, max, step, value, disabled: dim, style: S.slider, onChange: (e) => onInput(parseFloat(e.target.value)) }),
        h('span', { style: S.val }, dim ? '—' : (fmt ? fmt(value) : String(value))));

      const Toggle = (label, checked, onChange) => h('label', { style: S.row, key: label },
        h('input', { type: 'checkbox', checked, style: S.check, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label));

      const Select = (label, value, options, onChange, numeric, dim) => h('label', { style: off(!dim), key: label },
        h('span', { style: S.lab }, label),
        h('select', {
          value, disabled: dim, style: S.sel,
          onChange: (e) => onChange(numeric === false ? e.target.value : parseFloat(e.target.value)),
        }, options.map((o) => h('option', { key: o.v, value: o.v }, o.label))));

      const Group = (title, children) => h('div', { style: S.group, key: title },
        h('div', { style: S.gtitle }, title), ...children);

      const fix2 = (v) => Number(v).toFixed(2);

      const Card = () => {
        const [cfg, setCfg] = React.useState(() => config);
        const commit = (next) => { config = next; writeConfig(next); applyConfig(next); setCfg(next); };
        const patch = (k, v) => commit({ ...cfg, [k]: v });
        const patchPanel = (k, v) => commit({ ...cfg, panel: { ...cfg.panel, [k]: v } });

        const KNOB_LABEL = { intensity: '强度', softness: '柔度', noise: '颗粒', shape: '形态' };
        const mod = currentMod();
        /**
         * 效果下拉的显示名。
         *
         * ⚠️ 媒体型加**类型后缀**（「极光（MP4 视频）」）—— 用户的原话是：
         *    「流星雨是持续的动态效果，而极光是一个 MP4 视频……共用一套控制栏虽然没问题，
         *      但还是要说明一下分别是什么」。
         *    两者在面板里共用同一套控制栏，但本质完全不同：一个是程序化重绘，一个是播素材。
         *    只写「极光」会让人以为它也是程序化的，看到"视频怎么不动""怎么没有旋钮"时无从判断。
         * ⚠️ 后缀优先用**宿主半按扩展名派生**的 `media.label`（权威、且换素材会自动跟着变）。
         *    拿不到时**从 src 的扩展名兜底**，而不是不显示 ——
         *    否则"客户端半更新了、宿主半还没有"（两者可以独立热更：
         *    客户端半约 500ms 自动换，宿主半要重启）就会整个标注消失，
         *    表现为"改了但没效果"，排查时极易误判成前端没生效。
         * ⚠️ 都拿不到就**不加空括号**：硬加会渲染成「极光（）」。
         */
        const EXT_TAG = {
          mp4: 'MP4 视频', webm: 'WebM 视频', gif: 'GIF 动图',
          webp: 'WebP 图片', png: 'PNG 图片', jpg: 'JPEG 图片', jpeg: 'JPEG 图片',
        };
        const effectLabel = (m) => {
          if (m.media === null || m.media === undefined) return m.name;
          let tag = m.media.label;
          if (typeof tag !== 'string' || tag === '') {
            const src = typeof m.media.src === 'string' ? m.media.src : '';
            const dot = src.lastIndexOf('.');
            tag = dot > 0 ? (EXT_TAG[src.slice(dot + 1).toLowerCase()] ?? '') : '';
          }
          return tag === '' ? m.name : m.name + '（' + tag + '）';
        };
        // 渲染不起来的 mod 不进下拉框（文档承诺"编译失败者从效果列表里摘掉"）——
        // 它们仍在 errors 里可见，避免用户选到一个必然黑屏的效果。
        const effectOpts = state.mods
          .filter((m) => state.errors['__render:' + m.id] === undefined)
          .map((m) => ({ v: m.id, label: effectLabel(m) }));
        const missing = state.paletteShortfall;
        const noSurface = state.surface === null;
        /* 失败分三类展示（对应内核里三套 errors 命名空间）：
           __render: 内容坏了（已从下拉框摘掉）；__transient: 这次没拿到上下文（你的选择保留）；
           __contextlost: 跑着的时候上下文丢了。 */
        const renderErrs = Object.keys(state.errors).filter((k) => k.startsWith('__render:'));
        const transientErrs = Object.keys(state.errors).filter((k) => k.startsWith('__transient:'));
        const lostErrs = Object.keys(state.errors).filter((k) => k.startsWith('__contextlost:'));
        const playErrs = Object.keys(state.errors).filter((k) => k.startsWith('__mediaplay:'));
        const otherErrs = Object.keys(state.errors).filter((k) => !/^__(render|transient|contextlost|mediaplay):/.test(k));

        const reset = () => commit(JSON.parse(JSON.stringify(CONFIG_DEFAULT)));

        /* ── 播放模式控件（**仅视频型**才出现）──
           ⚠️ 判据必须是 `media.kind === 'video'`，不是"有 media 就对"：
              静态图片（png/jpg/webp）没有播放方向、也没有时间轴，
              给它显示「播放」下拉框是一个**点了不会有任何反应的控件** ——
              比不显示更糟（用户会以为坏了）。GIF 同样不适用：它的动效由解码器自驱，
              我们的 pause/seek 都控制不了它的循环（所以它也不进这个控件）。
           ⚠️ 它**不置灰**（与四个旋钮不同）：媒体型没有 uniform 是"没参数可调"，
              但播放模式是**真的有得选** —— 置灰会撒谎说"这项不可用"。 */
        const videoMod = mod !== null && mod.media?.kind === 'video' ? mod : null;
        const playModeNow = videoMod === null ? null : effectivePlayMode(videoMod);
        const playModeOpts = [
          /* ⚠️ 选项文案要说清**行为**，不是只说名字：用户的原话是
             「一个视频的头尾不一定衔接得很好，如果直接循环，有时候中段会比较生硬」——
             他关心的是"接缝处会不会突兀"，所以这里直接写出各自在接缝处的表现。 */
          { v: 'loop', label: '循环（播完跳回开头）' },
          { v: 'pingpong', label: '往返（正放到底再倒放回来）' },
        ];

        return h('section', { style: S.wrap },
          h('h3', { style: S.head }, SECTION.label),
          h('p', { style: S.hint }, '效果来自 mods/ 目录 —— 放进一个文件夹就多一个效果，改动即时生效。'),
          noSurface
            ? h('p', { style: S.mono }, '⚠️ 当前没有渲染面（无 WebGL2、端点不可用，或所有效果都启动失败）——面板保持不透明。')
            : null,
          state.fallbackFrom !== null && state.currentId !== null
            ? h('p', { style: S.mono },
              'ℹ️ 所选效果「' + state.fallbackFrom + '」本次未能启动，正在用「' + state.currentId + '」渲染；你的选择没有被改写。')
            : null,

          mod === null
            ? h('p', { style: S.mono }, '当前没有可用效果。把 mod 文件夹放进 mods/ 后刷新页面。')
            : Group('效果', [
              Toggle('启用', cfg.enabled, (v) => patch('enabled', v)),
              Select('效果', mod.id, effectOpts, (v) => { void switchTo(v); }, false, effectOpts.length <= 1),
              /* 播放模式：只在**视频型**出现（见上面 videoMod 的说明）。
                 ⚠️ 位置紧贴「效果」下拉框：它描述的就是这个效果"怎么播"，
                    放到"面板浓度"之后会被当成面板自身的设置。 */
              videoMod === null
                ? null
                : Select('播放', playModeNow, playModeOpts,
                  (v) => patch('playMode', v), false, noSurface),
              // 四个通用旋钮**数据驱动**渲染：值取 mod 自己的 spec 默认，
              // 映射写错（或 mod 没这个 uniform）就置灰 —— 不让用户拖一个没反应的滑块。
              ...KNOBS.map((knob) => {
                const usable = knobUsable(mod, knob);
                const v = knobValue(cfg, mod, knob);
                const rg = knobRange(mod, knob);
                return Slider(KNOB_LABEL[knob], v === null ? rg.min : v, rg.min, rg.max, rg.step,
                  (x) => patchPanel(knob, x), fix2, !usable || v === null || noSurface);
              }),
              Slider('面板浓度', cfg.veil, 0, 100, 1, (v) => patch('veil', v), (v) => v + '%', noSurface),
            ]),

          mod !== null && mod.description
            ? h('p', { style: S.mono }, mod.description)
            : null,
          /* 「往返」为什么值得做 —— 用户提出这一项的**理由**本身要说清楚：
             视频头尾不衔接时，循环会在接缝处生硬地跳一下；往返则让两端在同一帧折返，
             接缝自然消失（代价是素材实际在"来回播"）。 */
          videoMod !== null
            ? h('p', { style: S.mono },
              'ℹ️ 这是视频型效果（浏览器原生播放，不经 WebGL）——头尾不衔接的素材用「往返」可避免循环接缝。'
              + '注意「往返」的倒放段由脚本逐帧驱动（浏览器不支持负的播放速率），比正放略耗 CPU。')
            : null,
          /* 媒体型没有 uniform ⇒ 四个通用旋钮全部置灰。**必须说明原因**，
             否则用户看到四个灰滑块会以为是坏了（而不是"这个效果本来就没有参数"）。 */
          mod !== null && mod.media !== null && mod.media !== undefined
            ? h('p', { style: S.mono }, 'ℹ️ 这是媒体型效果（直接播放视频/图片，不经 WebGL）——它没有可调参数，所以上面四个旋钮置灰；「面板浓度」仍然有效。')
            : null,
          missing > 0
            ? h('p', { style: S.mono }, '⚠️ 有 ' + missing + ' 个主题令牌读不到，该色团已跳过（测试夹具常见，真机正常）。')
            : null,
          renderErrs.length > 0
            ? h('p', { style: S.mono }, '⚠️ 有 ' + renderErrs.length + ' 个 mod 不可用（已从效果列表摘掉）：'
              + renderErrs.map((k) => k.slice('__render:'.length)).join('、'))
            : null,
          transientErrs.length > 0
            ? h('p', { style: S.mono }, '⚠️ 有 ' + transientErrs.length + ' 个效果这次没能拿到 WebGL 上下文（'
              + transientErrs.map((k) => k.slice('__transient:'.length)).join('、') + '）——刷新页面可重试。')
            : null,
          lostErrs.length > 0
            ? h('p', { style: S.mono }, '⚠️ 有 ' + lostErrs.length + ' 个效果运行时丢了 WebGL 上下文：'
              + lostErrs.map((k) => k.slice('__contextlost:'.length)).join('、'))
            : null,
          /* 自动播放被拒 ⇒ 画面停在首帧。**仍然算"挂上了"**（首帧就是一张可用背景），
             所以不走 __render、不从下拉框摘掉 —— 只是告诉用户为什么它不动。 */
          playErrs.length > 0
            ? h('p', { style: S.mono }, '⚠️ 有 ' + playErrs.length + ' 个媒体效果无法自动播放（停在首帧）：'
              + playErrs.map((k) => k.slice('__mediaplay:'.length)).join('、'))
            : null,
          otherErrs.length > 0
            ? h('p', { style: S.mono }, '⚠️ 另有 ' + otherErrs.length + ' 条错误：' + otherErrs.join('、'))
            : null,

          h('div', { style: S.foot }, h('button', { style: S.btn, onClick: reset }, '恢复默认')),
        );
      };

      // ⚠️ slot 必须走 inject 声明路径，直接 register 会报 "not declared"
      if (typeof slots.inject === 'function') {
        const label = SECTION.label;
        slots.inject('settings.section', function* () {
          yield slots.register(
            { name: 'settings.section', id: SECTION.id, order: SECTION.order, label: () => label },
            Card,
          );
        });
        return 'ok';
      }
      slots.register({ name: 'settings.section', ...SECTION, label: SECTION.label }, Card);
      return 'ok';
    }

    /* ════════════════ 入口 ════════════════ */

    function apply(ctx) {
      if (typeof document === 'undefined' || document.body === null) return;
      injectStyle();
      document.body.setAttribute(SCOPE_ATTR, '');
      // ⚠️ 这里**不**调 applyConfig：此刻还没有渲染面，改半透明只会让面板发灰。
      //    mountSurface() 挂上画面后自己会调一次。

      globalThis.__betterSkin = {
        get scope() { return document.body.hasAttribute(SCOPE_ATTR); },
        /** 是否有活着的渲染面（自检用：判"挂不上画面时不该改半透明"）。 */
        get live() { return document.body.hasAttribute(MB_LIVE_ATTR); },
        get mods() {
          return {
            loaded: state.mods.map((m) => m.id),
            errors: state.errors,
            dir: state.dir,
            current: state.currentId,          // 真正在渲染的那个
            requested: config.effect,          // 用户选的那个（回落时两者不同）
            fallbackFrom: state.fallbackFrom,   // 回落时用户原本想要的那个（仅提示用）
            /** 当前渲染面的形态：'shader' | 'media' | null（自检用）。 */
            surfaceKind: state.surface === null ? null : (state.surface.kind ?? 'shader'),
            /** 媒体面的播放模式与方向（仅媒体型有）—— 自检据此判"往返真的在倒放"。 */
            playMode: state.surface?.playMode ?? null,
            direction: state.surface?.direction ?? null,
            uniforms: state.surface === null ? [] : state.surface.uniforms,
          };
        },
        get config() { return JSON.parse(JSON.stringify(config)); },
        get settings() { return state.settingsState; },
        get spec() { return state.surface === null ? null : state.surface.spec; },
        /**
         * 自检：把每个 mod 都真编译 + **真画一帧（真实分辨率）**，
         * 返回 id → true | 错误串。
         *
         * ⚠️ 画布**必须给真实尺寸**：游离 canvas 的 `clientWidth` 是 0，
         *   不给就会拿 `u_resolution=(0,0)` 去跑 —— 那样只证明"能编译"，
         *   证明不了"画得出"，而依赖分辨率的 mod 会在真机上黑屏。
         *   （这是本仓库最容易出现的假绿，故显式设尺寸。）
         */
        async probeMods(resolution) {
          const size = Number.isFinite(resolution) ? resolution : 512;
          const palette = readPalette(document.body) ?? {
            colors: [[1, 0, 0], [0, 0, 1]], back: [1, 1, 1, 1], front: [1, 0, 0, 1], shortfall: 0,
          };
          const out = {};
          for (const m of state.mods) {
            /* 媒体型走独立探针：它的成败判据是"**真的解码出画面**"，而不是"元素建出来了"
               （一个 404 的 URL 照样能建出 <video>，那是假绿）。 */
            if (m.media !== null && m.media !== undefined) {
              try { out[m.id] = await probeMedia(m); } catch (e) { out[m.id] = String(e?.message ?? e); }
              continue;
            }
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const s = createSurface(c, m, palette);
            try {
              if (await s.boot() !== true) { out[m.id] = s.error ?? 'boot 失败'; continue; }
              s.frame(performance.now(), true);
              out[m.id] = s.error === null ? true : s.error;
            } catch (e) { out[m.id] = String(e?.message ?? e); }
            s.release();
          }
          return out;
        },
      };

      // 拉 mod 清单 → 挂第一个可用效果
      void (async () => {
        try {
          const body = await fetchMods();
          state.dir = body.dir ?? null;
          const mods = Array.isArray(body.mods) ? body.mods : [];
          if (Array.isArray(body.errors)) for (const e of body.errors) state.errors[e.id ?? '?'] = e.reason;
          state.mods = mods;
        } catch (e) {
          state.errors['__endpoint'] = String(e?.message ?? e);
        }
        await mountSurface();
      })();

      try { state.settingsState = registerSettingsCard(ctx, require); }
      catch (e) { state.settingsState = 'error: ' + String(e?.message ?? e); }

      ctx.effect(() => () => {
        // 卸载要**清干净**（离线审核抓到两处残留）：
        //   · 只 stop() 不 release() ⇒ WebGL 上下文不回收（32 次探测就撞过上限）、
        //     或已缓冲的 <video> 继续占着解码器；
        //   · 内联的 `--mb-veil` 留在 body 上 ⇒ 插件没了、面板还是半透明。
        // `release()` 两种渲染面都负责把元素从 DOM 摘掉，这里不重复 remove。
        state.surface?.release();
        document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']')?.remove();
        document.body?.removeAttribute(SCOPE_ATTR);
        document.body?.removeAttribute(MB_LIVE_ATTR);
        document.body?.style.removeProperty('--mb-veil');
        state.surface = null;
        state.canvas = null;
        state.currentId = null;
      }, 'motion-background: surface + stylesheet');
    }

    return { inject: ['slots'], apply };
  },
});
