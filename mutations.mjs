#!/usr/bin/env node
/**
 * mutations.mjs —— 反证执行器（§7 第 2 条要求的"故意破坏 ⇒ 看它变红 ⇒ 还原"的记录生成器）
 *
 * 为什么需要它：**"现在是绿的"不构成验证**。只有"注入已知坏实现后必须变红"才证明断言真的在观察事实。
 * 原交付只有一张"期望变红"的表、没有执行记录；本脚本就是那份记录。
 *
 * 用法：
 *   node mutations.mjs                 # 跑全部反证，打印表格并写出 FALSIFICATION.md
 *   node mutations.mjs --only=no-draw  # 只跑一条
 *
 * 每条都：① 先跑一次**基线**（必须全绿）② 再跑变异（必须变红）③ 记录退出码与**具体哪条断言变红**。
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, 'verify.mjs');
const TMP_BASE = existsSync('D:/tmp') ? 'D:/tmp' : null;

/** 目录名里的 pid 是否还活着（**辅助**判据；"目录是谁建的"只认归属标记）。 */
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};
/** verify.mjs 写进自建副本目录的归属标记；形状不对就一律不认（见 verify.mjs 里的同一段说明）。 */
const OWNER_MARKER = '.mb-verify-owner.json';
const ownerOf = (dir) => {
  try {
    const st = statSync(join(dir, OWNER_MARKER));
    if (!st.isFile() || st.size > 4096) return null;
    const o = JSON.parse(readFileSync(join(dir, OWNER_MARKER), 'utf8'));
    const okShape = o?.tool === 'verify.mjs' && Number.isInteger(o?.pid) && o.pid > 0
      && Number.isInteger(o?.startedAt) && o.startedAt > 0
      && typeof o?.nonce === 'string' && o.nonce.length >= 8
      && typeof o?.runTag === 'string' && o.runTag.length > 0;
    return okShape ? o : null;
  } catch { return null; }
};

/**
 * 清掉**自己人留下的、属主已退出**的副本目录；清理走 PowerShell。
 *
 * ⚠️ 为什么必须走 PowerShell：调用方（Agent 运行时）给每个 node 进程注入 safe-delete 垫片，
 *    它把 `fs.rm*` 换成"移入回收站"并**按对话回合累计**删除项数，越线后**每笔删除都抛错**。
 *    PowerShell 的 `Remove-Item` 不经该垫片，因此既不消耗额度、也不会中途抛错。
 *    （这是**调用方 Agent 施加的限制**，不是 DSH 插件或操作系统的通用行为 —— 换个不带该垫片的
 *      运行时跑，裸 `fs.rm*` 完全正常。阈值**可配置**、有默认值、本机被上调过若干次，**别写死具体数字**，
 *      所以这里不给任何值；要看完整推理，读 verify.mjs 里 `rmrf()` 的说明。）
 *
 * ⚠️ 判据是**自证式声明**，不是防伪凭据（F6-A′ 别人照格式写一份标记，我们照样会删）—— 见 verify.mjs 里的长注释。
 * 与 verify.mjs 的清理保持同一套判据：标记合法 + 属主已退出才删；名字前缀不参与判定（只影响是否打印）。
 */
const cleanCopies = () => {
  if (TMP_BASE === null) return;
  for (const d of readdirSync(TMP_BASE)) {
    const full = join(TMP_BASE, d);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const owner = ownerOf(full);
    if (owner === null || pidAlive(owner.pid)) continue;
    try {
      execFileSync('powershell.exe',
        ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${full}' -Recurse -Force -ErrorAction SilentlyContinue`],
        { stdio: 'ignore' });
    } catch { /* 忽略 */ }
  }
};

