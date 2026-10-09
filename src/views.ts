import type { MaterializedBlock } from './materialize.ts';
import type { Entry } from './oplog.ts';
import type { BlockId, BlockRole, Document, LogLevel } from './types.ts';

/**
 * 视图层（§3.2 创新 2：文档即日志）。
 *
 * 当前文档、渲染结果、大纲、字数统计全部是日志上的**派生视图**，
 * 由同一个增量计算引擎维护。每个视图声明自己订阅哪些 op / 哪些块角色，
 * 改一个段落，只有订阅了该 span 的视图重算 —— 「插件 = 新视图的注册表」。
 */

export interface DocStats {
  readonly blocks: number;
  readonly headings: number;
  readonly chars: number;
  readonly words: number;
  readonly links: number;
}

export interface KernelSnapshot {
  readonly markdown: string;
  readonly html: string;
  readonly document: Document;
  readonly blocks: readonly MaterializedBlock[];
  readonly stats: DocStats;
  readonly logSize: number;
  readonly tombstoneCount: number;
  readonly poolBytes: number;
  readonly liveBytes: number;
}

export interface ViewContext {
  /** 本次物化中被重算的块 */
  readonly changed: readonly BlockId[];
  /** 变更块的角色（含变更前后的角色） */
  readonly roles: ReadonlySet<BlockRole>;
  /** 变更涉及的日志条目等级 */
  readonly levels: ReadonlySet<LogLevel>;
  /** 触发本次物化的最后一条日志条目 */
  readonly op: Entry | null;
  /** 是否全量重建（时间旅行 / 快照压缩后） */
  readonly full: boolean;
}

export abstract class MaterializedView<T> {
  abstract readonly name: string;

  /** 声明订阅：只有匹配的变更才会触发重算 */
  abstract matches(ctx: ViewContext): boolean;

  protected abstract compute(snapshot: KernelSnapshot): T;

  #value: T | undefined;
  #renders = 0;

  get recomputes(): number {
    return this.#renders;
  }

  get value(): T | undefined {
    return this.#value;
  }

  render(snapshot: KernelSnapshot): T {
    this.#renders++;
    this.#value = this.compute(snapshot);
    return this.#value;
  }
}

/** 视图 A：所见即所得编辑器（订阅全部块） */
export class PreviewView extends MaterializedView<string> {
  readonly name = 'preview';

  matches(): boolean {
    return true;
  }

  protected compute(snapshot: KernelSnapshot): string {
    return snapshot.html;
  }
}

export interface OutlineItem {
  readonly depth: number;
  readonly text: string;
  readonly block: number;
}

/** 视图 C：大纲 / 目录（只订阅 heading：改段落不会触发重算） */
export class OutlineView extends MaterializedView<readonly OutlineItem[]> {
  readonly name = 'outline';

  matches(ctx: ViewContext): boolean {
    if (ctx.full) return true;
    return ctx.roles.has('heading');
  }

  protected compute(snapshot: KernelSnapshot): readonly OutlineItem[] {
    return snapshot.document.blocks
      .filter((block) => block.role === 'heading')
      .map((block) => ({
        depth: block.depth ?? 1,
        text: block.children.map((child) => child.raw).join('').trim(),
        block: block.sourcepos.start.offset
      }));
  }
}

/** 视图 D：字数统计（订阅文本类 op） */
export class StatsView extends MaterializedView<DocStats> {
  readonly name = 'stats';

  matches(ctx: ViewContext): boolean {
    if (ctx.full) return true;
    return ctx.levels.has('L0') || ctx.levels.has('L1') || ctx.levels.has('L2');
  }

  protected compute(snapshot: KernelSnapshot): DocStats {
    return snapshot.stats;
  }
}
