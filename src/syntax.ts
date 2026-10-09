import type { BlockRole, InlineKind, LogLevel } from './types.ts';

/**
 * 输入分级器：把一段输入文本切成 L0 / L1 / L2 三种条目（§4.2）。
 *
 *   L0 纯文本块 —— 直接输出，零解析
 *   L1 行内语法 —— `**`、`` ` ``、`[]()`，状态机判断开闭
 *   L2 块级语法 —— `#`、`-`、`>`、`` ``` ``、`|`，触发块结构变更
 *
 * 状态机以**块为界**：未闭合的标记（流式输出的半截语法）按字面量处理，
 * 这正是 §2.2「流式渲染：容错解析」的做法——容错不是补丁而是本质。
 */

export interface Shape {
  readonly role: BlockRole;
  /** 块级标记原文，如 "## "、"- "、"> "、"```ts\n" */
  readonly marker: string;
  /** 去掉块级标记后的内容原文 */
  readonly content: string;
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly lang?: string;
  /** 结束围栏原文（含换行），仅 code 块可能非空 */
  readonly closing?: string;
}

export interface Token {
  readonly level: LogLevel;
  readonly text: string;
  /** L1 的语法类别 */
  readonly syntax?: InlineKind;
  /** L2 的块角色 */
  readonly role?: BlockRole;
  /** L2 的块标记 */
  readonly marker?: string;
}

const HEADING_RE = /^(#{1,6})([ \t]+)/;
const FENCE_RE = /^(`{3,}|~{3,})[ \t]*([^\n]*)/;
const LIST_RE = /^([-*+]|[0-9]{1,9}[.)])([ \t]+)/;
const QUOTE_RE = /^(>)([ \t]?)/;

function firstLine(text: string): string {
  const at = text.indexOf('\n');
  return at === -1 ? text : text.slice(0, at);
}

/**
 * 识别块的形状（角色 + 块级标记 + 内容）。
 * `hint` 来自块当前的 L2 条目，用于流式场景下"围栏已开、尚未闭合"的判断。
 */
export function detectShape(text: string, hint?: BlockRole): Shape {
  const line = firstLine(text);
  const fence = FENCE_RE.exec(line);
  if (fence !== null && (hint === 'code' || text.startsWith(fence[0]))) {
    const marker = text.includes('\n') ? `${fence[0]}\n` : fence[0];
    if (!text.includes('\n')) {
      return { role: 'code', marker, content: '', ...(fence[2] ? { lang: fence[2].trim() } : {}) };
    }
    const rest = text.slice(marker.length);
    const closeMatch = /(?:^|\n)([`~]{3,})[ \t]*\n?$/.exec(rest);
    if (closeMatch !== null) {
      const at = rest.lastIndexOf(closeMatch[0]);
      // 结束围栏行前的换行属于**代码内容**（CommonMark），不是围栏的一部分
      const withNewline = closeMatch[0].startsWith('\n');
      const closing = withNewline ? closeMatch[0].slice(1) : closeMatch[0];
      return {
        role: 'code',
        marker,
        content: rest.slice(0, withNewline ? at + 1 : at),
        closing,
        ...(fence[2] ? { lang: fence[2].trim() } : {})
      };
    }
    // 未闭合围栏：内容照收，按 code 块渲染（流式半闭合）
    return { role: 'code', marker, content: rest, ...(fence[2] ? { lang: fence[2].trim() } : {}) };
  }

  const heading = HEADING_RE.exec(line);
  if (heading !== null) {
    const marker = heading[0];
    return { role: 'heading', marker, content: text.slice(marker.length), depth: heading[1]!.length };
  }

  const list = LIST_RE.exec(line);
  if (list !== null) {
    const marker = list[0];
    return {
      role: 'listItem',
      marker,
      content: text.slice(marker.length),
      ordered: !/^[-*+]/.test(list[1]!)
    };
  }

  const quote = QUOTE_RE.exec(line);
  if (quote !== null) {
    const marker = quote[0];
    return { role: 'quote', marker, content: text.slice(marker.length) };
  }

  if (line.startsWith('|')) {
    return { role: 'table', marker: '', content: text };
  }

  return { role: 'paragraph', marker: '', content: text };
}

interface InlineMatch {
  readonly start: number;
  readonly end: number;
  readonly kind: InlineKind;
  /** 开、合定界符 */
  readonly open: string;
  readonly close: string;
}

