/**
 * dsh-motion-background · 宿主半
 *
 * 职责只有一件：**把 `mods/` 目录里的效果交给浏览器**。
 *
 * 为什么必须有这一层：客户端插件是单文件 bundle，跑在浏览器里，**没有文件系统**。
 * 而"往 mods/ 里丢一个文件夹就多一个效果"要求能读目录 ⇒ 由宿主读、经 HTTP 交给客户端。
 * 这也是这个插件**必须**有宿主半的原因（纯样式插件可以不要）。
 *
 * 端点每次请求都**重新扫目录**，所以装/卸 mod 不需要重启宿主，刷新页面即可。
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODS_DIR = join(HERE, '..', 'mods');
const ENDPOINT = '/motion-background/mods';
/** 媒体文件（mp4 / gif / webp / png / jpg）的端点前缀。 */
const MEDIA_PREFIX = '/motion-background/media';

/** 文件夹名白名单 —— 避免奇怪的路径进到 URL/日志里。 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 允许作为媒体提供的扩展名（白名单，不是黑名单）。 */
const MEDIA_EXT = Object.freeze({
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});

/** 视频类扩展名（客户端据此决定用 `<video>` 还是 `<img>`）。 */
const VIDEO_EXT = new Set(['.mp4', '.webm']);

/**
 * 媒体类型的**可读名** —— 面板的下拉框会把它括在 mod 名字后面（「极光（MP4 视频）」）。
 *
 * 为什么需要：着色器型与媒体型在面板里**共用同一套控制栏**，但两者的本质完全不同 ——
 * 一个是持续重绘的程序化动效，一个是播放一段素材。只写"极光"会让人以为它也是程序化的，
 * 看到"视频怎么不动"或"怎么没有旋钮"时就无从判断。
 *
 * ⚠️ 由**扩展名派生**，而不是让每个 mod 自己在 `name` 里写死：
 *    换素材（`bg.mp4` → `bg.webm`）时标注自动跟着变，不会留下"标着 MP4、实际是 WebM"的谎报。
 */
const MEDIA_LABEL = Object.freeze({
  '.mp4': 'MP4 视频',
  '.webm': 'WebM 视频',
  '.gif': 'GIF 动图',
  '.webp': 'WebP 图片',
  '.png': 'PNG 图片',
  '.jpg': 'JPEG 图片',
  '.jpeg': 'JPEG 图片',
});

/**
 * 把一个 URL 路径解析成 `mods/` 下的真实文件路径。
 *
 * ⚠️ **必须防目录穿越**：只接受 `/<mod-id>/<basename>` 这一种形状 ——
 *   段数固定为 2、id 过白名单、文件名不许含分隔符或 `..`、扩展名在白名单里。
 *   任何一条不满足就返回 null（调用方回 404）。
 */
function resolveMedia(urlPath) {
  let rel;
  /* 纵深防御：**先自己确认前缀**，不把"路径一定以 MEDIA_PREFIX 开头"当成路由器给的保证。
     实测（读 `packages/host/webserver/src/index.ts`）路由 `kind: 'prefix'`
     只匹配 `p` 与 `p/<anything>`，所以这条在当前装配下**不可达**；
     但本函数也可能被直接调用（verify.mjs 就是直接调 handler 的），
     而裸 `slice` 在无前缀时会把多余字符当成 id 的一部分。多这一行，
     安全性就不再依赖"调用方一定合规"这个外部契约。 */
  if (typeof urlPath !== 'string' || !urlPath.startsWith(MEDIA_PREFIX)) return null;
  try { rel = decodeURIComponent(urlPath.slice(MEDIA_PREFIX.length)); }
  catch { return null; }                              // 坏的百分号编码
  const parts = rel.split('/').filter((s) => s !== '');
  if (parts.length !== 2) return null;
  const [id, file] = parts;
  if (!ID_RE.test(id)) return null;
  if (file === '' || file.includes('..') || /[\\/]/.test(file)) return null;
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = file.slice(dot).toLowerCase();
  const type = MEDIA_EXT[ext];
  if (type === undefined) return null;
  return { path: join(MODS_DIR, id, file), type, ext, isVideo: VIDEO_EXT.has(ext) };
}

function asObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/**
 * 扫一遍 mods/，把每个 mod 的元数据与着色器源码读成 JSON 友好的结构。
 * **单个 mod 坏掉不影响其他 mod** —— 坏的进 `errors`，好的照常返回。
 */
function scanMods() {
  const mods = [];
  const errors = [];
  /** 已收下的 id —— 两个文件夹声明同一个 id 时，后面的会被跳过（否则面板出现两个同值选项，
   *  `switchTo` 永远只命中第一条）。 */
  const seenIds = new Set();
  if (!existsSync(MODS_DIR)) return { mods, errors, dir: MODS_DIR };

  let names = [];
  try { names = readdirSync(MODS_DIR); } catch (e) {
    return { mods, errors: [{ id: '__dir', reason: String(e?.message ?? e) }], dir: MODS_DIR };
  }
  // ⚠️ 先按文件夹名排序再扫：否则"同 id 时哪个生效"取决于文件系统的枚举顺序
  //    （同一份 mods/ 在不同机器/不同时刻可能给出不同结果）。排序后语义是确定的：
  //    **文件夹名升序里第一个生效，其余进 errors**。
  names = names.slice().sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const dir = join(MODS_DIR, name);
    try {
      if (statSync(dir).isDirectory() !== true) continue;      // 跳过散落的文件
      if (!ID_RE.test(name)) { errors.push({ id: name, reason: '文件夹名只允许 [a-z0-9-]' }); continue; }

      const cfgPath = join(dir, 'mod.json');
      if (!existsSync(cfgPath)) { errors.push({ id: name, reason: '缺 mod.json' }); continue; }

      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const id = cfg?.id;
      // id 同样要过白名单 —— 它会进面板选项、errors 键名、自检输出。
      if (typeof id !== 'string' || id === '') { errors.push({ id: name, reason: 'mod.json 里没有 id' }); continue; }
      if (!ID_RE.test(id)) {
        errors.push({ id: name, reason: 'mod.json 的 id 只允许 [a-z0-9-]，实得 ' + JSON.stringify(String(id).slice(0, 40)) });
        continue;
      }
      if (seenIds.has(id)) { errors.push({ id, reason: 'id 与前面的 mod 重复，已跳过（mods/ 里有两个文件夹声明了同一个 id）' }); continue; }

      /* ── 媒体型 mod（可选）：给了 `media` 就是"铺一段视频/图片当背景" ──
         ⚠️ 这类 mod **不需要** fragment.glsl，也**不需要** colors ——
            它不走 WebGL，所以下面那两条校验对它跳过。 */
      let media = null;
      const raw = cfg.media;
      if (raw !== undefined && raw !== null) {
        const src = typeof raw === 'string' ? raw : raw.src;
        if (typeof src !== 'string' || src === '') {
          errors.push({ id, reason: 'media 必须是字符串文件名，或 { src: "文件名" }' }); continue;
        }
        if (src.includes('..') || /[\\/]/.test(src)) {
          errors.push({ id, reason: 'media.src 不许含路径分隔符（只放本 mod 目录下的文件名）' }); continue;
        }
        const dot = src.lastIndexOf('.');
        const ext = dot > 0 ? src.slice(dot).toLowerCase() : '';
        if (MEDIA_EXT[ext] === undefined) {
          errors.push({ id, reason: 'media 扩展名不在白名单（' + Object.keys(MEDIA_EXT).join(' ') + '），实得 ' + JSON.stringify(ext) }); continue;
        }
        if (!existsSync(join(dir, src))) {
          errors.push({ id, reason: 'media 文件不存在：' + src }); continue;
        }
        const spec = typeof raw === 'string' ? {} : raw;
        media = {
          src,
          url: MEDIA_PREFIX + '/' + id + '/' + src,
          type: MEDIA_EXT[ext],
          kind: VIDEO_EXT.has(ext) ? 'video' : 'image',
          /** 可读类型名（面板会括在效果名后面）—— 由扩展名派生，见 MEDIA_LABEL。 */
          label: MEDIA_LABEL[ext] ?? '',
          /* 播放方式的**建议值**（仅视频型有意义）。
             ⚠️ 与 `panel` 旋钮同一套哲学：mod 只给"建议"，用户的选择永远优先。
                内核不替 mod 决定"这段素材该循环还是该往返"。 */
          playMode: spec.playMode === 'pingpong' ? 'pingpong' : 'loop',
          fit: spec.fit === 'contain' ? 'contain' : 'cover',
          opacity: Number.isFinite(+spec.opacity) ? Math.min(1, Math.max(0, +spec.opacity)) : 1,
          blend: spec.blend === true,
        };
      }

      // 媒体型不需要 fragment.glsl；着色器型必需
      const fragPath = join(dir, 'fragment.glsl');
      if (media === null && !existsSync(fragPath)) { errors.push({ id, reason: '缺 fragment.glsl（着色器型 mod 必需；若这是媒体型，请给 mod.json 加 media 字段）' }); continue; }
      // colors 对媒体型无意义；对着色器型必需，且非法值**不静默兜底**
      if (media === null && cfg.colors !== 'front' && cfg.colors !== 'array') {
        errors.push({ id, reason: 'colors 必须是 "front" 或 "array"，实得 ' + JSON.stringify(String(cfg.colors).slice(0, 40)) }); continue;
      }
      seenIds.add(id);

      const vertPath = join(dir, 'vertex.glsl');
      const entry = {
        id,
        name: typeof cfg.name === 'string' && cfg.name !== '' ? cfg.name : id,
        description: typeof cfg.description === 'string' ? cfg.description : '',
        author: typeof cfg.author === 'string' ? cfg.author : '',
        license: typeof cfg.license === 'string' ? cfg.license : '',
        colors: media === null ? cfg.colors : 'front',
        spec: asObject(cfg.spec),
        panel: asObject(cfg.panel),
        // 旋钮量程（可选）：{ intensity: [min, max] } 或 [min, max, step]；内核据此设滑块范围
        range: asObject(cfg.range),
        /* 排序权重（可选）：数字越小越靠前；缺省 0。
           ⚠️ 存在的意义：`mods[0]` 就是**用户第一次打开时看到的效果**。
              没有它的话，"谁是默认"完全由**文件夹起名**决定 —— 往 mods/ 里放一个
              `aurora-video` 就会把原本精心调的 `meteor` 挤成第二个（真实踩到）。
              有它之后，默认效果是作者**显式声明**的，而不是字典序的副产物。 */
        order: Number.isFinite(+cfg.order) ? +cfg.order : 0,
        fragment: media === null ? readFileSync(fragPath, 'utf8') : '',
        media,
      };
      if (existsSync(vertPath)) entry.vertex = readFileSync(vertPath, 'utf8');
      mods.push(entry);
    } catch (e) {
      errors.push({ id: name, reason: String(e?.message ?? e).slice(0, 240) });
    }
  }

  /* 排序：`order` 升序 → `id` 字典序兜底。
     ⚠️ 兜底那一级**不能省**：order 全为 0 时必须仍有确定顺序，否则排序结果依赖
        文件系统枚举顺序（同一份 mods/ 在不同机器上给出不同的默认效果）。 */
  mods.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return { mods, errors, dir: MODS_DIR };
}