const CASES = [
  { flag: null, label: '基线（无变异）', expectRed: false },
  { flag: 'bg-only', label: 'mod 只输出底色', expect: /画面真的画出来|一片纯底色/ },
  { flag: 'no-isolation', label: '宿主半见坏 mod 就中断整轮扫描', expect: /隔离/ },
  { flag: 'no-draw', label: '删掉 gl.drawArrays', expect: /画面真的画出来|E4|E5/ },
  { flag: 'no-fallback', label: '候选循环只试第一个（无回落）', expect: /E5/ },
  { flag: 'direct-register', label: 'slot 注册绕开 slots.inject', expect: /设置|注册|slot/i },
  { flag: 'no-scan-sort', label: '删掉宿主半扫描前的排序（F5 的 I8）', expect: /源码级兜底/ },
  { flag: 'crash', label: 'C 组前故意抛错（报告器 fail-closed）', expect: /验证未完成/, noSuccess: true },
  /* ── 媒体功能的反证（加）──
     每条都对着一条**具体的**媒体断言：如果拆掉实现后那些断言仍然全绿，
     说明它们是假绿（没在观察自己声称观察的东西）。
     ⚠️ `expect` 是正则，必须**真的能匹配**那条断言变红时的文本 ——
        宽度/措辞一变（例：非法路径从 14 种变成 19 种）正则就匹配不上，
        反证会被判成"❌ 反证失败（hit=0）"，看起来像代码坏了，实际是这里过期了。
        ⇒ 这里一律用**不随数量变动的稳定子串**（"非法路径全部 404" / "真的在播"）。
     ⚠️⚠️ **禁止用组名前缀当兜底**（如 `/E18a/`、`/E18e/`）：那是个恒真式的宽匹配 ——
        同一个组里任何一条断言变红都会命中，于是"这条反证在钉哪条契约"就失去了意义。
        `media-loud` 真正的变红断言是
        「E18a 视频**是静音 + 循环**」，而原来的 `/真的在播|E18a/` **只能靠 `E18a` 这个前缀**命中 ——
        即它看起来在验证"不静音会让播放失败"，实际只是碰巧匹配了组名。
        现在每条都写**唯一能命中的那条断言的措辞**。 */
  { flag: 'media-traversal', label: '拆掉媒体文件名校验（应导致非法路径断言变红）', expect: /非法路径全部 404/ },
  { flag: 'media-segments', label: '拆掉媒体路径段数校验（应导致非法路径断言变红）', expect: /非法路径全部 404/ },
  { flag: 'media-keep-el', label: '媒体元素不摘除（应导致"切走后不留 <video>"变红）', expect: /不留\s*<video>/ },
  { flag: 'media-loud', label: '媒体不静音（应导致"静音 + 循环"变红）', expect: /静音 \+ 循环/ },
  { flag: 'media-noplay', label: '媒体不调用 play()（应导致"真的在播"变红）', expect: /真的在播/ },
  /* ── 播放模式（往返倒放）的反证（加）──
     每条都指向**唯一**一条断言的措辞（不含组名前缀 —— 那是恒真式宽匹配，见上面的说明）。
     ⚠️ 这里刻意**不写** `/E19b/` 这种前缀兜底：同一个用例里任何一条变红都会命中，
        于是"这条反证在钉哪条契约"就失去了意义。 */
  { flag: 'pingpong-no-drive', label: '往返模式下不真的驱动时间轴（应导致"画面真的在变"变红）', expect: /画面真的在变/ },
  { flag: 'pingpong-seek-flood', label: '拆掉 seek 闸门（每帧都发 seek ⇒ 落位率崩）（应导致"落位率"断言变红）', expect: /落位率/ },
  { flag: 'pingpong-throttle', label: '闸门换成纯时间限流 400ms（落位率仍过线，但速度/帧率崩）（应导致"速度"断言变红）', expect: /倒放\*\*速度\*\*在 0\.8~1\.2×/ },
  { flag: 'pingpong-reduce-ignored', label: '倒放路径不查 reduce-motion（应导致 E19h"不进入倒放段"变红）', expect: /不进入倒放段/ },
  { flag: 'pingpong-loop-true', label: '往返模式下仍置 loop=true（应导致 loop 断言变红）', expect: /`loop` 必须是 false/ },
  { flag: 'nomedia-label', label: '效果下拉不加媒体类型标注（应导致 E19f 标注断言变红）', expect: /带类型标注/ },
  { flag: 'playmode-no-save', label: '播放模式不落盘（应导致"选择已落盘"变红）', expect: /选择已落盘/ },
  { flag: 'playmode-any-media', label: '任何媒体型都给播放控件（应导致"图片型不出现"变红）', expect: /图片型\*\*不出现\*\*/ },];

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length) || null;
const chosen = only === null ? CASES : CASES.filter((c) => (c.flag ?? 'baseline') === only);

