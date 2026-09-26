#!/usr/bin/env node
/**
 * 把一段视频做成「倒序版」。
 *
 * 为什么要这个文件：
 *   「往返」播放（正放一遍、再倒着放回来）默认靠脚本逐帧把 `currentTime` 往回挪 ——
 *   因为 `el.playbackRate = -1` 在 Chromium 上直接抛 `NotSupportedError`
 *   （HTML 规范里 playbackRate 只接受非负值）。逐帧驱动能用，但它一直在耗 CPU。
 *
 *   另一条路是**事先把倒序版做出来**：倒序版本身是一段正常的视频，正着播它就等于
 *   原片倒着播。于是「往返」变成两段原生播放交替，不需要脚本驱动。
 *   把倒序版放进效果目录、在 mod.json 里写 `media.reverseSrc`，内核就会走这条路。
 *
 * 用法：
 *   node tools/reverse-video.mjs <效果目录或视频文件> [--out <输出文件>]
 *
 * 例：
 *   node tools/reverse-video.mjs mods/aurora-video
 *   node tools/reverse-video.mjs mods/aurora-video/bg.mp4
 *
 * 产出（默认与输入同目录、同扩展名，文件名加 `.reversed`）：
 *   mods/aurora-video/bg.reversed.mp4
 *
 * 然后在这个效果的 `mod.json` 里加一行 `reverseSrc`：
 *   "media": { "src": "bg.mp4", "reverseSrc": "bg.reversed.mp4", "playMode": "pingpong" }
 *
 * ⚠️ 需要 ffmpeg。找不到会明确报错并告诉你去哪儿装 —— 不会静默失败。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** 只有这些扩展名才当作视频处理（与 mod 契约的白名单一致）。 */
const VIDEO_EXT = new Set(['.mp4', '.webm']);

/** ffmpeg 会整段缓冲再倒序，太长会吃很多内存 —— 超过这个时长先提醒。 */
const LONG_WARN_SECONDS = 30;

function fail(msg) {
  process.stderr.write('\n' + msg + '\n\n');
  process.exit(1);
}

function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG !== undefined && process.env.FFMPEG !== '') candidates.push(process.env.FFMPEG);
  candidates.push('ffmpeg');
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

function probeDuration(ffmpeg, file) {
  /* 用 ffmpeg 自己的输出读时长（不再依赖 ffprobe —— 少一个前置条件）。
     `-i` 把信息写在 stderr，没有输出文件时会以非零退出，这是正常的。 */
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = String(r.stderr ?? '');
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  if (m === null) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function videoStreamSummary(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = String(r.stderr ?? '');
  const m = /Stream #\d+:\d+.*?Video:\s*([^,\s]+).*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (m === null) return null;
  return { codec: m[1], width: Number(m[2]), height: Number(m[3]) };
}

/* ────────────────────────── 主流程 ────────────────────────── */

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(
    '用法：node tools/reverse-video.mjs <效果目录或视频文件> [--out <输出文件>]\n' +
      '  例：node tools/reverse-video.mjs mods/aurora-video\n',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const outFlag = argv.indexOf('--out');
const outArg = outFlag >= 0 ? argv[outFlag + 1] : undefined;

/** 剩下的第一个非 `--out` 参数就是输入。 */
let input = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out') {
    i += 1;
    continue;
  }
  input = argv[i];
  break;
}
if (input === undefined || input === null) fail('没给输入。用 --help 看用法。');

let target = resolve(input);
if (!existsSync(target)) fail(`路径不存在：${target}`);

/* 给目录就往里找一个视频文件；给文件就直接用。 */
if (statSync(target).isDirectory()) {
  const pkg = join(target, 'mod.json');
  let mediaSrc = null;
  if (existsSync(pkg)) {
    try {
      const cfg = JSON.parse(readFileSync(pkg, 'utf8'));
      const raw = cfg?.media;
      mediaSrc = typeof raw === 'string' ? raw : raw?.src ?? null;
    } catch {
      /* mod.json 坏了就退回"扫目录找视频"，不用它报错 —— 那不是本工具的职责 */
    }
  }
  if (mediaSrc !== null && existsSync(join(target, mediaSrc))) {
    target = join(target, mediaSrc);
  } else {
    const found = [];
    for (const name of ['bg.mp4', 'bg.webm']) if (existsSync(join(target, name))) found.push(name);
    if (found.length !== 1) {
      fail(
        `在 ${target} 里没能唯一确定要倒序的视频。\n` +
          '  该目录下应有 mod.json 且其 media.src 指向一个存在的文件；\n' +
          '  或者目录里恰好有 bg.mp4 / bg.webm 之一。\n' +
          '  也可以直接把视频文件的路径传给本脚本。',
      );
    }
    target = join(target, found[0]);
  }
}

