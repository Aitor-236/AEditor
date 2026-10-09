import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Kernel,
  OutlineView,
  PreviewView,
  StatsView,
  parseDocument,
  roundTrips,
  serialize
} from '../src/index.ts';

const CORPUS = [
  '',
  '\n',
  '# 标题\n',
  '###### 六级标题\n',
  '普通段落，里面有 **粗体**、*斜体*、`代码` 与 [链接](https://example.com)。\n',
  '- 无序一\n- 无序二\n',
  '1. 有序一\n2. 有序二\n',
  '> 引用一行\n',
  '```ts\nconst x: number = 1;\n```\n',
  '```\n未闭合的围栏\n',
  '| 等级 | 内容 |\n| --- | --- |\n| L0 | 纯文本 |\n',
  '# 头\n\n正文一。\n\n正文二。\n',
  '半闭合 **还没收尾\n',
  '\n\n\n前导空行\n\n'
];

const DOC = [
  '# Markdown 实时渲染内核\n',
  '内核只管**状态 + 解析 + 渲染 + 插件**。\n',
  '## 存储层\n',
  '- 原文池 appendPool\n',
  '- 语法日志 syntaxLog\n'
];

function buildAtOnce(lines: readonly string[]): Kernel {
  const kernel = new Kernel();
  for (const line of lines) kernel.insertText(kernel.createBlock(), line);
  return kernel;
}

function buildCharByChar(lines: readonly string[]): Kernel {
  const kernel = new Kernel();
  for (const line of lines) {
    const block = kernel.createBlock();
    for (const ch of line) kernel.insertText(block, ch);
  }
  return kernel;
}

test('可逆 parser：serialize(parse(md)) ≡ md 字节级成立', () => {
  for (const md of CORPUS) {
    assert.equal(serialize(parseDocument(md)), md, JSON.stringify(md));
    assert.ok(roundTrips(md), JSON.stringify(md));
  }
});

test('parse 是纯函数：parse(serialize(ast)) ≡ ast', () => {
  for (const md of CORPUS) {
    assert.deepEqual(parseDocument(serialize(parseDocument(md))), parseDocument(md));
  }
});

test('AST 带 sourcepos，且行内节点坐标落在块内', () => {
  const doc = parseDocument('内核只管**状态**。\n');
  const block = doc.blocks[0]!;
  assert.equal(block.role, 'paragraph');
  const strong = block.children.find((child) => child.kind === 'strong');
  assert.ok(strong);
  assert.equal(strong.sourcepos.start.offset, 4);
  assert.equal(strong.sourcepos.end.offset, 10);
  assert.equal(strong.raw, '**状态**');
});

test('日志条目分级：L2 块标记 / L1 行内语法 / L0 纯文本', () => {
  const kernel = buildAtOnce(['## 标题**粗**\n']);
  const kinds = kernel.entries.map((entry) => entry.kind);
  assert.ok(kinds.includes('NewBlock'));
  assert.ok(kinds.includes('L2'));
  assert.ok(kinds.includes('L1'));
  assert.ok(kinds.includes('L0'));
  const block = kernel.snapshot().blocks[0]!;
  assert.equal(block.role, 'heading');
  assert.deepEqual(
    block.segments.map((segment) => segment.level),
    ['L2', 'L0', 'L1', 'L0', 'L1', 'L0']
  );
});

test('块级自治：改一个块不动其它块的坐标', () => {
  const kernel = buildAtOnce(DOC);
  const ids = kernel.blockIds();
  const before = kernel.snapshot().blocks.find((block) => block.id === ids[4]!)!;
  kernel.deleteRange(ids[1]!, 0, 4);
  kernel.insertText(ids[3]!, 'x', 2);
  const after = kernel.snapshot().blocks.find((block) => block.id === ids[4]!)!;
  assert.deepEqual(after.segments, before.segments);
  assert.equal(after.text, before.text);
});

test('删除只记墓碑，可见文本由读时抵消得到', () => {
  const kernel = buildAtOnce(['abc**de**fg\n']);
  const block = kernel.blockIds()[0]!;
  const poolBefore = kernel.poolBytes;
  kernel.deleteRange(block, 1, 3);
  assert.equal(kernel.blockText(block), 'a**de**fg\n');
  assert.ok(kernel.tombstoneCount >= 1, '应产生墓碑');
  assert.ok(kernel.poolBytes >= poolBefore, '原文池只追加');
  const dead = kernel.snapshot().blocks[0]!.segments.filter((segment) => segment.dead);
  assert.ok(dead.length >= 1);
});

test('逐字符输入与整段输入等价（增量重放不吃文本）', () => {
  for (const lines of [DOC, ['# 头\n', 'para **bold** end\n', '```js\nlet a=1;\n```\n', '- a\n- b\n']]) {
    const a = buildAtOnce(lines);
    const b = buildCharByChar(lines);
    assert.equal(b.toMarkdown(), a.toMarkdown());
    assert.deepEqual(b.document.blocks.map((block) => block.role), a.document.blocks.map((block) => block.role));
  }
});

