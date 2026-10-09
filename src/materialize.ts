import { type LogReader, isContent } from './oplog.ts';
import type { AppendPool } from './pool.ts';
import { parseBlock } from './parser.ts';
import {
  type BlockId,
  type BlockNode,
  type BlockRole,
  type EntryId,
  type LogLevel,
  lineStartsOf,
  spanLength,
  type Span
} from './types.ts';

/**
 * 增量物化（§4.1 / §4.3）。
 *
 * 每个块独立物化：块内日志条目顺序遍历，**读时抵消**——遇到墓碑就把它的长度累进 delta，
 * 正常条目的可见坐标 = 记录坐标 - delta。因为 delta 只在块内累加，
 * 删除一个块绝不会改写其它块的坐标（§4.3「坐标管理降到块级」）。
 */

export interface Segment {
  readonly entry: EntryId;
  readonly level: LogLevel;
  /** 日志里记录的块内坐标 */
  readonly recorded: Span;
  /** 读时抵消后的可见坐标 */
  readonly visible: Span;
  readonly text: string;
  readonly dead: boolean;
}

export interface MaterializedBlock {
  readonly id: BlockId;
  /** 块角色：由块内 L2 条目推导，而非日志固化（§4.3） */
  readonly role: BlockRole;
  readonly text: string;
  readonly ast: BlockNode;
  readonly segments: readonly Segment[];
  readonly version: number;
  readonly liveBytes: number;
  readonly deadBytes: number;
}

export function materializeBlock(
  id: BlockId,
  order: readonly EntryId[],
  log: LogReader,
  pool: AppendPool,
  version: number
): MaterializedBlock {
  const segments: Segment[] = [];
  const parts: string[] = [];
  let delta = 0;
  let recorded = 0;
  let liveBytes = 0;
  let deadBytes = 0;
  let role: BlockRole = 'paragraph';

  for (const entryId of order) {
    const entry = log.byId(entryId);
    if (entry === undefined || !isContent(entry)) continue;
    const text = pool.read(entry.span);
    const length = text.length;
    const recordedSpan: Span = { start: recorded, end: recorded + length };
    recorded += length;

    const dead = log.isTombstoned(entryId);
    if (dead) {
      delta += length;
      deadBytes += length;
      segments.push({ entry: entryId, level: entry.kind, recorded: recordedSpan, visible: { start: 0, end: 0 }, text, dead: true });
      continue;
    }
    if (entry.kind === 'L2') role = entry.role;
    const visible: Span = { start: recordedSpan.start - delta, end: recordedSpan.end - delta };
    liveBytes += length;
    segments.push({ entry: entryId, level: entry.kind, recorded: recordedSpan, visible, text, dead: false });
    parts.push(text);
  }

  const text = parts.join('');
  const ast = parseBlock(text, 0, lineStartsOf(text));
  return {
    id,
    role,
    text,
    ast: { ...ast, role },
    segments,
    version,
    liveBytes,
    deadBytes
  };
}

export function segmentBytes(segments: readonly Segment[]): { live: number; dead: number } {
  let live = 0;
  let dead = 0;
  for (const segment of segments) {
    if (segment.dead) dead += spanLength(segment.recorded);
    else live += spanLength(segment.recorded);
  }
  return { live, dead };
}
