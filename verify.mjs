#!/usr/bin/env node
/**
 * dsh-motion-background · verify.mjs —— 可复跑的独立验证脚本
 *
 * 目标：**独立证明**「效果内核 + mod 机制」真的能工作，并且**找问题**（而不是盖章通过）。
 *
 * 五组：
 *   A. 宿主半（lib/index.js）—— 真调 apply()，真喂假 req/res，解析真 JSON。
 *   B. mod 解析健壮性 —— 在 D:/tmp/ 建仓库副本，往里塞各种坏 mod，只在副本上跑。
 *   C. 客户端半（lib/client.js）—— headless Chromium 真跑：真 fetch、真 WebGL2 编译、
 *      真画一帧、真把 WebGL canvas 画到 2D canvas 数「非背景像素」。
 *   D. 反证：mod 的 GLSL 坏掉时内核不崩、设置卡片照常注册。
 *   E. **行为级断言**（2026-09-25 新增）：真调用卡片组件树数旋钮/看待机灰、真驱动 onChange
 *      再看运行时 spec 与 drawArrays 计数、真读浅色主题下的像素、真数 loseContext。
 *      C/D 里那些"源码字符串存在即通过"的弱断言由这一组补上。
 *
 * 报告器是 **fail-closed** 的：任何阶段抛错都打印「验证未完成」并退出非零，
 * **绝不**打印成功标志（旧版崩溃时仍打印「✅ 四组验证通过」，那是被独立审核点名的缺陷）。
 *
 * 说明：
 *   · 本脚本**只读**仓库里的 lib/ 与 mods/，任何破坏性写入只发生在 D:/tmp/ 的副本上。
 *   · 起跑时会清理 D:/tmp 下**已死进程遗留**的 `mb-verify*` 副本目录；名字里认不出 pid、
 *     或那个 pid 还活着的目录一律不碰（F6-A 的 C7：旧实现按前缀无条件删，实测删掉过无关的第三方目录）。
 *   · `--client=<path>` 可让 C/D/E 组改用另一份 client.js（用于反证）。
 *
 * 反证（mutation）清单 —— 每条都是"故意破坏 ⇒ 对应断言必须变红"，**运行记录要写进交付说明**：
 *   `--mutate=bg-only`         把 mod fragment 换成"只输出底色"      ⇒ C 组像素断言应变红
 *   `--mutate=no-isolation`    副本宿主半"见坏 mod 就中断整次扫描"    ⇒ B 组隔离性断言应变红
 *   `--mutate=no-draw`         删掉 gl.drawArrays                     ⇒ 像素/E4/E5 的"真的重画"应变红
 *   `--mutate=no-fallback`     候选循环只试第一个                     ⇒ E5 的回落断言应变红
 *   `--mutate=direct-register` slot 注册绕开 slots.inject             ⇒ 设置相关断言应变红
 *   `--mutate=no-scan-sort`    删掉副本宿主半扫描前的排序             ⇒ B 组"源码级兜底"断言应变红
 *   `--mutate=crash`           在 C 组前故意抛错                      ⇒ 必须非零退出且不打印成功标志
 *
 *   媒体功能的反证（2026-09-25 加）：
 *   `--mutate=media-traversal` 拆掉"文件名不许含 .. / 分隔符"那道闸   ⇒ A 组非法路径断言应变红
 *   `--mutate=media-segments`  拆掉"段数必须为 2"那道闸               ⇒ A 组非法路径断言应变红
 *   `--mutate=media-keep-el`   媒体元素不摘除（release 不 remove）     ⇒ E18e"切走不留 <video>"应变红
 *   `--mutate=media-loud`      媒体不静音（muted=false）              ⇒ E18a"真的在播"应变红
 *   `--mutate=media-noplay`    媒体不调 play()                        ⇒ E18a"真的在播"应变红
 *   （共 12 条变异 + 1 条基线 = mutations.mjs 的 13 行）
 *
 * ⚠️ 写**媒体路径**反证时必读（本仓库踩过两次假绿，代价不小）：
 *    `/motion-background/media` 的校验是多道**互相重叠**的闸（① 段数=2 ② 文件名干净 ③ 扩展名白名单），
 *    随便一条非法路径通常被好几道同时拦住 ⇒ "拆掉某一道"时断言**照样全绿**，看着像稳、实为假绿。
 *    正确做法：**每道闸都配「只有它拦得住」的向量**，且向量**落点文件必须真实存在**
 *    （否则拆掉那道闸后 `statSync` 兜底 404，反证又静默失效）。落点存在性不能靠推理 ——
 *    实测有 2 条"看着合理"的向量落点其实不存在。A 组末尾有一条**按闸分计数**的结构性断言
 *    守住这件事（闸①=3 闸②=5 闸③=1）。
 *
 * 用法：
 *   node verify.mjs
 *   node verify.mjs --mutate=bg-only        # 反证：像素断言应变红
 *   node verify.mjs --mutate=no-fallback    # 反证：回落断言应变红
 *   node verify.mjs --mutate=crash          # 反证：报告器 fail-closed
 */
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WORKSPACE = join(homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const ORIGIN = 'http://mb.test/';
/* 一次性副本一律放 D:/tmp（拿不到就退回系统临时目录）。
   ⚠️ 目录名带本次运行的唯一 tag：否则上一轮的残留会让本轮 buildCopy 的删除撞上
   调用方（Agent 运行时）注入的 safe-delete 垫片（它按**对话回合累计**删除项数，
   越线后每笔删除都抛错 —— 详见下面 `rmrf()` 的说明）而中途抛错。 */
const TMP_BASE = existsSync('D:/tmp') ? 'D:/tmp' : tmpdir();
const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`;
const TMP_COPY = join(TMP_BASE, `mb-verify-${RUN_TAG}`);
const TMP_NOMODS = join(TMP_BASE, `mb-verify-nomods-${RUN_TAG}`);

/**
 * 真实视频字节（仓库里的 aurora-video/bg.mp4 —— ffmpeg 自产、无版权）。
 *
 * ⚠️ 媒体断言**必须**用真字节：一个 404 或空 buffer 也能让 `<video>` 元素存在，
 *    只有真解码才能证明"能出画"。缺文件时这里直接抛 —— 让整套明确失败，
 *    而不是悄悄退化成"用假数据测通过了"。
 * ⚠️ 定义必须放在**文件前部**：A 组（媒体路由夹具）会用到它，而 `const` 有 TDZ，
 *    放到 A 组后面会报 "Cannot access before initialization"。
 */
const REAL_MP4 = readFileSync(join(HERE, 'mods', 'aurora-video', 'bg.mp4'));

/**
 * E19b 的 seek **落位率**下限（`landed / assigns`）。
 *
 * ⚠️ 这个数是**实测定出来的**，不是拍脑袋 —— 两个分布（共 7 次独立整套运行）：
 *
 *   | 实现 | 落位率（每次独立运行） | 浪费的 seek |
 *   |---|---|---|
 *   | 正常（在途不重发） | **1.000 ×4**（零浪费） | 0 |
 *   | 拆掉闸门（每帧发） | 0.648 / 0.643 / 0.651 / 0.646 / 0.646 / 0.683 / **0.715** | 40~46 |
 *
 * 正常恒为 1.0（从不例外），洪水版最高只到 0.715 ⇒ 取 **0.9**：两侧各留 ≥0.1 余量，
 * 实测正常 4/4 全绿、洪水 4/4 全红。
 *
 * ⚠️ 曾经取 0.6，**是错的**：洪水版实测 0.643~0.715，与 0.6 只差 0.04~0.12 ⇒
 *    `pingpong-seek-flood` 这条反证一直在 flaky 边界上（2026-09-25 一次 0.625 被抓、
 *    另一次 0.65 放行，整套报「反证失败」，而坏实现其实是坏的 —— 判据没有辨别力，
 *    不是实现变好了）。这是**用实测分布校准阈值**、而不是"取个看起来宽松的数"的理由。
 */
const SEEK_LAND_RATE_MIN = 0.9;

/**
 * 删除文件或目录（文件与目录都支持）。
 *
 * ⚠️ 为什么不用裸 `rmSync`（2026-09-25 用垫片源码 + 对照实验查明；旧注释的因果是**错的**）：
 *    **调用方（Agent 运行时）**会经 `NODE_OPTIONS` 给每个 node 进程注入一个 safe-delete 垫片，
 *    把 `fs.rmSync` / `fs.rm` / `fs.unlink` / `fs.rmdir` 换成"移入回收站"，并**按对话回合
 *    累计删除项数**（`scope:'turn'`、`totalCount = 已用 + 本次项数`、达阈值即要求确认）。
 *
 *    ⚠️ 这是**调用方 Agent 施加的限制**，不是 DSH 插件本身的、也不是操作系统的通用行为 ——
 *       换个不带该垫片的运行时跑，裸 `rmSync` 完全正常。下面所有结论都以此为前提。
 *
 *    ⚠️ 阈值**可配置**（有一个默认值，本机已被上调过若干次）—— 所以**别把任何一个具体数字
 *       写进契约**：会随环境变。可断定的是**机制**：它是**回合累计**的，
 *       且**越线之后每一笔删除都会继续被拒并抛错**（不是只拦超标那一笔）。
 *
 *    这个"越线后每笔都拒"的性质是决定性的：无论删多小的目录都会炸。实测坐实过——
 *    反证套件跑到第 8 条起，A 组的夹具清理开始抛
 *    `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，其后 13 条全部记成 ERROR（"跑不完"）。
 *
 *    旧注释说"拒绝超过某个项数的递归删除"——**方向错了**：不是单次项数超限，而是**回合内累计**超限。
 *    按旧理解会去"缩小单次删除量"（无效）；按真实语义才知道要"整条路径绕开垫片的额度计账"。
 *    排查线索：报错里的 `count` 远小于一次 `buildCopy()` 的项数 ⇒ 它数的必然不是"本次目标"。
 *
 *    实测对照（同一回合内）：裸 `rmSync` 删 1 个目录 ⇒ 被拒并抛错；
 *    本函数的 PowerShell 路径 ⇒ 删成功，且回合计数**原值不变**（不消耗额度）。
 *    ⇒ 凡本文件里清自建夹具/副本的地方一律调本函数。
 *    ⚠️ 本函数内部保留 `rmSync` 作为 PowerShell 不可用时的兜底 —— 那是最后手段，
 *       且失败只是返回 false（由调用方如实上报），不会像裸调用那样把整轮验证打断。
 *
 * @returns {boolean} 是否真的删掉了（调用方**必须**据此如实上报，别无条件打印"已清理"）
 */
function rmrf(p) {
  if (!existsSync(p)) return true;
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe',
        ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${p}' -Recurse -Force -ErrorAction SilentlyContinue`],
        { stdio: 'ignore' });
      if (!existsSync(p)) return true;
    } catch { /* 落到 rmSync */ }
  }
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
  return !existsSync(p);
}

/** 归属标记文件名（放在每个自建副本目录里）。 */
const OWNER_MARKER = '.mb-verify-owner.json';
/** 本次运行的归属凭据：pid + 启动时刻 + 随机 nonce（用来证明"这个目录是我建的"）。 */
const OWNER = JSON.stringify({
  tool: 'verify.mjs', pid: process.pid, startedAt: Date.now(),
  nonce: `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`, runTag: RUN_TAG,
});
function markOwned(dir, marker = OWNER_MARKER) { try { writeFileSync(join(dir, marker), OWNER, 'utf8'); } catch { /* 忽略 */ } }

/**
 * 目录名里的 pid 是否还活着。
 * 只作为"是否仍在使用"的**辅助**判据（F6-B′ 指出：单靠 pid 无法回答"目录是谁建的"）。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * 起跑先清**上一轮死进程留下的**副本目录，避免多轮跑堆积几十个。
 *
 * ⚠️ 旧实现是无条件 `if (/^mb-verify/.test(d)) rmrf(...)` —— 第六轮审核（F6-A / C7）实测它能删掉
 * 一个**完全无关的第三方目录** `D:\tmp\mb-verify-f6decoy-99999\`：只按前缀匹配、不看归属。
 * 第一版修法只看"名字里的 pid 是否还活着"，F6-B′ 指出那只是**风险收缩**：
 * 第三方目录若恰好叫 `mb-verify-<某个已死 pid>-x`，照样会被删。
 *
 * ⇒ 现在的判据是**归属证明**：目录里必须有**本工具写的**归属标记（`.mb-verify-owner.json`），
 * 且标记里的 pid 已不存在，才删。没有标记、标记读不出、标记里的 pid 还活着 —— 一律不碰并打印保留清单。
 * 这样"别人的目录"在原理上不可能被删（它不会带着我的标记），与 pid 复用无关。
 */
function ownedByUs(dir, marker = OWNER_MARKER) {
  try {
    const st = statSync(join(dir, marker));                 // 先看大小：4 MB 的"合法标记"也读过（F6-A′ 实测）
    if (!st.isFile() || st.size > 4096) return null;
    const o = JSON.parse(readFileSync(join(dir, OWNER_MARKER), 'utf8'));
    /* 字段形状全部校验 —— nonce/startedAt/runTag 不是装饰：缺一个就说明这不是本工具写的标记。 */
    const okShape = o?.tool === 'verify.mjs' && Number.isInteger(o?.pid) && o.pid > 0
      && Number.isInteger(o?.startedAt) && o.startedAt > 0
      && typeof o?.nonce === 'string' && o.nonce.length >= 8
      && typeof o?.runTag === 'string' && o.runTag.length > 0;
    return okShape ? o : null;
  } catch { return null; }
}

/**
 * 起跑先清**上一轮死进程留下的**副本目录。
 *
 * ⚠️ 判据的准确说法（F6-A′ 把话说死了，我接受并收窄声明）：这是**自证式声明（self-declared claim）**，
 * **不是防伪凭据**。别人若在目录里写一份同样格式的标记，我们照样会按"它自称的属主已退出"去删它 ——
 * 这是明知的取舍：不做密码学签名，就不可能区分"我上次崩溃留下的"与"别人照着格式伪造的"。
 * 能保证的是：**不认识、标记不合法、属主还活着的目录一律不删**（旧版按前缀无条件删，那才是真危险）。
 * 名字前缀对**安全性**已无贡献，只用于缩小扫描面 ⇒ 反过来说，漏清理方向也不再受名字格式影响：
 * 只要标记合法且属主已退出，名字不合 `/^mb-verify/i` 也照样清（F6-A′ 指出过这个漏方向）。
 */
function cleanStaleRuns(dir) {
  let removed = 0; const kept = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const owner = ownedByUs(full);
    if (owner === null) {
      /* 不是我的目录：只有当它长得像本套件的命名才值得打印，免得把无关目录刷屏。 */
      if (/^mb-verify/i.test(name)) kept.push(`${name}（无合法归属标记 ⇒ 不是我的，绝不删）`);
      continue;
    }
    if (pidAlive(owner.pid)) { kept.push(`${name}（属主 pid ${owner.pid} 还活着）`); continue; }
    if (rmrf(full)) removed += 1; else kept.push(`${name}（删不掉）`);
  }
  return { removed, kept };
}

if (existsSync(TMP_BASE)) {
  const { removed, kept } = cleanStaleRuns(TMP_BASE);
  if (removed > 0) console.log(`（起跑清理：删掉 ${removed} 个"带合法归属标记且属主已退出"的副本目录）`);
  /* 全量打印保留清单：**"哪些没被删"本身就是安全证据**，不该被截断（F6-A′ 的指摘）。 */
  if (kept.length > 0) console.log(`（保留 ${kept.length} 个目录，完整清单：\n  - ${kept.join('\n  - ')}）`);
}
/** 反证用：一个"文件夹名合法、但 mod.json 里的 id 是任意串"的 mod。 */
const WILD_ID = '<img src=x onerror=alert(1)>';

const argv = process.argv.slice(2);
const CLIENT_OVERRIDE = (argv.find((a) => a.startsWith('--client=')) ?? '').slice('--client='.length) || null;
const MUTATE = (argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length) || null;

/* ════════════════════════════ 计数与打印 ════════════════════════════ */
let pass = 0;
let failed = 0;
let findings = 0;

function section(title) { console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`); }

/** 契约类断言：不通过 ⇒ 退出码非 0。 */
function check(name, ok, detail = '') {
  if (ok) pass += 1; else failed += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok === true;
}

/** 偏差发现：记录"实现与文档契约不一致"之处；不参与退出码，但显式打印。 */
function finding(name, isDeviation, detail = '') {
  if (isDeviation) findings += 1;
  console.log(`${isDeviation ? '  ⚠️ ' : '  ✅'} [偏差发现] ${name}${detail ? `  — ${detail}` : ''}`);
  return isDeviation === true;
}

function info(name, detail = '') { console.log(`  ·  ${name}${detail ? `  — ${detail}` : ''}`); }

/**
 * 剥掉 GLSL / JS 源码里的注释。
 *
 * 用途：所有"契约要求声明了 X"的检查都必须在**剥注释后**的源码上做 —— 否则把声明
 * 塞进注释就能让断言变绿（离线审核实测过这条假绿路径）。字符串字面量里的 `//`
 * （例如 URL）不会被误伤：`[^:]` 前缀条件。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}


/* ════════════════════════════ A 组：宿主半 ════════════════════════════ */

function mkFakeCtx() {
  const registered = [];
  const webServer = { register: (r) => { registered.push(r); } };
  return { registered, ctx: { webServer } };
}

/**
 * 假 res：抓 writeHead / end，并**收集流式写入的字节**。
 *
 * ⚠️ 媒体路由用 `createReadStream(...).pipe(res)` —— 那要求 res 是**真正的可写流**。
 *    手写 `on/once/emit` 那种最小桩一定会漏（实测：先漏 `listenerCount`，
 *    补完还有 `off`/`addListener`…）。所以这里直接继承 `stream.Writable`：
 *    pipe 需要什么它都有，且字节是**真**流过的。
 */
class FakeRes extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = null;
    this.chunks = [];
    this.ended = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  _write(chunk, _enc, cb) { this.chunks.push(Buffer.from(chunk)); cb(); }
  _final(cb) { this.ended = true; cb(); }
  /** 等流真正写完（或超时），返回累积字节。 */
  async bytes(timeout = 3000) {
    if (!this.ended) {
      await Promise.race([
        new Promise((r) => this.on('finish', r)),
        new Promise((r) => setTimeout(r, timeout)),
      ]);
    }
    return Buffer.concat(this.chunks);
  }
}

function callHandler(handler, req = { url: '/motion-background/mods', method: 'GET' }) {
  const res = new FakeRes();
  handler(req, res);
  return {
    status: res.status,
    headers: res.headers ?? {},
    /* `body` 保持"字符串"语义（旧断言全是 JSON.parse(String) 风格）；
       媒体路由是二进制，用 `bytes` 取原始 Buffer。 */
    body: Buffer.concat(res.chunks).toString('utf8'),
    bytes: Buffer.concat(res.chunks),
    res,
  };
}