test('流式 feed 与整段输入等价，且半闭合语法不抛错', () => {
  const streamed = new Kernel();
  // 流式 chunk 不按行对齐：一行可以分多次到达，半闭合的 ** 先按字面量挂着
  const chunked = ['# 流式\n', '半闭合的 ', '**加粗', '收尾**', ' 结束\n', '```ts\nconst a = 1;\n```\n'];
  for (const chunk of chunked) streamed.feed(chunk);
  const whole = buildAtOnce(['# 流式\n', '半闭合的 **加粗收尾** 结束\n', '```ts\nconst a = 1;\n```\n']);
  assert.equal(streamed.toMarkdown(), whole.toMarkdown());
  assert.equal(streamed.document.blocks.length, whole.document.blocks.length);
});

test('未闭合围栏会持续吞内容，形成单个 code 块', () => {
  const kernel = new Kernel();
  kernel.feed('```ts\n');
  kernel.feed('const a = 1;\n');
  kernel.feed('const b = 2;\n');
  kernel.feed('```\n');
  kernel.feed('收尾。\n');
  assert.equal(kernel.document.blocks.length, 2);
  assert.equal(kernel.document.blocks[0]!.role, 'code');
  assert.equal(kernel.document.blocks[0]!.content, 'const a = 1;\nconst b = 2;\n');
});

test('时间旅行：撤销 / 重做 = 物化到第 N 条日志', () => {
  const kernel = buildAtOnce(DOC);
  const final = kernel.toMarkdown();
  kernel.deleteRange(kernel.blockIds()[1]!, 0, 4);
  const edited = kernel.toMarkdown();
  assert.notEqual(edited, final);
  kernel.undo();
  assert.equal(kernel.toMarkdown(), final);
  kernel.redo();
  assert.equal(kernel.toMarkdown(), edited);
  const version = kernel.projectAt(2);
  assert.equal(version.markdown, '# ');
  assert.equal(kernel.projectAt(3).markdown, '# Markdown 实时渲染内核\n');
  assert.equal(kernel.toMarkdown(), edited, 'projectAt 是只读投影，不改内核状态');
});

test('撤销后重新编辑会丢弃重做分支', () => {
  const kernel = buildAtOnce(['a\n', 'b\n']);
  kernel.undo();
  assert.ok(kernel.canRedo);
  kernel.insertText(kernel.blockIds()[0]!, 'x');
  assert.equal(kernel.canRedo, false);
  assert.equal(kernel.toMarkdown(), 'a\nx');
});

test('块角色由 L2 条目推导：删掉块标记就退回段落', () => {
  const kernel = new Kernel();
  const block = kernel.createBlock();
  kernel.insertText(block, '# 标题\n');
  assert.equal(kernel.document.blocks[0]!.role, 'heading');
  kernel.deleteRange(block, 0, 2);
  assert.equal(kernel.document.blocks[0]!.role, 'paragraph');
  assert.equal(kernel.blockText(block), '标题\n');
});

test('墓碑上限触发快照压缩，且可见态不变', () => {
  const kernel = new Kernel({ tombstoneLimit: 3 });
  const block = kernel.createBlock();
  kernel.insertText(block, '可见态保持稳定。\n');
  const expected = kernel.blockText(block);
  for (let i = 0; i < 6; i++) {
    kernel.insertText(block, '【草稿】', 0);
    kernel.deleteRange(block, 0, 4);
  }
  assert.ok(kernel.compactionCount >= 1, '应触发快照压缩');
  assert.equal(kernel.blockText(block), expected);
  assert.ok(kernel.tombstoneCount <= kernel.undoLimit + 1);
  assert.equal(kernel.toMarkdown(), expected);
});

test('视图按订阅重算：改段落不动大纲，改标题才动', () => {
  const kernel = buildAtOnce(DOC);
  const preview = new PreviewView();
  const outline = new OutlineView();
  const stats = new StatsView();
  kernel.register(preview);
  kernel.register(outline);
  kernel.register(stats);

  const paragraph = kernel.blockIds()[1]!;
  const heading = kernel.blockIds()[0]!;
  const base = { preview: preview.recomputes, outline: outline.recomputes, stats: stats.recomputes };

  kernel.insertText(paragraph, '（v2）', 0);
  assert.equal(preview.recomputes, base.preview + 1);
  assert.equal(stats.recomputes, base.stats + 1);
  assert.equal(outline.recomputes, base.outline, '大纲不订阅段落');

  kernel.insertText(heading, ' · v0.1', kernel.blockText(heading).length - 1);
  assert.equal(outline.recomputes, base.outline + 1);
  assert.equal(outline.value?.length, 2);
  assert.equal(stats.value?.headings, 2);
});

test('选区是一等公民，取每个 owner 的最新一条', () => {
  const kernel = buildAtOnce(DOC);
  const [first, second] = kernel.blockIds() as [number, number];
  kernel.setSelection('user:aitor', first, 0, 3);
  kernel.setSelection('user:aitor', second, 2, 5);
  kernel.setSelection('ai:assistant', first, 1, 1);
  const selections = kernel.selections();
  assert.equal(selections.length, 2);
  const mine = selections.find((selection) => selection.owner === 'user:aitor')!;
  assert.equal(mine.block, second);
  assert.equal(mine.anchor, 2);
  assert.equal(mine.head, 5);
});

test('toMarkdown / toHTML 反映当前可见态', () => {
  const kernel = buildAtOnce(DOC);
  assert.equal(kernel.toMarkdown(), DOC.join(''));
  const html = kernel.toHTML();
  assert.match(html, /<h1>/);
  assert.match(html, /<strong>状态 \+ 解析 \+ 渲染 \+ 插件<\/strong>/);
  assert.match(html, /<ul>/);
});
