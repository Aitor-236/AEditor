import { AppendPool } from './pool.ts';
import {
  type Anchor,
  type ContentEntry,
  type Entry,
  type EntryId,
  type LogReader,
  OpLog,
  deriveBlockOrder,
  isContent
} from './oplog.ts';
import { materializeBlock, type MaterializedBlock } from './materialize.ts';
import { renderHtml } from './render.ts';
import { computePieces, detectShape, tokenize } from './syntax.ts';
import type { BlockId, BlockRole, Document, LogLevel } from './types.ts';
import type { DocStats, KernelSnapshot, ViewContext } from './views.ts';
import type { MaterializedView } from './views.ts';

/**
 * 内核（§4 核心数据结构 / §6.1 MVP 骨架）。
 *
 * 单一写入口：所有编辑都变成向语法日志追加条目（§5.1「天然无竞态」）。
 * 打字、AI 流式输出、协作远程编辑对内核都是同一件事：一批新日志条目到达。
 */

export interface KernelOptions {
  /** 墓碑上限，超限触发快照压缩（§4.4）。默认 500 */
  tombstoneLimit?: number;
}

interface BlockState {
  readonly id: BlockId;
  /** 块内条目顺序：由日志锚点推导出的派生索引 */
  order: EntryId[];
  materialized: MaterializedBlock;
  version: number;
}

interface PendingChange {
  readonly roles: Set<BlockRole>;
  readonly levels: Set<LogLevel>;
}

/** 日志前缀视图：时间旅行 = 物化到第 N 条日志（§5.1） */
class LogSlice implements LogReader {
  #byId = new Map<EntryId, Entry>();
  #tombstoned = new Set<EntryId>();

  constructor(entries: readonly Entry[]) {
    for (const entry of entries) {
      this.#byId.set(entry.id, entry);
      if (entry.kind === 'Del') this.#tombstoned.add(entry.target);
    }
  }

  byId(id: EntryId): Entry | undefined {
    return this.#byId.get(id);
  }

  isTombstoned(id: EntryId): boolean {
    return this.#tombstoned.has(id);
  }
}

export interface HistoryMark {
  readonly index: number;
  readonly ops: number;
}

function computeStats(document: Document, markdown: string): DocStats {
  let headings = 0;
  let links = 0;
  for (const block of document.blocks) {
    if (block.role === 'heading') headings++;
    for (const child of block.children) if (child.kind === 'link' || child.kind === 'image') links++;
  }
  const words = markdown.split(/\s+/).filter((part) => part.length > 0).length;
  return { blocks: document.blocks.length, headings, chars: markdown.length, words, links };
}

export class Kernel {
  #pool = new AppendPool();
  #log = new OpLog();
  #blocks = new Map<BlockId, BlockState>();
  #order: BlockId[] = [];
  #pending = new Map<BlockId, PendingChange>();
  #views: MaterializedView<unknown>[] = [];
  #nextBlock: BlockId = 1;
  #tombstoneLimit: number;
  #compactionCount = 0;

  /** 撤销栈：每次编辑事务后记录日志长度。撤销 = 物化到第 N 条日志 */
  #marks: number[] = [0];
  #cursor = 0;
  /** 流式写入的当前块 */
  #streamBlock: BlockId | null = null;
  /** 下一个 chunk 是否应该开新块（上一段已经以换行收尾） */
  #streamFresh = true;

  constructor(options: KernelOptions = {}) {
    this.#tombstoneLimit = options.tombstoneLimit ?? 500;
  }

  // ───────────────────────────── 编辑 API ─────────────────────────────