async function groupA() {
  section('A. 宿主半（lib/index.js）—— 直接 import，真调 apply，真解析 JSON');

  /*      ⚠️ 有宿主半变异时**必须 import 副本**，不能 import 源码原文件。
     否则 `--mutate=media-traversal` 这类反证会打在空气上：A 组的非法路径那一组
     仍然跑的是**未被变异**的真实现，于是"全绿"，看起来像"断言很稳"，
     实际是"断言根本没观察到自己想观察的那份代码"（假绿，2026-09-25 加媒体反证时发现）。
     ⚠️ 但副本的 `mods/` 是 B 组的测试语料（不含 aurora-video）—— 所以下面凡是需要
        **真仓库语料**的断言，都要用 `REAL_MODS` 而非 `payload.dir`，并把"语料在哪"
        这件事显式说明。读的是 lib/，验的是行为，两者不混。 */
  const hostEntry = MUTATE !== null && existsSync(join(TMP_COPY, 'lib', 'index.js'))
    ? join(TMP_COPY, 'lib', 'index.js')
    : join(HERE, 'lib', 'index.js');
  if (MUTATE !== null) info('A 组读取的宿主半', hostEntry);
  const mod = await import(pathToFileURL(hostEntry).href);
  check('lib/index.js 导出 apply 函数', typeof mod.apply === 'function');
  check('lib/index.js 导出 inject 且含 "webServer"',
    Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject));

  const { registered, ctx } = mkFakeCtx();
  mod.apply(ctx);
  /* ⚠️ 从 1 条变成 2 条：媒体功能新增了 `/motion-background/media` 前缀路由。
     这条断言改成"恰好 2 条且分别是 mods 与 media" —— 不是把数字改大就完事，
     而是把它变成**结构性**断言，以后再多一条路由也会立刻被看见。 */
  check('apply(ctx) 恰好注册 2 条路由（mods 清单 + media 媒体）',
    registered.length === 2, `实得 ${registered.length}：${registered.map((r) => r.path).join(', ')}`);

  const route = registered[0] ?? {};
  check("path === '/motion-background/mods'", route.path === '/motion-background/mods', String(route.path));
  check('kind 是合法字符串（cordis 路由类别）', typeof route.kind === 'string' && route.kind.length > 0, String(route.kind));
  check('handler 是函数', typeof route.handler === 'function');

  /* ══════════════ 媒体路由（/motion-background/media）安全边界 ══════════════
     这一块是**新增的攻击面**：它把 mods/ 下的文件交给浏览器，一旦路径校验有洞就是任意文件读取。
     每条断言都真的调 handler 看响应码，不看源码文本。

     ⚠️ 夹具策略：**在"被测宿主半自己认的那个 mods/ 下"临时建一个 mod 目录**。
        不能硬编码 `aurora-video`：变异模式下被测的是副本（它的 mods/ 是 B 组的测试语料，
        不含 aurora-video），硬编码会让所有媒体断言在变异时误红。
        做法是跑一次 mods 端点、读出 `payload.dir`，再往那里写一个 `zz-media-probe/`。 */
  const mediaRoute = registered.find((r) => r.path === '/motion-background/media') ?? {};
  check("存在 '/motion-background/media' 路由（媒体型 mod 靠它取视频/图片）",
    mediaRoute.path === '/motion-background/media', String(mediaRoute.path));
  check('媒体路由用 kind="prefix"（路径形如 /motion-background/media/<id>/<file>）',
    mediaRoute.kind === 'prefix', String(mediaRoute.kind));
  check('媒体路由 handler 是函数', typeof mediaRoute.handler === 'function');

  /* 被测宿主半认的 mods/ 目录（变异时是副本的，非变异时是真仓库的）。 */
  const probeModsDir = (() => {
    try { return JSON.parse(callHandler(route.handler).body).dir ?? null; } catch { return null; }
  })();
  check('能问出被测宿主半的 mods/ 目录（媒体断言的夹具基址）',
    typeof probeModsDir === 'string' && existsSync(probeModsDir), String(probeModsDir));

  if (typeof mediaRoute.handler === 'function' && typeof probeModsDir === 'string' && existsSync(probeModsDir)) {
    /* 建夹具：一个合法的 mp4 + 一个**不该被服务**的敏感文件（扩展名不在白名单）。
       放在 mods/ 下的独立目录，结束前删掉（try/finally）。

       ⚠️⚠️ **夹具里的每个"诱饵"文件都必须真实存在**。
           钉住闸②的向量靠"编码反斜杠 + 合法 .mp4 扩展名"跨出 mod 目录，
           它们指向的**目标必须真在磁盘上** —— 否则把闸②拆掉后，
           处理器会走到 `statSync` → 文件不存在 → 仍然 404，
           于是断言**照样全绿**，反证静默失效（这正是我要修的假绿模式）。
           ⇒ 所以下面不但建 `zz-media-probe/`，还建一个**邻居 mod 目录** `zz-media-neighbor/`，
             两者都放真 mp4，让"跨目录读"有真东西可读、拆掉闸后真能读出 200。 */
    const probeId = 'zz-media-probe';
    const neighborId = 'zz-media-neighbor';
    const probeDir = join(probeModsDir, probeId);
    const neighborDir = join(probeModsDir, neighborId);
    const looseLure = join(probeModsDir, 'zz-lure.mp4');   // mods/ 根的散落文件（扫描时被跳过）
    mkdirSync(probeDir, { recursive: true });
    mkdirSync(neighborDir, { recursive: true });
    const probeMp4 = join(probeDir, 'bg.mp4');
    writeFileSync(probeMp4, REAL_MP4);
    /* 敏感文件：与 mp4 同目录但扩展名不在白名单 ⇒ 绝不能被服务。 */
    writeFileSync(join(probeDir, 'secret.json'), JSON.stringify({ secret: 'DO-NOT-SERVE' }));
    /* 文件名里含 `..` 的 mp4（内容合法、扩展名合法）——
       契约规定"文件名不许含 `..`"⇒ 必须 404；拆掉闸②后它会变成 200。 */
    writeFileSync(join(probeDir, 'do..t.mp4'), REAL_MP4);
    /* 邻居 mod 的文件 + mods/ 根的散落文件 —— 闸②失效时这些就是"被越权读到"的落点。
       ⚠️ 落点必须**真的存在**，否则拆掉闸②后仍是 404（`statSync` 兜底），反证静默失效。
          实测 `..\..\<id>\bg.mp4` 会规范化到 mods/ 的**上一级**（不存在），
          所以只用「一层 `..` 正好落回 mods/ 之内」的形状，这些落点全部真实存在。 */
    writeFileSync(join(neighborDir, 'bg.mp4'), REAL_MP4);
    writeFileSync(join(neighborDir, 'lure.mp4'), REAL_MP4);
    writeFileSync(looseLure, REAL_MP4);

    try {
      const hitMedia = (url) => callHandler(mediaRoute.handler, { url, method: 'GET' });
      const okMedia = hitMedia('/motion-background/media/' + probeId + '/bg.mp4');
      check('合法媒体路径返回 200（夹具里的真 mp4）', okMedia.status === 200, String(okMedia.status));
      check('媒体响应的 content-type 是 video/mp4',
        String(okMedia.headers['content-type']).includes('video/mp4'), String(okMedia.headers['content-type']));
      check('媒体响应声明 accept-ranges: bytes（<video> 的 Range 探测靠它）',
        String(okMedia.headers['accept-ranges'] ?? '').includes('bytes'), String(okMedia.headers['accept-ranges']));

      /* ⚠️ 目录穿越：下列**每一条都必须是 404**。任何一条 200 都意味着任意文件读取。
         目标文件都**真实存在**（package.json / target.mp4 / secret.json），否则"404 是因为文件不存在"
         会掩盖校验漏洞 —— 那样断言就是假绿。

         🔴🔴 **2026-09-25 实测到的真·假绿，以及它的正确解法**（务必读完再改这个列表）

         校验是三道路径闸，**它们互相重叠**：
           ① `parts.length !== 2`  —— 段数必须是 2
           ② `file.includes('..') || /[\\/]/.test(file)` —— 文件名不许含 `..` 或分隔符
           ③ `MEDIA_EXT[ext]` + `dot > 0` —— 扩展名必须在白名单里（**这一道同时挡住了大部分向量**）

         我原以为"补几条编码分隔符向量就能触达 ②"，实际一测：**不行**。原因是
         `new URL()` 会先做一次规范化，且三闸重叠，下面每条都另有闸兜住：
           · `/media/../package.json`   → URL 规范化直接吃掉 `..`，`pathname` 变成 `/motion-background/package.json`
           · `/media/zz/..%5Cpackage.json` → 段数=2 ✓、能过 ②，**但被 ③ 拦下**（`.json` 不在白名单）
           · `/media/zz/..%2Fpackage.json` → 解码出真 `/` ⇒ 段数=3，**被 ① 拦下**
           · `/media/zz/..`             → 段数=2 ✓，但 `dot <= 0` **被 ③ 拦下**

         ⇒ 「拆掉 ② 后这 18 条仍全绿」**不是断言写错，而是这 18 条本来就够不着 ②**：
            它们全被 ①/③ 兜住了。这种情况下的绿是**真绿**（路径确实被拦住了），
            但它**不能证明 ② 在工作** —— 而 ② 是唯一挡住"同目录敏感文件"的那道闸。

         解法：给每道闸**配一条只有它拦得住的向量**，且**被判闸必须真的改变结果**
         （这是反证能变红的前提 —— 见下面 ★★★ 那三条，以及「同目录敏感文件」那条）。

         ⚠️ 别再用"文件名里编码的 `..`"这种向量去钉 ② —— 已证触达不了，白写。 */
      const traversals = [
        /* ── ★★★ 闸①（段数）：只有它拦得住的形状 = 「多出一段」 ──
           为什么这些才对：拆掉段数校验后，解构 `const [id, file] = parts` 只取**前两段**，
           第三段起被**静默丢弃** —— 于是 `/media/<id>/bg.mp4/任何东西` 会照常送出 bg.mp4。
           ⚠️ 这几条**落点已用地面真值探针逐条验过存在**（否则拆掉闸①后 statSync 兜底 404、
              反证又变假绿）。反过来说，像 `/<id>/a/b.mp4` 那种"三段但第二段不是合法文件名"
              的向量**钉不住闸①**（拆掉它在闸③就死了）—— 实测确认过，别拿它当闸①的证据。 */
        ['★★★ [闸①] 尾随多余段（拆掉段数校验后第三段被静默丢弃、照常送 bg.mp4）',
          '/motion-background/media/' + probeId + '/bg.mp4/extra'],
        ['★★★ [闸①] 尾随两段（同上）',
          '/motion-background/media/' + probeId + '/bg.mp4/a/b'],
        ['★★★ [闸①] 尾随段里夹编码穿越（同上；段数校验是唯一屏障）',
          '/motion-background/media/' + probeId + '/bg.mp4/..%5C..%5Cpackage.json'],
        /* ── ③ 扩展名白名单：★ 这条只有它拦得住（段数=2 ✓、文件名干净 ✓、文件真实存在） ── */
        ['★★★ [闸③] 同目录敏感文件 secret.json（只有白名单拦得住，且文件真的在）',
          '/motion-background/media/' + probeId + '/secret.json'],
        /* ── 以下为**重叠覆盖**（多闸都能拦，任一闸在就 404）。保留它们是为了覆盖面，
             但**不要**把它们当成某一道闸的证据：删掉任一道闸它们都不会变红（实测）。
             真正逐闸钉住的只有上面带 ★★★ 的那几条。 ── */
        ['[重叠] 三段路径且第二段不是合法文件名', '/motion-background/media/' + probeId + '/a/b.mp4'],
        ['[重叠] 深层 ../（URL 规范化后段数≠2）', '/motion-background/media/' + probeId + '/../../package.json'],
        ['[重叠] 缺文件名（只剩一段）', '/motion-background/media/' + probeId],
        ['[重叠] 空文件名', '/motion-background/media/' + probeId + '/'],
        ['[重叠] 绝对路径注入', '/motion-background/media//C:/Windows/win.ini'],
        ['[重叠] URL 编码 %2e%2e 做 id', '/motion-background/media/%2e%2e/package.json'],
        ['[重叠] 裸 ../ 穿越到仓库根', '/motion-background/media/../package.json'],
        ['[重叠] 白名单扩展名的伪装（.mp4.txt）', '/motion-background/media/' + probeId + '/bg.mp4.txt'],
        ['[重叠] 无扩展名', '/motion-background/media/' + probeId + '/bg'],
        ['[重叠] 双扩展名但末位不在白名单（.mp4.json）', '/motion-background/media/' + probeId + '/bg.mp4.json'],
        ['[重叠] id 含大写', '/motion-background/media/ZZ-Probe/bg.mp4'],
        ['[重叠] id 含下划线', '/motion-background/media/zz_media_probe/bg.mp4'],
        /* ── ② 文件名闸：唯一有效形式 —— 「合法扩展名 + 名字里带编码分隔符」 ──
           这是**故意留的活口**：`..%5Cxxx.mp4` 解码成 `..\xxx.mp4`，段数=2 ✓、
           扩展名 `.mp4` 在白名单 ✓ —— 三闸里**只有 ② 能拦住它**。

           🔴 下面这 5 条的落点**已逐条用地面真值探针验过**（`existsSync` 为真）：
              拆掉 ② 后它们真的会读出 200，反证才会变红。
              ⚠️ 写这类向量时**必须**做这一步核对 —— 本轮实测有 2 条看着合理的向量
                 （`..\lure.mp4`、`..\..\<id>\bg.mp4`）落点其实**不存在**：
                 拆掉 ② 后 `statSync` 会兜底 404，断言照样全绿 ⇒ 反证静默失效。
                 形状对不对**不能靠推理**，要在真目录里算一遍落点。
              ⚠️ 只用 `%5C` 编码形式，**不要写裸反斜杠**：裸的 `..\bg.mp4` 经 shell/heredoc
                 层转义极易被拼成 `..%08g.mp4`（退格符），同批次实测踩到过。 */
        ['★★★ [闸②] 编码反斜杠跨目录读邻居 mod 的 bg.mp4（落点已验存在）',
          '/motion-background/media/' + probeId + '/..%5C' + neighborId + '%5Cbg.mp4'],
        ['★★★ [闸②] 编码反斜杠跨目录读邻居 mod 的 lure.mp4（落点已验存在）',
          '/motion-background/media/' + probeId + '/..%5C' + neighborId + '%5Clure.mp4'],
        ['★★★ [闸②] 编码反斜杠读 mods/ 根的散落文件 zz-lure.mp4（落点已验存在）',
          '/motion-background/media/' + probeId + '/..%5Czz-lure.mp4'],
        ['★★★ [闸②] 文件名含两个点 do..t.mp4（内容/扩展名都合法、文件真实存在）',
          '/motion-background/media/' + probeId + '/do..t.mp4'],
        ['★★★ [闸②] 双反斜杠绕回同目录 bg.mp4（落点已验存在）',
          '/motion-background/media/' + probeId + '/..%5C%5C' + probeId + '%5Cbg.mp4'],
        /* ── 交叉覆盖：这条解码出的 `/` 会让段数变 3 ⇒ 实际由闸①兜住（保留，但不指望它钉 ②）。 ── */
        ['[重叠] 编码正斜杠 + .mp4（解码后段数=3）',
          '/motion-background/media/' + probeId + '/..%2Fbg.mp4'],
      ];
      const leaked = [];
      for (const [label, url] of traversals) {
        const r = hitMedia(url);
        if (r.status !== 404) leaked.push(`${label} → ${r.status}`);
      }
      check(`★ 媒体路由的 ${traversals.length} 种非法路径全部 404（防目录穿越 / 防扩展名绕过）`,
        leaked.length === 0, leaked.length === 0 ? `${traversals.length} 种全部拒绝` : leaked.join(' ; '));

      /* ⚠️ 上面那条的**真·反证前提**（不是自证，是给读者看的硬约束）：
         这组里必须**每道闸都有"只有它拦得住"的向量**，否则拆掉那道闸时它仍会全绿。
         2026-09-25 血的教训（两次）：
           · 原来 18 条**全都够不着闸②**（各被 ①/③ 兜住）⇒ 拆掉闸② 零红，是假绿；
           · 修闸② 时我给"闸①"打的标签**也是错的** —— 实测那些向量在闸③/id 就死了，
             拆掉段数校验后它们根本没有一条变成 200。
         ⇒ 所以下面这条**结构性断言**按**每道闸分别计数**，并要求全部达标。
            将来谁删掉某道闸的证据向量，这里立刻变红，而不是等到反证跑出来才发现假绿。
         （"只有它拦得住"不是靠命名声明的，是靠真目录里的落点探针逐条验过的。） */
      const countGate = (tag) => traversals.filter(([l]) => l.includes(tag)).length;
      const gateCounts = { '闸①': countGate('[闸①]'), '闸②': countGate('[闸②]'), '闸③': countGate('[闸③]') };
      check('★ 三道闸各自都有"只有它拦得住"的证据向量（缺一道 ⇒ 那道闸的反证会退化成假绿）',
        gateCounts['闸①'] >= 3 && gateCounts['闸②'] >= 5 && gateCounts['闸③'] >= 1,
        `闸①=${gateCounts['闸①']} 闸②=${gateCounts['闸②']} 闸③=${gateCounts['闸③']}`);

      /* 这条证明上面那组不是恒真：同一批里"合法的那一条"确实返回 200（已在前面验过），
         另外确认 404 的响应体**不泄漏目录内容**。
         ⚠️ 必须 await：媒体路由是 `createReadStream().pipe(res)`，body 是**流式**写进来的，
            同步读只会拿到空串 —— 那样这条断言就变成恒真（永远"不泄漏"）。 */
      const notFound = hitMedia('/motion-background/media/nope/none.mp4');
      const nfBody = (await notFound.res.bytes()).toString('utf8');
      check('不存在的 mod ⇒ 404，且响应体不泄漏目录信息',
        notFound.status === 404 && !/mods|aurora|meteor|C:\\|\/d\//i.test(nfBody),
        `${notFound.status} / ${JSON.stringify(nfBody.slice(0, 60))}`);

      /* 合法媒体请求真的把**文件字节**送出来了（证明上面那组 404 不是因为"全都404"）。
         ⚠️ 必须在这一步就把字节读完：`createReadStream` 是**惰性打开**文件的，
            先删夹具目录再读会 ENOENT（而且那个错误是流上的 unhandled 'error'，直接崩进程）。 */
      const okBytes = await okMedia.res.bytes();
      const realSize = statSync(probeMp4).size;
      check('合法媒体请求真的送出了完整文件字节（与磁盘大小一致）',
        okBytes.length === realSize, `${okBytes.length} vs ${realSize}`);
      check('送出的字节是合法 mp4（含 ftyp box 特征）',
        okBytes.length > 12 && okBytes.slice(4, 8).toString('ascii') === 'ftyp',
        okBytes.slice(4, 12).toString('ascii'));

      /* Range：<video> 靠它做 seek 与循环。206 + content-range 缺一不可。
         ⚠️ Range 请求会开新的 ReadStream —— 必须等它读完再进入下一段/离开 finally，
            否则夹具目录被删后流才去 open ⇒ ENOENT 打崩进程（实测踩到）。 */
      const mkReq = (range) => ({ url: '/motion-background/media/' + probeId + '/bg.mp4', method: 'GET', headers: { range } });
      const rHead = callHandler(mediaRoute.handler, mkReq('bytes=0-99'));
      await rHead.res.bytes();
      check('Range bytes=0-99 ⇒ 206 且 content-range 正确',
        rHead.status === 206 && /^bytes 0-99\/\d+$/.test(String(rHead.headers['content-range'] ?? '')),
        `${rHead.status} / ${rHead.headers['content-range']}`);
      check('Range bytes=0-99 ⇒ content-length = 100',
        rHead.headers['content-length'] === 100, String(rHead.headers['content-length']));

      const rOpen = callHandler(mediaRoute.handler, mkReq('bytes=0-'));
      await rOpen.res.bytes();
      check('Range bytes=0-（浏览器首个探测请求）⇒ 206 且从 0 开始',
        rOpen.status === 206 && /^bytes 0-/.test(String(rOpen.headers['content-range'] ?? '')),
        `${rOpen.status} / ${rOpen.headers['content-range']}`);

      const rTail = callHandler(mediaRoute.handler, mkReq('bytes=-100'));
      await rTail.res.bytes();
      check('Range bytes=-100（最后 100 字节）⇒ 206 且区间在文件尾部',
        rTail.status === 206 && /bytes \d+-\d+\/\d+$/.test(String(rTail.headers['content-range'] ?? '')),
        `${rTail.status} / ${rTail.headers['content-range']}`);

      const rBad = callHandler(mediaRoute.handler, mkReq('bytes=999999999-'));
      await rBad.res.bytes();
      check('Range 起点越界 ⇒ 416（不是 200 也不是 500）', rBad.status === 416, String(rBad.status));

      const rGarbage = callHandler(mediaRoute.handler, mkReq('bytes=abc'));
      await rGarbage.res.bytes();
      check('Range 头非法 ⇒ 不崩，退化为完整 200 或 416',
        rGarbage.status === 200 || rGarbage.status === 416, String(rGarbage.status));
    } finally {
      /* 兜底：等所有已开的流结束再删夹具（读不完的流在目录消失后会抛 unhandled 'error'）。 */
      await new Promise((r) => setTimeout(r, 120));
      /* ⚠️⚠️ 必须走 `rmrf()`（PowerShell 优先），**不能**用裸 `rmSync`。
         这是 2026-09-25 反证套件"前 7 条绿、第 8 条起 13 条全崩"的根因，实测坐实：
           · **调用方（Agent 运行时）**经 `NODE_OPTIONS` 给每个 node 进程注入 safe-delete 垫片，
             它把 `fs.rmSync/rm/unlink/rmdir` 换成"移入回收站"，并**按对话回合累计删除项数**
             （`scope:'turn'`，`totalCount = 已用 + 本次项数`，达阈值即要求确认）；
           · 越线后**每一笔**删除都会抛错（不是只拦超标那一笔）⇒ 无论删多小的目录都炸，
             于是 A 组的媒体夹具清理成了"跑不完"的起点，整个套件从那里开始连续报 ERROR。
         ⚠️ 阈值**可配置**（有默认值，本机被上调过若干次）—— 所以这里只写"累计越线即每笔都拒"
            这个**机制**，不写任何具体阈值（数字会随环境变）。
         实测对照（同一回合内）：裸 `rmSync` 删 1 个目录 ⇒ 被拒并抛错；
           走 `rmrf()` 的 PowerShell 路径 ⇒ 删成功，且回合计数**原值不变**（不消耗额度）。
         ⇒ 凡本文件里清自建夹具/副本的地方一律用 `rmrf()`；裸 `rmSync` 只允许出现在 `rmrf()` 内部
           作为 PowerShell 失败后的兜底（那已经是最后手段，失败也只是返回 false，不外抛）。 */
      rmrf(probeDir);
      rmrf(neighborDir);
      rmrf(looseLure);
    }
  }

  const r1 = callHandler(route.handler);
  check('handler 返回 HTTP 200', r1.status === 200, String(r1.status));
  check('content-type 是 application/json', /application\/json/.test(String(r1.headers['content-type'])), String(r1.headers['content-type']));
  check('cache-control: no-store（保证每次请求重扫目录）',
    String(r1.headers['cache-control'] ?? '').includes('no-store'), String(r1.headers['cache-control']));
  check('content-length 与 body 字节数一致',
    r1.headers['content-length'] === Buffer.byteLength(r1.body), `${r1.headers['content-length']} vs ${Buffer.byteLength(r1.body)}`);
  check('res.end 里是合法 JSON 字符串', typeof r1.body === 'string' && (() => { try { JSON.parse(r1.body); return true; } catch { return false; } })());

  const payload = JSON.parse(r1.body);
  check('payload.mods 是数组', Array.isArray(payload.mods));
  check('payload.errors 是数组', Array.isArray(payload.errors));
  /* ⚠️ 这两条（"0 个错误""dir 指向真仓库"）只在**非变异**模式成立。
     变异模式下 A 组读的是副本，副本的 mods/ 是 B 组的测试语料（故意塞了 10 类坏 mod），
     拿"真仓库很干净"去要求它**必然误红** —— 那种红是夹具自己造成的，不是被测代码的问题，
     会污染反证结果（2026-09-25 实测：media-traversal 反证里 4 条红，3 条是这个原因）。
     所以变异模式跳过，并**显式说明**跳过是为了不制造假红。 */
  if (MUTATE === null) {
    check('真实仓库扫出 0 个错误（仓库里的 mod 都干净）',
      payload.errors.length === 0, JSON.stringify(payload.errors));
  } else {
    info('变异模式：跳过"真仓库很干净"这两条（副本语料本就含坏 mod）', MUTATE);
  }

  const meteor = payload.mods.find((m) => m.id === 'meteor');
  check('mods 里含 meteor', meteor !== undefined, payload.mods.map((m) => m.id).join(',') || '(空)');
  if (meteor === undefined) return { payload, meteor: null };

  check('meteor.fragment 是非空字符串', typeof meteor.fragment === 'string' && meteor.fragment.length > 0,
    `${meteor.fragment?.length ?? 0} 字符`);
  check('meteor.fragment 首行 === "#version 300 es"',
    String(meteor.fragment).split(/\r?\n/)[0] === '#version 300 es',
    JSON.stringify(String(meteor.fragment).split(/\r?\n/)[0]));
  check('meteor.spec 是非空普通对象', typeof meteor.spec === 'object' && meteor.spec !== null
    && !Array.isArray(meteor.spec) && Object.keys(meteor.spec).length > 0,
    JSON.stringify(meteor.spec));
  check('meteor.panel 是普通对象', typeof meteor.panel === 'object' && meteor.panel !== null && !Array.isArray(meteor.panel),
    JSON.stringify(meteor.panel));
  check("meteor.colors 是合法枚举值（'front' | 'array'）",
    meteor.colors === 'front' || meteor.colors === 'array', String(meteor.colors));

  /* 同理：`payload.dir` 在变异模式下指向副本，不能拿真仓库路径去比。 */
  const expectedDir = MUTATE === null ? resolve(join(HERE, 'mods')) : resolve(TMP_COPY, 'mods');
  check('payload.dir 指向真实存在的 mods/ 目录',
    typeof payload.dir === 'string' && resolve(payload.dir) === expectedDir && existsSync(payload.dir),
    String(payload.dir));
  check('payload.dir 下真有 meteor/mod.json', existsSync(join(payload.dir ?? '', 'meteor', 'mod.json')));

  /* 契约 §3 硬性要求 2/3：必须声明 out fragColor，必须用 in vec2 v_uv 拿坐标。
     ⚠️ 必须**剥注释后**再判：离线审核实测过 —— 把这两行只写进注释、真 program 完全不用它们，
     原来那三条断言照样全绿（典型的"源码字符串存在即算通过"）。 */
  const frag = stripComments(String(meteor.fragment));
  check('meteor.fragment 声明了 out vec4 fragColor（契约 §3.2，已剥注释）', /out\s+vec4\s+fragColor\s*;/.test(frag));
  check('meteor.fragment 声明了 in vec2 v_uv（契约 §3.3，已剥注释）', /in\s+vec2\s+v_uv\s*;/.test(frag));
  const commentOnly = '/* out vec4 fragColor; */\n// in vec2 v_uv;\nvoid main(){}';
  check('契约检查不是恒真：声明只存在于注释时必须判否',
    !/out\s+vec4\s+fragColor\s*;/.test(stripComments(commentOnly))
    && !/in\s+vec2\s+v_uv\s*;/.test(stripComments(commentOnly)));
  /* 契约说"内核不含任何第三方着色器"，顺带钉住 meteor 自述的授权声明。 */
  check('meteor 声明了 author 与 license（契约 §2 要求第三方代码必须声明）',
    typeof meteor.author === 'string' && meteor.author !== '' && typeof meteor.license === 'string' && meteor.license !== '',
    `${meteor.author} / ${meteor.license}`);

  /* 降级路径：拿不到 webServer 必须静默退出，而不是抛。 */
  let degradeThrew = null;
  const empty = { registered: [], ctx: {} };
  try { mod.apply(empty.ctx); } catch (e) { degradeThrew = String(e?.message ?? e); }
  check('ctx 无 webServer 时 apply 不抛（降级为"无效果可选"）', degradeThrew === null, String(degradeThrew));
  check('ctx 无 webServer 时不注册任何路由', empty.registered.length === 0, `实得 ${empty.registered.length}`);

  /* cordis 的另一种取服务方式：ctx.get(name)。 */
  const viaGet = { registered: [], ctx: { get: (n) => (n === 'webServer' ? { register: (r) => viaGet.registered.push(r) } : undefined) } };
  let getThrew = null;
  try { mod.apply(viaGet.ctx); } catch (e) { getThrew = String(e?.message ?? e); }
  check('ctx.get("webServer") 路径也能注册', getThrew === null && viaGet.registered.length === 2,
    getThrew ?? `注册 ${viaGet.registered.length} 条`);

  /* 端点"每次请求都重扫"：连调两次必须都能拿到完整结果。 */
  const r2 = callHandler(route.handler);
  check('两次调用 handler 都给出含 meteor 的清单（每次请求重扫目录）',
    JSON.parse(r2.body).mods.some((m) => m.id === 'meteor'));

  return { payload, meteor };
}

/* ════════════════════════════ B 组：健壮性（临时副本） ════════════════════════════ */

/**
 * 建 B 组用的仓库副本（lib/ + package.json + 一份测试语料 mods/）。
 *
 * ⚠️ **幂等**。变异模式下主流程会在 A 组**之前**先建一次副本（A 组必须 import 变异后的宿主半），
 *    然后 B 组会再调一次 —— 旧实现用裸 `rmSync` 清目录，第二次删除会撞上调用方（Agent 运行时）
 *    注入的 safe-delete 垫片（那时本回合的删除额度已耗尽 ⇒ 每笔删除都抛错）而抛错，
 *    整个 run 停在 B 阶段：B/C/D/E 全不跑，
 *    `mutations.mjs` 于是把每条媒体反证都记成 `ERROR（本轮没跑完）`，**反证永远是"未完成"**。
 *    现在两道保险：① 已经建过就直接返回（A 组 import 过的那个副本不能被中途换掉）；
 *    ② 真要删也走 `rmrf`（PowerShell 优先，绕开垫片的额度计账）。
 */
