import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Kernel,
  OutlineView,
  PreviewView,
  StatsView,
  parseDocument,
  roundTrips,
  serialize
} from '../src/index.ts';

/**
 * 最小可执行用例：走一遍设计文档 §6.1 的 MVP 骨架。
 *
 *   1. 可逆 parser（创新点 1）
 *   2. 文档即日志 + 视图订阅（创新点 2）
 *   3. 分级条目 L0/L1/L2 与读时抵消
 *   4. 时间旅行（撤销 / 版本投影）
 *   5. 流式输入与半闭合语法容错
 *   6. 墓碑上限 + 快照压缩
 *   7. 选区一等公民（创新点 4）
 */

const BAR = '─'.repeat(72);

function section(index: number, title: string): void {
  console.log(`\n${BAR}\n${index}. ${title}\n${BAR}`);
}

function bullet(text: string): void {
  console.log(`   · ${text}`);
}

// ─────────────────────── 1. 可逆 parser ───────────────────────

section(1, '可逆语法：parse / serialize 是双射（创新点 1）');

const SAMPLES = [
  '# 标题\n',
  '内核只管**状态 + 解析 + 渲染 + 插件**，UI 交给使用方。\n',
  '- 原文池 appendPool\n- 语法日志 syntaxLog\n',
  '```ts\nconst x: number = 1;\n```\n',
  '> 文档即日志\n\n| 等级 | 内容 |\n| --- | --- |\n| L0 | 纯文本 |\n'
];

for (const sample of SAMPLES) {
  const ok = roundTrips(sample);
  bullet(`${ok ? '✓' : '✗'} round-trip  ${JSON.stringify(sample)}`);
}

const ast = parseDocument(SAMPLES[1]!);
const node = ast.blocks[0]!;
console.log('\n   AST（带 sourcepos，供光标映射使用）:');
console.log(`   role=${node.role}  raw=${JSON.stringify(node.raw)}  start=${JSON.stringify(node.sourcepos.start)}`);
for (const child of node.children) {
  console.log(`     - ${child.kind.padEnd(9)} raw=${JSON.stringify(child.raw)} @${child.sourcepos.start.offset}..${child.sourcepos.end.offset}`);
}
bullet(`serialize(parse(md)) === md → ${serialize(ast) === SAMPLES[1]}`);

// ─────────────────────── 2. 文档即日志 ───────────────────────

section(2, '文档即日志：打字 = 追加日志条目，视图按订阅重算（创新点 2）');

const kernel = new Kernel({ tombstoneLimit: 12 });
const preview = new PreviewView();
const outline = new OutlineView();
const stats = new StatsView();
kernel.register(preview);
kernel.register(outline);
kernel.register(stats);

const paragraphSource = [
  '# Markdown 实时渲染内核\n',
  '内核只管**状态 + 解析 + 渲染 + 插件**，UI 完全交给使用方。\n',
  '## 存储层\n',
  '- 原文池 appendPool：只追加的纯文本池\n',
  '- 语法日志 syntaxLog：只存语法事件\n'
];

const blockIds: number[] = [];
for (const text of paragraphSource) {
  const id = kernel.createBlock();
  kernel.insertText(id, text);
  blockIds.push(id);
}

const [titleBlock, bodyBlock, sectionBlock, listA, listB] = blockIds as [
  number,
  number,
  number,
  number,
  number
];

const tally = new Map<string, number>();
for (const entry of kernel.entries) tally.set(entry.kind, (tally.get(entry.kind) ?? 0) + 1);
console.log('   日志条目分布：');
for (const [kind, count] of tally) bullet(`${kind.padEnd(9)} × ${count}`);
bullet(`日志总长 ${kernel.logSize} 条，原文池 ${kernel.poolBytes} 字节`);

console.log('\n   物化后的文档（每行一个块）：');
for (const id of kernel.blockIds()) {
  const role = kernel.document.blocks[kernel.blockIds().indexOf(id)]?.role ?? '?';
  bullet(`[block ${id}] ${role.padEnd(9)} ${JSON.stringify(kernel.blockText(id))}`);
}

console.log('\n   只改一个段落 → 只有订阅它的视图重算：');
const before = { preview: preview.recomputes, outline: outline.recomputes, stats: stats.recomputes };
kernel.insertText(bodyBlock, '（v2）', 0);
bullet(`改段落：preview ${before.preview}→${preview.recomputes}  stats ${before.stats}→${stats.recomputes}  outline ${before.outline}→${outline.recomputes}（未订阅 paragraph，不重算）`);

const beforeHeading = outline.recomputes;
const titleText = kernel.blockText(titleBlock);
kernel.insertText(titleBlock, ' · 设计稿', titleText.length - 1);
bullet(`改标题：outline ${beforeHeading}→${outline.recomputes}（订阅了 heading）`);

// ─────────────────────── 3. 分级条目 + 读时抵消 ───────────────────────

section(3, 'L0 / L1 / L2 分级与「读时抵消」（§4.2 / §4.3）');