  createBlock(role: BlockRole = 'paragraph'): BlockId {
    let id = -1;
    this.#transaction(() => {
      id = this.#newBlock(role);
    });
    return id;
  }

  /** 在块的可见坐标 `at` 处插入文本（缺省追加到块尾） */
  insertText(blockId: BlockId, text: string, at?: number): void {
    if (text.length === 0) return;
    this.#transaction(() => {
      this.#insertCore(blockId, text, at);
    });
  }

  /** 删除块内可见区间 [from, to)。删除只记墓碑，绝不改写原文池（§5.1） */
  deleteRange(blockId: BlockId, from: number, to: number): void {
    this.#transaction(() => {
      this.#deleteCore(blockId, from, to);
    });
  }

  /**
   * 流式输入（§6.2）：AI 输出与打字在内核层面是同一件事——一批新日志条目到达。
   * 未闭合围栏会持续吞内容，半闭合语法按字面量 / 代码块容忍。
   */
  feed(chunk: string): BlockId {
    let id = -1;
    this.#transaction(() => {
      const continuing = this.#streamBlock !== null && !this.#streamFresh;
      const target = continuing ? this.#streamBlock! : this.#newBlock('paragraph');
      this.#insertCore(target, chunk, this.#require(target).materialized.text.length);
      const text = this.#require(target).materialized.text;
      if (this.#hasOpenFence(text)) {
        this.#streamBlock = target;
        this.#streamFresh = false;
      } else if (chunk.endsWith('\n')) {
        this.#streamBlock = null;
        this.#streamFresh = true;
      } else {
        this.#streamBlock = target;
        this.#streamFresh = false;
      }
      id = target;
    });
    return id;
  }

  /** 选区是一等公民（§3.2 创新 4）：协作光标 = 他人的 Selection 条目 */
  setSelection(owner: string, blockId: BlockId, anchor: number, head: number): void {
    this.#log.appendSelection(owner, blockId, anchor, head);
    this.#notify([blockId], new Set(), new Set(), false, this.#lastOp());
  }

  selections(): readonly { id: EntryId; owner: string; block: BlockId; anchor: number; head: number }[] {
    const latest = new Map<string, { id: EntryId; owner: string; block: BlockId; anchor: number; head: number }>();
    for (const entry of this.#log.entries) {
      if (entry.kind !== 'Sel') continue;
      latest.set(entry.owner, { id: entry.id, owner: entry.owner, block: entry.block, anchor: entry.anchor, head: entry.head });
    }
    return [...latest.values()];
  }

  // ───────────────────────────── 物化 ─────────────────────────────

  /** 按订阅关系通知视图（只有匹配的视图重算，快照只构建一次） */
  flush(): void {
    if (this.#pending.size === 0) return;
    const changed = [...this.#pending.keys()];
    const roles = new Set<BlockRole>();
    const levels = new Set<LogLevel>();
    for (const change of this.#pending.values()) {
      for (const role of change.roles) roles.add(role);
      for (const level of change.levels) levels.add(level);
    }
    this.#pending.clear();
    this.#notify(changed, roles, levels, false, this.#lastOp());
    this.#maybeCompact();
  }

  register(view: MaterializedView<unknown>): void {
    this.#views.push(view);
    view.render(this.snapshot());
  }

  get document(): Document {
    return { blocks: this.#order.map((id) => this.#require(id).materialized.ast) };
  }

  /** 生态适配接口之一：把私有格式投影回标准 Markdown（§5.2） */
  toMarkdown(): string {
    return this.#order.map((id) => this.#require(id).materialized.text).join('');
  }

  toHTML(): string {
    return renderHtml(this.document);
  }

  blockText(blockId: BlockId): string {
    return this.#require(blockId).materialized.text;
  }

  blockIds(): readonly BlockId[] {
    return this.#order;
  }

  snapshot(): KernelSnapshot {
    const document = this.document;
    const markdown = this.toMarkdown();
    const blocks = this.#order.map((id) => this.#require(id).materialized);
    const liveBytes = blocks.reduce((total, block) => total + block.liveBytes, 0);
    return {
      markdown,
      html: renderHtml(document),
      document,
      blocks,
      stats: computeStats(document, markdown),
      logSize: this.#log.size,
      tombstoneCount: this.#log.tombstoneCount,
      poolBytes: this.#pool.length,
      liveBytes
    };
  }

  // ───────────────────────────── 时间旅行 ─────────────────────────────

  get logSize(): number {
    return this.#log.size;
  }

  /** 调试用：暴露日志（只读）。可观察 L0/L1/L2 分布与墓碑 */
  get entries(): readonly Entry[] {
    return this.#log.entries;
  }

  get history(): readonly HistoryMark[] {
    return this.#marks.map((ops, index) => ({ index, ops }));
  }

  get canUndo(): boolean {
    return this.#cursor > 0;
  }

  get canRedo(): boolean {
    return this.#cursor < this.#marks.length - 1;
  }

  /** 时间旅行窗口 = min(墓碑上限, 快照间隔)，作为内核参数暴露（§4.4） */
  get undoLimit(): number {
    return this.#tombstoneLimit;
  }

  undo(steps = 1): void {
    this.#travelTo(this.#cursor - steps);
  }

  redo(steps = 1): void {
    this.#travelTo(this.#cursor + steps);
  }

  /**
   * 只读投影：物化到第 opCount 条日志。
   * 版本对比、AI 生成前后 diff 审阅、协作会话回放都是同一能力的不同用法（§5.1）。
   */
  projectAt(opCount: number): { markdown: string; html: string; document: Document; blocks: readonly MaterializedBlock[] } {
    const entries = this.#log.prefix(opCount);
    const orders = deriveBlockOrder(entries);
    const slice = new LogSlice(entries);
    const ids = [...orders.keys()].sort((a, b) => a - b);
    const blocks = ids.map((id) => materializeBlock(id, orders.get(id) ?? [], slice, this.#pool, 0));
    const document: Document = { blocks: blocks.map((block) => block.ast) };
    return { markdown: blocks.map((block) => block.text).join(''), html: renderHtml(document), document, blocks };
  }

  // ─────────────────────── 墓碑管理 / 快照压缩 ───────────────────────

  get tombstoneCount(): number {
    return this.#log.tombstoneCount;
  }

  get poolBytes(): number {
    return this.#pool.length;
  }

  get compactionCount(): number {
    return this.#compactionCount;
  }

  /**
   * 快照压缩（§4.4）：不逐条删墓碑（会产生新墓碑、套娃），
   * 而是把旧状态坍缩为"当前可见态"，新日志从干净状态继续。
   */
  compact(): void {
    const texts = this.#order.map((id) => this.#require(id).materialized.text);
    const pool = new AppendPool();
    const log = new OpLog();
    const blocks = new Map<BlockId, BlockState>();
    const order: BlockId[] = [];
    let nextBlock = 1;

    for (const text of texts) {
      const id = nextBlock++;
      log.appendNewBlock(id, 'paragraph');
      const state: BlockState = { id, order: [], materialized: materializeBlock(id, [], log, pool, 0), version: 0 };
      blocks.set(id, state);
      order.push(id);
      let anchor: Anchor | undefined = 'head';
      for (const token of tokenize(text, detectShape(text).role)) {
        const span = pool.append(token.text);
        const entry: ContentEntry =
          token.level === 'L2'
            ? log.appendBlock(id, span, token.role ?? 'paragraph', token.marker ?? token.text, anchor)
            : token.level === 'L1'
              ? log.appendInline(id, span, token.syntax ?? 'mark', anchor)
              : log.appendText(id, span, anchor);
        state.order.push(entry.id);
        anchor = entry.id;
      }
    }
    for (const id of order) {
      const state = blocks.get(id)!;
      state.materialized = materializeBlock(id, state.order, log, pool, 1);
      state.version = 1;
    }

    this.#pool = pool;
    this.#log = log;
    this.#blocks = blocks;
    this.#order = order;
    this.#nextBlock = nextBlock;
    this.#marks = [log.size];
    this.#cursor = 0;
    this.#pending.clear();
    this.#streamBlock = null;
    this.#streamFresh = true;
    this.#compactionCount++;
    this.#notify(order, new Set(), new Set(), true, null);
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  #notify(
    changed: readonly BlockId[],
    roles: ReadonlySet<BlockRole>,
    levels: ReadonlySet<LogLevel>,
    full: boolean,
    op: Entry | null
  ): void {
    if (this.#views.length === 0) return;
    const context: ViewContext = { changed, roles, levels, op, full };
    const matching = this.#views.filter((view) => view.matches(context));
    if (matching.length === 0) return;
    const snapshot = this.snapshot();
    for (const view of matching) view.render(snapshot);
  }

  #transaction(fn: () => void): void {
    this.#discardRedoBranch();
    fn();
    this.flush();
    const size = this.#log.size;
    const last = this.#marks[this.#marks.length - 1] ?? 0;
    if (size > last) this.#marks.push(size);
    this.#cursor = this.#marks.length - 1;
    this.#pending.clear();
  }

  /** 撤销后重新编辑 = 丢弃重做分支（等价于快照截断，§4.4） */
  #discardRedoBranch(): void {
    if (this.#cursor >= this.#marks.length - 1) return;
    const head = this.#marks[this.#cursor]!;
    this.#log.truncate(head);
    this.#marks = this.#marks.slice(0, this.#cursor + 1);
    this.#rebuildFromPrefix(head);
    this.#cursor = this.#marks.length - 1;
  }

  #travelTo(index: number): void {
    const target = Math.max(0, Math.min(index, this.#marks.length - 1));
    if (target === this.#cursor) return;
    this.#cursor = target;
    this.#rebuildFromPrefix(this.#marks[target]!);
  }

  /** 用日志前缀重建全部块状态（撤销 / 重做 / 回放的统一实现） */
  #rebuildFromPrefix(opCount: number): void {
    const entries = this.#log.prefix(opCount);
    const orders = deriveBlockOrder(entries);
    const slice = new LogSlice(entries);
    this.#blocks = new Map();
    this.#order = [];
    this.#pending.clear();
    this.#streamBlock = null;
    this.#streamFresh = true;
    let maxId = 0;
    for (const [id, order] of orders) {
      maxId = Math.max(maxId, id);
      this.#blocks.set(id, {
        id,
        order: [...order],
        materialized: materializeBlock(id, order, slice, this.#pool, 1),
        version: 1
      });
      this.#order.push(id);
    }
    this.#order.sort((a, b) => a - b);
    this.#nextBlock = maxId + 1;
    this.#notify([...this.#order], new Set(), new Set(), true, this.#lastOp());
  }

  #maybeCompact(): void {
    if (this.#log.tombstoneCount > this.#tombstoneLimit) this.compact();
  }

  #newBlock(role: BlockRole): BlockId {
    const id = this.#nextBlock++;
    this.#log.appendNewBlock(id, role);
    const state: BlockState = {
      id,
      order: [],
      materialized: materializeBlock(id, [], this.#log, this.#pool, 0),
      version: 0
    };
    this.#blocks.set(id, state);
    this.#order.push(id);
    const change: PendingChange = { roles: new Set([role]), levels: new Set() };
    this.#pending.set(id, change);
    return id;
  }

  /**
   * 插入文本 = 对结果文本重新分级，但**只重解析受影响的语法子树**：
   * 受影响区间扩张到语法切片（L1/L2）边界；被切开的旧条目记墓碑，
   * 区间外的部分保留为新条目——既不吞文本，也不全量重放
   * （§5.1「击键只重放受影响 block 的日志段」）。
   */
  #insertCore(blockId: BlockId, text: string, at?: number): void {
    const state = this.#require(blockId);
    const before = state.materialized.text;
    const pos = at === undefined ? before.length : Math.max(0, Math.min(at, before.length));
    const after = before.slice(0, pos) + text + before.slice(pos);
    const shape = detectShape(after, state.materialized.role);
    const pieces = computePieces(after, shape);

    // 旧条目在 after 坐标系下的范围（插入点之后的条目整体右移）
    const extents: { entry: EntryId; from: number; to: number }[] = [];
    for (const segment of state.materialized.segments) {
      if (segment.dead) continue;
      extents.push({
        entry: segment.entry,
        from: segment.visible.start >= pos ? segment.visible.start + text.length : segment.visible.start,
        to: segment.visible.end > pos ? segment.visible.end + text.length : segment.visible.end
      });
    }

    const insertFrom = Math.max(0, Math.min(pos, after.length));
    const insertTo = Math.max(0, Math.min(pos + text.length, after.length));
    if (insertTo <= insertFrom) {
      this.#touch(state);
      return;
    }

    // 重建区间只扩张到**语法切片**边界（L1/L2 必须整块重建）；
    // 纯文本切片与普通条目可以在任意处切开，所以打字不会牵动整段正文。
    let lo = insertFrom;
    let hi = insertTo;
    for (;;) {
      const prevLo = lo;
      const prevHi = hi;
      for (const piece of pieces) {
        if (piece.level === 'L0') continue;
        if (piece.to > lo && piece.from < hi) {
          lo = Math.min(lo, piece.from);
          hi = Math.max(hi, piece.to);
        }
      }
      if (lo === prevLo && hi === prevHi) break;
    }

    // 受影响的旧条目记墓碑；被切开的条目，区间外的部分保留为新条目（日志只增不删）
    const removed = new Set<EntryId>();
    const leftovers: { from: number; to: number }[] = [];
    for (const extent of extents) {
      if (extent.to <= lo || extent.from >= hi) continue;
      this.#log.appendTombstone(blockId, extent.entry);
      removed.add(extent.entry);
      if (extent.from < lo) leftovers.push({ from: extent.from, to: lo });
      if (extent.to > hi) leftovers.push({ from: hi, to: extent.to });
    }
    leftovers.sort((a, b) => a.from - b.from);

    let anchor: Anchor = 'head';
    for (const extent of extents) {
      if (!removed.has(extent.entry) && extent.to <= lo) anchor = extent.entry;
    }
    const emitText = (
      chunk: string,
      level: 'L0' | 'L1' | 'L2',
      syntax: string | undefined,
      role: BlockRole | undefined,
      marker: string | undefined
    ): void => {
      const span = this.#pool.append(chunk);
      const entry: ContentEntry =
        level === 'L2'
          ? this.#log.appendBlock(blockId, span, role ?? shape.role, marker ?? chunk, anchor)
          : level === 'L1'
            ? this.#log.appendInline(blockId, span, syntax ?? 'mark', anchor)
            : this.#log.appendText(blockId, span, anchor);
      this.#place(state, entry.id, anchor);
      anchor = entry.id;
    };

    for (const left of leftovers) {
      if (left.to <= lo) emitText(after.slice(left.from, left.to), 'L0', undefined, undefined, undefined);
    }
    for (const piece of pieces) {
      const from = Math.max(piece.from, lo);
      const to = Math.min(piece.to, hi);
      if (to <= from) continue;
      if (piece.level !== 'L0' && (from !== piece.from || to !== piece.to)) continue;
      emitText(after.slice(from, to), piece.level, piece.syntax, piece.role, piece.marker);
    }
    for (const right of leftovers) {
      if (right.from >= hi) emitText(after.slice(right.from, right.to), 'L0', undefined, undefined, undefined);
    }
    this.#touch(state);
  }

  #deleteCore(blockId: BlockId, from: number, to: number): void {
    const state = this.#require(blockId);
    const length = state.materialized.text.length;
    const a = Math.max(0, Math.min(from, length));
    const b = Math.max(0, Math.min(to, length));
    if (b <= a) return;
    for (const segment of [...state.materialized.segments]) {
      if (segment.dead) continue;
      const overlapStart = Math.max(segment.visible.start, a);
      const overlapEnd = Math.min(segment.visible.end, b);
      if (overlapEnd <= overlapStart) continue;
      this.#log.appendTombstone(blockId, segment.entry);
      if (overlapStart === segment.visible.start && overlapEnd === segment.visible.end) continue;
      // 部分删除：整条记墓碑，保留部分以**新条目**追加（日志只增不删）
      const source = this.#log.byId(segment.entry);
      if (source === undefined || !isContent(source)) continue;
      let anchor = this.#anchorBefore(state, segment.entry);
      const left = segment.text.slice(0, overlapStart - segment.visible.start);
      const right = segment.text.slice(overlapEnd - segment.visible.start);
      if (left.length > 0) anchor = this.#appendLike(state, source, left, anchor);
      if (right.length > 0) this.#appendLike(state, source, right, anchor);
    }
    this.#touch(state);
  }

  /** 立即重算该块，并登记本次变更供视图订阅判断 */
  #touch(state: BlockState): void {
    const previousRole = state.materialized.role;
    state.version++;
    state.materialized = materializeBlock(state.id, state.order, this.#log, this.#pool, state.version);
    const change = this.#pending.get(state.id) ?? { roles: new Set<BlockRole>(), levels: new Set<LogLevel>() };
    change.roles.add(previousRole);
    change.roles.add(state.materialized.role);
    for (const segment of state.materialized.segments) {
      if (!segment.dead) change.levels.add(segment.level);
    }
    this.#pending.set(state.id, change);
  }

  #appendLike(state: BlockState, source: { kind: 'L0' | 'L1' | 'L2'; syntax?: string; role?: BlockRole; marker?: string }, text: string, anchor: Anchor): EntryId {
    const span = this.#pool.append(text);
    const entry =
      source.kind === 'L2'
        ? this.#log.appendBlock(state.id, span, source.role ?? 'paragraph', source.marker ?? text, anchor)
        : source.kind === 'L1'
          ? this.#log.appendInline(state.id, span, source.syntax ?? 'mark', anchor)
          : this.#log.appendText(state.id, span, anchor);
    this.#place(state, entry.id, anchor);
    return entry.id;
  }

  #place(state: BlockState, entryId: EntryId, anchor: Anchor): void {
    let at = state.order.length;
    if (anchor === 'head') at = 0;
    else {
      const index = state.order.indexOf(anchor);
      if (index >= 0) at = index + 1;
    }
    state.order.splice(at, 0, entryId);
  }

  #anchorBefore(state: BlockState, entryId: EntryId): Anchor {
    let previous: EntryId | null = null;
    for (const segment of state.materialized.segments) {
      if (segment.entry === entryId) return previous ?? 'head';
      previous = segment.entry;
    }
    return previous ?? 'head';
  }

  #hasOpenFence(text: string): boolean {
    const shape = detectShape(text);
    return shape.role === 'code' && shape.closing === undefined;
  }

  #lastOp(): Entry | null {
    return this.#log.size > 0 ? this.#log.entries[this.#log.size - 1]! : null;
  }

  #require(blockId: BlockId): BlockState {
    const state = this.#blocks.get(blockId);
    if (state === undefined) throw new Error(`unknown block: ${blockId}`);
    return state;
  }
}
