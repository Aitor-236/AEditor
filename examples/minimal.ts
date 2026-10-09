import { Kernel, OutlineView, PreviewView } from '../src/index.ts';

/**
 * 最小可执行用例：20 行看懂内核的形状。
 * 运行： npm run minimal
 */

const kernel = new Kernel();
const preview = new PreviewView();
const outline = new OutlineView();
kernel.register(preview);
kernel.register(outline);

// 打字 = 向 op log 追加条目
for (const line of ['# 你好，内核\n', '这段文字来自 **op log**。\n', '- 视图按需订阅\n']) {
  kernel.insertText(kernel.createBlock(), line);
}

// 删除 = 墓碑；撤销 = 物化到第 N 条日志
kernel.deleteRange(kernel.blockIds()[1]!, 4, 8);
kernel.undo();

console.log(kernel.toMarkdown());
console.log('─'.repeat(40));
console.log(kernel.toHTML());
console.log('─'.repeat(40));
console.log(`大纲 ${outline.value?.length} 项 / 重算 ${outline.recomputes} 次，日志 ${kernel.logSize} 条`);