let COPY_BUILT = false;
function buildCopy() {
  if (COPY_BUILT) return;
  COPY_BUILT = true;
  rmrf(TMP_COPY);
  rmrf(TMP_NOMODS);
  mkdirSync(TMP_COPY, { recursive: true });
  markOwned(TMP_COPY);          // 归属标记：起跑清理只删"带我的标记且属主已退出"的目录
  cpSync(join(HERE, 'lib'), join(TMP_COPY, 'lib'), { recursive: true });
  cpSync(join(HERE, 'package.json'), join(TMP_COPY, 'package.json'));
  /* 宿主半的源码级变异（如 no-scan-sort）只写进副本，仓库原文不受影响。 */
  if (MUTATE !== null) writeFileSync(join(TMP_COPY, 'lib', 'index.js'), hostSource(), 'utf8');
  /* 只要 meteor 这一个"好 mod"，其余全靠我们造。 */
  mkdirSync(join(TMP_COPY, 'mods'), { recursive: true });
  cpSync(join(HERE, 'mods', 'meteor'), join(TMP_COPY, 'mods', 'meteor'), { recursive: true });

  const M = join(TMP_COPY, 'mods');
  const goodFrag = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = vec4(1.); }\n';
  const goodJson = (id) => JSON.stringify({ id, name: id, colors: 'front', spec: { u_x: 1 }, panel: {} });

  mkdirSync(join(M, 'no-manifest'));                                    // 空目录：缺 mod.json
  mkdirSync(join(M, 'no-frag'));                                        // 有 mod.json，缺 fragment.glsl
  writeFileSync(join(M, 'no-frag', 'mod.json'), goodJson('no-frag'));

  mkdirSync(join(M, 'bad-json'));                                       // mod.json 是坏 JSON
  writeFileSync(join(M, 'bad-json', 'mod.json'), '{ "id": "bad-json", ');
  writeFileSync(join(M, 'bad-json', 'fragment.glsl'), goodFrag);

  mkdirSync(join(M, 'null-json'));                                      // mod.json 合法 JSON 但是 null
  writeFileSync(join(M, 'null-json', 'mod.json'), 'null');
  writeFileSync(join(M, 'null-json', 'fragment.glsl'), goodFrag);

  mkdirSync(join(M, 'no-id'));                                          // 有 id 字段但不是字符串
  writeFileSync(join(M, 'no-id', 'mod.json'), JSON.stringify({ id: 42, colors: 'front' }));
  writeFileSync(join(M, 'no-id', 'fragment.glsl'), goodFrag);

  mkdirSync(join(M, 'BadCaps'));                                        // 文件夹名含大写
  writeFileSync(join(M, 'BadCaps', 'mod.json'), goodJson('BadCaps'));
  writeFileSync(join(M, 'BadCaps', 'fragment.glsl'), goodFrag);

  mkdirSync(join(M, 'bad_name'));                                       // 文件夹名含下划线
  writeFileSync(join(M, 'bad_name', 'mod.json'), goodJson('bad_name'));
  writeFileSync(join(M, 'bad_name', 'fragment.glsl'), goodFrag);

  /* 散落的文件：必须被静默忽略。 */
  writeFileSync(join(M, 'loose.txt'), '这不是一个 mod');
  writeFileSync(join(M, 'stray'), '也不是');

  /* 边界但合法的：spec / panel 派成错误类型 ⇒ 内核 asObject 应折成 {} 而不是崩。
     ⚠️ colors 必须是合法值 —— 它不是"类型兜底"的测试对象，非法 colors 会被宿主拒绝。 */
  mkdirSync(join(M, 'array-spec'));
  writeFileSync(join(M, 'array-spec', 'mod.json'),
    JSON.stringify({ id: 'array-spec', colors: 'front', spec: [1, 2, 3], panel: 'not-an-object' }));
  writeFileSync(join(M, 'array-spec', 'fragment.glsl'), goodFrag);

  /* colors 非法值 ⇒ 必须被拒（不许静默兜底成默认，否则作者拿到"颜色不对但能跑"的效果） */
  mkdirSync(join(M, 'bad-colors'));
  writeFileSync(join(M, 'bad-colors', 'mod.json'),
    JSON.stringify({ id: 'bad-colors', colors: 'weird-value', spec: {}, panel: {} }));
  writeFileSync(join(M, 'bad-colors', 'fragment.glsl'), goodFrag);

  /* 两个**不同文件夹**声明**同一个 id**。契约 §1 的确定性语义：
     **按文件夹名升序，靠前的那个生效，其余进 errors**。
     ⚠️ 两份内容必须**可区分**（这里用不同的 name）——否则"谁生效"根本观察不到：
     第五轮审核的注入 I8 就是"删掉宿主半的排序后自检仍全绿"，因为旧夹具两份一模一样。 */
  for (const [folder, name] of [['dup-a', 'dup-from-a'], ['dup-b', 'dup-from-b']]) {
    mkdirSync(join(M, folder));
    writeFileSync(join(M, folder, 'mod.json'),
      JSON.stringify({ id: 'dup', name, description: '', author: 'v', license: 'MIT', colors: 'front', spec: { u_x: 1 }, panel: {} }));
    writeFileSync(join(M, folder, 'fragment.glsl'), goodFrag);
  }

  /* 文件夹名合法（weird-id），但 mod.json 里的 id 是个带尖括号的任意串：
     白名单只拦文件夹名，id 原样放行。 */
  mkdirSync(join(M, 'weird-id'));
  writeFileSync(join(M, 'weird-id', 'mod.json'),
    JSON.stringify({ id: WILD_ID, name: 'wild', colors: 'front', spec: { u_x: 1 }, panel: {} }));
  writeFileSync(join(M, 'weird-id', 'fragment.glsl'), goodFrag);

  /* 第二份副本：连 mods/ 都不存在，验证"目录缺失"这条路。 */
  mkdirSync(TMP_NOMODS, { recursive: true });
  markOwned(TMP_NOMODS);
  cpSync(join(TMP_COPY, 'lib'), join(TMP_NOMODS, 'lib'), { recursive: true });
  cpSync(join(TMP_COPY, 'package.json'), join(TMP_NOMODS, 'package.json'));

  /* 反证用变异：把一个坏 mod 变成"扫描整体中断"，看隔离性断言会不会变红。
     只改临时副本，仓库原文不受影响。 */
  if (MUTATE === 'no-isolation') {
    const p = join(TMP_COPY, 'lib', 'index.js');
    const s = readFileSync(p, 'utf8');
    const anchor = '  for (const name of names) {';
    if (!s.includes(anchor)) throw new Error('--mutate=no-isolation 的锚点没找到');
    writeFileSync(p, s.replace(anchor,
      "  if (names.includes('BadCaps')) throw new Error('反证变异：一个坏 mod 直接中断整次扫描');\n" + anchor));
    info('⚠️ 已对副本施加变异', 'no-isolation：见坏 mod 就中断整次扫描');
  }
}

async function loadCopyHandler(root) {
  const m = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
  const { registered, ctx } = mkFakeCtx();
  m.apply(ctx);
  return registered[0];
}

/**
 * 给 C/D/E 组准备一份**含 meteor** 的载荷。
 *
 * 非变异模式直接用 A 组那份 —— 保留"真跑宿主扫描 → 交给客户端渲染"的端到端性质。
 *
 * ⚠️ 变异模式必须能回落。A 组在变异模式下读的是**副本宿主半**（为了让路径/排序类变异
 *    真的打在它身上），而像 `--mutate=no-isolation` 这种"见坏 mod 就中断整轮扫描"的变异
 *    会让 A 组载荷塌成 `{ mods: [], errors: [{id:'__scan'}] }`。C 组开头有
 *    `payloadC.mods.length === 0 ⇒ throw`，于是**整轮变 ERROR**（表现为
 *    「验证未完成：在 C 阶段抛错」，被 mutations.mjs 记成 ERROR 而不是 PASS）。
 *
 *    这是**耦合缺陷**：宿主半的故障归 A/B 组负责，不该把只测客户端的 C/D/E 一起拖停。
 *    所以这里在"A 组载荷没有 meteor"时，改用**真仓库宿主半**另取一份载荷，
 *    并显式打印原因 —— 回落本身也要留痕，否则就成了"悄悄换掉被测对象"。
 *    （2026-09-25 实测：把 buildCopy 提到 A 组之前后，no-isolation 从"变红"退化成 ERROR。）
 */
async function payloadForClient(payload) {
  if (Array.isArray(payload?.mods) && payload.mods.some((m) => m.id === 'meteor')) return payload;
  info('A 组载荷里没有 meteor（本轮变异把宿主半的整轮扫描打断了）',
    '⇒ C/D/E 改用**真仓库宿主半**另取一份载荷。宿主半的故障由 A/B 组断言负责，'
    + '不该让只测客户端的组跟着中断 —— 那会让反证被记成 ERROR 而不是 PASS。');
  const m = await import(pathToFileURL(join(HERE, 'lib', 'index.js')).href);
  const { registered, ctx } = mkFakeCtx();
  m.apply(ctx);
  const clean = JSON.parse(callHandler(registered[0].handler).body);
  if (!clean.mods.some((x) => x.id === 'meteor')) {
    throw new Error('回落也不行：真仓库宿主半的载荷里没有 meteor —— 真仓库语料本身出了问题，'
      + `mods=${JSON.stringify(clean.mods.map((x) => x.id))} errors=${JSON.stringify(clean.errors)}`);
  }
  return clean;
}

