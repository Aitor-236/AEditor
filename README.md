# aeditor-kernel

`docs/markdown-rendering-kernel-design.md` 设计文档的 **MVP 可执行用例**（TypeScript，零运行时依赖）。

内核不是编辑器，而是「以 Markdown 为输入语言、以操作日志为心脏的增量计算引擎」——
当前文档、渲染结果、大纲、字数统计，全都是同一条 op log 上的**派生视图**。

## 快速开始

需要 Node ≥ 22.18（直接运行 `.ts`，无需构建）。

```bash
npm run minimal   # 最小可执行用例：20 行看完内核形状
npm run demo      # 完整走查：8 个环节对应设计文档的 4 个创新点
npm run test      # 16 个用例（round-trip 双射 / 墓碑 / 时间旅行 / 视图订阅 / 压缩…）
npm run render -- docs/markdown-rendering-kernel-design.md   # 只读嵌入：md → html
npm run typecheck # tsc --noEmit（需先 npm install 或复用本地 typescript）
```

## 结构

```
src/
  types.ts       Span / BlockNode / InlineNode / sourcepos —— 公共类型
  pool.ts        原文池 appendPool：只追加纯文本，删除只是"不再被引用"
  oplog.ts       语法日志：L0/L1/L2/Del/Sel/NewBlock，条目用稳定 ID + 锚点互相引用
  syntax.ts      输入分级器：detectShape / tokenize / computePieces
  parser.ts      可逆 parser：parse ⇄ serialize 双射，每个节点带 sourcepos
  materialize.ts 增量物化：块级遍历 + 读时抵消（lazy delta）
  render.ts      AST → HTML
  views.ts       物化视图基类 + Preview / Outline / Stats 三个视图
  kernel.ts      内核：编辑 API、物化调度、视图通知、时间旅行、快照压缩
examples/
  minimal.ts     最小可执行用例
  demo.ts        端到端走查（会写出 dist/preview.html）
  render-cli.ts  只读嵌入：渲染任意 md 文件
test/kernel.test.ts
```

## 设计文档 → 代码映射

| 设计文档 | 落地位置 | 实现要点 |
|---|---|---|
| §3.2 创新 1 可逆语法 | `parser.ts` | 节点 `raw` 直接取源串切片，`serialize = 拼接 raw`，字节级 `serialize(parse(md)) ≡ md`；`parse` 是纯函数，故 `parse(serialize(ast)) ≡ ast` |
| §3.2 创新 2 文档即日志 | `kernel.ts` + `views.ts` | 一切编辑 = 向 op log 追加条目；视图声明订阅（块角色 / 条目等级），只有命中的视图重算 |
| §3.2 创新 4 选区一等公民 | `oplog.ts` `SelectionEntry` | `Selection(owner, block, anchor, head)` 作为日志条目，与文档内容同一平面 |
| §4.1 原文池 + 语法日志 | `pool.ts` `oplog.ts` | 池只追加不修改；日志条目用稳定 ID（锚点）而非位置坐标引用彼此，重放任意前缀结果确定 |
| §4.2 条目分级 L0/L1/L2 | `syntax.ts` `computePieces` | 块标记 → L2，行内语法（`**`/`` ` ``/`[]()`）→ L1，纯文本 → L0；状态机**以块为界**，未闭合标记按字面量处理 |
| §4.3 块级坐标 + 读时抵消 | `materialize.ts` | 块内顺序遍历，遇墓碑 `delta += 长度`，正常条目可见坐标 = 记录坐标 − delta；块之间坐标完全独立 |
| §4.4 墓碑上限 + 快照压缩 | `kernel.ts#maybeCompact/compact` | 超限时不逐条删墓碑，而是把可见态坍缩成新池 + 新日志；时间旅行窗口 = `tombstoneLimit` |
| §5.1 时间旅行 | `kernel.ts` `undo/redo/projectAt` | 撤销 = 物化到第 N 条日志（`#marks` 记录事务边界）；`projectAt(n)` 是只读投影，可用于版本对比 / AI 生成前后 diff |
| §5.2 生态适配 | `kernel.ts` `toMarkdown()/toHTML()` | 私有格式投影回标准 Markdown，适配成本集中在两个函数 |
| §6.2 流式接口 | `kernel.ts` `feed(chunk)` | 打字与 AI 流式在内核层面是同一件事：一批新日志条目到达；未闭合围栏持续吞内容，半闭合 `**` 先按字面量挂着 |
| §3.2 创新 3 输入即解析 | `kernel.ts#insertCore` | 插入按结果文本重新分级，但重建区间只扩张到**语法切片边界**，区间外文本切成新条目保留——即"只重解析受影响的子树" |

## 几个能直接观察到性质

- **块级自治**：`test/kernel.test.ts` 断言改动块 2 后，块 5 的 `segments` 逐字段不变。
- **增量不吃文本**：逐字符输入与整段输入产出完全相同的文档与角色序列。
- **删除只记墓碑**：`poolBytes` 单调不减，而 `toMarkdown()` 立刻反映可见态。
- **视图选择性重算**：改段落时 `StatsView`/`PreviewView` 重算，`OutlineView` 不重算；改标题才触发大纲。
- **快照压缩**：`tombstoneLimit` 触顶后日志从 10 条坍缩回 2 条，可见态一字不变。

## 与设计文档的取舍 / 已知限制

MVP 只覆盖 §6.1（创新点 1 + 2 + 分级 + 读时抵消 + 墓碑/压缩），以下刻意留白：

1. **输入手势层（§6.2）未做**：敲 `- ` 仍然是"记两个字符"，而不是"直接生成创建列表节点的 op"。
2. **插入点落在条目内部会记墓碑**：受影响的旧条目被切开，区间外部分以新条目保留。因此连续打字会产生墓碑，靠 §4.4 的墓碑上限 + 快照压缩兜底（设计文档把逐步细化的增量 parser 放在第二阶段）。
3. **跨块行内语法按未闭合处理**：`**` 开在块 A、闭在块 B 这种 CommonMark 合法边角按字面量渲染——与 §4.3 的明确取舍一致。
4. **块顺序 = 创建顺序**：尚未实现块重排导致的合并/分裂 diff 策略（§6.4 第 2 项）。
5. **无协作合并 / 全文检索 / 懒加载**：单写入口已保证日志只追加，但多来源合并与 spill 到磁盘未做。

## 作为库使用

```ts
import { Kernel, PreviewView, OutlineView } from './src/index.ts';

const kernel = new Kernel({ tombstoneLimit: 500 });
kernel.register(new PreviewView());
kernel.register(new OutlineView());

const block = kernel.createBlock();
kernel.insertText(block, '# 标题\n');
kernel.insertText(kernel.createBlock(), '正文 **加粗**。\n');
kernel.deleteRange(kernel.blockIds()[1]!, 2, 4); // 删除 = 墓碑
kernel.undo();                                    // 物化到第 N 条日志

kernel.toMarkdown(); // ⇄ 标准 Markdown
kernel.toHTML();     // 只读嵌入
kernel.feed('AI 流式 chunk'); // 流式 / 协作走同一个入口
```
