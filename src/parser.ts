import {
  type BlockNode,
  type BlockRole,
  type Document,
  type InlineKind,
  type InlineNode,
  lineStartsOf,
  locate
} from './types.ts';
import { detectShape } from './syntax.ts';

/**
 * 可逆 parser（§3.2 创新 1）。
 *
 * 双射保证：
 *   serialize(parse(md)) ≡ md     —— 序列化只是 raw 的确定性投影
 *   parse(serialize(ast)) ≡ ast   —— parse 是纯函数，同输入同输出
 *
 * 做法很朴素但足够严格：每个节点的 raw 直接取自源串切片，序列化就是拼接 raw，
 * 因此字节级 round-trip 天然成立；同时每个节点都带 sourcepos，
 * 供光标映射（源字符 offset → 渲染 DOM 路径）与行内编辑定位使用。
 */

interface InlineRule {
  readonly re: RegExp;
  readonly kind: InlineKind;
}

const INLINE_RULES: readonly InlineRule[] = [
  { re: /!\[[^\]\n]*\]\([^)\n]*\)/y, kind: 'image' },
  { re: /\[[^\]\n]*\]\([^)\n]*\)/y, kind: 'link' },
  { re: /`[^`\n]+`/y, kind: 'codeSpan' },
  { re: /\*\*[^\n]+?\*\*/y, kind: 'strong' },
  { re: /__[^\n]+?__/y, kind: 'strong' },
  { re: /\*[^\n*]+?\*/y, kind: 'emphasis' },
  { re: /_[^\n_]+?_/y, kind: 'emphasis' }
];

function inlineUrl(raw: string): string | undefined {
  const at = raw.indexOf('](');
  return at === -1 ? undefined : raw.slice(at + 2, -1);
}

/**
 * 行内解析：产出带 sourcepos 的行内节点。
 * `contentAbs` 是 content 在**整篇文档**中的绝对起始偏移，sourcepos 由文档级行首表换算。
 */
export function parseInline(
  content: string,
  contentAbs: number,
  lineStarts: readonly number[]
): InlineNode[] {
  const nodes: InlineNode[] = [];
  const span = (from: number, to: number) => ({
    start: locate(lineStarts, contentAbs + from),
    end: locate(lineStarts, contentAbs + to)
  });

  let cursor = 0;
  let plain = '';
  const flush = (): void => {
    if (plain.length === 0) return;
    const to = cursor;
    nodes.push({ kind: 'text', raw: plain, children: [], sourcepos: span(to - plain.length, to) });
    plain = '';
  };

  while (cursor < content.length) {
    let hit: { raw: string; kind: InlineKind } | null = null;
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = cursor;
      const m = rule.re.exec(content);
      if (m !== null && m[0].length > 0) {
        hit = { raw: m[0], kind: rule.kind };
        break;
      }
    }
    if (hit === null) {
      plain += content[cursor]!;
      cursor++;
      continue;
    }
    flush();
    const start = cursor;
    cursor += hit.raw.length;
    nodes.push({
      kind: hit.kind,
      raw: hit.raw,
      ...(hit.kind === 'link' || hit.kind === 'image' ? { url: inlineUrl(hit.raw) ?? '' } : {}),
      children: [],
      sourcepos: span(start, cursor)
    });
  }
  flush();
  return nodes;
}

/** 解析单个块。`raw` 必须是源串切片，`startOffset` 是它在文档中的绝对偏移 */
export function parseBlock(
  raw: string,
  startOffset: number,
  lineStarts: readonly number[],
  _hint?: BlockRole
): BlockNode {
  const shape = detectShape(raw);
  const contentAbs = startOffset + shape.marker.length;
  const children = shape.role === 'code' ? [] : parseInline(shape.content, contentAbs, lineStarts);
  return {
    type: shape.role,
    role: shape.role,
    raw,
    marker: shape.marker,
    content: shape.content,
    ...(shape.lang !== undefined ? { lang: shape.lang } : {}),
    ...(shape.depth !== undefined ? { depth: shape.depth } : {}),
    ...(shape.ordered !== undefined ? { ordered: shape.ordered } : {}),
    children,
    sourcepos: {
      start: locate(lineStarts, startOffset),
      end: locate(lineStarts, startOffset + raw.length)
    }
  };
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function lineSlice(md: string, starts: readonly number[], index: number): string {
  const from = starts[index]!;
  const to = index + 1 < starts.length ? starts[index + 1]! : md.length;
  return md.slice(from, to);
}

function fenceOf(line: string): { char: string; length: number } | null {
  const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
  if (m === null) return null;
  return { char: m[1]![0]!, length: m[1]!.length };
}

function isClosingFence(line: string): boolean {
  return /^[ \t]*[`~]{3,}[ \t]*\n?$/.test(line);
}

/** 块首行下标列表：空行是分隔符；围栏代码块跨行成块；连续表格行合成一块 */
function blockStarts(md: string, starts: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < starts.length) {
    const line = lineSlice(md, starts, i);
    if (isBlank(line)) {
      i++;
      continue;
    }
    out.push(i);
    const fence = fenceOf(line);
    if (fence !== null && !isClosingFence(line)) {
      // 开围栏：吞到匹配的结束围栏（未闭合则到文末 —— 流式半闭合）
      let j = i + 1;
      while (j < starts.length) {
        const probe = lineSlice(md, starts, j);
        const close = fenceOf(probe);
        j++;
        if (close !== null && close.char === fence.char && close.length >= fence.length && isClosingFence(probe)) {
          break;
        }
      }
      i = j;
      continue;
    }
    let next = i + 1;
    if (line.startsWith('|')) {
      while (next < starts.length && lineSlice(md, starts, next).startsWith('|')) next++;
    }
    i = next;
  }
  return out;
}

/**
 * 解析整篇 Markdown。
 * 块之间空行被并入**前一个块**的 raw，使「块 raw 拼接 ≡ 源串」恒成立（round-trip 保证）。
 */
export function parseDocument(md: string): Document {
  const starts = lineStartsOf(md);
  const heads = blockStarts(md, starts);
  if (heads.length === 0) {
    return md.length === 0 ? { blocks: [] } : { blocks: [parseBlock(md, 0, starts)] };
  }
  const blocks: BlockNode[] = [];
  heads.forEach((head, index) => {
    const start = index === 0 ? 0 : starts[head]!;
    const next = heads[index + 1];
    const end = next === undefined ? md.length : starts[next]!;
    blocks.push(parseBlock(md.slice(start, end), start, starts));
  });
  return { blocks };
}

/** 序列化 = 确定性投影（§3.2 创新 1） */
export function serialize(doc: Document): string {
  return doc.blocks.map((block) => block.raw).join('');
}

/** 字节级 round-trip 校验 */
export function roundTrips(md: string): boolean {
  return serialize(parseDocument(md)) === md;
}

export function parseMarkdown(md: string): Document {
  return parseDocument(md);
}