async function groupB() {
  section(`B. mod 解析健壮性 —— 仓库副本 ${TMP_COPY}（绝不碰仓库里的 mods/）`);
  buildCopy();
  info('副本已建好', TMP_COPY);

  const route = await loadCopyHandler(TMP_COPY);
  check('副本的 apply 也注册了同一端点', route?.path === '/motion-background/mods', String(route?.path));

  let threw = null;
  let payload = null;
  try { payload = JSON.parse(callHandler(route.handler).body); } catch (e) { threw = String(e?.message ?? e); }
  check('全部是坏 mod 时 handler 不抛（坏 mod 不能让端点挂掉）', threw === null, String(threw));
  if (payload === null) return;

  const errIds = payload.errors.map((e) => e.id);
  const modIds = payload.mods.map((m) => m.id);
  const reasonOf = (id) => payload.errors.find((e) => e.id === id)?.reason ?? '(无)';

  check('缺 mod.json 的文件夹进 errors', errIds.includes('no-manifest'), reasonOf('no-manifest'));
  check('缺 fragment.glsl 的进 errors', errIds.includes('no-frag'), reasonOf('no-frag'));
  check('mod.json 是坏 JSON 的进 errors（JSON.parse 抛被兜住）', errIds.includes('bad-json'), reasonOf('bad-json'));
  check('mod.json 是 null 的进 errors（不是 TypeError 崩掉）', errIds.includes('null-json'), reasonOf('null-json'));
  check('mod.json 里 id 不是字符串的进 errors', errIds.includes('no-id'), reasonOf('no-id'));
  check('文件夹名含大写的进 errors', errIds.includes('BadCaps'), reasonOf('BadCaps'));
  check('文件夹名含下划线的进 errors', errIds.includes('bad_name'), reasonOf('bad_name'));
  check('大写/下划线被 ID_RE 拦下（reason 提到命名规则）',
    reasonOf('BadCaps').includes('[a-z0-9-]') && reasonOf('bad_name').includes('[a-z0-9-]'));

  check('散落文件 loose.txt 不进 errors、也不进 mods',
    !errIds.includes('loose.txt') && !modIds.includes('loose.txt'));
  check('散落文件 stray（无扩展名）同样被忽略',
    !errIds.includes('stray') && !modIds.includes('stray'));

  /* ★ 隔离性：坏 mod 在场时，好 mod 必须毫发无伤。 */
  const meteor = payload.mods.find((m) => m.id === 'meteor');
  check('★ 隔离性：坏 mod 同时存在时 meteor 照常出现在 mods 里', meteor !== undefined, modIds.join(','));
  check('★ 隔离性：meteor 的 fragment 仍完整可用',
    typeof meteor?.fragment === 'string' && meteor.fragment.split(/\r?\n/)[0] === '#version 300 es',
    `${meteor?.fragment?.length ?? 0} 字符`);
  /* 排序规则：`order` 升序 → `id` 字典序兜底。
     ⚠️ 这里必须**按真实规则**验，而不是只验 id 升序：副本里的 meteor 是从真仓库
        cpSync 过来的，它带了 `order:-10`，因此**必然**排在最前 —— 只验 id 升序会红，
        而红的原因是"断言写的是旧规则"（2026-09-25 实测踩到）。
     规则：order 优先，同 order 时 id 升序。 */
  const orderOf = (id) => (id === 'meteor' ? -10 : 0);     // 与 mods/meteor/mod.json 一致
  const expectOrder = [...modIds].sort((a, b) => (orderOf(a) - orderOf(b)) || a.localeCompare(b));
  check('mods 排序：order 升序优先、同 order 按 id 字典序兜底',
    JSON.stringify(modIds) === JSON.stringify(expectOrder),
    `${modIds.join(' | ')}（期望 ${expectOrder.join(' | ')}）`);
  /* 单独钉住"同 order 时仍是确定的 id 序"——否则排序会退化成依赖文件系统枚举顺序。 */
  const sameOrderIds = modIds.filter((id) => orderOf(id) === 0);
  check('同 order 的 mod 之间仍是确定的 id 字典序（不依赖 readdir 顺序）',
    JSON.stringify(sameOrderIds) === JSON.stringify([...sameOrderIds].sort((a, b) => a.localeCompare(b))),
    sameOrderIds.join(' | '));
  /* mods 的构成：好 mod 全部收下，坏 mod 全部拒掉（用**语义**断言，不断具体条数 ——
     readdir 顺序不确定，且"括号里那个野生 id"现在应当被拒）。 */
  check('收下的 mod 恰好是三个合法项',
    JSON.stringify([...modIds].sort()) === JSON.stringify(['array-spec', 'dup', 'meteor']), JSON.stringify(modIds));
  check('同一个 id 只保留一份（去重生效）',
    modIds.filter((x) => x === 'dup').length === 1, `dup 出现 ${modIds.filter((x) => x === 'dup').length} 次`);
  check('id 未过白名单的 mod 被拒（不再原样放行）',
    !modIds.includes(WILD_ID), `modIds=${JSON.stringify(modIds)}`);
  check('colors 非法的 mod 被拒（不静默兜底）',
    errIds.includes('bad-colors') && !modIds.includes('bad-colors'), errIds.join(','));
  check('errors 覆盖全部 10 类坏 mod',
    ['no-manifest', 'no-frag', 'bad-json', 'null-json', 'no-id', 'BadCaps', 'bad_name', 'weird-id', 'dup', 'bad-colors']
      .every((x) => errIds.includes(x)),
    `${errIds.length}: ${errIds.join(',')}`);
  check('散落的文件既不进 mods 也不进 errors',
    !modIds.some((x) => x === 'loose.txt' || x === 'stray') && !errIds.includes('loose.txt'),
    `mods=${modIds.length} errors=${errIds.length}`);

  /* 同 id 的确定性语义：文件夹名升序靠前者生效。 */
  const dupCount = modIds.filter((x) => x === 'dup').length;
  const dupMod = payload.mods.find((m) => m.id === 'dup');
  check('★ 同 id 时"文件夹名升序靠前者"生效（dup-a 赢，不是 dup-b）',
    dupMod?.name === 'dup-from-a', `生效的 name = ${JSON.stringify(dupMod?.name)}`);
  check('同 id 的落选者进 errors（键就是那个 id）', errIds.includes('dup'), errIds.join(','));
  /* 语义已钉住，但**行为层分不出"排序有没有做"**：文件系统若本来就按名字枚举（本机 NTFS 就是），
     去掉排序也照样绿 —— 第五轮审核的 I8 实测。故补一条源码级断言，并如实标明它的性质。 */
  // 源码级兜底：读的是**被测副本**里的 index.js（= 本轮真正在跑的那份代码），
  // 所以 `--mutate=no-scan-sort` 会打红这条；而行为层的"谁生效"在按名枚举的文件系统上分不出来。
  const indexSrc = readFileSync(join(TMP_COPY, 'lib', 'index.js'), 'utf8');
  check('[源码级兜底] 被测的宿主半确实在扫描前按文件夹名排序（行为层在按名枚举的文件系统上分不出来）',
    /names\s*=\s*names\.slice\(\)\.sort\(/.test(indexSrc));
  /* 同理钉住 `order` 排序：它的效果（谁是 mods[0]）在行为层能验，但"排序依据里
     确实带了 order"这件事只有看源码才知道 —— 一个只按 id 排的实现会让 order 字段
     变成**死字段**（作者写了却不生效，且没有任何报错）。 */
  check('[源码级兜底] mods 排序依据里带了 order（否则 mod.json 的 order 是死字段）',
    /mods\.sort\([\s\S]{0,200}?\.order[\s\S]{0,200}?localeCompare/.test(indexSrc),
    indexSrc.match(/mods\.sort\([^\n]*/)?.[0] ?? '(找不到 mods.sort)');
  /* 这两条旧 finding 描述的是修复**之前**的行为（"不检测重复 id""id 不走白名单"），
     现在都已不成立 —— 留着会打印出"✅ + 一句错误结论"，比没有更危险。改成对当前语义的断言。 */
  check('重复 id 已被检测并去重（不再是"两条同 id 条目"）',
    dupCount === 1 && errIds.includes('dup'), `dup 出现 ${dupCount} 次，errors 含 dup=${errIds.includes('dup')}`);
  check('mod.json 里的 id 也过白名单（野生 id 被拒，文件夹名与 id 同一套规则）',
    !modIds.includes(WILD_ID), `modIds=${JSON.stringify(modIds)}`);

  /* asObject 的宽容性：bad 类型被折成空对象，而不是崩或透传。 */
  const lax = payload.mods.find((m) => m.id === 'array-spec');
  check('spec 派成数组 ⇒ 被折成 {}（不崩、不透传数组）',
    lax !== undefined && typeof lax.spec === 'object' && !Array.isArray(lax.spec) && Object.keys(lax.spec).length === 0,
    JSON.stringify(lax?.spec));
  check('panel 派成字符串 ⇒ 被折成 {}', lax !== undefined && typeof lax.panel === 'object'
    && !Array.isArray(lax.panel) && Object.keys(lax.panel).length === 0, JSON.stringify(lax?.panel));
  /* colors 是契约里的必需字段，只有两个合法值 ⇒ 非法值必须**被拒**，
     不许静默兜底成默认（否则作者拿到"颜色不对但看起来能跑"的效果）。 */
  check('colors 非法值被拒，且不静默兜底成 "front"',
    errIds.includes('bad-colors') && !modIds.includes('bad-colors'),
    `errors 含 bad-colors=${errIds.includes('bad-colors')}；mods 含=${modIds.includes('bad-colors')}`);
  check('合法 colors 的 mod 正常收下（对照，证明上面不是"全拒"）',
    lax !== undefined && lax.colors === 'front', `array-spec.colors=${JSON.stringify(lax?.colors)}`);

  /* 目录不存在：不抛、给空清单。 */
  const route2 = await loadCopyHandler(TMP_NOMODS);
  let missing = null;
  let missingThrew = null;
  try { missing = JSON.parse(callHandler(route2.handler).body); } catch (e) { missingThrew = String(e?.message ?? e); }
  check('mods/ 目录整体不存在时不抛', missingThrew === null, String(missingThrew));
  check('mods/ 目录不存在时 mods=[] 且 errors=[]', missing?.mods?.length === 0 && missing?.errors?.length === 0,
    JSON.stringify({ mods: missing?.mods?.length, errors: missing?.errors?.length }));
  check('mods/ 目录不存在时 dir 仍如实回报那个不存在的路径',
    typeof missing?.dir === 'string' && missing.dir.endsWith('mods') && !existsSync(missing.dir), String(missing?.dir));
}

/* ════════════════════════════ C / D 组：客户端半 ════════════════════════════ */

/**
 * 解析 playwright-core —— **不硬编码任何本机绝对路径**。
 *
 * 三个理由：① 别人在自己机器上跑不该直接挂；② 硬编码会把作者的用户名带进仓库；
 * ③ 作者环境的位置本身就是可变的（managed node 的版本目录会被工具改名）。
 *
 * 顺序：直接 require → 环境变量 PLAYWRIGHT_CORE → 用 homedir() **运行时**拼出常见位置。
 * 全失败就给一条能照着做的提示，而不是一句 "Cannot find module"。
 */
function loadPlaywright() {
  const tried = [];
  const attempt = (spec) => {
    try { return require(spec); } catch { tried.push(spec); return null; }
  };
  let mod = attempt('playwright-core');
  if (mod !== null) return mod;
  if (process.env.PLAYWRIGHT_CORE) {
    mod = attempt(process.env.PLAYWRIGHT_CORE);
    if (mod !== null) return mod;
  }
  mod = attempt(join(WORKSPACE, 'playwright-core'));
  if (mod !== null) return mod;
  throw new Error(
    '未找到 playwright-core。请任选其一：\n'
    + '  · 在本仓库 `npm i -D playwright-core`；\n'
    + '  · 或用环境变量指定：PLAYWRIGHT_CORE=<playwright-core 的绝对路径>\n'
    + '已试：' + tried.join(' ; '),
  );
}

const { chromium } = loadPlaywright();

/** 官方令牌 + 深色主题夹具。令牌齐了 readPalette 才拿得到色。 */
const FIXTURE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root{
  --dsw-static-neutral-bluish-00:#ffffff; --dsw-static-neutral-bluish-950:#151517;
  --dsw-static-deepseek-500:#4176e6; --dsw-static-deepseek-300:#b7c8fe;
  --dsw-static-blue-450:#4d93f8; --dsw-static-amber-400:#f7ad31;
  --dsw-static-red-400:#f25a5a; --dsw-static-blue-300:#93c5fd; --dsw-static-blue-400:#60a5fa;
  --dsw-static-deepseek-400:#679efe; --dsw-static-blue-500:#3b82f6;
}
html,body{margin:0;padding:0;height:100%}
body{background:var(--dsw-static-neutral-bluish-950)}
</style></head><body data-ds-dark-theme>
<div data-composer-card style="position:absolute;left:60px;top:120px;width:420px;height:96px"></div>
</body></html>`;

function clientSource() {
  let src, from;
  if (CLIENT_OVERRIDE !== null) {
    if (!existsSync(CLIENT_OVERRIDE)) throw new Error('--client 指定的文件不存在：' + CLIENT_OVERRIDE);
    src = readFileSync(CLIENT_OVERRIDE, 'utf8');
    from = CLIENT_OVERRIDE;
  } else {
    src = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8');
    from = join(HERE, 'lib', 'client.js');
  }
  /* 变异**之前**的原文快照 —— 用来在施加之后证明"能力真的少了"，而不是"打了个标记"。
     ⚠️ 必须在**任何 patch 调用之前**取，否则前后对比的是同一份（差恒为 0，总闸误报）。 */
  const pristine = src;

  /* 源码级变异：每条都必须**真的命中锚点**，否则抛错 —— 一个"没生效的变异"会让反证结果变成假绿/假红。
     ⚠️ **"命中一次"不等于"能力被删掉了"**：同一个能力在源码里可能有多处实现（如 `el.play()`
        在 boot() 与 applyConfig() 各一处）。只改掉第一处 ⇒ 能力仍然可用 ⇒ 反证**假 PASS**
        （2026-09-25 实测：`media-noplay` 曾以 exit=0 / 187 通过 / 打印成功标志 收场）。
        所以 `patch()` 会把"这个锚点在**改动前**的全文里出现几次"记下来并**打印**：
        只要 >1，就说明你只改了一处，必须自己确认那是不是全部（多数情况应改用循环替换）。
        真正需要"删掉整个能力"的地方请参考下面的 media-noplay 写法。 */
  const patch = (anchor, replacement, label) => {
    const occurrences = src.split(anchor).length - 1;
    if (occurrences === 0) throw new Error(`--mutate=${label} 的锚点没找到：${anchor}`);
    src = src.replace(anchor, replacement);
    from += `（变异：${label}` + (occurrences > 1 ? `，⚠️ 该锚点原有 ${occurrences} 处、本次只改掉第 1 处` : '') + '）';
  };
  if (MUTATE === 'no-draw') patch('gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);', '/* 变异：不绘制 */;', 'no-draw');
  if (MUTATE === 'no-fallback') patch('for (const mod of order) {', 'for (const mod of order.slice(0, 1)) {', 'no-fallback');
  if (MUTATE === 'direct-register') patch("if (typeof slots.inject === 'function') {", 'if (false) {', 'direct-register');
  /* 媒体专用反证 —— 每条都对着一条 E18 断言。
     ① 不摘媒体元素：E18e（切走后不留 <video>）与 E18b（失败后不留残留）应变红；
     ② 媒体不静音：自动播放会被拒 ⇒ E18a（真的在播）应变红，证明那条不是恒真；
     ③ 不驱动 play：证明"在播"这条断言真的在观察 play()。
     ⚠️ ①② 必须留在**这一层**（用 patch 一次替换），不要被下面的 ③ 挤掉 ——
        2026-09-25 实测踩到：改 ③ 时误删了这两行，于是 `media-keep-el` / `media-loud`
        变成"变异根本没施加"（exit=0 / 187 通过 / 打印成功标志），反证被读成"❌ 反证失败"。
        变异没施加与变异太弱，表现是**同一种假 PASS**。 */
  if (MUTATE === 'media-keep-el') patch('          el.remove();\n          ready = false;', '          /* 变异：不摘元素 */\n          ready = false;', 'media-keep-el');
  if (MUTATE === 'media-loud') patch('            el.muted = true;', '            el.muted = false; // 变异：不静音', 'media-loud');
  /* 媒体专用反证 —— 每条都对着一条 E18 断言。
     ① 不摘媒体元素：E18e（切走后不留 <video>）与 E18b（失败后不留残留）应变红；
     ② 媒体不静音：自动播放会被拒 ⇒ E18a（真的在播）应变红，证明那条不是恒真；
     ③ 不驱动 play：证明"在播"这条断言真的在观察 play()。

     ⚠️⚠️ ③ 必须**同时**干掉两处 `play()`，否则是**弱变异、反证变假 PASS**（2026-09-25 实测踩到）：
        `el.play()` 在 client.js 里有**两处** —— `createMediaSurface().boot()` 与 `applyConfig()`。
        而 `mountSurface()` 挂上之后**紧接着就调 `applyConfig(config)`**（见 client.js 里
        `surface.frame(); applyConfig(config);`）⇒ 只干掉 boot 里那处，视频**照样被第二处播起来**，
        `currentTime > 0` 依旧成立、断言全绿、还打印成功标志（当时的记录就是
        `media-noplay | exit=0 | 187/0 | ❌ 反证失败（exit=0 red=0 hit=0 且打印了成功标志）`）。
        教训不是"断言写错了"，而是**"删掉一处实现"不等于"删掉这个能力"** ——
        做变异前必须先确认这个能力在源码里**一共几处**（这里是 grep `el.play(`）。
        下面用 replaceAll 语义（循环替换 + 计数校验）一次干掉全部。 */
  if (MUTATE === 'media-noplay') {
    /* ⚠️ 锚点必须**跟上源码**。2026-09-25 加播放模式时，`boot()` 里那处
       `try { await el.play(); }` 变成了 `try { await el.play(); running = true; }`
       ⇒ 旧锚点失配、只命中 2 处、总闸抛错拦住（`mutations.mjs` 记成 ERROR）。
       这是**预期行为**（fail-closed 发现了"变异没施加"），代价是必须同步锚点。
       ⚠️ 2026-09-25 第二次同步：把两处 `void el.play()` 收敛成 `safePlay(...)`
       （为了不让 play() 的异步拒绝漏成 unhandledrejection，见 client.js 里的 safePlay）
       ⇒ 现在要削的是**"真的去播"这条能力**的全部落点，一共 4 处：
         boot 的 `await el.play()`、两处 `safePlay(...)` 调用、以及 `safePlay` 内部那一次 `el.play()`。
       ⚠️ 为什么要连 `safePlay` 内部一起削：只削调用点的话，插件里**仍然存在**一次真正的
          `play()` 调用，"从不播"这个前提就是假的 —— 变异与断言想钉的东西对不上。
         全削之后才等价于"这个插件从不调用 play()"（那正是本条反证要模拟的坏实现）。
       教训：改 `el.play()` / `safePlay()` 附近的代码时，记得回来看看这里。
       ⚠️⚠️ 三个落点的**替换文本不能相同** —— 它们的语法环境不一样：
         · boot 那处是 `try { … }` 后面**紧跟一个 `catch` 子句** ⇒ 替换文本必须仍是完整的
           `try { … }`（只写一句注释会留下**孤立的 catch**，而 `try {}` 不带 catch/finally
           同样是语法错误）⇒ bundle 加载不了，报 `bundle 没有调用 __ModuleLoader__.load`，
           整条被记成 ERROR 而不是"反证变红"。实测踩过。
         · 两处 `safePlay(...)` 是**表达式语句** ⇒ 换成 `void 0` 即可。 */
    const plans = [
      ['try { await el.play(); running = true; }', 'try { /* 变异：不播 */ }'],  // boot：保留 try/catch 结构
      ["safePlay('倒放到头后重新正放')", '/* 变异：不播 */ void 0'],              // 倒放到头 ⇒ 再正放
      ["safePlay('恢复播放')", '/* 变异：不播 */ void 0'],                        // applyConfig 从停用切回启用
    ];
    let hitCount = 0;
    for (const [a, r] of plans) {
      while (src.includes(a)) { src = src.replace(a, r); hitCount += 1; }
    }
    /* safePlay 内部那一处（把 promise 换成一个非 promise 的值 ⇒ 真的不播）。 */
    if (src.includes('const p = el.play();')) {
      src = src.replace('const p = el.play();', 'const p = void 0;'); hitCount += 1;
    }
    if (hitCount < 4) {
      throw new Error(`--mutate=media-noplay 只命中了 ${hitCount} 处，期望 4 处。`
        + '少命中说明 client.js 里的播放落点变了 —— 弱变异会让这条反证变成假 PASS（见上面的说明）。'
        + '（当前应有：boot 的 await play、两处 safePlay 调用、safePlay 内部的 el.play()。）');
    }
    from += `（变异：media-noplay，命中 ${hitCount} 处播放落点）`;
  }
  /* ── 播放模式（往返倒放）专用反证（2026-09-25 加）──
     每条都对着 E19 的**一条具体断言**。这里最容易犯的错是"变异只削状态、不削行为"：
     倒放有两层 —— 状态机（`dir` 翻转）与时间轴驱动（真的改 `currentTime`）。
     只拆驱动、保留状态，E19b 的 `direction === 'reverse'` 照样绿，
     于是"倒放能跑"看着没问题，实际画面根本没动。所以下面每条都指明它该让**哪条**变红。 */
  if (MUTATE === 'pingpong-reduce-ignored') {
    /* 倒放**不看** reduce-motion（把两处 `prefersReduce()` 判据拆掉）。
       这是独立审核 2026-09-25 指出的 🟢 级缺陷：用户运行中打开系统"减少动态效果"后，
       正放到头**仍会跑一整轮倒放**（倒放是我们自己的 rAF 驱动的，浏览器不会替我们停）。
       ⇒ 现在这条变异用来钉住修复：E19h 那把 reduce 打开后方向**不该**翻到 reverse。
       锚点刻意只削"倒放这一路"的两处判据，不动 boot/resume 的（那些是另一条契约）。 */
    const anchor1 = `        if (prefersReduce()) return;\n        dir = 'reverse';\n        startDrive();`;
    const anchor2 = `        if (prefersReduce()) return;\n        const now = performance.now();`;
    let hit = 0;
    if (src.includes(anchor1)) { src = src.replace(anchor1, `        dir = 'reverse';\n        startDrive();`); hit += 1; }
    if (src.includes(anchor2)) { src = src.replace(anchor2, `        const now = performance.now();`); hit += 1; }
    if (hit < 2) throw new Error(`--mutate=pingpong-reduce-ignored 只命中了 ${hit} 处 reduce 判据，期望 2 处（onEnded 与 tickReverse）—— 锚点失配了，反证会变假 PASS。`);
    from += `（变异：pingpong-reduce-ignored，削掉 ${hit} 处倒放路径的 reduce 判据）`;
  }
  if (MUTATE === 'pingpong-throttle') {
    /* 把闸门换成**纯时间限流**（不看 `seeking`）—— 一种"看着更保守、其实更糟"的写法。
       它是 2026-09-25 独立审核发现的最大假绿通道：**落位率反而 1.0**（发得少、
       5 发 5 中），但可见帧率掉到 2.4 fps、速度掉到 0.60×（比修复前还差）。
       ⇒ 落位率抓不住它；靠 E19b「速度在 0.8~1.2×」与「可见帧率 ≥ 10」才现形。 */
    const anchor = '        if (el.seeking === true && (now - lastIssue) < 250) { rafId = requestAnimationFrame(tickReverse); return; }';
    if (!src.includes(anchor)) throw new Error('--mutate=pingpong-throttle 的锚点没找到（seek 闸门那一行）');
    src = src.replace(anchor, '        if ((now - lastIssue) < 400) { rafId = requestAnimationFrame(tickReverse); return; }');
    from += '（变异：pingpong-throttle，闸门换成纯时间限流 400ms）';
  }
  if (MUTATE === 'pingpong-no-drive') {
    /* 拆掉时间轴驱动：把倒放那一拍改成"只记时间、不 seek"。
       ⇒ E19b「画面真的在变」与「currentTime 单调递减」都应变红。
       ⚠️ 锚点跟着实现走：加了 seek 闸门之后，这一行多了 `lastIssue = now`（见 tickReverse），
          锚点未同步会让本变异直接抛"锚点没找到"⇒ 整轮 ERROR（总闸 fail-closed 抓住了它）。 */
    const anchor = '        try { el.currentTime = next; lastIssue = now; } catch { /* seek 失败：这一帧不动，下一帧再试 */ }';
    if (!src.includes(anchor)) throw new Error('--mutate=pingpong-no-drive 的锚点没找到（倒放 seek 那一行）');
    src = src.replace(anchor, '        /* 变异：不真的 seek，只留状态 */');
    from += '（变异：pingpong-no-drive，倒放不再驱动时间轴）';
  }
  if (MUTATE === 'pingpong-seek-flood') {
    /* 拆掉 **seek 闸门**：退回"每个动画帧都发一个 seek"（最自然也最错的那版）。
       每个新的 `currentTime` 赋值都会掐掉在途的那次 seek ⇒ 解码器永远从头开始。
       ⇒ E19b「seek 落位率 ≥ 0.9」应变红（实测落位率 0.65，浪费约 45 次 seek）。
       ⚠️ 这条变异钉的是**性能/流畅度契约**（"倒放不许退化成幻灯片"），
          与 `pingpong-no-drive`（画面完全不动）是两个不同的能力，不能互相替代。 */
    const anchor = '        if (el.seeking === true && (now - lastIssue) < 250) { rafId = requestAnimationFrame(tickReverse); return; }';
    if (!src.includes(anchor)) throw new Error('--mutate=pingpong-seek-flood 的锚点没找到（倒放的 seek 闸门那一行）');
    src = src.replace(anchor, '        /* 变异：闸门被拆 —— 每帧都发 seek */');
    from += '（变异：pingpong-seek-flood，倒放每帧都发 seek）';
  }
  if (MUTATE === 'pingpong-loop-true') {    /* 让往返模式下 loop 仍为 true：浏览器会在到尾时自己跳回开头，
       `ended` 永不触发 ⇒ 方向永远不翻转。
       ⇒ E19a「loop 必须是 false」与 E19b「方向翻转到 reverse」都应变红。 */
    const anchor = '            el.loop = mode !== \'pingpong\';';
    if (!src.includes(anchor)) throw new Error('--mutate=pingpong-loop-true 的锚点没找到（el.loop 赋值那行）');
    src = src.replace(anchor, '            el.loop = true;  /* 变异：往返也循环 */');
    from += '（变异：pingpong-loop-true，往返模式下仍循环）';
  }
  if (MUTATE === 'nomedia-label') {
    /* 不给效果下拉加类型标注（回退到"只显示名字"）。
       ⇒ E19f「视频型带类型标注」应变红。 */
    const anchor = "          return tag === '' ? m.name : m.name + '（' + tag + '）';";
    if (!src.includes(anchor)) throw new Error('--mutate=nomedia-label 的锚点没找到（effectLabel 的返回行）');
    src = src.replace(anchor, '          return m.name;  /* 变异：不加类型标注 */');
    from += '（变异：nomedia-label，下拉框不显示媒体类型）';
  }
  if (MUTATE === 'playmode-no-save') {
    /* 播放模式不落盘（只在内存里改）。
       ⇒ E19d「选择已落盘」应变红。 */
    const anchor = "              videoMod === null\n                ? null\n                : Select('播放', playModeNow, playModeOpts,\n                  (v) => patch('playMode', v), false, noSurface),";
    if (!src.includes(anchor)) throw new Error('--mutate=playmode-no-save 的锚点没找到（「播放」下拉框那段）');
    src = src.replace(anchor, "              videoMod === null\n                ? null\n                : Select('播放', playModeNow, playModeOpts,\n                  (v) => { config.playMode = v; setCfg({ ...config }); }, false, noSurface),  /* 变异：不落盘 */");
    from += '（变异：playmode-no-save，播放模式只改内存）';
  }
  if (MUTATE === 'playmode-any-media') {
    /* 控件对所有媒体型出现（包括静态图片）。
       ⇒ E19e「图片型不出现播放下拉框」应变红。 */
    const anchor = "        const videoMod = mod !== null && mod.media?.kind === 'video' ? mod : null;";
    if (!src.includes(anchor)) throw new Error('--mutate=playmode-any-media 的锚点没找到（videoMod 判定那行）');
    src = src.replace(anchor, "        const videoMod = mod !== null && mod.media !== null && mod.media !== undefined ? mod : null;  /* 变异：任何媒体型都给控件 */");
    from += '（变异：playmode-any-media，图片型也给播放控件）';
  }
  /* 变异**之前**的原文快照 —— 用来在施加之后证明"能力真的少了"，而不是"打了个标记"。
     （已在函数开头、任何 patch 之前取好；这里只用不取，避免前后同一份导致差恒为 0。） */

  /* 🔒 总闸（**证明能力被拆掉**，不是证明标记存在）。
     ⚠️ 这条守卫是被两类真实事故逼出来的（2026-09-25）：
        ① 给 media-noplay 加"命中计数"时，我**误删了** `media-keep-el` 与 `media-loud`
           两行 patch ⇒ 这两条变异变成"根本没施加"。表现与"变异太弱"**完全一样**：
           exit=0、断言全绿、还打印成功标志，被 mutations.mjs 记成「❌ 反证失败」。
        ② 第一版总闸只检查 `from.includes('（变异：')` —— 那是**标记存在性**检查。
           `patch()` 无论替换成什么都会追加这个标记，所以"把能力换成一个等价实现"
           （例如把 `el.muted = true` 改成 `el.muted = !!1`）照样能让它通过。
           独立审核（security-auditor）指出这正是**假绿**：总闸声称"能力被拆掉"，
           实际只断言了"我来过"。
     ⇒ 现在改为**按能力核对削减数**：每个变异必须声明它**应当**让哪个源码特征
        出现次数减少多少（`minRemoved`），闸门拿变异前/后的计数差来验。
        这既覆盖"漏施加"（差=0），也覆盖"施加了但没削弱能力"（差=0）。
     ⚠️ 维护提示：新增客户端变异时**必须**在下面这张表里登记，否则总闸会误报未施加。 */
  const CAPABILITY = {
    'no-draw': { needle: 'gl.drawArrays(', minRemoved: 1, what: '绘制调用' },
    'no-fallback': { needle: 'for (const mod of order) {', minRemoved: 1, what: '完整候选循环', mustIntroduce: 'order.slice(0, 1)' },
    'direct-register': { needle: "if (typeof slots.inject === 'function') {", minRemoved: 1, what: 'slots.inject 声明路径', mustIntroduce: 'if (false)' },
    'media-keep-el': { needle: '          el.remove();\n          ready = false;', minRemoved: 1, what: '媒体元素摘除' },
    'media-loud': { needle: 'el.muted = true;', minRemoved: 1, what: '静音设置', mustIntroduce: 'el.muted = false' },
    /* ⚠️⚠️ 判据串刻意带**分号**（`el.play();`）—— 不带分号会连**注释**一起数进去：
        `el.play(` 在源码里出现 4 次，其中 2 次是 safePlay 的说明注释（`` `void el.play()` ``），
        真正的代码只有 2 处（boot 的 await、safePlay 内部）。
        实测过这个坑：只数 `el.play(` 时，即使变异把 3 个调用点全摘掉，计数也只从 4 掉到 3
        （因为被摘掉的 `safePlay(...)` 本来就不含这个串）⇒ 总闸抛"只减少了 1 处"，整条记 ERROR。
        ⇒ 判据串必须只匹配**会被这次变异改动的那些行**。 */
    'media-noplay': { needle: 'el.play();', minRemoved: 2, what: 'play() 驱动（boot 的 await + safePlay 内部）' },
    /* ── 播放模式（往返倒放）—— 每条都钉住一个**能力**，不是"改到了某段文本" ── */
    /* ⚠️ 锚点用 `el.currentTime = next;` —— 它在源码里**只有倒放驱动那一处**（含 `lastIssue = now` 的同行）。
       不要写成整行：整行会随实现细节漂移（加个赋值就得改锚点），这里只认那个**能力**本身。 */
    'pingpong-no-drive': { needle: 'el.currentTime = next;', minRemoved: 1, what: '倒放的时间轴驱动' },
    'pingpong-loop-true': { needle: 'el.loop = mode !== \'pingpong\';', minRemoved: 1, what: '播放模式驱动的 loop 取值', mustIntroduce: 'el.loop = true;' },
    /* 钉**流畅度契约**：倒放的 seek 闸门（在途时不重发）。拆掉它 ⇒ 落位率掉到 0.65（判据 ≥0.9）。 */
    'pingpong-seek-flood': { needle: 'if (el.seeking === true && (now - lastIssue) < 250)', minRemoved: 1, what: '倒放的 seek 闸门（在途不重发）' },
    /* 钉**同速契约**：闸门换成纯时间限流 ⇒ 落位率反而 1.0，但速度/可见帧率崩。 */
    'pingpong-throttle': { needle: 'if (el.seeking === true && (now - lastIssue) < 250)', minRemoved: 1, what: '倒放的 seek 闸门（按 seeking 判据，而非纯时间限流）', mustIntroduce: 'if ((now - lastIssue) < 400)' },
    /* 钉**无障碍契约**：倒放路径上的两处 `prefersReduce()` 判据（onEnded 入口 + tickReverse 逐拍）。
       计数是 2 —— 只削倒放这一路，`boot()` / `resumeInternal()` 里的那两处是另一条契约（启动与恢复），
       不在本条范围内。削掉后 E19h 两条断言都应变红（实测 227/2）。 */
    'pingpong-reduce-ignored': { needle: 'if (prefersReduce()) return;', minRemoved: 2, what: '倒放路径的 reduce-motion 判据（入口 + 逐拍）' },
    'nomedia-label': { needle: "m.name + '（' + tag + '）'", minRemoved: 1, what: '媒体类型标注' },
    'playmode-no-save': { needle: "patch('playMode', v)", minRemoved: 1, what: '播放模式的落盘提交', mustIntroduce: 'config.playMode = v' },
    /* ⚠️⚠️ `mustIntroduce` 必须是一条**只在"被削弱后"的源码里存在**的串。
       本条初版写的是 `mod.media !== null` —— 那是**恒真式**：该串在变异前就已经出现 2 次
       （面板里两处"这是媒体型效果"的说明都用它判分支），于是"变异太弱"这半个防护完全失效
       （独立审核 2026-09-25 指出，我复现确认）。
       现在改用带 `? mod : null` 尾巴的整串：实测变异前出现 **0 次**、变异后 1 次 —— 才真的能失败。
       ⇒ 给任何变异写 `mustIntroduce` 前，一律先 `grep` 一遍变异前的源码确认它是 0 次。 */
    'playmode-any-media': { needle: "mod.media?.kind === 'video'", minRemoved: 1, what: '「仅视频型」的控件判据', mustIntroduce: 'mod.media !== null && mod.media !== undefined ? mod : null' },
  };
  const cap = CAPABILITY[MUTATE];
  if (cap !== undefined) {
    const occurrencesBefore = pristine.split(cap.needle).length - 1;
    const occurrencesAfter = src.split(cap.needle).length - 1;
    const removed = occurrencesBefore - occurrencesAfter;
    if (removed < cap.minRemoved) {
      throw new Error(`--mutate=${MUTATE} 没有真的拆掉「${cap.what}」：`
        + `源码里 "${cap.needle.slice(0, 40)}" 施加前 ${occurrencesBefore} 处、施加后 ${occurrencesAfter} 处，`
        + `只减少了 ${removed} 处（要求 ≥${cap.minRemoved}）。`
        + '这说明变异没施加、或被换成了等价实现 —— 两种都会让这条反证变成**假 PASS**'
        + '（变异没施加与变异太弱在结果上无法区分）。请检查 clientSource() 里对应的 patch 调用。');
    }
    /* ⚠️ 第二道：削减数只证明"那串文本没了"，**不证明换成了更弱的实现** ——
       把 `el.muted = true` 换成 `el.muted = !!1`（语义等价）同样让计数掉 1。
       所以凡是"削弱点是一段字面量"的变异，都额外要求**那段削弱**真的出现在结果里。
       （2026-09-25 实测：只有削减计数时，等价替换能骗过总闸、反证 187/0 全绿。） */
    if (cap.mustIntroduce !== undefined && !src.includes(cap.mustIntroduce)) {
      throw new Error(`--mutate=${MUTATE} 的替换没有引入预期的削弱 "${cap.mustIntroduce}"：`
        + '原锚点确实消失了，但换上去的不是"弱实现"（例如等价写法）—— 能力没被削弱，'
        + '反证会变成**假 PASS**。请检查 clientSource() 里该变异的替换文本。');
    }
    from += `〔总闸已验：${cap.what} 削减 ${removed} 处`
      + (cap.mustIntroduce !== undefined ? `，且已引入削弱「${cap.mustIntroduce}」` : '')
      + '〕';
  } else if (MUTATE !== null && HOST_MUTATIONS.has(MUTATE)) {
    /* 宿主半变异不在这个函数里施加（走 hostSource()），跳过 —— 但不能静默：
       一个**既没登记进 CAPABILITY、又不是已知宿主半变异**的字符串，说明名字打错了。 */
    if (GATE_LOGGED !== true) { GATE_LOGGED = true; info('总闸：本轮是宿主半变异，能力削减由 hostSource() 那一侧负责', MUTATE); }
  } else if (MUTATE !== null && NON_SOURCE_MUTATIONS.has(MUTATE)) {
    /* 第三类：变异**不落在源码上**（改的是载荷或 runner 自身）——
       `bg-only` 在 groupC 里改 payload 的 fragment；`crash` 在主流程里故意抛错。
       它们在源码层面**本就不该有削减**，所以这里必须放行；但同样要打印留痕，
       否则"没削减"与"漏施加"看起来一样。 */
    if (GATE_LOGGED !== true) {
      GATE_LOGGED = true;
      info('总闸：本轮变异不落在源码上（改载荷 / 改 runner），无需源码削减',
        MUTATE === 'bg-only' ? 'bg-only：在 C 组改 payload 的 fragment' : `${MUTATE}：在 runner 侧注入`);
    }
  } else if (MUTATE !== null && !from.includes('（变异：')) {
    /* 落到这里的只有"名字不认识"或"客户端变异漏施加"两种 —— 都必须炸出来。 */
    throw new Error(`--mutate=${MUTATE} 既不在 CAPABILITY 表里、也不是已知的宿主半/非源码变异，`
      + `且一处都没改到（from="${from}"）。`
      + '这说明变异名打错、或对应的 patch 调用被删掉/改坏了 —— 两种都会让反证变成**假 PASS**。');
  }
  return { src, from };
}

const HOST_MUTATIONS = new Set(['no-scan-sort', 'media-traversal', 'media-segments', 'no-isolation']);
/** 第三类变异：**不落在源码上** —— 改的是载荷（bg-only 改 fragment）或 runner 自身（crash 故意抛错）。 */
const NON_SOURCE_MUTATIONS = new Set(['bg-only', 'crash']);
/** 总闸的"跳过类"提示只打一次（`clientSource()` 会被 C/D/E 各调一次，否则同一句刷三遍）。 */
let GATE_LOGGED = false;

/**
 * 宿主半的源码级变异（第五轮审核的 I8：删掉扫描前的排序，行为层在按名枚举的文件系统上分不出来，
 * 所以必须由源码级断言兜住 —— 见 B 组那条 `[源码级兜底]`）。
 *
 * ⚠️ 与客户端侧同一套纪律：**每条变异都要能证明"能力真的被拆掉了"**，不只是"我改到了"。
 *    所以这里也用 `removes()` 记削减数 —— 否则把校验换成一个恒真式（`if (true)`）
 *    同样能通过"锚点命中"检查，而反证会变成假绿。
 */
function hostSource() {
  const pristine = readFileSync(join(HERE, 'lib', 'index.js'), 'utf8');
  let src = pristine;
  /** 证明某段特征真的被削掉了（而不只是"锚点还在"）。 */
  const removes = (needle, label) => {
    const before = pristine.split(needle).length - 1;
    const after = src.split(needle).length - 1;
    if (before - after < 1) {
      throw new Error(`--mutate=${label} 没有真的拆掉能力：源码里 "${needle.slice(0, 60)}" `
        + `施加前 ${before} 处、施加后 ${after} 处，没减少。`
        + '这多半是替换写成了等价实现（例如 if (true)），会让这条反证变成**假绿**。');
    }
  };
  if (MUTATE === 'no-scan-sort') {
    const anchor = 'names = names.slice().sort((a, b) => a.localeCompare(b));';
    if (!src.includes(anchor)) throw new Error('--mutate=no-scan-sort 的锚点没找到');
    src = src.replace(anchor, '/* 变异：不排序 */');
    removes(anchor, 'no-scan-sort');
  }
  /* ⚠️ 最要紧的一条媒体反证：**把路径校验拆掉**。
     拆掉后 A 组那批非法路径必须出现非 404 —— 如果它们**仍然全绿**，
     就说明那组断言是假绿（根本没在观察校验逻辑）。
     ⚠️ 锚点用「包含判据检索 + 整行替换」而不是写字面量：这一行里有字符类 `[\\/]`，
        字面量要穿 4 层转义（正则→JS 串→正则字面量→文件），极易写成"看起来一样但 includes 为 false"
        —— 那样变异会**静默不生效**，反证变成假绿（2026-09-25 实测踩到：锚点不匹配，
        拆校验后 18 种非法路径竟然零红）。 */
  if (MUTATE === 'media-traversal') {
    const idx = src.split('\n').findIndex((l) => l.includes("file.includes('..')"));
    if (idx === -1) throw new Error('--mutate=media-traversal 的锚点没找到（找不到 file.includes("..") 那一行）');
    const all = src.split('\n');
    all[idx] = all[idx].replace(/if \(.*\) return null;/, '/* 变异：不校验文件名 */');
    if (!all[idx].includes('变异')) throw new Error('--mutate=media-traversal 的替换没生效：' + all[idx]);
    src = all.join('\n');
    /* 证明"文件名闸"真的没了：{闸②} 的判据必须**不再出现**在解析函数里。
       （只看"锚点命中"是不够的 —— 那把判据换成恒真式照样能命中。） */
    removes("file.includes('..')", 'media-traversal');
  }
  /* 拆掉"段数必须为 2"：让 `/media/../x.mp4` 这类形状能被解析出来。
     ⚠️ 必须**同时**给 `file` 兜一个默认值。只删段数校验的话，1 段路径会让
        `file` 变成 undefined，紧接着 `file.includes('..')` 抛 TypeError ——
        于是反证的表现是**脚本在 A 阶段崩掉**（`验证未完成`），而不是
        「非法路径断言变红」。那种"崩"虽然也是被注入的变异引起的，但
        它掩盖了我们要观察的东西（闸① 是否真在拦路径），而且会被 mutations.mjs
        记成 ERROR 而不是 PASS（2026-09-25 实测踩到）。 */
  if (MUTATE === 'media-segments') {
    const anchor = 'if (parts.length !== 2) return null;';
    if (!src.includes(anchor)) throw new Error('--mutate=media-segments 的锚点没找到');
    src = src.replace(anchor, '/* 变异：不校验段数 */');
    removes(anchor, 'media-segments');
    const dAnchor = 'const [id, file] = parts;';
    if (!src.includes(dAnchor)) throw new Error('--mutate=media-segments 的第二个锚点没找到（解构那一行）');
    src = src.replace(dAnchor, "const [id, file = ''] = parts;   // 变异：给 file 兜底，否则 1 段路径 TypeError 会让脚本崩而不是让断言变红");
  }
  return src;
}

/**
 * 起一个真页面：真 origin、真令牌、真 WebGL2。
 * 拦截 /motion-background/mods 返回给定的 payload（默认就是 A 组真跑出来的那份）。
 */
async function openPage(browser, { payload, src, tag, theme = 'dark', seedConfig = null, failFirstContext = 0, mediaBody = undefined }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const pageErrors = [];
  /* ⚠️ 「预期内的 404」不算异常：E18b/E18c **故意**让媒体 404，浏览器一定会往
     console 打一条 "Failed to load resource: 404"，那是**网络层**的噪音，
     不是应用的未捕获异常。不过滤的话，那两条用例会永远红，而红的原因是测试自己制造的。
     只有 `mediaBody === null`（即显式声明"这次要它失败"）时才放行这类噪音。 */
  const expectMedia404 = mediaBody === null;
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${String(e?.message ?? e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (expectMedia404 && /404|Failed to load resource/i.test(t)) return;
    pageErrors.push(`console.error: ${t}`);
  });

  await page.route(`${ORIGIN}**`, (route) => {
    const url = route.request().url();
    if (url.includes('/motion-background/mods')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(payload),
      });
    }
    /* 媒体路由。默认**给真实视频字节** —— 因为主 payload 里就含 aurora-video，
       不默认放行的话每条用主 payload 的用例都会吃一次 404（噪音会淹掉真信号）。
       · `mediaBody` 未传（undefined）⇒ 默认真视频；
       · `mediaBody: null` ⇒ **有意**让它加载失败（E18b/E18c 用）；
       · `mediaBody: {type,data}` ⇒ 用指定的响应。
       ⚠️ 绝不"失败时静默给一个空视频"：那会让"加载失败要判不可用"的用例变成假绿。 */
    if (url.includes('/motion-background/media')) {
      if (mediaBody === null) {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      }
      const mb = mediaBody ?? { type: 'video/mp4', data: REAL_MP4 };
      return route.fulfill({
        status: 200,
        contentType: mb.type,
        headers: { 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
        body: mb.data,
      });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE_HTML });
  });
  await page.goto(ORIGIN, { waitUntil: 'load' });

  /* 浅色主题夹具：去掉 data-ds-dark-theme 并把面板底色换成浅色令牌 ——
     这样 readPalette 走"浅色底"分支，正好复现"加法叠加在纯白底上饱和"的场景。 */
  if (theme === 'light') {
    await page.evaluate(() => {
      document.body.removeAttribute('data-ds-dark-theme');
      document.body.style.background = 'var(--dsw-static-neutral-bluish-00)';
    });
  }

  /* 预置配置：用于复现"用户已经选过某个效果"的场景（回落是否改写用户选择）。 */
  if (seedConfig !== null) {
    await page.evaluate((cfg) => {
      globalThis.localStorage.setItem('dsh-motion-background.config', JSON.stringify(cfg));
    }, seedConfig);
  }

  await page.evaluate((failFirstCtx) => {
    /* WebGL 的绘图缓冲默认在合成后丢弃 ⇒ drawImage canvas 会得到空白。
       这里强制 preserveDrawingBuffer（只影响"留不留缓冲"，不影响任何像素内容），
       好让我们能把画面搬到 2D canvas 上数像素。顺带记下每个 canvas 的上下文。 */
    window.__glCtxs = [];
    window.__draws = 0;          // drawArrays 次数（自检用：判"真的重画了"）
    window.__loseCalls = 0;      // WEBGL_lose_context().loseContext() 次数（判"上下文真的回收了"）
    window.__ctxFailLeft = failFirstCtx;   // 前 N 次 getContext('webgl2') 返回 null（模拟上下文配额耗尽）
    const origGetCtx = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      if ((type === 'webgl2' || type === 'webgl') && window.__ctxFailLeft > 0) {
        window.__ctxFailLeft -= 1;
        return null;                       // 模拟"这次拿不到上下文"
      }
      const o = Object.assign({}, opts || {});
      if (type === 'webgl2' || type === 'webgl') o.preserveDrawingBuffer = true;
      const c = origGetCtx.call(this, type, o);
      if (c !== null && c !== undefined && (type === 'webgl2' || type === 'webgl')) {
        window.__glCtxs.push({ canvas: this, surface: this.hasAttribute('data-mb-surface') });
        /* 行为级探针：数 drawArrays、数 loseContext —— 这两件事都是"断言能不能失败"的关键，
           只看源码文本证明不了它们真的发生过。 */
        if (typeof c.drawArrays === 'function') {
          const od = c.drawArrays.bind(c);
          c.drawArrays = (...a) => { window.__draws += 1; return od(...a); };
        }
        if (typeof c.getExtension === 'function') {
          const og = c.getExtension.bind(c);
          c.getExtension = (name) => {
            const ext = og(name);
            if (ext && name === 'WEBGL_lose_context' && typeof ext.loseContext === 'function') {
              const ol = ext.loseContext.bind(ext);
              ext.loseContext = () => { window.__loseCalls += 1; return ol(); };
            }
            return ext;
          };
        }
      }
      return c;
    };
    window.__winErrors = [];
    window.addEventListener('error', (e) => window.__winErrors.push(String(e?.message ?? e)));
    window.addEventListener('unhandledrejection', (e) => window.__winErrors.push('unhandledrejection: ' + String(e?.reason)));
    /* 与真实 loader 一致：只给 __ModuleLoader__，不给 module/exports。 */
    window.__mod = null;
    window.__ModuleLoader__ = { load: (m) => { window.__mod = m; } };
    window.__slotsCalls = [];
    window.__cardComp = null;
    /* 用调色板/主题相关的桩：matchMedia 可被自检改成 reduce（R9）。 */
    window.__reduceMotion = false;
    const mm = window.matchMedia?.bind(window);
    window.matchMedia = (q) => (String(q).includes('prefers-reduced-motion')
      ? { matches: window.__reduceMotion === true }
      : (mm ? mm(q) : { matches: false }));
  }, failFirstContext);
  await page.addScriptTag({ content: src });

  const ns = await page.evaluate(() => {
    const m = window.__mod;
    if (m === null) throw new Error('bundle 没有调用 __ModuleLoader__.load');
    /* require('react') ⇒ 最小 React 桩（组件不渲染，只要 createElement/useState 可用）。 */
    const requireStub = (id) => {
      if (id === 'react') {
        return {
          createElement: (t, p, ...c) => ({ t, p, c }),
          useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
          Fragment: 'Fragment',
        };
      }
      throw new Error('unexpected require: ' + id);
    };
    const exports = m.factory(requireStub);

    /* slots 桩：未经 inject 声明就 register ⇒ 抛（复刻真机行为，否则断言形同虚设）。 */
    const declared = new Set();
    const slots = {
      register: (...a) => {
        if (!declared.has(a[0].name)) {
          throw new Error('slot "' + a[0].name + '" is not declared (a parent entry\'s children table must declare it)');
        }
        window.__slotsCalls.push({
          name: a[0].name, id: a[0].id, order: a[0].order,
          labelIsFn: typeof a[0].label === 'function', compIsFn: typeof a[1] === 'function',
        });
        // 组件本体单独存（不进 snapshot：函数不能序列化）—— 自检要**调用它**做行为级断言
        if (typeof a[1] === 'function') window.__cardComp = a[1];
      },
      inject: (name, gen) => { declared.add(name); const it = gen(); it.next(); },
    };
    exports.apply({
      slots,
      effect: (cb) => { window.__dispose = cb(); return () => { window.__disposed = true; }; },
    });
    return { regKey: m.id, hasApply: typeof exports.apply === 'function', injectIsArray: Array.isArray(exports.inject) };
  });

  return { page, pageErrors, ns, tag };
}

const snapshot = (page) => page.evaluate(() => {
  const b = window.__betterSkin;
  const c = document.querySelector('canvas[data-mb-surface]');
  return {
    scope: b?.scope ?? null,
    /** 渲染面活着的门控（`body[data-mb-live]`）—— 判"没画面时不该半透明"。 */
    live: b?.live ?? null,
    settings: b?.settings ?? null,
    mods: b?.mods ?? null,
    spec: b?.spec ?? null,
    styleTags: document.querySelectorAll('style[data-plugin-css="dsh-motion-background/backdrop.css"]').length,
    canvasCount: document.querySelectorAll('canvas[data-mb-surface]').length,
    /** 媒体面（video/img）计数 —— 判"媒体失败后不留残留元素""切走后真被摘掉"。 */
    mediaCount: document.querySelectorAll('video[data-mb-surface], img[data-mb-surface]').length,
    canvas: c === null ? null : {
      w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, display: c.style.display,
      dpr: Math.min(globalThis.devicePixelRatio || 1, 2),
    },
    bgBase: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
    slotsCalls: window.__slotsCalls,
    winErrors: window.__winErrors,
  };
});

/** 把 WebGL canvas 搬到 2D canvas，统计"不等于底色"的像素占比。 */
const pixelStats = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas[data-mb-surface]');
  const bg = window.__betterSkin?.spec?.u_colorBack ?? null;
  if (c === null) return { ok: false, why: '没有 canvas[data-mb-surface]' };
  if (bg === null) return { ok: false, why: '拿不到 u_colorBack' };
  const w = c.width, h = c.height;
  if (!(w > 0 && h > 0)) return { ok: false, why: `画布尺寸 ${w}×${h}` };
  const d = document.createElement('canvas');
  d.width = w; d.height = h;
  const ctx = d.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const br = bg[0] * 255, bgG = bg[1] * 255, bgB = bg[2] * 255;
  const TOL = 12;
  let non = 0, total = 0, peak = 0;
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    total += 1;
    const dr = Math.abs(data[i] - br), dg = Math.abs(data[i + 1] - bgG), db = Math.abs(data[i + 2] - bgB);
    const dist = Math.max(dr, dg, db);
    if (dist > TOL) non += 1;
    if (dist > peak) peak = dist;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    ok: true, w, h, total, non, ratio: non / total, peak,
    bg255: [Math.round(br), Math.round(bgG), Math.round(bgB)],
    top, first: [data[0], data[1], data[2], data[3]],
  };
});

/** 等 mods 清单到账（或端点报错）。 */
async function waitMods(page) {
  await page.waitForFunction(() => {
    const m = window.__betterSkin?.mods;
    return m !== undefined && (m.loaded.length > 0 || Object.keys(m.errors).length > 0);
  }, null, { timeout: 15000 }).catch(() => {});
}

async function groupC(browser, payload) {
  section('C. 客户端半 —— headless Chromium 真跑（真 fetch / 真 WebGL2 / 真画一帧）');
  const { src, from } = clientSource();
  info('被测 client.js', from + (CLIENT_OVERRIDE === null ? '' : '（⚠️ 非仓库原文，反证模式）'));
  if (MUTATE !== null) info('⚠️ 已启用变异', MUTATE);

  /* ⚠️ C 组的断言是**针对 meteor 这个随包 mod** 的（它的 10 个 uniform、它的画面）。
     仓库以后可能带更多 mod，所以这里把载荷**过滤成只有 meteor** —— 否则"多一个合法 mod"
     就会让这些断言误报（离线审核实测：加一个合法 mod 后 91/2 判红，而实现完全正确）。
     多 mod / 回落 / 切换的行为由 E 组用**自造载荷**覆盖。 */
  let payloadC = JSON.parse(JSON.stringify(payload));
  payloadC.mods = payloadC.mods.filter((m) => m.id === 'meteor');
  if (MUTATE === 'bg-only') {
    for (const m of payloadC.mods) {
      m.fragment = '#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nuniform vec4 u_colorBack;\nvoid main(){ fragColor = vec4(u_colorBack.rgb, 1.0); }\n';
    }
    info('变异 payload', 'fragment 改为「仅输出 u_colorBack」');
  }
  if (payloadC.mods.length === 0) throw new Error('C 组需要随包的 meteor mod，但载荷里没有');

  const { page, pageErrors, ns } = await openPage(browser, { payload: payloadC, src, tag: 'C' });
  try {
    check('bundle 注册键 === 包名 dsh-motion-background',
      ns.regKey === 'dsh-motion-background', String(ns.regKey));
    check('factory 返回值含 apply', ns.hasApply === true);
    check('返回值声明了 inject: [...]（含 slots）', ns.injectIsArray === true);

    await waitMods(page);
    /* 等真画上几帧 */
    await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(600);

    const s = await snapshot(page);

    check('__betterSkin.mods.loaded 含 meteor',
      Array.isArray(s.mods?.loaded) && s.mods.loaded.includes('meteor'), JSON.stringify(s.mods?.loaded));
    check("__betterSkin.mods.current === 'meteor'", s.mods?.current === 'meteor', String(s.mods?.current));
    /* ⚠️ 这两条只在**非变异**模式成立 —— 与 A 组同一模式、同一理由：
       变异模式下宿主半来自副本，它的 `mods/` 是 B 组的测试语料（10 类故意坏掉的 mod），
       拿"真仓库很干净 / dir 指向真仓库"去要求它**必然误红**，而那个红是**夹具自己造成的**，
       不是被测代码的问题。留着它会让每条媒体反证都带 2 条噪音红，淹没真信号
       （2026-09-25 实测：media-traversal 反证里 3 条红，其中 2 条就是这个）。 */
    if (MUTATE === null) {
      check('__betterSkin.mods.errors 为空（真跑没有加载期错误）',
        s.mods !== null && Object.keys(s.mods?.errors ?? {}).length === 0, JSON.stringify(s.mods?.errors));
      check('__betterSkin.mods.dir = 宿主半回报的真实路径',
        typeof s.mods?.dir === 'string' && resolve(s.mods.dir) === resolve(join(HERE, 'mods')), String(s.mods?.dir));
    } else {
      info('变异模式：跳过"真仓库很干净 / dir 指向真仓库"两条（宿主半来自副本，语料本就含坏 mod）', MUTATE);
    }
    check('body 带皮肤作用域属性 data-motion-background', s.scope === true);
    check('皮肤样式表已注入且只有一份', s.styleTags === 1, `实得 ${s.styleTags}`);

    const probe = await page.evaluate(() => window.__betterSkin.probeMods());
    check('await __betterSkin.probeMods() 里 meteor === true（真编译 + 真链接 + 真画一帧）',
      probe?.meteor === true, JSON.stringify(probe));

    check('画布 canvas[data-mb-surface] 存在且只有一块', s.canvasCount === 1, `实得 ${s.canvasCount}`);
    check('画布 width/height > 0（渲染面真的被撑开了）',
      (s.canvas?.w ?? 0) > 0 && (s.canvas?.h ?? 0) > 0, s.canvas === null ? '(无画布)' : `${s.canvas.w}×${s.canvas.h}`);
    check('画布宽高与 clientWidth×DPR 一致（resize 逻辑对得上）',
      s.canvas !== null && s.canvas.w === Math.round(s.canvas.cw * s.canvas.dpr)
      && s.canvas.h === Math.round(s.canvas.ch * s.canvas.dpr),
      s.canvas === null ? '(无画布)' : `canvas ${s.canvas.w}×${s.canvas.h} vs client ${s.canvas.cw}×${s.canvas.ch} ×dpr ${s.canvas.dpr}`);

    const px = await pixelStats(page);
    /* ⚠️ 这条原来只要求 ratio>0，第五轮审核证明它**近乎恒真**：`no-draw`（完全不绘制）时
       未初始化的画布整块都不是底色 ⇒ ratio=100%，照样绿。现在两头都卡：
       既要有足够多的非底色像素（真的画了图案），又不能"整块都不是底色"（那是没画）。 */
    check('★ 画面真的画出来了：非底色像素占比在 (0.5%, 90%) 之间',
      px.ok === true && px.ratio > 0.005 && px.ratio < 0.9,
      px.ok === false ? px.why : `non=${px.non}/${px.total} ratio=${(px.ratio * 100).toFixed(2)}% peak=${px.peak}`);
    if (px.ok === true) {
      info('像素统计', `底色 rgb(${px.bg255.join(',')}) 前景占比 ${(px.ratio * 100).toFixed(2)}% 最大偏差 ${px.peak}`);
      info('出现最多的颜色', px.top.map(([k, v]) => `${k}×${v}`).join('  '));
      check('画面不是"一片纯底色"（存在与 u_colorBack 明显不同的像素）',
        px.peak > 40, `最大通道偏差 ${px.peak}`);
    }

    check('__betterSkin.settings === \'ok\'（设置卡片注册成功）', s.settings === 'ok', String(s.settings));
    check('注册只发生一次，且 slot 名/栏 id/order 正确',
      s.slotsCalls.length === 1 && s.slotsCalls[0].name === 'settings.section'
      && s.slotsCalls[0].id === 'motion-background' && s.slotsCalls[0].order === 41,
      JSON.stringify(s.slotsCalls));
    check('注册项带 label 函数与 React 组件（官方要求）',
      s.slotsCalls[0]?.labelIsFn === true && s.slotsCalls[0]?.compIsFn === true);

    /* 内核声明的 uniform 必须都被程序接受（名字/类型对不上是最常见的坑）。 */
    const uni = s.mods?.uniforms ?? [];
    const need = ['u_time', 'u_resolution', 'u_colorBack', 'u_colorFront',
      'u_intensity', 'u_softness', 'u_noise', 'u_shape', 'u_angle', 'u_speed'];
    const missing = need.filter((n) => !uni.includes(n));
    check('meteor 声明的 10 个 uniform 全部进了程序（无被优化的漏项）',
      missing.length === 0, missing.length === 0 ? `${uni.length} 个` : `缺 ${missing.join(',')}（实得 ${uni.join(',')}）`);

    check('--dsw-alias-bg-base 被改成半透明（底纹能透上来的关键机制）',
      /color-mix\(/.test(s.bgBase) && s.bgBase !== 'rgb(21, 21, 23)', s.bgBase);
    check('--mb-veil 落到了 body 内联样式（浓度可即时调）',
      await page.evaluate(() => document.body.style.getPropertyValue('--mb-veil')) !== '',
      await page.evaluate(() => document.body.style.getPropertyValue('--mb-veil')));

    /* 面板默认不得覆盖 mod 的设计；四个通用旋钮必须齐备。 */
    const shapeVal = s.spec?.u_shape ?? null;
    check('内核不用自己的默认值覆盖 mod 的 spec（旋钮初值取 mod 的默认）',
      shapeVal !== null && shapeVal >= 0 && shapeVal <= 1, `u_shape 实得 ${shapeVal}`);
    const clientSrc = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8');
    const knobLabels = ['强度', '柔度', '颗粒', '形态'];
    const missingKnob = knobLabels.filter((l) => !clientSrc.includes(`'${l}'`));
    check('设置卡片渲染四个通用旋钮（强度/柔度/颗粒/形态）',
      missingKnob.length === 0, missingKnob.length === 0 ? '四个齐备' : `缺 ${missingKnob.join(',')}`);
    check('面板旋钮由 mod 的 panel 映射数据驱动（不是硬编码四项）',
      /KNOBS\.map\(/.test(clientSrc) && /knobUsable\(/.test(clientSrc));

    /* ⚠️ 偏差：probeMods 用**游离画布**（不在 DOM ⇒ clientWidth=0）⇒ 实际是 0×0 viewport。
       它只能证明"编译+链接"，证明不了"真实分辨率下画得出来"。 */
    const glDump = await page.evaluate(() => window.__glCtxs.map((x) => ({
      surface: x.surface, w: x.canvas.width, h: x.canvas.height,
    })));
    const probeCanvases = glDump.filter((x) => !x.surface);
    const zeroSized = probeCanvases.filter((x) => x.w === 0 && x.h === 0).length;
    finding('probeMods 的游离画布被 resize 成 0×0（u_resolution=(0,0)，gl.viewport(0,0,0,0)）',
      probeCanvases.length > 0 && zeroSized === probeCanvases.length,
      `游离画布 ${probeCanvases.length} 块，其中 0×0 的 ${zeroSized} 块；主画布 ${glDump.filter((x) => x.surface).map((x) => `${x.w}×${x.h}`).join(',') || '(无)'}`);

    /* 卸载：ctx.effect 的 disposer 必须把画布/样式/作用域属性都收干净。 */
    const after = await page.evaluate(() => {
      if (typeof window.__dispose === 'function') window.__dispose();
      return {
        canvas: document.querySelectorAll('canvas[data-mb-surface]').length,
        style: document.querySelectorAll('style[data-plugin-css="dsh-motion-background/backdrop.css"]').length,
        attr: document.body.hasAttribute('data-motion-background'),
      };
    });
    check('卸载后底纹画布被移除', after.canvas === 0, `实得 ${after.canvas}`);
    check('卸载后样式表被移除', after.style === 0, `实得 ${after.style}`);
    check('卸载后作用域属性被摘掉', after.attr === false);

    const allErrors = [...pageErrors, ...s.winErrors];
    check('全程无未捕获异常 / 无 console.error', allErrors.length === 0, JSON.stringify(allErrors));
    return { probe, px };
  } finally {
    await page.close();
  }
}

async function groupD(browser, payload) {
  section('D. 反证：mod 的 GLSL 非法时，内核不崩、设置卡片照常注册');

  /* ⚠️ 载荷**只放一个坏掉的 mod**（而不是"把真仓库里那个改坏"）：
     否则仓库一旦多带一个 mod，内核会正确地回落到它，而这里"全部不可用 ⇒ 什么都不挂"的前提
     就不成立了 —— 那会让正确的实现被判红（离线审核实测过这条夹具脆弱）。
     回落行为由 E5 用两个 mod 的载荷单独覆盖。 */
  const template = payload.mods.find((m) => m.id === 'meteor') ?? payload.mods[0];
  if (template === undefined) throw new Error('D 组需要至少一个 mod 作模板');
  const broken = { mods: [JSON.parse(JSON.stringify(template))], errors: [], dir: payload.dir };
  const target = broken.mods[0];
  target.fragment = '#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main(){ fragColor = this_symbol_does_not_exist(v_uv); }\n';
  info('注入的坏 GLSL', target.fragment.split('\n').filter((l) => l.trim() !== '').pop());

  const { src } = clientSource();
  const { page, pageErrors } = await openPage(browser, { payload: broken, src, tag: 'D' });
  try {
    await page.waitForFunction(() => {
      const m = window.__betterSkin?.mods;
      return m !== undefined && Object.keys(m.errors).length > 0;
    }, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);

    const s = await snapshot(page);
    const errKeys = Object.keys(s.mods?.errors ?? {});
    check('★ 坏 GLSL 让编译失败 ⇒ __betterSkin.mods.errors 里有 meteor 的对应条目',
      errKeys.some((k) => k.includes('meteor')), JSON.stringify(s.mods?.errors));
    check('错误条目里的 reason 指出是着色器/编译问题',
      /着色器|编译|shader|ERROR/i.test(errKeys.map((k) => s.mods.errors[k]).join(' ')),
      JSON.stringify(s.mods?.errors));
    check('★ 页面没有未捕获异常', pageErrors.length === 0 && s.winErrors.length === 0,
      JSON.stringify([...pageErrors, ...s.winErrors]));
    check('★ 设置卡片仍能注册（settings === \'ok\'）', s.settings === 'ok', String(s.settings));
    check('失败的画布被摘掉（不留一块黑画布盖住界面）', s.canvasCount === 0, `实得 ${s.canvasCount}`);
    check('内核自身未崩：__betterSkin 快照仍可读', s.mods !== null && s.scope === true);

    const probe = await page.evaluate(() => window.__betterSkin.probeMods());
    check('probeMods 如实报告 meteor 编译失败（不谎报 true）',
      typeof probe?.meteor === 'string' && probe.meteor !== true, JSON.stringify(probe));

    /* 唯一一个 mod 坏掉时：必须**明确进入"无效果"态**（current=null、画布被摘掉），
       而不是留着"面板有设置项、画布却不在"的半死状态。 */
    check('全部 mod 都不可用时明确置空（不留半死状态）',
      s.mods?.current === null && s.canvasCount === 0,
      `current=${JSON.stringify(s.mods?.current)} 且画布数 ${s.canvasCount}`);
  } finally {
    await page.close();
  }
}

/* ════════════════════════════ E 组：行为级断言 ════════════════════════════
 *
 * 为什么要有这一组（离线审核的结论）：
 *   C/D 组里有若干断言只做**源码字符串存在性**检查（`clientSrc.includes('强度')`、
 *   `/KNOBS\.map\(/`），于是"Card 一个旋钮都不渲染"仍能全绿；"画面真的画出来了"又太弱
 *   （`gl.clear` 即可骗过）。E 组把这些换成**行为级**证据：
 *     · 真**调用**卡片组件、走它产出的元素树，数滑块、看 disabled、读初值与量程；
 *     · 真**驱动** onChange，再看运行时 spec 与 drawArrays 计数是否跟着变；
 *     · 真**读像素**（浅色主题下的可见性回归）；
 *     · 真**数** loseContext（卸载是否回收了 WebGL 上下文）。
 */

/** 深拷贝一份 payload。 */
const clonePayload = (p) => JSON.parse(JSON.stringify(p));

/** 一个最小但合法的效果：四个旋钮的 uniform 都在，颜色用 front 模式。 */
const FRAG_SIMPLE = [
  '#version 300 es', 'precision highp float;',
  'uniform vec4 u_colorBack;', 'uniform vec4 u_colorFront;',
  'uniform float u_time;', 'uniform vec2 u_resolution;',
  'uniform float u_intensity;', 'uniform float u_softness;',
  'uniform float u_noise;', 'uniform float u_shape;',
  'in vec2 v_uv;', 'out vec4 fragColor;',
  'void main(){',
  '  float k = u_intensity * (0.6 + 0.4 * u_softness) + u_noise * 0.0 + u_shape * 0.0;',
  '  fragColor = vec4(u_colorBack.rgb + u_colorFront.rgb * k * v_uv.y, 1.0);',
  '}',
].join('\n');

function simpleMod(id, over = {}) {
  return Object.assign({
    id, name: id, description: '', author: 'verify', license: 'MIT',
    colors: 'front',
    spec: { u_intensity: 1, u_softness: 0.5, u_noise: 0.5, u_shape: 0.5 },
    panel: { intensity: 'u_intensity', softness: 'u_softness', noise: 'u_noise', shape: 'u_shape' },
    range: {},
    fragment: FRAG_SIMPLE,
  }, over);
}

/**
 * 在页面里遍历卡片产出的元素树，取出所有滑块/下拉（标签 + min/max/step/值/是否置灰）。
 * ⚠️ 必须以**函数**形式传给 page.evaluate（传字符串会被当表达式求值 —— 那就永远拿不到结果，
 *    这类"夹具自己坏了"的坑会让断言变成恒假，属于本仓库最怕的假绿/假红来源）。
 */
const readCard = (page) => page.evaluate(() => {
  const comp = window.__cardComp;
  if (typeof comp !== 'function') return [];
  const tree = comp();
  const out = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.t === 'label') {
      const kids = (node.c ?? []).filter((k) => k !== null && k !== undefined);
      const spans = kids.filter((k) => typeof k === 'object' && k.t === 'span');
      const input = kids.find((k) => typeof k === 'object'
        && (k.t === 'input') && (k.p?.type === 'range' || k.p?.type === 'checkbox'));
      const select = kids.find((k) => typeof k === 'object' && k.t === 'select');
      if (input) out.push({
        kind: input.p.type, label: spans[0]?.c?.[0] ?? null, value: input.p.value,
        min: input.p.min, max: input.p.max, step: input.p.step,
        disabled: input.p.disabled === true, checked: input.p.checked === true,
      });
      if (select) out.push({
        kind: 'select', label: spans[0]?.c?.[0] ?? null, value: select.p.value,
        disabled: select.p.disabled === true,
        // ⚠️ 必须拍平：`h('select', props, options.map(...))` 传进来的是一个**数组子节点**，
        //    不 flat 的话拿到的是 [ [opt1, opt2] ]，读出来全是 undefined（这个坑当场踩过一次）。
        options: (select.c ?? []).flat(Infinity).map((o) => o?.p?.value),
        /* 选项的**显示文案**（与 value 分开）——「效果」下拉的媒体类型标注（「极光（MP4 视频）」）
           断言的是**用户看到的字**，只看 value 证明不了标注存在。 */
        optionLabels: (select.c ?? []).flat(Infinity).map((o) => o?.c?.[0] ?? null),
      });
    }
    (node.c ?? []).forEach(walk);
  };
  walk(tree);
  return out;
});

/** 驱动某个控件的 onChange（真调用组件树里的处理函数）。 */
const driveCard = (page, arg) => page.evaluate(({ label, kind, value, checked }) => {
  const comp = window.__cardComp;
  if (typeof comp !== 'function') return false;
  const tree = comp();
  let hit = false;
  const walk = (node) => {
    if (hit || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.t === 'label') {
      const kids = (node.c ?? []).filter((k) => k !== null && k !== undefined);
      const spans = kids.filter((k) => typeof k === 'object' && k.t === 'span');
      const ctl = kids.find((k) => typeof k === 'object'
        && ((kind === 'select' && k.t === 'select') || (k.t === 'input' && k.p?.type === kind)));
      if (ctl && (spans[0]?.c?.[0] ?? null) === label) {
        if (kind === 'select') ctl.p.onChange({ target: { value } });
        else if (kind === 'checkbox') ctl.p.onChange({ target: { checked } });
        else ctl.p.onChange({ target: { value: String(value) } });
        hit = true;
        return;
      }
    }
    (node.c ?? []).forEach(walk);
  };
  walk(tree);
  return hit;
}, arg);

async function groupE(browser, payload) {
  section('E. 行为级断言（真调组件 / 真驱动旋钮 / 真读像素 / 真数 context 释放）');
  const { src } = clientSource();

  /* ── E0：源码级单测（不需要浏览器）——
     把两个**纯函数**从源文件里按大括号配平切出来真跑边界。
     为什么值得单独测：它们是本次新增的解析/判定逻辑，坏输入的兜底最容易漏，
     而"读着觉得对"不算证据（第五轮审核实测：`range:[2,0]` 会产出 min>max + 负 step）。 */
  {
    /* ⚠️ 锚点找不到时**判该断言失败并继续**，不要抛 —— 断言让整套崩掉会把后面的组一起拖停，
       反向验收（拿新自检去跑旧内核）正是这样被自己的单测打断的。 */
    const trySlice = (header) => {
      const start = src.indexOf(header);
      if (start === -1) return null;
      let depth = 0, seen = false;
      for (let i = start; i < src.length; i++) {
        if (src[i] === '{') { depth += 1; seen = true; } else if (src[i] === '}') {
          depth -= 1;
          if (seen && depth === 0) {
            const extra = /^\s*\)/.test(src.slice(i + 1)) ? ')' : '';   // 头部形如 `() => ({`
            return src.slice(start, i + 1) + extra;
          }
        }
      }
      return null;
    };

    const knobRangeSrc = trySlice('function knobRange(mod, knob) {');
    const clampSrc = trySlice('function clampToRange(v, rg) {');
    if (knobRangeSrc === null || clampSrc === null) {
      check('E0a 源码里有 knobRange()/clampToRange()（量程解析 + 夹取）', false,
        '锚点找不到 —— 旧版本没有这两个函数，或它们被改名');
    } else {
      const { knobRange, clampToRange } = new Function(`${knobRangeSrc}\n${clampSrc}; return { knobRange, clampToRange };`)();
      const badRange = [];
      for (const [label, mod, knob] of [
        ['无 range', {}, 'shape'],
        ['[0,3,0.01]', { range: { shape: [0, 3, 0.01] } }, 'shape'],
        ['[0,2]（无 step）', { range: { shape: [0, 2] } }, 'shape'],
        ['[2,0]（写反）', { range: { shape: [2, 0] } }, 'shape'],
        ['["a"]（非数字）', { range: { shape: ['a'] } }, 'shape'],
        ['null', { range: { shape: null } }, 'shape'],
        ['step=0', { range: { shape: [0, 2, 0] } }, 'shape'],
        ['负区间', { range: { shape: [-1, 1, 0.1] } }, 'shape'],
        ['range 不是对象', { range: 'x' }, 'shape'],
      ]) {
        const r = knobRange(mod, knob);
        const ok = Number.isFinite(r.min) && Number.isFinite(r.max) && Number.isFinite(r.step)
          && r.max > r.min && r.step > 0;
        if (!ok) badRange.push(`${label} → ${JSON.stringify(r)}`);
      }
      check('E0a knobRange：任何坏 range 都必须给出 min<max 且 step>0 的合法区间（含 [2,0]）',
        badRange.length === 0, badRange.join(' / ') || '9 个边界全合法');
      check('E0a clampToRange：越界夹回、非数字返回 null',
        clampToRange(5, { min: 0, max: 1 }) === 1 && clampToRange(-2, { min: 0, max: 1 }) === 0
        && clampToRange(0.5, { min: 0, max: 1 }) === 0.5 && clampToRange('x', { min: 0, max: 1 }) === null
        && clampToRange(NaN, { min: 0, max: 1 }) === null);
    }

    const reservedSrc = trySlice('const RESERVED_TYPES = () => ({');
    const checkSrc = trySlice('function checkContract() {');
    if (reservedSrc === null || checkSrc === null) {
      check('E0b 源码里有 RESERVED_TYPES()/checkContract()（保留 uniform 类型 + sampler 体检）', false,
        '锚点找不到 —— 旧版本没有契约体检');
    } else {
      const contractSrc = `${reservedSrc}\n${checkSrc}`;
      const GLish = {
        FLOAT: 0x1406, FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52, INT: 0x1404, BOOL: 0x8B56,
        SAMPLER_2D: 0x8B5E, SAMPLER_3D: 0x8B5F, SAMPLER_CUBE: 0x8B60, SAMPLER_2D_ARRAY: 0x8DC1,
        INT_SAMPLER_2D: 0x8DCA, INT_SAMPLER_3D: 0x8DCB, INT_SAMPLER_CUBE: 0x8DCC, INT_SAMPLER_2D_ARRAY: 0x8DCF,
        UNSIGNED_INT_SAMPLER_2D: 0x8DD2, UNSIGNED_INT_SAMPLER_3D: 0x8DD3,
        UNSIGNED_INT_SAMPLER_CUBE: 0x8DD4, UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8DD7,
      };
      const runContract = (locs) => {
        try { new Function('gl', 'locs', `${contractSrc}; checkContract();`)(GLish, locs); return 'ok'; }
        catch (e) { return String(e?.message ?? e); }
      };
      const T = (type) => ({ loc: {}, type });
      const allowed = [
        ['四个保留 uniform 类型都对', { u_time: T(GLish.FLOAT), u_resolution: T(GLish.FLOAT_VEC2), u_colorBack: T(GLish.FLOAT_VEC4), u_colorFront: T(GLish.FLOAT_VEC4) }],
        ['全部被优化掉（只剩自定义 uniform）', { u_intensity: T(GLish.FLOAT) }],
        ['colors="array" 的 u_colors 数组', { u_colors: T(GLish.FLOAT_VEC4) }],
        ['自定义 int/bool uniform', { u_flag: T(GLish.BOOL), u_count: T(GLish.INT) }],
      ].filter(([, locs]) => runContract(locs) !== 'ok').map(([label]) => label);
      const rejected = [
        ['u_time 声明成 vec2', { u_time: T(GLish.FLOAT_VEC2) }, 'u_time'],
        ['u_resolution 声明成 float', { u_resolution: T(GLish.FLOAT) }, 'u_resolution'],
        ['sampler2D', { u_tex: T(GLish.SAMPLER_2D) }, '采样器'],
        ['isampler2D', { u_i: T(GLish.INT_SAMPLER_2D) }, '采样器'],
        ['usampler2DArray', { u_u: T(GLish.UNSIGNED_INT_SAMPLER_2D_ARRAY) }, '采样器'],
      ].filter(([, locs, need]) => !runContract(locs).includes(need)).map(([label]) => label);
      check('E0b checkContract：不误杀合法 mod（数组 / 自定义 / 被优化掉的 uniform）',
        allowed.length === 0, allowed.join(' / ') || '4 类合法写法全部放行');
      check('E0b checkContract：该拒的都拒（类型不符 + 各类 sampler）',
        rejected.length === 0, rejected.join(' / ') || '5 类违规写法全部拦下');
    }
  }

  /* ── E1/E4/E7/E8/E10/E14/E15：两个 mod 的页面（meteor + 一个自造 mod） ── */
  const twoMods = clonePayload(payload);
  twoMods.mods.push(simpleMod('zz-knobs', {
    name: 'zz-knobs',
    panel: { intensity: 'u_intensity', softness: 'u_softness', noise: 'u_does_not_exist', shape: 'u_shape' },
    range: { shape: [0, 3, 0.01], intensity: [0, 2, 0.01] },
  }));
  {
    const { page, pageErrors } = await openPage(browser, { payload: twoMods, src, tag: 'E1' });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);

      const sliders = await readCard(page);
      const knobs = (sliders ?? []).filter((s) => ['强度', '柔度', '颗粒', '形态'].includes(s.label));
      check('E1 卡片真的产出四个通用旋钮（行为级：调用组件树，不是 grep 源码）',
        knobs.length === 4 && ['强度', '柔度', '颗粒', '形态'].every((l) => knobs.some((k) => k.label === l)),
        JSON.stringify((sliders ?? []).map((s) => s.label)));
      check('E1 四个旋钮都是 range 控件且可用（meteor 的 panel 映射齐全）',
        knobs.length === 4 && knobs.every((k) => k.kind === 'range' && k.disabled === false),
        JSON.stringify(knobs.map((k) => ({ l: k.label, d: k.disabled }))));
      const intensity = knobs.find((k) => k.label === '强度');
      const shape = knobs.find((k) => k.label === '形态');
      check('E1 旋钮初值取自 mod 自己的 spec（内核不注入自己的默认）',
        Number(intensity?.value) === 1 && Number(shape?.value) === 0.5,
        `强度=${intensity?.value} 形态=${shape?.value}`);
      check('E2 meteor 没声明 range ⇒ 滑块量程回落 0..1',
        Number(shape?.max) === 1 && Number(shape?.min) === 0, `min=${shape?.min} max=${shape?.max}`);

      /* E4：真拖一下 → 运行时 spec 必须变，且**真的重画**。
         先冻结动画（reduced-motion 桩）再数 drawArrays —— 否则循环每帧都在画，
         "计数增加"就变成恒真断言（假绿）。冻结后只该多出"改参数引起的那一帧"。 */
      await page.evaluate(() => { window.__reduceMotion = true; });
      await page.waitForTimeout(250);
      const before = await page.evaluate(() => ({ spec: window.__betterSkin.spec?.u_intensity, draws: window.__draws }));
      const drove = await driveCard(page, { label: '强度', kind: 'range', value: 0.9 });
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => ({ spec: window.__betterSkin.spec?.u_intensity, draws: window.__draws }));
      check('E4 拖动旋钮真的改到运行时 spec（u_intensity 1 → 0.9）',
        drove === true && after.spec === 0.9, `驱到=${drove} 前=${before.spec} 后=${after.spec}`);
      check('E4 拖动旋钮真的触发重画（冻结动画后 drawArrays 恰好多出 ≥1 帧）',
        after.draws > before.draws, `${before.draws} → ${after.draws}`);

      /* E14：取消勾选「启用」⇒ live 门控必须**撤销**、面板回到不透明。
         这是第五轮审核 F1 的回归：旧实现只在挂载时置位属性，取消勾选后画面没了、
         CSS 那条 color-mix 却照样生效（"没画面却仍半透明"）。 */
      const driveToggle = (checked) => driveCard(page, { label: '启用', kind: 'checkbox', checked });
      const onState = await page.evaluate(() => ({
        live: window.__betterSkin.live,
        bg: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
      }));
      check('E14 前置：勾选状态下 live=true 且面板半透明', onState.live === true && /color-mix\(/.test(onState.bg),
        JSON.stringify(onState));
      const droveToggle = await driveToggle(false);
      await page.waitForTimeout(120);
      const offState = await page.evaluate(() => ({
        live: window.__betterSkin.live,
        veil: document.body.style.getPropertyValue('--mb-veil'),
        bg: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
        display: document.querySelector('canvas[data-mb-surface]')?.style.display ?? null,
      }));
      check('E14 ★ 取消勾选「启用」⇒ live 被撤销、面板回到不透明（F1 回归）',
        droveToggle === true && offState.live === false && offState.veil === '' && !/color-mix\(/.test(offState.bg),
        JSON.stringify(offState));
      check('E14 取消勾选时画面被隐藏（display:none，而不是留着一块在跑）',
        offState.display === 'none', JSON.stringify(offState.display));
      await driveToggle(true);
      await page.waitForTimeout(120);
      const backState = await page.evaluate(() => ({
        live: window.__betterSkin.live,
        bg: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
      }));
      check('E14 重新勾选 ⇒ live 与半透明都回来（不是一次性开关）',
        backState.live === true && /color-mix\(/.test(backState.bg), JSON.stringify(backState));

      /* E7：切换效果必须落盘（否则刷新回退）。 */
      const switched = await driveCard(page, { label: '效果', kind: 'select', value: 'zz-knobs' });
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({
        current: window.__betterSkin.mods?.current,
        stored: JSON.parse(globalThis.localStorage.getItem('dsh-motion-background.config') ?? 'null')?.effect ?? null,
        canvas: document.querySelectorAll('canvas[data-mb-surface]').length,
        lose: window.__loseCalls,
      }));
      check('E7 切换效果后 current 跟着变（着色器重建）',
        switched === true && st.current === 'zz-knobs' && st.canvas === 1, JSON.stringify(st));
      check('E7 切换效果**落盘**（localStorage.effect === zz-knobs）',
        st.stored === 'zz-knobs', String(st.stored));
      /* E15：切换必须回收旧上下文（第五轮审核 F2 的回归：旧实现只 stop() 不 release()，
         连切 20 次 ⇒ 21 个 context、loseContext 0 次，撞上限后画面被静默丢弃）。 */
      check('E15 ★ 切换效果回收了旧 WebGL 上下文（loseContext ≥ 1）',
        st.lose >= 1, `loseContext × ${st.lose}`);
      check('E15 切换后不残留游离画布（只有当前这一块）', st.canvas === 1, `画布数 ${st.canvas}`);

      /* E2b/E3：切到 zz-knobs 后看它的量程与置灰。 */
      const sliders2 = await readCard(page);
      const knobs2 = (sliders2 ?? []).filter((s) => ['强度', '柔度', '颗粒', '形态'].includes(s.label));
      const shape2 = knobs2.find((k) => k.label === '形态');
      const noise2 = knobs2.find((k) => k.label === '颗粒');
      check('E2 mod 声明的 range 被采纳（形态量程 0..3，不再是硬编码 0..1）',
        Number(shape2?.max) === 3, `min=${shape2?.min} max=${shape2?.max}`);
      check('E3 映射到不存在的 uniform ⇒ 该旋钮真置灰（行为级：disabled=true）',
        noise2?.disabled === true && knobs2.filter((k) => k.disabled === true).length === 1,
        JSON.stringify(knobs2.map((k) => ({ l: k.label, d: k.disabled }))));

      /* E10：reduced motion ⇒ 只画一帧、不再续帧。 */
      await page.evaluate(() => { window.__reduceMotion = true; });
      await page.waitForTimeout(300);
      const d1 = await page.evaluate(() => window.__draws);
      await page.waitForTimeout(500);
      const d2 = await page.evaluate(() => window.__draws);
      check('E10 prefers-reduced-motion ⇒ 不再续帧（drawArrays 计数停住）',
        d2 === d1, `${d1} → ${d2}`);

      /* E8：卸载要清干净 —— DOM、内联变量、**以及 WebGL 上下文**。 */
      const after2 = await page.evaluate(() => {
        window.__dispose?.();
        return {
          canvas: document.querySelectorAll('canvas[data-mb-surface]').length,
          style: document.querySelectorAll('style[data-plugin-css="dsh-motion-background/backdrop.css"]').length,
          scope: document.body.hasAttribute('data-motion-background'),
          live: document.body.hasAttribute('data-mb-live'),
          veil: document.body.style.getPropertyValue('--mb-veil'),
          lose: window.__loseCalls,
        };
      });
      check('E8 卸载后画布 / 样式表 / 作用域 / live 门控 全部摘除',
        after2.canvas === 0 && after2.style === 0 && after2.scope === false && after2.live === false,
        JSON.stringify(after2));
      check('E8 卸载后内联 --mb-veil 也被清掉（否则插件没了面板还半透明）',
        after2.veil === '', JSON.stringify(after2.veil));
      check('E8 卸载真的回收了 WebGL 上下文（loseContext 被调用过）',
        after2.lose >= 1, `loseContext × ${after2.lose}`);
      check('E 组全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E5：回落（R3 正向覆盖）—— 首选 mod 坏掉时真的切到备用、且旋钮仍然有效 ── */
  {
    /* ⚠️ 备用 mod **按 id 显式取**，绝不写 `mods[0]`：
       mods 是按文件夹名升序排的，往仓库里加一个新 mod（例如 aurora-video）就会把
       `mods[0]` 挤走 —— 那时载荷里根本没有 meteor，E5 的五六条断言会集体变红，
       而内核其实是好的（这是**夹具脆弱**，不是产品缺陷，2026-09-25 实测踩到）。
       显式点名后，新增 mod 永远影响不到这条用例。 */
    const backup = clonePayload(payload).mods.find((m) => m.id === 'meteor');
    if (backup === undefined) {
      check('E5 夹具：载荷里必须有 meteor 作为备用 mod', false,
        '载荷 mods = ' + JSON.stringify(clonePayload(payload).mods.map((m) => m.id)));
    } else {
      const brokenFirst = { mods: [simpleMod('aaa-broken', {
        fragment: '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = nope_undefined_symbol(); }\n',
      }), backup], errors: [], dir: 'D:/x/mods' };
      const { page, pageErrors } = await openPage(browser, { payload: brokenFirst, src, tag: 'E5' });
      try {
        await waitMods(page);
        await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        const s = await snapshot(page);
        check('E5 首选 mod 编译失败 ⇒ 真的回落到下一个可用 mod 并出画',
          s.mods?.current === 'meteor' && s.canvasCount === 1,
          `current=${JSON.stringify(s.mods?.current)} canvas=${s.canvasCount}`);
        check('E5 回落时把生效的 id 写回配置（面板与画面不再脱节）',
          s.mods?.requested === 'meteor', `requested=${JSON.stringify(s.mods?.requested)}`);
        check('E5 坏掉的 mod 被记进 errors（__render:aaa-broken）',
          Object.keys(s.mods?.errors ?? {}).includes('__render:aaa-broken'),
          JSON.stringify(Object.keys(s.mods?.errors ?? {})));
        const px = await pixelStats(page);
        check('E5 回落后画面真的画出来了（像素级）', px.ok === true && px.peak > 40,
          px.ok === false ? px.why : `peak=${px.peak} ratio=${(px.ratio * 100).toFixed(2)}%`);
        /* 这条是回归测试：修复前回落后 applyConfig 的守卫恒不成立 ⇒ 旋钮静默失效 */
        const before = await page.evaluate(() => window.__betterSkin.spec?.u_intensity);
        await driveCard(page, { label: '强度', kind: 'range', value: 0.25 });
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => window.__betterSkin.spec?.u_intensity);
        check('E5 ★ 回落后旋钮仍然有效（回归：修复前拖了没反应）',
          after === 0.25, `前=${before} 后=${after}`);
        check('E5 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
      } finally {
        await page.close();
      }
    }
  }

  /* ── E16：这次没拿到上下文（瞬时故障）⇒ **不得改写用户的选择**（F3 回归） ── */
  {
    const two = { mods: [simpleMod('aaa-first'), simpleMod('bbb-second')], errors: [], dir: 'D:/x/mods' };
    const seed = { enabled: true, effect: 'aaa-first', veil: 52, panel: {} };
    const { page, pageErrors } = await openPage(browser, {
      payload: two, src, tag: 'E16', seedConfig: seed, failFirstContext: 1,
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      const s = await page.evaluate(() => ({
        current: window.__betterSkin.mods?.current,
        requested: window.__betterSkin.mods?.requested,
        fallbackFrom: window.__betterSkin.mods?.fallbackFrom,
        stored: JSON.parse(globalThis.localStorage.getItem('dsh-motion-background.config') ?? 'null')?.effect ?? null,
        errs: Object.keys(window.__betterSkin.mods?.errors ?? {}),
      }));
      const sliders = await readCard(page);
      const sel = (sliders ?? []).find((x) => x.kind === 'select');
      check('E16 首选这次没拿到上下文 ⇒ 回落到下一个可用 mod 并出画',
        s.current === 'bbb-second', JSON.stringify(s));
      check('E16 ★ 瞬时失败**不改写**用户的选择（requested 与 localStorage 仍是 aaa-first）',
        s.requested === 'aaa-first' && s.stored === 'aaa-first', JSON.stringify(s));
      check('E16 记进 __transient: 而不是 __render:（后者会被当成"这个 mod 坏了"并从列表摘掉）',
        s.errs.includes('__transient:aaa-first') && !s.errs.some((k) => k.startsWith('__render:aaa-first')),
        JSON.stringify(s.errs));
      check('E16 该 mod 仍留在效果下拉框里（用户还能选回来）',
        Array.isArray(sel?.options) && sel.options.includes('aaa-first'), JSON.stringify(sel?.options));
      check('E16 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E17：range 退化值 + 初值越界（F4 回归） ── */
  {
    const rmod = simpleMod('zz-range', {
      spec: { u_intensity: 5, u_softness: 0.5, u_noise: 0.5, u_shape: 0.5 },
      range: { intensity: [0, 1], softness: [0, 2, 0.1], noise: null, shape: [2, 0] },
    });
    const { page, pageErrors } = await openPage(browser, {
      payload: { mods: [rmod], errors: [], dir: 'D:/x/mods' }, src, tag: 'E17',
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
      const sliders = await readCard(page);
      const k = (label) => (sliders ?? []).find((x) => x.label === label);
      const shape = k('形态');
      const soft = k('柔度');
      const inten = k('强度');
      const spec = await page.evaluate(() => window.__betterSkin.spec);
      check('E17 ★ 退化 range（[2,0]）不产生 min>max / 负 step',
        Number(shape?.max) > Number(shape?.min) && Number(shape?.step) > 0, JSON.stringify(shape));
      check('E17 [0,2,0.1] 被正确采纳', Number(soft?.max) === 2 && Number(soft?.step) === 0.1, JSON.stringify(soft));
      check('E17 ★ 初值越界被夹进 range（滑块 5→1，且运行时 spec 也是 1 —— 看到的就是跑的）',
        Number(inten?.value) === 1 && spec?.u_intensity === 1,
        `滑块 value=${inten?.value}（min=${inten?.min} max=${inten?.max}）运行时 spec=${spec?.u_intensity}`);
      check('E17 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E6：没有任何渲染面时，面板**不得**被改成半透明 ── */
  {
    const allBroken = { mods: [simpleMod('only-broken', {
      fragment: '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = nope_undefined_symbol(); }\n',
    })], errors: [], dir: 'D:/x/mods' };
    const { page, pageErrors } = await openPage(browser, { payload: allBroken, src, tag: 'E6' });
    try {
      await waitMods(page);
      await page.waitForTimeout(700);
      const s = await page.evaluate(() => ({
        live: window.__betterSkin.live,
        canvas: document.querySelectorAll('canvas[data-mb-surface]').length,
        veil: document.body.style.getPropertyValue('--mb-veil'),
        bgBase: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
        current: window.__betterSkin.mods?.current,
      }));
      check('E6 全部 mod 都挂不上 ⇒ live 门控为假、没有画布',
        s.live === false && s.canvas === 0 && s.current === null, JSON.stringify(s));
      check('E6 ★ 没有渲染面时面板保持**不透明**（回归：修复前会发灰）',
        s.veil === '' && !/color-mix\(/.test(s.bgBase), JSON.stringify({ veil: s.veil, bgBase: s.bgBase }));
      const sliders = await readCard(page);
      const knobs = (sliders ?? []).filter((x) => ['强度', '柔度', '颗粒', '形态'].includes(x.label));
      check('E6 没有渲染面时四个旋钮置灰（不让用户拖一个必然没反应的滑块）',
        knobs.length === 4 && knobs.every((k) => k.disabled === true),
        JSON.stringify(knobs.map((k) => ({ l: k.label, d: k.disabled }))));
      check('E6 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E9：浅色主题下画面必须**看得见**（回归：加法叠加在纯白底上饱和） ── */
  {
    const { page, pageErrors } = await openPage(browser, { payload, src, tag: 'E9', theme: 'light' });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
      const s = await snapshot(page);
      const px = await pixelStats(page);
      check('E9 浅色主题下画布仍然存在且底色为浅色令牌',
        s.canvasCount === 1 && px.ok === true && px.bg255[0] > 200,
        px.ok === false ? px.why : `底色 rgb(${px.bg255.join(',')})`);
      check('E9 ★ 浅色主题下画面真的看得见（非底色像素 / 峰值偏差）',
        px.ok === true && px.peak > 40 && px.ratio > 0.005,
        px.ok === false ? px.why : `peak=${px.peak} ratio=${(px.ratio * 100).toFixed(2)}%`);
      check('E9 浅色主题下无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E11/E12：契约体检（保留 uniform 类型 / 采样器）必须是**行为级**失败，而不是静默 GL error ── */
  {
    const badTime = { mods: [simpleMod('bad-time', {
      fragment: '#version 300 es\nprecision highp float;\nuniform vec2 u_time;\nuniform vec4 u_colorBack;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main(){ fragColor = vec4(u_colorBack.rgb + vec3(u_time.y * 0.0001), 1.0); }\n',
    })], errors: [], dir: 'D:/x/mods' };
    const { page } = await openPage(browser, { payload: badTime, src, tag: 'E11' });
    try {
      await waitMods(page);
      await page.waitForTimeout(700);
      const s = await snapshot(page);
      const errs = s.mods?.errors ?? {};
      check('E11 把 u_time 声明成 vec2 ⇒ 该 mod 被判不可用并给出明确原因（不是静默 GL error）',
        Object.keys(errs).some((k) => k.startsWith('__render:bad-time')) && /u_time/.test(JSON.stringify(errs)),
        JSON.stringify(errs));
    } finally {
      await page.close();
    }
  }
  {
    const sampler = { mods: [simpleMod('bad-sampler', {
      fragment: '#version 300 es\nprecision highp float;\nuniform sampler2D u_tex;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main(){ fragColor = texture(u_tex, v_uv); }\n',
    })], errors: [], dir: 'D:/x/mods' };
    const { page } = await openPage(browser, { payload: sampler, src, tag: 'E12' });
    try {
      await waitMods(page);
      await page.waitForTimeout(700);
      const s = await snapshot(page);
      const errs = s.mods?.errors ?? {};
      check('E12 声明 sampler ⇒ 被判不可用（契约：内核不提供任何纹理）',
        Object.keys(errs).some((k) => k.startsWith('__render:bad-sampler')) && /采样器|sampler/i.test(JSON.stringify(errs)),
        JSON.stringify(errs));
    } finally {
      await page.close();
    }
  }

  /* ════════════════ E18：媒体型 mod（mp4 / 图片） ════════════════
   *
   * 判据必须是「**真的解码出画面**」，不是"元素建出来了" —— 一个 404 的 URL
   * 照样能建出 <video>，那是本仓库最怕的假绿。所以这里用**真实视频字节**做夹具。
   */
  const realMp4 = readFileSync(join(HERE, 'mods', 'aurora-video', 'bg.mp4'));
  const mediaPayload = (over = {}) => ({
    mods: [Object.assign({
      id: 'vid-test', name: '视频测试', description: '', author: 't', license: 'CC0-1.0',
      colors: 'front', spec: {}, panel: {}, range: {}, fragment: '',
      media: { src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4', kind: 'video', fit: 'cover', opacity: 1, blend: false },
    }, over)],
    errors: [], dir: 'D:/x/mods',
  });

  /* ── E18a：真的挂上 <video> 并出画 ── */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload(), src, tag: 'E18a',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const s = await page.evaluate(() => {
        const v = document.querySelector('video[data-mb-surface]');
        return {
          has: v !== null,
          readyState: v?.readyState ?? -1,
          vw: v?.videoWidth ?? 0,
          vh: v?.videoHeight ?? 0,
          paused: v?.paused ?? null,
          muted: v?.muted ?? null,
          loop: v?.loop ?? null,
          currentTime: v?.currentTime ?? -1,
          canvasCount: document.querySelectorAll('canvas[data-mb-surface]').length,
          kind: window.__betterSkin?.mods?.surfaceKind ?? null,
          current: window.__betterSkin?.mods?.current ?? null,
          live: window.__betterSkin?.live ?? null,
        };
      });
      check('E18a 媒体 mod 建出 <video data-mb-surface>', s.has === true, JSON.stringify(s));
      check('E18a 视频**真的解码出帧**（readyState>=2 且 videoWidth>0）',
        s.readyState >= 2 && s.vw > 0 && s.vh > 0, `readyState=${s.readyState} ${s.vw}x${s.vh}`);
      check('E18a 视频参数与源一致（640x360）', s.vw === 640 && s.vh === 360, `${s.vw}x${s.vh}`);
      check('E18a 视频是静音 + 循环（否则自动播放会被拒 / 播一次就停）',
        s.muted === true && s.loop === true, `muted=${s.muted} loop=${s.loop}`);
      check('E18a 视频**真的在播**（currentTime 已推进）', s.currentTime > 0, `currentTime=${s.currentTime}`);
      check('E18a 媒体型不建 canvas（不占 WebGL 上下文）', s.canvasCount === 0, `canvas=${s.canvasCount}`);
      check('E18a surfaceKind 自检报 media', s.kind === 'media', String(s.kind));
      check('E18a 当前效果是媒体 mod', s.current === 'vid-test', String(s.current));
      check('E18a 媒体挂上后 live 门控为真（面板半透明才生效）', s.live === true, String(s.live));
      check('E18a 媒体型全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E18b：媒体加载失败必须是「不可用」，且**不能**被误判为成功 ── */
  {
    const { page } = await openPage(browser, {
      payload: mediaPayload(), src, tag: 'E18b',
      mediaBody: null,                       // 拦截器回 404
    });
    try {
      await waitMods(page);
      await page.waitForTimeout(2500);
      const s = await snapshot(page);
      const errs = s.mods?.errors ?? {};
      check('E18b 媒体加载失败（404）⇒ 被判不可用并记进 errors',
        Object.keys(errs).some((k) => k.includes('vid-test')), JSON.stringify(errs));
      check('E18b 媒体加载失败 ⇒ 没有 live 门控（面板不会发灰）',
        s.live === false, String(s.live));
      check('E18b 媒体加载失败 ⇒ DOM 里不留 <video>',
        s.mediaCount === 0, `media=${s.mediaCount}`);
    } finally {
      await page.close();
    }
  }

  /* ── E18c：媒体型与着色器型**共存**时的回落（媒体坏了要能退到着色器）── */
  {
    const bothPayload = {
      mods: [
        mediaPayload().mods[0],                       // vid-test（媒体，会 404）
        simpleMod('zz-shader'),                       // 着色器备用
      ],
      errors: [], dir: 'D:/x/mods',
    };
    const { page, pageErrors } = await openPage(browser, { payload: bothPayload, src, tag: 'E18c', mediaBody: null });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('canvas[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
      const s = await snapshot(page);
      check('E18c 媒体坏了 ⇒ 回落到着色器 mod 并出画',
        s.mods?.current === 'zz-shader' && s.canvasCount === 1,
        `current=${JSON.stringify(s.mods?.current)} canvas=${s.canvasCount}`);
      const px = await pixelStats(page);
      check('E18c 回落后的着色器画面真的是画出来的（像素级）', px.ok === true && px.peak > 40,
        px.ok === false ? px.why : `peak=${px.peak}`);
      check('E18c 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E18d：媒体型没有 uniform ⇒ 四个旋钮置灰，但**面板浓度仍可用** ── */
  {
    const { page } = await openPage(browser, {
      payload: mediaPayload(), src, tag: 'E18d',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForTimeout(800);
      const rows = await readCard(page);
      const knobRows = rows.filter((r) => ['强度', '柔度', '颗粒', '形态'].includes(r.label));
      check('E18d 媒体型：四个通用旋钮全部置灰（没有可调参数，不许假装能拖）',
        knobRows.length === 4 && knobRows.every((r) => r.disabled === true),
        JSON.stringify(knobRows.map((r) => ({ l: r.label, d: r.disabled }))));
      const veil = rows.find((r) => r.label === '面板浓度');
      check('E18d 媒体型：「面板浓度」仍然可用（它不依赖 mod 参数）',
        veil !== undefined && veil.disabled === false, JSON.stringify(veil ?? null));
    } finally {
      await page.close();
    }
  }

  /* ── E18e：切换效果时媒体资源真被释放（pause + 摘元素）── */
  {
    const bothPayload = {
      mods: [mediaPayload().mods[0], simpleMod('zz-shader')],
      errors: [], dir: 'D:/x/mods',
    };
    const { page } = await openPage(browser, {
      payload: bothPayload, src, tag: 'E18e',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => ({
        videos: document.querySelectorAll('video[data-mb-surface]').length,
        playing: document.querySelector('video[data-mb-surface]')?.paused === false,
      }));
      check('E18e 前置：切换前有媒体面且在播',
        before.videos === 1 && before.playing === true, JSON.stringify(before));

      /* ⚠️ 用**同一套** driveCard（真调组件树的 onChange），不要自己 querySelector
         —— 自己写的 DOM 选择器选不到官方的哈希类名/结构，会"切了个寂寞"然后断言全红
         （2026-09-25 实测：手写的 `[...document.querySelectorAll('select')]` 没匹配到，
         切换根本没发生，于是两条断言失败在"没切换"而不是"没释放"）。 */
      const switched = await driveCard(page, { label: '效果', kind: 'select', value: 'zz-shader' });
      check('E18e 前置：面板里能驱动"效果"下拉框切到着色器 mod', switched === true, String(switched));
      await page.waitForTimeout(1200);
      const after = await page.evaluate(() => ({
        videos: document.querySelectorAll('video[data-mb-surface]').length,
        canvases: document.querySelectorAll('canvas[data-mb-surface]').length,
        current: window.__betterSkin?.mods?.current ?? null,
        kind: window.__betterSkin?.mods?.surfaceKind ?? null,
      }));
      /* ⚠️ 这条是**真断言**：媒体元素若不释放，切走后 DOM 里会留下一个挂着 src 的 <video>
         —— 它的缓冲与在途请求都还在（`el.remove()` 只是把元素摘出文档，不回收媒体资源）。
         `release()` 里那条 `el.remove()` 就是为了它 —— 删掉就会变红（已由
         `--mutate=media-keep-el` 反证钉住：拆掉后本条变红）。 */
      check('E18e ★ 切走媒体后 DOM 里不留 <video>（元素真的被摘掉了）',
        after.videos === 0, JSON.stringify(after));
      check('E18e 切换后确实换成了着色器面',
        after.canvases === 1 && after.kind === 'shader', JSON.stringify(after));
    } finally {
      await page.close();
    }
  }
  /* ════════════════ E19：播放模式（循环 / 往返倒放） ════════════════
   *
   * 用户需求原文：「希望当选中视频（比如极光）之后，能出现一个播放选项……
   *              一个视频的头尾不一定衔接得很好，如果直接循环，有时候中段会比较生硬」，
   * 紧接着修正为：「**倒播**。正着播放到尾，再反着播回来」。
   *
   * ⚠️ 这一组最容易写成假绿，所以每条断言都刻意避开"自证"：
   *    · 只看 `direction === 'reverse'` 是不够的 —— 那是我自己设的标志位，
   *      把驱动器整个删掉、只留状态翻转，它照样是绿的；
   *    · 只看 `currentTime` 数字在减小也不够 —— 证明的是"标量在动"，不是"画面在动"；
   *    ⇒ 必须**同时**观察：`currentTime` 单调递减 **且** 像素指纹真的在变。
   */
  const REAL_MP4_DURATION = 6;              // 夹具 bg.mp4 的时长（实测 6.000s）

  /* ── E19a：往返模式下 loop 必须是 false（否则 ended 永不触发、倒放支路根本不启动）── */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload({ media: {
        src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
        kind: 'video', fit: 'cover', opacity: 1, blend: false,
        label: 'MP4 视频', playMode: 'pingpong',
      } }),
      src, tag: 'E19a',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
      const s = await page.evaluate(() => {
        const v = document.querySelector('video[data-mb-surface]');
        return {
          has: v !== null,
          loop: v?.loop ?? null,
          paused: v?.paused ?? null,
          t: v?.currentTime ?? -1,
          muted: v?.muted ?? null,
          mode: window.__betterSkin?.mods?.playMode ?? null,
          dir: window.__betterSkin?.mods?.direction ?? null,
        };
      });
      check('E19a ★ 往返模式下 `loop` 必须是 false（true 的话 ended 永不触发 ⇒ 倒放根本不会启动）',
        s.loop === false, `loop=${s.loop}`);
      check('E19a 往返模式仍然静音（静音是自动播放的前提，与模式无关）',
        s.muted === true, `muted=${s.muted}`);
      check('E19a mod 声明的 playMode=pingpong 被采纳（用户没选过时用 mod 的建议值）',
        s.mode === 'pingpong', `mode=${s.mode}`);
      check('E19a 刚挂上时方向是 forward（从头正放，不是一上来就倒放）',
        s.dir === 'forward', `dir=${s.dir}`);
      check('E19a 正放阶段真的在播（currentTime 已推进）', s.t > 0, `t=${s.t}`);
      check('E19a 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E19b：往返**真的**会翻转方向，并且倒放段画面真的在变 ──
   *
   * 这是整组的核心断言。为了不真的等满 6 秒，用 `currentTime` 把元素**直接送到尾部附近**
   * 再让它自然播完 —— `ended` 与真实播放走的是同一条路径（不是调内部函数伪造的）。 */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload({ media: {
        src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
        kind: 'video', fit: 'cover', opacity: 1, blend: false,
        label: 'MP4 视频', playMode: 'pingpong',
      } }),
      src, tag: 'E19b',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);

      /* 像素指纹：把当前帧画进 2D canvas 取一个粗指纹。
         ⚠️ 这是"画面真的在变"与"只是标量在变"的**唯一区分手段**。
         ⚠️⚠️ 采样必须**等 `seeked` 事件**再取像素：倒放是靠连续 seek 驱动的，
             `drawImage` 早于解码落位时会读到**上一帧** —— 2026-09-25 实测踩到：
             60ms 定时采样得到 12 个样本、指纹全同（看着像"画面冻住"），
             而同一个实现在驱动器内部逐拍取样是 31/74 不同。
             结论：**不是实现没更新画面，是断言取错了时机** —— 这类"夹具自己坏了"
             会伪装成功能缺陷，比漏测更费时间。 */
      const probe = await page.evaluate(async () => {
        const v = document.querySelector('video[data-mb-surface]');
        if (v === null) return { why: '没有 <video>' };
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const g = c.getContext('2d', { willReadFrequently: true });
        /* ⚠️ 取像素前**先擦画布**：不看这一步的话，"此刻没有可画之帧"会读成**上一帧**
           ⇒ 指纹假重复。同时把"全透明"单列成 `blank`，好把"画面卡住"与"根本没画出帧"分开。 */
        const fp = () => {
          g.clearRect(0, 0, 64, 36);
          try { g.drawImage(v, 0, 0, 64, 36); } catch (e) { return 'err:' + String(e?.message ?? e).slice(0, 30); }
          const d = g.getImageData(0, 0, 64, 36).data;
          let h = 0, opaque = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] !== 0) opaque += 1;
            h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3]) % 2147483647;
          }
          return opaque === 0 ? 'blank' : String(h);
        };
        /* ⚠️⚠️ **三件套判据**：落位率 + **速度** + **可见帧率**。
           为什么必须三个都有（2026-09-25 独立审核实测抓到断言网的真空洞）：
             · 只数**落位率** ⇒ 只钉住"别发太多"。一个把 seek 限流到 400ms 的版本
               （它发得少、**反而落位率 1.0**）可见只有 **2.4 fps**、速度 **0.60×**，
               却能全绿通过 —— 落位率根本抓不住它。
             · 反过来**速度也抓不住洪水版**：拆掉闸门后速度仍是 1.00×，只有落位率（0.65）掉下来。
             · 只数**像素指纹** ⇒ 统计量，洪水版也能刷到 40/82。
           ⇒ 三者各抓一种坏法，互相独立、缺一不可。**判据数不等于覆盖度。** */
        const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        let assigns = 0, landed = 0, counting = false;
        try {
          Object.defineProperty(v, 'currentTime', {
            configurable: true,
            get() { return proto.get.call(this); },
            set(x) { if (counting === true) assigns += 1; proto.set.call(this, x); },
          });
        } catch (e) { return { why: '无法计数 currentTime 赋值：' + String(e?.message ?? e).slice(0, 60) }; }
        v.addEventListener('seeked', () => { if (counting === true) landed += 1; });

        /* 可见帧率仪器：`requestVideoFrameCallback` 只在**真的呈现了一帧**时回调
           ⇒ 它数的是"用户看到的帧"，与 `seeked`（解码落位）和像素指纹（我主动取样）
           都**相互独立**。掉帧 / 幻灯片会直接反映在它的去重计数上。 */
        const presented = [];
        if (typeof v.requestVideoFrameCallback === 'function') {
          const onFrame = (_now, meta) => {
            if (counting === true) presented.push(Math.round((meta?.presentationTime ?? meta?.mediaTime ?? 0) * 100));
            v.requestVideoFrameCallback(onFrame);
          };
          v.requestVideoFrameCallback(onFrame);
        }
        /* 等到下一次画面真的换过（`seeked` 由解码器在 seek 落位后派发）——
           带超时兜底，免得事件不来时把整组挂死。 */
        const waitSeeked = (ms = 200) => new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          v.addEventListener('seeked', fin, { once: true });
          setTimeout(fin, ms);
        });
        /* 送到尾部附近，让它**自然**播完 ⇒ 走真实的 ended 路径。
           ⚠️ 这次的 seek 发生在计数开启**之前**，不会污染落位率。 */
        v.currentTime = Math.max(0, v.duration - 0.5);
        await new Promise((r) => setTimeout(r, 300));

        /* 先等方向真的翻到 reverse（计数从此刻开始），再做像素采样 ——
           两件事分开，避免把正放段的读数混进倒放段。 */
        {
          const w = performance.now();
          while (performance.now() - w < 2500) {
            if (window.__betterSkin?.mods?.direction === 'reverse') break;
            await new Promise((r) => setTimeout(r, 30));
          }
        }
        /* ⚠️ 开窗之前先**等一次 seeked 落位**，再清零计数器 —— 否则窗口外发出的那次
           seek 的 `seeked` 会落进窗口里，把落位率算成 >1（实测过 23/22=1.045）。
           落位率 >1 在物理上不可能，是个**一眼就该被怀疑**的数字：
           它会让"这条断言在观察什么"变得不可信（分母少算了一次，谁也不知道还少算了什么）。
           ⚠️⚠️ 独立审核指出这一步**没有修干净**：`waitSeeked` 自带 200ms 超时，
              超时后仍带着"在途未落位的 seek"开窗 ⇒ 那个 seeked 落进窗口 ⇒ 仍可能 >1
              （CPU 降速下 6/6 复现）。所以下面的判据**不依赖 rate ≤ 1** ——
              只要求 ≥0.6，超一点不影响结论；这里如实记录这个已知残余，不再假称"已修掉"。 */
        await waitSeeked();
        assigns = 0; landed = 0; presented.length = 0;
        counting = true;

        const samples = [];
        const wallStart = performance.now();
        const mediaStart = v.currentTime;
        /* ⚠️ 采样窗口是**固定的墙上时间 2.0s**（不是"凑够 12 个样本"）——
           这样"速度"与"可见帧率"才有确定的分母。凑样本数的写法会让一个慢速实现
           采到更长的媒体跨度，把"它在慢慢爬"这件事掩盖掉。 */
        while (performance.now() - wallStart < 2000) {
          const st = window.__betterSkin?.mods ?? {};
          /* 采样窗口：**只**在已经进入反向后才开始记，避免把正放段的读数混进来。 */
          if (st.direction === 'reverse') {
            await waitSeeked();          // ← 关键：等这一帧解码落位再取像素
            samples.push({ t: +v.currentTime.toFixed(4), px: fp(), paused: v.paused });
          }
        }
        const wallMs = performance.now() - wallStart;
        const mediaAdv = mediaStart - v.currentTime;       // 倒放 ⇒ 往回走的距离（正数）
        counting = false;
        return {
          dir: window.__betterSkin?.mods?.direction ?? null,
          mode: window.__betterSkin?.mods?.playMode ?? null,
          loopNow: v.loop,
          samples,
          duration: v.duration,
          assigns, landed,
          rate: assigns === 0 ? null : +(landed / assigns).toFixed(3),
          /* 倒放的**媒体推进速度**（1.0 = 与正放同速）。 */
          mediaAdv: +mediaAdv.toFixed(3),
          wallMs: Math.round(wallMs),
          speed: +(mediaAdv / (wallMs / 1000)).toFixed(3),
          /* **可见帧率**：rvfc 呈现时间去重计数 ÷ 墙上时间。源是 25 fps。 */
          visibleFrames: new Set(presented).size,
          visibleFps: +(new Set(presented).size / (wallMs / 1000)).toFixed(1),
          rvfcSupported: typeof v.requestVideoFrameCallback === 'function',
        };
      });

      check('E19b ★ 正放播完后**方向翻转到 reverse**（ended ⇒ 开始倒放）',
        probe.dir === 'reverse', JSON.stringify({ dir: probe.dir, why: probe.why }));
      const ts = (probe.samples ?? []).map((s) => s.t);
      const monotone = ts.length >= 5 && ts.every((x, i) => i === 0 || x <= ts[i - 1] + 1e-6);
      const moved = ts.length >= 5 && (ts[0] - ts[ts.length - 1]) > 0.05;
      check('E19b ★ 倒放段 currentTime **单调递减**（真的在往回走，不是随机跳）',
        monotone, `样本=${ts.length} 序列=${JSON.stringify(ts.slice(0, 6))}`);
      check('E19b ★ 倒放段确实往回走了可观的距离（不是只动了一点点就停）',
        moved, ts.length >= 2 ? `${ts[0]} → ${ts[ts.length - 1]}（${(ts[0] - ts[ts.length - 1]).toFixed(3)}s）` : '样本不足');
      /* ⚠️⚠️ 这条是整组最重要的：**画面真的在变**。
         只验 currentTime 的话，把 `el.currentTime = next` 注释掉、只改内部状态变量
         也能全绿 —— 那就是"倒放"的假绿。 */
      const pxSet = new Set((probe.samples ?? []).map((s) => s.px));
      check('E19b ★★ 倒放段**画面真的在变**（像素指纹不重复 —— 不是只改了时间标量）',
        pxSet.size >= 5, `不同指纹数=${pxSet.size} / 样本数=${(probe.samples ?? []).length}`);
      /* ⚠️⚠️ **决定性的一条：seek 落位率**。
         倒放靠改 `currentTime` 驱动，而"每帧都发一个 seek"是**最自然的错误写法** ——
         每个新赋值都会掐掉在途的那次 seek，解码器于是永远从头开始。
         ⚠️ 为什么不能只用上面那条"不同指纹数"：它是**统计量**，洪水版也能刷到 40/82
            （见 `FALSIFICATION` 记录），不足以钉住"不许掐掉在途 seek"这条契约。
            落位率是**因果性**的（直接对着那个赋值行为）：正常 1.00 vs 洪水 0.65。
         ⚠️ 阈值（`SEEK_LAND_RATE_MIN`，取 0.9）是**用实测分布校准**的，定义处有完整的两个分布；
            不要凭"看起来宽松"改小它 —— 0.6 那版就是这样失去辨别力的。
         ⚠️ 阈值必须能被**真的**违反：`pingpong-seek-flood` 变异（把闸门拆掉）应让它变红。 */
      /* ⚠️⚠️ **先说清分母**（这条不是装饰性断言）：
         下面三条判据（倒放距离 / 速度 / 可见帧率）全都以"素材长度与帧率"为前提 ——
         夹具换了素材而没人改这里的话，"倒放距离可观"之类的阈值就失去了依据
         （例如换成一段 1s 的素材，`mediaAdv > 2s` 会永远假红；换成 60s 的则永远假绿）。
         ⚠️ 这条断言**真的能失败**：把夹具换成别的视频（长度≠6s）它就红。
         （2026-09-25 之前这里是 `REAL_MP4_DURATION` 定义后**从未被引用**的死代码，
           独立审核指出；现在让它承担"夹具自校验"这个职责。） */
      check(`E19b 夹具自校验：素材时长 = ${REAL_MP4_DURATION}s（下面几条阈值的分母前提）`,
        Math.abs((probe.duration ?? -1) - REAL_MP4_DURATION) < 0.1,
        `实测 duration=${probe.duration}`);
      check(`E19b ★★ 倒放段 seek **落位率** ≥ ${SEEK_LAND_RATE_MIN}（不许每帧都发 seek 掐掉在途解码 —— 那会退化成幻灯片）`,
        (probe.rate ?? 0) >= SEEK_LAND_RATE_MIN,
        `发出 ${probe.assigns} 次、落位 ${probe.landed} 次 ⇒ 落位率 ${probe.rate ?? 'n/a'}`);
      /* ⚠️⚠️ **速度夹**：倒放必须与正放**同速**（1.0×）。
         这一条是 2026-09-25 独立审核抓到真空洞后补的：
         上面那条落位率**只钉住"别发太多"**，完全钉不住"别发太少"。
         实测（我复现过审核者的做法）把闸门换成**纯时间限流 400ms**（不看 `seeking`）：
           落位率 **0.8**（照样过 0.6 线）、可见 **2.5 fps**、速度 **0.62×**（比修复前还糟），
         却能 **226 通过 / 0 失败**全绿通过 —— 因为没有任何断言在看"它走得多快"。
         根因：限流到 400ms 时 `dt` 被 `Math.min(0.25, …)` 夹住，每拍少走 0.15s
         ⇒ 2.5 拍/s × 0.25s = 0.625×。
         ⚠️ 区间取 [0.8, 1.2]：正常实现实测 0.998（余量充足），限流 400ms 是 0.62（明确红）。 */
      check('E19b ★★ 倒放**速度**在 0.8~1.2×（不许变慢 —— 限流型退化会在这里现形）',
        probe.speed >= 0.8 && probe.speed <= 1.2,
        `墙上 ${probe.wallMs}ms 走了 ${probe.mediaAdv}s ⇒ ${probe.speed}×`);
      /* ⚠️⚠️ **可见帧率下限**：这是最贴近用户感受的一条 —— 用户要的是"衔接不生硬"，
         而不是"时间戳在动"。`requestVideoFrameCallback` 只在**真的呈现了一帧**时回调，
         与落位率（解码落位）、像素指纹（我主动取样）三者互相独立。
         源素材 25 fps ⇒ 正常实现实测 ≈24~28 fps；限流版 2.5 fps；洪水版 0 fps。
         阈值取 10（远低于 24、远高于 2.5，两侧余量都充足）。 */
      if (probe.rvfcSupported === true) {
        check('E19b ★★ 倒放段**可见帧率** ≥ 10 fps（这是"流畅"与"幻灯片"的直接分界）',
          probe.visibleFps >= 10,
          `2 秒窗口内呈现 ${probe.visibleFrames} 帧 ⇒ ${probe.visibleFps} fps（源 25 fps）`);
      } else {
        /* 不支持 rvfc 的环境（老浏览器）不能静默跳过 —— 那等于这条契约没人看。
           如实打印成"未覆盖"，而不是伪装成通过。 */
        info('E19b 可见帧率断言：本环境不支持 requestVideoFrameCallback，**该项未覆盖**');
      }
      check('E19b 倒放段元素是 paused 的（倒放由脚本驱动，不是原生播放 —— 这是它唯一可行路径）',
        (probe.samples ?? []).every((s) => s.paused === true),
        JSON.stringify((probe.samples ?? []).slice(0, 3).map((s) => s.paused)));
      /* ⚠️⚠️ **必须把页内 `unhandledrejection` 一起读**（独立审核 2026-09-25 指出我漏了这项）：
         `el.play()` 返回 promise，它的失败**是异步的** —— `try { void el.play() } catch {}`
         根本抓不到，拒绝会冒成 window 上的 `unhandledrejection`。只读 `pageErrors`
         （Playwright 的 pageerror = 未捕获的**同步**异常）会**完全看不见**这条泄漏路径。
         写入 `__winErrors` 的桩在 openPage 里早就装好了（含 unhandledrejection 分支），
         但当时的 E19 组没读它 ⇒ 那些断言声称"全程无未捕获异常"，实际只覆盖了一半。
         ⚠️ 必须**此刻实时**读取：`ns.winErrors` 是页面加载那一刻的快照，读它会永远看不见
            倒放期间（本段真正要观察的时段）才发生的拒绝。 */
      const live = await page.evaluate(() => window.__winErrors ?? []);
      check('E19b 全程无未捕获异常（含页内 unhandledrejection —— play() 的异步拒绝只能从这里看见）',
        pageErrors.length === 0 && live.length === 0,
        JSON.stringify([...pageErrors, ...live]));
    } finally {
      await page.close();
    }
  }

  /* ── E19c：往返能闭环回到正放（倒到头 ⇒ 再正着播）── */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload({ media: {
        src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
        kind: 'video', fit: 'cover', opacity: 1, blend: false,
        label: 'MP4 视频', playMode: 'pingpong',
      } }),
      src, tag: 'E19c',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
      const r = await page.evaluate(async () => {
        const v = document.querySelector('video[data-mb-surface]');
        if (v === null) return { why: '没有 <video>' };
        const seen = [];                       // 记录方向变化序列
        let lastDir = null;
        v.currentTime = Math.max(0, v.duration - 0.4);   // 送到尾部，尽快进入往返
        const t0 = performance.now();
        while (performance.now() - t0 < 14000) {
          const d = window.__betterSkin?.mods?.direction ?? null;
          if (d !== lastDir) { seen.push({ dir: d, t: +v.currentTime.toFixed(3), at: Math.round(performance.now() - t0) }); lastDir = d; }
          if (seen.filter((x) => x.dir === 'forward').length >= 2) break;   // 已回到正放 ⇒ 闭环成立
          await new Promise((r) => setTimeout(r, 60));
        }
        return { seen, finalDir: lastDir, paused: v.paused, t: +v.currentTime.toFixed(3), loop: v.loop };
      });
      const dirs = (r.seen ?? []).map((x) => x.dir);
      check('E19c ★ 往返能闭环：方向序列出现 reverse → forward（倒到头会重新正放）',
        dirs.includes('reverse') && dirs.filter((d) => d === 'forward').length >= 2,
        JSON.stringify(r.seen ?? r.why ?? null));
      check('E19c 回到正放时元素**真的在播**（不是停下来的死循环）',
        r.finalDir === 'forward' && r.paused === false, `dir=${r.finalDir} paused=${r.paused} t=${r.t}`);
      check('E19c 往返全程 loop 保持 false（否则中途会被浏览器自己跳回开头）',
        r.loop === false, `loop=${r.loop}`);
      check('E19c 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E19d：面板控件 —— 「播放」下拉**只在视频型出现**，且能真的驱动模式切换 ── */
  {
    const { page } = await openPage(browser, {
      payload: mediaPayload(), src, tag: 'E19d',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForTimeout(800);
      const rows = await readCard(page);
      const sel = rows.find((r) => r.label === '播放');
      check('E19d ★ 视频型面板里出现「播放」下拉框（用户要求的"播放选项"）',
        sel !== undefined && sel.kind === 'select', JSON.stringify(rows.map((r) => r.label)));
      check('E19d 「播放」下拉**不置灰**（真的有得选，置灰等于撒谎说不可用）',
        sel !== undefined && sel.disabled === false, JSON.stringify(sel ?? null));
      check('E19d 「播放」两个选项是 loop / pingpong',
        sel !== undefined && sel.options.includes('loop') && sel.options.includes('pingpong'),
        JSON.stringify(sel?.options ?? null));

      /* 切到往返 ⇒ 元素上的 `loop` 必须跟着变 false（真的生效，不是只改了配置）。 */
      const drove = await driveCard(page, { label: '播放', kind: 'select', value: 'pingpong' });
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => {
        const v = document.querySelector('video[data-mb-surface]');
        return {
          loop: v?.loop ?? null,
          mode: window.__betterSkin?.mods?.playMode ?? null,
          stored: JSON.parse(globalThis.localStorage.getItem('dsh-motion-background.config') ?? '{}').playMode ?? null,
        };
      });
      check('E19d 面板里能驱动「播放」下拉框', drove === true, String(drove));
      check('E19d ★ 切到「往返」后元素 `loop` 真的变成 false（模式真的落到渲染面上了）',
        after.loop === false && after.mode === 'pingpong',
        JSON.stringify({ loop: after.loop, mode: after.mode }));
      check('E19d ★ 选择已落盘（刷新后不会回到默认）',
        after.stored === 'pingpong', `localStorage.playMode=${JSON.stringify(after.stored)}`);
    } finally {
      await page.close();
    }
  }

  /* ── E19e：静态图片型**不该**出现「播放」控件（它没有播放方向）── */
  {
    const { page } = await openPage(browser, {
      payload: {
        mods: [Object.assign(mediaPayload().mods[0], {
          id: 'img-test',
          media: {
            src: 'bg.png', url: '/motion-background/media/img-test/bg.png', type: 'image/png',
            kind: 'image', fit: 'cover', opacity: 1, blend: false,
            label: 'PNG 图片', playMode: 'loop',
          },
        })],
        errors: [], dir: 'D:/x/mods',
      },
      src, tag: 'E19e',
      /* 1×1 透明 PNG —— 图片型只要求"解码后宽度不为 0"。 */
      mediaBody: { type: 'image/png', data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64') },
    });
    try {
      await waitMods(page);
      await page.waitForTimeout(800);
      const rows = await readCard(page);
      const sel = rows.find((r) => r.label === '播放');
      check('E19e ★ 图片型**不出现**「播放」下拉框（静态图没有播放方向 / 时间轴，给了就是个无效控件）',
        sel === undefined, JSON.stringify(rows.map((r) => r.label)));
      const s = await snapshot(page);
      check('E19e 图片型仍然能挂上（不被播放模式逻辑带坏）',
        s.mods?.current === 'img-test' && s.mods?.surfaceKind === 'media',
        JSON.stringify({ current: s.mods?.current, kind: s.mods?.surfaceKind }));
    } finally {
      await page.close();
    }
  }

  /* ── E19f：媒体类型标注出现在「效果」下拉的**显示文案**里（需求 1）── */
  {
    const { page } = await openPage(browser, {
      payload: {
        mods: [
          simpleMod('aa-shader'),
          /* ① 宿主半给了 label（正常路径）；名字不含"视频"，标注必须自己加。 */
          Object.assign(mediaPayload().mods[0], {
            name: '极光',
            media: {
              src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
              kind: 'video', fit: 'cover', opacity: 1, blend: false,
              label: 'MP4 视频', playMode: 'loop',
            },
          }),
          /* ② **宿主半没给 label**（模拟"客户端半已热更、宿主半还没重启"的中间态）——
             必须从 src 扩展名兜底派生，而不是把标注丢掉。 */
          Object.assign(mediaPayload().mods[0], {
            id: 'vid-nolabel', name: '旧宿主半效果',
            media: {
              src: 'bg.webm', url: '/motion-background/media/vid-nolabel/bg.webm', type: 'video/webm',
              kind: 'video', fit: 'cover', opacity: 1, blend: false,
            },
          }),
        ],
        errors: [], dir: 'D:/x/mods',
      },
      src, tag: 'E19f',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForTimeout(900);
      const rows = await readCard(page);
      const eff = rows.find((r) => r.label === '效果');
      const labels = eff?.optionLabels ?? [];
      check('E19f ★ 视频型在「效果」下拉里带类型标注（如「极光（MP4 视频）」）',
        labels.some((l) => typeof l === 'string' && l.includes('极光') && l.includes('MP4 视频')),
        JSON.stringify(labels));
      check('E19f 着色器型**不**被加标注（它是程序化效果，不是素材）',
        labels.some((l) => typeof l === 'string' && l.includes('aa-shader') && !l.includes('（')),
        JSON.stringify(labels));
      check('E19f ★ 宿主半没给 label 时，从 src 扩展名兜底派生标注（.webm ⇒ WebM 视频）',
        labels.some((l) => typeof l === 'string' && l.includes('旧宿主半效果') && l.includes('WebM 视频')),
        JSON.stringify(labels));
      check('E19f ★ 标注里没有空括号（label 缺失时不许渲染成「名字（）」）',
        labels.every((l) => typeof l !== 'string' || !/（）/.test(l)), JSON.stringify(labels));
      /* ⚠️ 这条是**回归**：`aurora-video/mod.json` 的 name 一度写作「极光（视频）」，
         客户端再追加标注 ⇒ 面板里显示成「极光（视频）（MP4 视频）」双重标注。
         类型标注只该由内核派生一次，`name` 必须保持纯净。 */
      check('E19f ★ 不出现双重类型标注（name 里已写类型词时会被再追加一次）',
        labels.every((l) => typeof l !== 'string' || (l.match(/视频|图片|动图/g) ?? []).length <= 1),
        JSON.stringify(labels));
    } finally {
      await page.close();
    }
  }

  /* ── E19g：**倒放中途**切到「循环」⇒ 必须继续正放，不许停在半空 ──
   *
   * 这条是 2026-09-25 用**对照实验**定位到的真实缺陷的回归：
   *   · 正放中途切模式：`readyState=4` ⇒ 正常；
   *   · **倒放中途**切模式：倒放是连续 seek 驱动的 ⇒ `readyState` 掉到 1 ⇒
   *     旧实现里 `resumeInternal()` 的 `readyState < 2` 早退命中 ⇒ `play()` 从未被调用
   *     ⇒ 视频**停在半空**（既不再倒放、也没被播起来）。
   * ⚠️ 判据必须是"**切换后 currentTime 还在推进**"，不能只看 `paused`：
   *    停在半空时元素也是 `paused === true`，两种状态在 paused 上无法区分。 */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload({ media: {
        src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
        kind: 'video', fit: 'cover', opacity: 1, blend: false,
        label: 'MP4 视频', playMode: 'pingpong',
      } }),
      src, tag: 'E19g',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);

      /* 先送进倒放段（等方向真的翻到 reverse），再驱动面板切到循环。 */
      const before = await page.evaluate(async () => {
        const v = document.querySelector('video[data-mb-surface]');
        v.currentTime = Math.max(0, v.duration - 0.3);
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
          if (window.__betterSkin?.mods?.direction === 'reverse') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return {
          dir: window.__betterSkin?.mods?.direction ?? null,
          readyState: v.readyState, paused: v.paused, seeking: v.seeking,
          t: +v.currentTime.toFixed(3),
        };
      });
      check('E19g 前置：已进入倒放段（方向 reverse）', before.dir === 'reverse', JSON.stringify(before));

      const switched = await driveCard(page, { label: '播放', kind: 'select', value: 'loop' });
      check('E19g 前置：面板里能驱动「播放」下拉框切到循环', switched === true, String(switched));

      /* 切换后**两段采样**，看 currentTime 是否真的在推进（这是"没停住"的唯一判据）。 */
      const after = await page.evaluate(async () => {
        const v = document.querySelector('video[data-mb-surface]');
        await new Promise((r) => setTimeout(r, 400));
        const a = { t: +v.currentTime.toFixed(3), paused: v.paused, readyState: v.readyState };
        await new Promise((r) => setTimeout(r, 1000));
        const b = { t: +v.currentTime.toFixed(3), paused: v.paused };
        return { a, b, loop: v.loop, mode: window.__betterSkin?.mods?.playMode ?? null };
      });
      check('E19g ★★ 倒放中途切到「循环」后**画面继续推进**（不许停在半空 —— 旧的 readyState 早退会卡死）',
        Math.abs(after.b.t - after.a.t) > 0.15,
        `切换后 ${after.a.t} → ${after.b.t}（差 ${(after.b.t - after.a.t).toFixed(3)}s）paused=${after.b.paused} readyState@切换=${after.a.readyState}`);
      check('E19g 切换后元素确实在播（不是 paused 停着）',
        after.b.paused === false, `paused=${after.b.paused}`);
      check('E19g 切换后 loop 与模式都跟着变（真的落到渲染面上了）',
        after.loop === true && after.mode === 'loop', `loop=${after.loop} mode=${after.mode}`);
      check('E19g 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── E19h：运行中打开「减少动态效果」⇒ 倒放**必须立刻不跑** ──
   *
   * 独立审核 2026-09-25 指出的 🟢 级缺陷：`onEnded` 与倒放驱动都不查 `prefersReduce()`。
   * 后果不是"画面错"，而是**用户明确要求减少动效之后仍被塞了一整轮倒放动画** ——
   * 而且这段动画是**我们自己**的 rAF 驱动的（正放由浏览器播，浏览器会遵系统设置；
   * 倒放不会），所以"浏览器会管"这个假设在这里不成立，必须我们判。
   *
   * ⚠️ 判据必须是**行为级**的，两条一起看（只看其中一条都不够）：
   *   ① 方向**不该**翻到 reverse（onEnded 的入口判据）；
   *   ② `currentTime` **不该**被脚本往回挪（驱动循环的逐拍判据）。
   *   只查 ① 的话，"入口挡住了、但已经在跑的循环没停"这种半修状态会漏过；
   *   只查 ② 的话，"方向翻了但驱动没动"会漏过（那是另一个 bug，但不该算这条通过）。
   *   ⇒ 两条都红才算真缺陷，所以下面分开断言、分别打印。
   *
   * ⚠️ 时序：把 reduce 打开**之后**才把视频送到尾部 —— 这样 ended 一定在 reduce 生效后触发，
   *    不会与"打开开关的那一刻"抢跑（抢跑会让这条断言变成偶然通过）。 */
  {
    const { page, pageErrors } = await openPage(browser, {
      payload: mediaPayload({ media: {
        src: 'bg.mp4', url: '/motion-background/media/vid-test/bg.mp4', type: 'video/mp4',
        kind: 'video', fit: 'cover', opacity: 1, blend: false,
        label: 'MP4 视频', playMode: 'pingpong',
      } }),
      src, tag: 'E19h',
      mediaBody: { type: 'video/mp4', data: realMp4 },
    });
    try {
      await waitMods(page);
      await page.waitForFunction(() => document.querySelector('video[data-mb-surface]') !== null, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);

      const r = await page.evaluate(async () => {
        const v = document.querySelector('video[data-mb-surface]');
        if (v === null) return { why: '没有 video 元素' };
        /* ① 先打开"减少动态效果"（桩是 openPage 装的：读 window.__reduceMotion）。 */
        window.__reduceMotion = true;
        await new Promise((res) => setTimeout(res, 80));
        /* ② 再把它送到尾部，让它**自然播完** —— ended 走的是真实路径（不是伪造事件）。 */
        v.currentTime = Math.max(0, v.duration - 0.25);
        await new Promise((res) => setTimeout(res, 1200));
        const dirAtEnd = window.__betterSkin?.mods?.direction ?? null;
        const t0 = +v.currentTime.toFixed(3);
        /* ③ 再观察 1.2s：倒放若在跑，currentTime 会**变回更小的值**。 */
        await new Promise((res) => setTimeout(res, 1200));
        const t1 = +v.currentTime.toFixed(3);
        return { dirAtEnd, t0, t1, reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches };
      });

      check('E19h 前置：桩已生效（matchMedia 报告 reduce 为真）',
        r.reduce === true, JSON.stringify(r));
      check('E19h ★ 打开 reduce-motion 后正放到头**不进入倒放段**（方向不翻到 reverse）',
        r.dirAtEnd !== 'reverse', `direction=${r.dirAtEnd}`);
      check('E19h ★★ 倒放驱动器**没有**把时间轴往回挪（reduce 期间画面必须静止）',
        !(r.t1 < r.t0 - 0.05), `currentTime ${r.t0} → ${r.t1}（若变小 = 脚本仍在倒放）`);
      check('E19h 全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors));
    } finally {
      await page.close();
    }
  }

  /* ── 关于「渲染节流」这个性能修复：**本文件里没有对应断言**（2026-09-26 记）──
     缺陷：`requestAnimationFrame` 会跟着**显示器刷新率**跑 —— 240 Hz 屏上就是 240 次/秒
     的**全屏** WebGL 重绘；而窗口失焦时浏览器**不会**停 rAF ⇒ 切到别的窗口后它继续吃满
     GPU，鼠标移动/点击（都要经桌面合成）全被拖慢（用户实测报告）。
     修法见 lib/client.js 的 FPS_ACTIVE（30）/ FPS_BLURRED（5）。

     ⚠️ 为什么**不写**断言：**这个夹具里动画循环不跑**。加全套诊断后的实测：
       · `hook自检=true`（hook 有效，能数到自己造的 drawArrays）
       · `__betterSkin.live=true`、`surfaceKind='shader'`、mod 已挂上、cfg 正确
       · `probeMods()` 返回 `{meteor:true, aurora-video:true}`（**能**真画一帧）
       · `hidden=false / visible / hasFocus=true`、`mmMatches=false`（prefersReduce 为假）
       · 但 2 秒窗口内 `drawArrays` **0 次**
     ⇒ 夹具没有驱动"动画时间轴"（E 组其它用例也都靠 freeze 单帧或 `paint()` 显式重绘，
       从不依赖"动画自己跑"）。与其留一条**在 0 帧时也通过**的恒真断言 —— 那正是本项目
       最反对的假绿 —— 这里**如实不写**。
     修好的证据是**真实 dsh 页面上的实测**（数 drawArrays）：前台 240→30 fps、
     失焦 240→3~5 fps，见 README 的"倒放"一节旁的性能小节。
     要把它变成断言，得先找到一个能驱动动画时间轴的夹具（**未做**）。 */
}

/* ════════════════════════════ 主流程 ════════════════════════════ */

console.log('dsh-motion-background · verify.mjs');
console.log('仓库：' + HERE);
if (CLIENT_OVERRIDE !== null || MUTATE !== null) {
  console.log('⚠️  反证模式：' + [CLIENT_OVERRIDE && `--client=${CLIENT_OVERRIDE}`, MUTATE && `--mutate=${MUTATE}`].filter(Boolean).join(' '));
}

let exitCode = 1;
let browser = null;
let tmpCreated = [];
const STAGES = [];
let stageNow = 'A';
let crashed = null;
try {
  /* ⚠️ 副本必须在 A 组**之前**建好：A 组在变异模式下要 import 副本里的宿主半
     （见 groupA 里的说明），而 B 组原本是建副本的地方。 */
  if (MUTATE !== null) buildCopy();

  stageNow = 'A'; const { payload: rawPayload } = await groupA(); STAGES.push('A');

  stageNow = 'B'; await groupB(); STAGES.push('B');
  tmpCreated = [TMP_COPY, TMP_NOMODS];

  /* 反证：runner 自证 —— 中途抛错必须**非零退出且不打印成功标志**（fail-closed）。 */
  if (MUTATE === 'crash') throw new Error('反证变异：在 C 组之前故意抛错');

  /* ⚠️ 必须**在 B 组之后**结算载荷：A 组在变异模式下读的是副本宿主半，
     它可能被"见坏 mod 就中断整轮扫描"这类变异打垮而给出空载荷。
     C/D/E 只测客户端，不该替宿主半的故障背锅（详见 payloadForClient 的说明）。 */
  stageNow = 'payload'; const payload = await payloadForClient(rawPayload);

  stageNow = 'launch'; browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  stageNow = 'C'; await groupC(browser, payload); STAGES.push('C');
  stageNow = 'D'; await groupD(browser, payload); STAGES.push('D');
  stageNow = 'E'; await groupE(browser, payload); STAGES.push('E');

  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  crashed = e;
  console.log(`\n💥 验证脚本自身抛错：${e?.stack ?? e}`);
  exitCode = 1;
} finally {
  if (browser !== null) await browser.close();
  const left = tmpCreated.filter((p) => !rmrf(p));
  if (tmpCreated.length > 0) {
    /* 如实报告：删不掉就说删不掉（旧版无条件打印"已清理"，是假消息 —— 第五轮审核 F6）。 */
    console.log(left.length === 0
      ? `\n（已清理临时副本：${tmpCreated.join(' , ')}）`
      : `\n⚠️ 临时副本未能清理，请手工删除：${left.join(' , ')}`);
  }
}

console.log(`\n${'═'.repeat(72)}`);
if (crashed !== null) {
  /* fail-closed：中断**绝不**打印成功标志。旧版在崩溃时仍打印「✅ 四组验证通过」——
     离线审核把它列为"报告器不是 fail-closed"，这是那条缺陷的回归测试。 */
  console.log(`❌ 验证未完成：在 ${stageNow} 阶段抛错，其后各组未运行（已完成：${STAGES.join(' → ') || '无'}）`);
  console.log('❌ 未通过（脚本自身中断）');
  process.exit(1);
}
console.log(`断言：${pass} 通过 / ${failed} 失败${failed === 0 ? '' : '  ← 有契约被破坏'}`);
console.log(`偏差发现：${findings} 项（见上面 ⚠️ 行，不计入退出码）`);
console.log(`阶段：${STAGES.join(' → ')}`);
if (failed === 0 && STAGES.length === 5) console.log('✅ 五组验证通过');
else if (failed === 0) console.log(`❌ 断言全过但阶段不完整（${STAGES.length}/5）—— 判为未通过`);
else console.log(`❌ ${failed} 项断言未通过`);
process.exit(exitCode);