/**
 * 把文件流式写进响应。
 *
 * ⚠️ **必须挂 `error` 处理器**。`createReadStream(...).pipe(res)` 看起来很干净，
 *    但流是**惰性打开**文件的 —— 若文件在 `statSync` 之后、`open` 之前消失
 *    （TOCTOU：用户此刻正在删 mod 目录，或权限变化），流会 emit 一个 'error'。
 *    没有监听者时 Node 会把它当**未捕获异常**抛出，**直接终止整个 DSH 宿主进程**
 *    —— 一个背景图的读取失败不该把用户的 harness 打崩（写媒体断言时实测到：
 *    测试夹具先删目录再读流，进程当场退出）。
 */
function pipeFile(path, res, opts = undefined) {
  const stream = opts === undefined ? createReadStream(path) : createReadStream(path, opts);
  stream.on('error', () => {
    /* 响应头可能已经发出去了（200/206 都写完了才发现打不开）。
       这时只能**断开连接**让浏览器知道出了问题；不能改状态码，也不能再 writeHead。 */
    try { res.destroy?.(); } catch { /* 已经关了 */ }
  });
  res.on?.('close', () => { try { stream.destroy?.(); } catch { /* 忽略 */ } });
  stream.pipe(res);
}

/**
 * 宿主侧入口。
 *
 * `inject: ['webServer']` ⇒ cordis 会等 webServer 服务就绪再调 apply。
 * 拿不到就静默退出（这一层不可用时皮肤仍然加载，只是没有效果可选）。
 *
 * 注册走 `ctx.effect(...)`（第一方插件 `@deepseek-ai/dsh-host-open-in-app` 的写法）：
 * 这样路由的生命周期挂在这个插件的 fiber 上，插件卸载/重载时 cordis 会连路由一起回收。
 * 没有 `ctx.effect` 时退回直接注册（老宿主兼容），并把 disposer 记下来备用。
 */