const snapshot1 = kernel.snapshot();
const bodyState = snapshot1.blocks.find((block) => block.id === bodyBlock)!;
console.log(`   块 ${bodyBlock} 的条目（level | recorded → visible | 文本）：`);
for (const segment of bodyState.segments) {
  const flag = segment.dead ? '墓碑' : ' 活 ';
  bullet(`${flag} ${segment.level}  [${segment.recorded.start},${segment.recorded.end}) → [${segment.visible.start},${segment.visible.end})  ${JSON.stringify(segment.text)}`);
}

console.log('\n   删除行内一段（"渲染 + "）—— 只记墓碑，原文池只增不减：');
const poolBefore = kernel.poolBytes;
const text = kernel.blockText(bodyBlock);
const from = text.indexOf('渲染 + ');
kernel.deleteRange(bodyBlock, from, from + '渲染 + '.length);
bullet(`删除前 ${JSON.stringify(text)}`);
bullet(`删除后 ${JSON.stringify(kernel.blockText(bodyBlock))}`);
bullet(`原文池 ${poolBefore} → ${kernel.poolBytes} 字节（只追加），墓碑 ${kernel.tombstoneCount} 个`);

const bodyAfter = kernel.snapshot().blocks.find((block) => block.id === bodyBlock)!;
for (const segment of bodyAfter.segments) {
  if (segment.dead) bullet(`墓碑 L?  recorded=[${segment.recorded.start},${segment.recorded.end})  ${JSON.stringify(segment.text)}`);
}

// ─────────────────────── 4. 时间旅行 ───────────────────────

section(4, '时间旅行：撤销 = 物化到第 N 条日志（§5.1）');

for (const mark of kernel.history) bullet(`标记 ${mark.index}: 日志长度 ${mark.ops}`);
const currentText = kernel.toMarkdown();
kernel.undo();
kernel.undo();
bullet(`撤销两次后：${JSON.stringify(kernel.toMarkdown())}`);
if (kernel.canRedo) kernel.redo(2);
bullet(`重做后回到：${JSON.stringify(kernel.toMarkdown())}  （一致=${kernel.toMarkdown() === currentText}）`);

const version = kernel.projectAt(4);
bullet(`projectAt(4) 的历史版本：${JSON.stringify(version.markdown)}`);

// ─────────────────────── 5. 流式输入 ───────────────────────

section(5, '流式输入：AI 输出与打字是同一件事（创新点 3）');

const streamed = new Kernel();
const chunks = ['# 流式输出\n', '半闭合的 **加粗还没', '收尾** 以及未闭合代码块：\n', '```ts\nconst a = 1;\n', 'const b = 2;\n', '```\n', '结束。\n'];

for (const chunk of chunks) {
  streamed.feed(chunk);
  const html = streamed.toHTML().replace(/\n/g, '');
  bullet(`chunk ${JSON.stringify(chunk)}\n       → ${html}`);
}
bullet(`半闭合阶段没有抛错，最终文档 ${streamed.blockIds().length} 个块`);

// ─────────────────────── 6. 墓碑上限 + 快照压缩 ───────────────────────

section(6, '墓碑上限 + 快照压缩（§4.4）');

bullet('tombstoneLimit = 4：每轮「插入草稿 → 删掉草稿」各留 1 个墓碑');
const churn = new Kernel({ tombstoneLimit: 4 });
const churnBlock = churn.createBlock();
churn.insertText(churnBlock, '墓碑管理：超上限就拍快照。\n');
bullet(`初始：日志 ${churn.logSize} 条，原文池 ${churn.poolBytes} 字节，墓碑 ${churn.tombstoneCount}`);
for (let round = 1; round <= 6; round++) {
  churn.insertText(churnBlock, '【草稿】', 0);
  churn.deleteRange(churnBlock, 0, 4);
  bullet(
    `round ${round}: 日志 ${String(churn.logSize).padStart(2)} 条，墓碑 ${String(churn.tombstoneCount).padStart(2)}，` +
      `原文池 ${String(churn.poolBytes).padStart(3)} 字节，压缩 ${churn.compactionCount} 次`
  );
}
bullet(`可见态始终是：${JSON.stringify(churn.blockText(churnBlock))}`);
bullet('快照压缩后时间旅行窗口重置：' + JSON.stringify(churn.history));

// ─────────────────────── 7. 选区一等公民 ───────────────────────

section(7, '选区是一等公民（创新点 4）');

kernel.setSelection('user:aitor', bodyBlock, 6, 12);
kernel.setSelection('ai:assistant', listA, 0, 4);
for (const selection of kernel.selections()) {
  bullet(`${selection.owner} → block ${selection.block} [${selection.anchor}, ${selection.head})`);
}

// ─────────────────────── 8. 渲染产物 ───────────────────────

section(8, '渲染产物：toHTML()（生态适配接口）');

console.log(kernel.toHTML());

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'preview.html');
writeFileSync(outFile, `<!doctype html><meta charset="utf-8">\n${kernel.toHTML()}\n`, 'utf8');
bullet(`已写出预览文件：${outFile}`);

console.log(`\n${BAR}\nDemo 结束。\n${BAR}`);
