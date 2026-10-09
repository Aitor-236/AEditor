/** 公开 API：内核 + 视图 + 可逆 parser */

export { Kernel, type KernelOptions, type HistoryMark } from './kernel.ts';
export { AppendPool } from './pool.ts';
export {
  OpLog,
  deriveBlockOrder,
  isContent,
  type Anchor,
  type ContentEntry,
  type Entry,
  type EntryId,
  type L0Entry,
  type L1Entry,
  type L2Entry,
  type LogReader
} from './oplog.ts';
export {
  materializeBlock,
  type MaterializedBlock,
  type Segment
} from './materialize.ts';
export {
  MaterializedView,
  OutlineView,
  PreviewView,
  StatsView,
  type DocStats,
  type KernelSnapshot,
  type OutlineItem,
  type ViewContext
} from './views.ts';
export { parseBlock, parseDocument, parseInline, roundTrips, serialize } from './parser.ts';
export { escapeHtml, renderBlock, renderHtml, renderText } from './render.ts';
export { detectShape, hasOpenFence, scanInlineTokens, tokenize, type Shape, type Token } from './syntax.ts';
export type {
  BlockId,
  BlockNode,
  BlockRole,
  Document,
  InlineNode,
  LogLevel,
  Offset,
  SourcePos,
  Span
} from './types.ts';
export { lineStartsOf, locate, spanLength } from './types.ts';