const INLINE_PATTERNS: readonly { re: RegExp; kind: InlineKind }[] = [
  { re: /!\[[^\]\n]*\]\([^)\n]*\)/, kind: 'image' },
  { re: /\[[^\]\n]*\]\([^)\n]*\)/, kind: 'link' },
  { re: /`[^`\n]+`/, kind: 'codeSpan' },
  { re: /\*\*[^\n]+?\*\*/, kind: 'strong' },
  { re: /__[^\n]+?__/, kind: 'strong' },
  { re: /\*[^\n*]+?\*/, kind: 'emphasis' },
  { re: /_[^\n_]+?_/, kind: 'emphasis' }
];

/**
 * 行内扫描：命中的语法构造产出 L1 条目（定界符 + 内容都记），
 * 未闭合的标记退回 L0 字面量。
 */
function scanInline(text: string, out: Token[]): void {
  let cursor = 0;
  let plain = '';
  const flush = (): void => {
    if (plain.length > 0) {
      out.push({ level: 'L0', text: plain });
      plain = '';
    }
  };

  while (cursor < text.length) {
    let matched: InlineMatch | null = null;
    for (const pattern of INLINE_PATTERNS) {
      const re = new RegExp(pattern.re.source, 'y');
      re.lastIndex = cursor;
      const m = re.exec(text);
      if (m !== null && m[0].length > 0) {
        const full = m[0];
        let open = '';
        let close = '';
        if (pattern.kind === 'strong') {
          open = full.slice(0, 2);
          close = full.slice(-2);
        } else if (pattern.kind === 'emphasis') {
          open = full.slice(0, 1);
          close = full.slice(-1);
        } else if (pattern.kind === 'codeSpan') {
          open = '`';
          close = '`';
        }
        matched = { start: cursor, end: cursor + full.length, kind: pattern.kind, open, close };
        break;
      }
    }

    if (matched === null) {
      plain += text[cursor]!;
      cursor++;
      continue;
    }

    flush();
    if (matched.open.length > 0) {
      out.push({ level: 'L1', text: matched.open, syntax: matched.kind });
      const inner = text.slice(matched.start + matched.open.length, matched.end - matched.close.length);
      if (inner.length > 0) out.push({ level: 'L0', text: inner });
      out.push({ level: 'L1', text: matched.close, syntax: matched.kind });
    } else {
      out.push({ level: 'L1', text: text.slice(matched.start, matched.end), syntax: matched.kind });
    }
    cursor = matched.end;
  }
  flush();
}

/** 把一段输入文本按分级切成条目序列（块级标记优先，其余走行内状态机） */
export function tokenize(text: string, hint?: BlockRole): Token[] {
  const shape = detectShape(text, hint);
  const tokens: Token[] = [];
  if (shape.marker.length > 0) {
    tokens.push({ level: 'L2', text: shape.marker, role: shape.role, marker: shape.marker });
  }
  if (shape.role === 'code') {
    // 代码块内部不做行内解析：整块是 L0（§5.1「纯文本 O(1) 直通」）
    if (shape.content.length > 0) tokens.push({ level: 'L0', text: shape.content });
    if (shape.closing !== undefined && shape.closing.length > 0) {
      tokens.push({ level: 'L2', text: shape.closing, role: 'code', marker: shape.closing });
    }
    return tokens;
  }
  scanInline(text.slice(shape.marker.length), tokens);
  return tokens;
}

/**
 * 只做行内分级（不做块标记识别）。用于在块中间插入文本的场景：
 * 此时插入内容天然不可能是块级标记，块级标记的识别交给调用方按结果文本判断。
 */
export function scanInlineTokens(text: string, role: BlockRole): Token[] {
  if (text.length === 0) return [];
  if (role === 'code') return [{ level: 'L0', text }];
  const tokens: Token[] = [];
  scanInline(text, tokens);
  return tokens;
}

/** 是否处于未闭合围栏中（流式半闭合判断） */
export function hasOpenFence(text: string): boolean {
  const shape = detectShape(text);
  return shape.role === 'code' && shape.closing === undefined;
}

/** 一份连续的分级切片，pieces 从左到右恰好铺满整段文本 */
export interface Piece {
  readonly from: number;
  readonly to: number;
  readonly level: LogLevel;
  readonly text: string;
  readonly syntax?: InlineKind;
  readonly role?: BlockRole;
  readonly marker?: string;
}

/**
 * 把一段完整文本切成连续的分级切片：块标记 L2 + 正文（行内分级）+ 结束围栏 L2。
 * 这是"只重解析受影响的语法子树"的粒度单位（§5.1「首屏与增量两个数量级」）。
 */
export function computePieces(text: string, shape: Shape): Piece[] {
  const pieces: Piece[] = [];
  const markerEnd = shape.marker.length;
  if (markerEnd > 0) {
    pieces.push({ from: 0, to: markerEnd, level: 'L2', text: shape.marker, role: shape.role, marker: shape.marker });
  }
  const closingStart = shape.closing !== undefined ? text.length - shape.closing.length : text.length;
  if (shape.role === 'code') {
    if (closingStart > markerEnd) {
      const body = text.slice(markerEnd, closingStart);
      pieces.push({ from: markerEnd, to: closingStart, level: 'L0', text: body });
    }
  } else {
    let at = markerEnd;
    for (const token of scanInlineTokens(text.slice(markerEnd, closingStart), shape.role)) {
      pieces.push({
        from: at,
        to: at + token.text.length,
        level: token.level,
        text: token.text,
        ...(token.syntax !== undefined ? { syntax: token.syntax } : {})
      });
      at += token.text.length;
    }
  }
  if (shape.closing !== undefined && shape.closing.length > 0) {
    pieces.push({ from: closingStart, to: text.length, level: 'L2', text: shape.closing, role: 'code', marker: shape.closing });
  }
  return pieces;
}