export function apply(ctx) {
  const webServer = ctx.webServer
    ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
  if (webServer === undefined || typeof webServer.register !== 'function') return;

  const route = {
    kind: 'exact',
    path: ENDPOINT,
    handler: (req, res) => {
      let payload;
      try {
        payload = scanMods();
      } catch (e) {
        payload = { mods: [], errors: [{ id: '__scan', reason: String(e?.message ?? e) }], dir: MODS_DIR };
      }
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    },
  };

  /**
   * 媒体端点：把 mod 目录里的 mp4 / webm / gif / png … 原样交给浏览器。
   *
   * 用 `kind: 'prefix'`（路径是 `/motion-background/media/<mod-id>/<file>`）。
   * ⚠️ 安全全靠 `resolveMedia`：白名单扩展名 + 固定两段路径 + id 过白名单 +
   *    文件名不许含分隔符/`..`，任何不合格的形状一律 404（不泄漏目录内容）。
   *
   * ⚠️ **必须支持 Range**：浏览器播 mp4 时会先发 `Range: bytes=0-` 探测，
   *    不支持 Range 的响应在部分浏览器上会导致 `<video>` 直接不播或不能循环。
   */
  const mediaRoute = {
    kind: 'prefix',
    path: MEDIA_PREFIX,
    handler: (req, res) => {
      const hit = resolveMedia(new URL(req.url ?? '/', 'http://host.invalid').pathname);
      if (hit === null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      let stat;
      try { stat = statSync(hit.path); } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('missing');
        return;
      }
      if (stat.isFile() !== true) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not a file');
        return;
      }

      const total = stat.size;
      const base = {
        'content-type': hit.type,
        'accept-ranges': 'bytes',
        // 媒体随 mod 走，改了就该立刻生效 ⇒ 不缓存
        'cache-control': 'no-store',
      };

      const range = req.headers?.range;
      const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (m !== null) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end === null) {
          res.writeHead(416, { ...base, 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        if (start === null) {                    // `bytes=-N` ⇒ 最后 N 字节
          start = Math.max(0, total - end);
          end = total - 1;
        } else if (end === null || end >= total) {
          end = total - 1;
        }
        if (start > end || start >= total) {
          res.writeHead(416, { ...base, 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...base,
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
        });
        pipeFile(hit.path, res, { start, end });
        return;
      }

      res.writeHead(200, { ...base, 'content-length': total });
      pipeFile(hit.path, res);
    },
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const offMods = webServer.register(route);
      const offMedia = webServer.register(mediaRoute);
      return () => { offMods(); offMedia(); };
    }, 'motion-background: /motion-background/mods + /motion-background/media');
    return;
  }
  webServer.register(route);
  webServer.register(mediaRoute);
}

export const inject = ['webServer'];
