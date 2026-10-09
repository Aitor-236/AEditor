import type { Span } from './types.ts';

/**
 * 原文池（appendPool，§4.1）。
 *
 * 只追加、不修改、不删除。删除操作在语法日志里记为墓碑，
 * 池中的字节只是"不再被引用"——这正是 §5.2「内存只增不减」的来源，
 * 由 §4.4 的墓碑上限 + 快照压缩来兜底。
 */
export class AppendPool {
  #buf = '';

  /** 追加一段纯文本，返回它在池中的区间 */
  append(text: string): Span {
    const start = this.#buf.length;
    this.#buf += text;
    return { start, end: start + text.length };
  }

  read(span: Span): string {
    return this.#buf.slice(span.start, span.end);
  }

  get length(): number {
    return this.#buf.length;
  }

  /** 无效字节比例：liveBytes 由物化层统计，用于观察墓碑堆积（§5.2） */
  wasteRatio(liveBytes: number): number {
    if (this.#buf.length === 0) return 0;
    return 1 - liveBytes / this.#buf.length;
  }
}