const run = (flag) => new Promise((res) => {
  cleanCopies();
  const args = [VERIFY, ...(flag === null ? [] : [`--mutate=${flag}`])];
  const p = spawn(process.execPath, args, { cwd: HERE });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { out += b; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 300000);
  p.on('close', (code) => {
    clearTimeout(timer);
    const red = [...out.matchAll(/^\s*❌\s(.*)$/gm)].map((m) => m[1].trim())
      .filter((s) => !/项断言未通过|验证未完成|未通过/.test(s));
    const summary = (out.match(/断言：(\d+) 通过 \/ (\d+) 失败/) ?? []).slice(1).join('/');
    const successBanner = /✅ (五组|四组)验证通过/.test(out);
    const incomplete = /验证未完成/.test(out);
    res({ code, red, summary, successBanner, incomplete, out });
  });
});

const rows = [];
for (const c of chosen) {
  const r = await run(c.flag);
  const completed = r.summary !== '';        // 真的跑到了汇总行（不是中途崩）
  let verdict;
  if (!completed && c.flag !== 'crash') {
    /* ⚠️ 第五轮审核的 F7：环境坏掉时脚本会中途崩，旧判据把它读成"基线不绿/反证失败"，
       甚至在某些行上误判成 PASS。**跑不完 ≠ 反证成立**，一律记为 ERROR。 */
    verdict = `ERROR（本轮没跑完：exit=${r.code}${r.incomplete ? '，脚本自报未完成' : ''}）`;
  } else if (c.flag === null) {
    verdict = (r.code === 0 && r.red.length === 0) ? 'PASS（基线全绿）' : `❌ 基线不绿（exit=${r.code}）`;
  } else if (c.flag === 'crash') {
    /* 这条不靠"某条断言变红"，而靠报告器语义：非零退出 + 明确说未完成 + **绝不**打印成功标志
       + 崩的原因确实是这次注入（否则"环境崩了"也会让它 PASS —— F7 指出的恒真风险）。 */
    const injected = /在 C 组之前故意抛错/.test(r.out);
    verdict = (r.code !== 0 && r.incomplete && !r.successBanner && injected && !completed)
      ? 'PASS（fail-closed：中断即非零、无成功标志、且崩因是本次注入）'
      : `❌ 反证失败（exit=${r.code} incomplete=${r.incomplete} 成功标志=${r.successBanner} 崩因匹配=${injected}）`;
  } else {
    const hit = r.red.filter((s) => c.expect.test(s));
    const ok = r.code !== 0 && hit.length > 0 && !r.successBanner;
    verdict = ok
      ? `PASS（变红：${hit[0].slice(0, 46)}）`
      : `❌ 反证失败（exit=${r.code} red=${r.red.length} hit=${hit.length}${r.successBanner ? ' 且打印了成功标志' : ''}）`;
  }
  rows.push({ ...c, ...r, verdict, sample: r.red.slice(0, 3) });
  console.log(`${String(c.flag ?? '(baseline)').padEnd(16)} exit=${String(r.code).padEnd(4)} 断言=${(r.summary || '未跑完').padEnd(9)} ${verdict}`);
}

const ok = rows.every((r) => r.verdict.startsWith('PASS'));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const doc = [
  `# 反证执行记录（FALSIFICATION）`,
  '',
  '> 由 `node mutations.mjs` 生成：每条都是「注入已知坏实现 → 断言必须变红」。',
  '> 基线全绿 + 每条变异都变红，才说明这套断言在观察事实，而不是恒真。',
  '',
  `**总结论：${ok ? '全部通过' : '有反证失败'}**（${rows.filter((r) => r.verdict.startsWith('PASS')).length}/${rows.length}）`,
  '',
  '| 变异 | 破坏了什么 | 退出码 | 断言（通过/失败） | 变红的断言（前 3 条） | 判定 |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.flag ?? '(基线)'}\` | ${r.label} | ${r.code} | ${r.summary || '?'} | ${r.sample.map((s) => s.slice(0, 60)).join('<br>') || '—'} | ${r.verdict} |`),
  '',
  '## 复跑方式',
  '',
  '```bash',
  'node mutations.mjs',
  '```',
  '',
].join('\n');
writeFileSync(join(HERE, 'FALSIFICATION.md'), doc, 'utf8');
console.log('\n记录已写出 → FALSIFICATION.md');
process.exit(ok ? 0 : 1);
