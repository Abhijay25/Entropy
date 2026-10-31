import type { RequestSpan } from '../../../../../shared/types.js';

export type RecordedSpan = RequestSpan;
export type Channel = RequestSpan['channel'];

export const TRACE_HEADER = 'x-entropy-trace-id';
export const PARENT_HEADER = 'x-entropy-parent-span-id';
export const CHANNEL_HEADER = 'x-entropy-channel';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/** Monotonic offset (performance.now) to wall-clock ISO string, for display only. */
export function wallIso(monotonicMs: number): string {
  return new Date(performance.timeOrigin + monotonicMs).toISOString();
}

/** Bounded in-process span store. Overflow is reported, never silently dropped. */
export class SpanStore {
  private spans: RecordedSpan[] = [];
  private sequence = 0;
  overflowed = 0;

  constructor(private readonly limit: number) {}

  nextId(traceId: string): string {
    this.sequence += 1;
    return `${traceId}:${this.sequence}`;
  }

  add(span: RecordedSpan): void {
    if (this.spans.length >= this.limit) {
      this.overflowed += 1;
      return;
    }
    this.spans.push(span);
  }

  all(): RecordedSpan[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans = [];
    this.overflowed = 0;
  }
}
