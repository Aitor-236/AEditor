/**
 * 内核公共类型。
 *
 * 术语与设计文档《Markdown 实时渲染内核 · 设计文档》对应：
 *  - 原文池 appendPool（§4.1）
 *  - 语法日志 syntaxLog，条目之间用**稳定 ID** 引用而非位置坐标（§4.1）
 *  - 日志条目分级 L0 / L1 / L2（§4.2）
 *  - 可逆 parser：AST 携带 sourcepos，序列化是确定性投影（§3.2 创新 1）
 */

/** 原文池中的半开区间 [start, end) */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export function spanLength(span: Span): number {
  return span.end - span.start;
}

/** 日志条目的稳定 ID（单调递增，永不复用） */
export type EntryId = number;
/** 块的稳定 ID */
export type BlockId = number;

/** 日志条目分级：L0 纯文本块 / L1 行内语法 / L2 块级语法（§4.2） */
export type LogLevel = 'L0' | 'L1' | 'L2';

/** 块角色。块身份不固化在日志里，由物化时从 L2 条目推导（§4.3） */
export type BlockRole = 'paragraph' | 'heading' | 'listItem' | 'quote' | 'code' | 'table';

/** 行内节点类别 */
export type InlineKind = 'strong' | 'emphasis' | 'codeSpan' | 'link' | 'image' | 'text' | 'mark';

export interface Offset {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** 可逆 parser 的关键：每个节点都带原始字节区间（§3.2 创新 1） */
export interface SourcePos {
  readonly start: Offset;
  readonly end: Offset;
}

export interface InlineNode {
  readonly kind: InlineKind;
  /** 该节点的原始字节。序列化直接投影 raw，因此 round-trip 无损 */
  readonly raw: string;
  /** link / image 的目标地址 */
  readonly url?: string;
  readonly children: readonly InlineNode[];
  readonly sourcepos: SourcePos;
}

export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'quote' | 'code' | 'table';

export interface BlockNode {
  readonly type: BlockKind;
  readonly role: BlockRole;
  /** 整个块的原始字节（含块级标记与行尾换行）—— serialize(parse(md)) ≡ md 的保证 */
  readonly raw: string;
  /** 块级标记，如 "## "、"- "、"> "、"```ts" */
  readonly marker: string;
  /** 去掉块级标记后的内容原文（code 块不含围栏与结束行） */
  readonly content: string;
  /** code 块的语言 */
  readonly lang?: string;
  /** heading 的级别 1..6 */
  readonly depth?: number;
  /** listItem 是否有序 */
  readonly ordered?: boolean;
  /** 行内子节点 */
  readonly children: readonly InlineNode[];
  readonly sourcepos: SourcePos;
}

export interface Document {
  readonly blocks: readonly BlockNode[];
}

export function offset(line: number, column: number, at: number): Offset {
  return { line, column, offset: at };
}

/** 由行首偏移表把字节偏移换算成 line/column（1-based） */
export function locate(lineStarts: readonly number[], at: number): Offset {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= at) lo = mid;
    else hi = mid - 1;
  }
  return offset(lo + 1, at - (lineStarts[lo] ?? 0) + 1, at);
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}
