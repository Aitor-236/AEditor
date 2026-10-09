import type { BlockId, BlockRole, EntryId, Span } from './types.ts';

export type { BlockId, EntryId } from './types.ts';

/**
 * 语法日志（syntaxLog，§4.1）。
 *
 * 每条日志 = { type, target, id }，条目之间用**稳定 ID** 引用，不用位置坐标。
 * 这就是「文档即日志」的心脏：当前文档、渲染结果、大纲、字数统计，
 * 全部是这条日志上的派生视图（materialized view）。
 */

/** 条目在块内的落位锚点：'head' 块首；EntryId 表示插在该条目之后；缺省表示追加到块尾 */
export type Anchor = 'head' | EntryId;

export interface ContentEntryBase {
  readonly id: EntryId;
  readonly block: BlockId;
  readonly span: Span;
  readonly anchor?: Anchor;
}

/** L0：纯文本块，渲染时零解析直通 */
export interface L0Entry extends ContentEntryBase {
  readonly kind: 'L0';
}

/** L1：行内语法（`**`、`` ` ``、`[]()`），由状态机判断开闭 */
export interface L1Entry extends ContentEntryBase {
  readonly kind: 'L1';
  readonly syntax: string;
}

/** L2：块级语法（`#`、`-`、`` ``` ``、`|`），触发块结构变更 */
export interface L2Entry extends ContentEntryBase {
  readonly kind: 'L2';
  readonly role: BlockRole;
  readonly marker: string;
}

/** 块的诞生事件 */
export interface NewBlockEntry {
  readonly kind: 'NewBlock';
  readonly id: EntryId;
  readonly block: BlockId;
  readonly role: BlockRole;
}

/** 墓碑：按稳定 ID 指向被删除的条目（§4.4） */
export interface TombstoneEntry {
  readonly kind: 'Del';
  readonly id: EntryId;
  readonly block: BlockId;
  readonly target: EntryId;
}

/** 选区是一等公民：协作光标 = 他人的 Selection 条目（§3.2 创新 4） */
export interface SelectionEntry {
  readonly kind: 'Sel';
  readonly id: EntryId;
  readonly owner: string;
  readonly block: BlockId;
  readonly anchor: number;
  readonly head: number;
}

export type ContentEntry = L0Entry | L1Entry | L2Entry;
export type Entry = ContentEntry | NewBlockEntry | TombstoneEntry | SelectionEntry;

export function isContent(entry: Entry): entry is ContentEntry {
  return entry.kind === 'L0' || entry.kind === 'L1' || entry.kind === 'L2';
}

/** 只读日志视图：完整日志与"日志前缀"都能满足它，物化层只依赖这个接口 */
export interface LogReader {
  byId(id: EntryId): Entry | undefined;
  isTombstoned(id: EntryId): boolean;
}

export class OpLog implements LogReader {
  #entries: Entry[] = [];
  #index = new Map<EntryId, Entry>();
  #tombstoned = new Set<EntryId>();
  #nextId: EntryId = 1;
  #tombstoneCount = 0;

  get size(): number {
    return this.#entries.length;
  }

  get tombstoneCount(): number {
    return this.#tombstoneCount;
  }

  get entries(): readonly Entry[] {
    return this.#entries;
  }

  isTombstoned(id: EntryId): boolean {
    return this.#tombstoned.has(id);
  }

  byId(id: EntryId): Entry | undefined {
    return this.#index.get(id);
  }

  /** 时间旅行：日志前缀即可物化出任意历史版本（§5.1） */
  prefix(count: number): readonly Entry[] {
    return this.#entries.slice(0, Math.max(0, Math.min(count, this.#entries.length)));
  }

  appendText(block: BlockId, span: Span, anchor?: Anchor): L0Entry {
    const entry: L0Entry = { id: this.#nextId++, kind: 'L0', block, span, anchor };
    this.#push(entry);
    return entry;
  }

  appendInline(block: BlockId, span: Span, syntax: string, anchor?: Anchor): L1Entry {
    const entry: L1Entry = { id: this.#nextId++, kind: 'L1', block, span, syntax, anchor };
    this.#push(entry);
    return entry;
  }

  appendBlock(block: BlockId, span: Span, role: BlockRole, marker: string, anchor?: Anchor): L2Entry {
    const entry: L2Entry = { id: this.#nextId++, kind: 'L2', block, span, role, marker, anchor };
    this.#push(entry);
    return entry;
  }

  appendNewBlock(block: BlockId, role: BlockRole): NewBlockEntry {
    const entry: NewBlockEntry = { id: this.#nextId++, kind: 'NewBlock', block, role };
    this.#push(entry);
    return entry;
  }

  appendTombstone(block: BlockId, target: EntryId): TombstoneEntry {
    const entry: TombstoneEntry = { id: this.#nextId++, kind: 'Del', block, target };
    this.#push(entry);
    if (!this.#tombstoned.has(target)) {
      this.#tombstoned.add(target);
      this.#tombstoneCount++;
    }
    return entry;
  }

  appendSelection(owner: string, block: BlockId, anchor: number, head: number): SelectionEntry {
    const entry: SelectionEntry = { id: this.#nextId++, kind: 'Sel', owner, block, anchor, head };
    this.#push(entry);
    return entry;
  }

  #push(entry: Entry): void {
    this.#entries.push(entry);
    this.#index.set(entry.id, entry);
  }

  /** 快照压缩（§4.4）：旧状态坍缩为"当前可见态"，新日志从干净状态继续 */
  reset(): void {
    this.#entries = [];
    this.#index = new Map();
    this.#tombstoned = new Set();
    this.#tombstoneCount = 0;
  }

  /** 丢弃尾部（撤销后重新编辑 = 丢弃重做分支，语义与快照截断同级） */
  truncate(count: number): void {
    const keep = Math.max(0, Math.min(count, this.#entries.length));
    this.#entries = this.#entries.slice(0, keep);
    this.#index = new Map(this.#entries.map((entry) => [entry.id, entry]));
    this.#tombstoned = new Set();
    this.#tombstoneCount = 0;
    for (const entry of this.#entries) {
      if (entry.kind === 'Del' && !this.#tombstoned.has(entry.target)) {
        this.#tombstoned.add(entry.target);
        this.#tombstoneCount++;
      }
    }
  }
}

/**
 * 由日志（或其前缀）推导每个块内条目的顺序。
 *
 * 顺序完全由日志决定：每条内容条目记录自己落在哪个锚点之后，
 * 锚点是**稳定 ID** 而不是坐标，所以重放任意前缀都得到确定结果。
 * —— 对应设计文档 §4.3「块身份由物化时重新推导」。
 */
export function deriveBlockOrder(entries: readonly Entry[]): Map<BlockId, EntryId[]> {
  const orders = new Map<BlockId, EntryId[]>();
  for (const entry of entries) {
    if (entry.kind === 'Del' || entry.kind === 'Sel') continue;
    if (entry.kind === 'NewBlock') {
      if (!orders.has(entry.block)) orders.set(entry.block, []);
      continue;
    }
    let list = orders.get(entry.block);
    if (list === undefined) {
      list = [];
      orders.set(entry.block, list);
    }
    let at = list.length;
    if (entry.anchor === 'head') {
      at = 0;
    } else if (typeof entry.anchor === 'number') {
      const pos = list.indexOf(entry.anchor);
      if (pos >= 0) at = pos + 1;
    }
    list.splice(at, 0, entry.id);
  }
  return orders;
}