const ext = extname(target).toLowerCase();
if (!VIDEO_EXT.has(ext)) {
  fail(
    `只支持 ${[...VIDEO_EXT].join(' / ')}（实得 ${JSON.stringify(ext)}）。\n` +
      '  图片与 GIF 没有时间轴可倒序；GIF 的循环由解码器自驱，往返本来就不适用。',
  );
}

const ffmpeg = findFfmpeg();
if (ffmpeg === null) {
  fail(
    '找不到 ffmpeg。\n' +
      '  · 装一个并放进 PATH，或用环境变量指过去：FFMPEG=/path/to/ffmpeg node tools/reverse-video.mjs …\n' +
      '  · Windows 上常见获取方式：winget install Gyan.FFmpeg，或从 ffmpeg.org 下静态包解压后加进 PATH。\n' +
      '  这条是硬前置 —— 本工具不做"没有 ffmpeg 时的降级"，那样只会让你以为已经倒序好了。',
  );
}

const out = outArg !== undefined ? resolve(outArg) : join(dirname(target), basename(target, ext) + '.reversed' + ext);

const dur = probeDuration(ffmpeg, target);
const info = videoStreamSummary(ffmpeg, target);
process.stdout.write(`输入：${target}\n`);
if (info !== null) process.stdout.write(`      ${info.codec} ${info.width}x${info.height}\n`);
if (dur !== null) process.stdout.write(`      时长 ${dur.toFixed(2)}s\n`);
process.stdout.write(`输出：${out}\n\n`);

if (dur !== null && dur > LONG_WARN_SECONDS) {
  process.stdout.write(
    `⚠️ 这段有 ${dur.toFixed(0)} 秒，ffmpeg 的 reverse 滤镜要**整段读进内存**才开始写。\n` +
      '   背景素材通常循环几秒到十几秒 —— 这么长的话建议先截短。\n\n',
  );
}

/* ⚠️ 音频一律丢掉（`-an`）：这个插件把视频当背景用，元素本身是 muted 的，
   留着音轨只会让文件更大。也因此不需要 `-af areverse`。 */
const args = [
  '-hide_banner',
  '-loglevel', 'error',
  '-y',
  '-i', target,
  '-an',
  '-vf', 'reverse',
  '-movflags', '+faststart',
  out,
];

let code = 0;
try {
  execFileSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
} catch (e) {
  code = typeof e?.status === 'number' ? e.status : 1;
}

if (code !== 0 || !existsSync(out) || statSync(out).size === 0) {
  fail(`ffmpeg 失败（退出码 ${code}），没有可用的输出。${existsSync(out) ? '（输出是空的）' : ''}`);
}

const size = statSync(out).size;
process.stdout.write(`✅ 已写出 ${out}（${(size / 1048576).toFixed(2)} MB）\n\n`);
process.stdout.write(
  '接下来把它接到效果上 —— 在同一个目录的 mod.json 里加 `reverseSrc`：\n\n' +
    '  "media": {\n' +
    `    "src": ${JSON.stringify(basename(target))},\n` +
    `    "reverseSrc": ${JSON.stringify(basename(out))},\n` +
    '    "playMode": "pingpong"\n' +
    '  }\n\n' +
    '⚠️ `reverseSrc` 与 `src` 一样：只能是**本效果目录下的文件名**，不许含路径分隔符或 `..`。\n' +
    '加完刷新页面即可（宿主半每次请求都重扫目录）。\n\n' +
    '没写 `reverseSrc` 也能用「往返」，只是倒放那一段会退回脚本逐帧驱动。\n',
);
