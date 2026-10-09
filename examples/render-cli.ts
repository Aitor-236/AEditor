import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kernel, StatsView } from '../src/index.ts';

/**
 * 只读嵌入用法：把任意 Markdown 文件渲染成 HTML。
 * 用法： npm run render -- <file.md>
 */

const target = resolve(process.argv[2] ?? 'docs/markdown-rendering-kernel-design.md');
const markdown = readFileSync(target, 'utf8');

const kernel = new Kernel();
const stats = new StatsView();
kernel.register(stats);

// 按行成块地喂进内核（真实编辑器里这一步就是打字 / 粘贴）
for (const line of markdown.split(/(?<=\n)/)) {
  if (line.trim().length === 0) continue; // 空行只是块间分隔符，不作为空块喂入
  kernel.feed(line);
}

console.log(kernel.toHTML());
console.error(
  `\n[render-cli] ${target}\n` +
    `  块 ${stats.value?.blocks} / 标题 ${stats.value?.headings} / 字 ${stats.value?.chars} / 词 ${stats.value?.words}\n` +
    `  日志 ${kernel.logSize} 条（墓碑 ${kernel.tombstoneCount}），原文池 ${kernel.poolBytes} 字节`
);
