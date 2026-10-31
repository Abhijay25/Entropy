import { EventEmitter } from 'node:events';

import type { AgentEventType, AgentStreamEvent, GraphRepository } from '../../../shared/types.js';

type EventPayload = NonNullable<AgentStreamEvent['payload']>;

const TERMINAL_FLUSH_MS = 1000;
const MAX_MESSAGE = 1024;
const MAX_LOG_LINE = 4096;

/**
 * Durable, ordered per-run event log. Every event is appended to the repository before it
 * is published to live listeners; SSE loss never affects measurements.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  private readonly sequences = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly terminal = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly repository: Pick<GraphRepository, 'appendEvent' | 'getRun'>) {
    this.emitter.setMaxListeners(100);
  }

  /** Persists then publishes. Resolves once the event is durable. */
  async emit(runId: string, type: AgentEventType, message: string, payload?: EventPayload): Promise<AgentStreamEvent> {
    const prior = this.chains.get(runId) ?? Promise.resolve();
    let created!: AgentStreamEvent;
    const next = prior.catch(() => undefined).then(async () => {
      const seq = await this.nextSeq(runId);
      created = { id: `${runId}:${seq}`, runId, seq, type, timestamp: new Date().toISOString(), message: message.slice(0, MAX_MESSAGE) || type, ...(payload ? { payload } : {}) };
      await this.repository.appendEvent(created);
      this.emitter.emit(runId, created);
    });
    this.chains.set(runId, next);
    await next;
    return created;
  }

  /** Coalesces terminal lines into at most one TERMINAL_LOG event per second per run. */
  log(runId: string, line: string): void {
    const pending = this.terminal.get(runId);
    if (pending) { pending.lines.push(line); return; }
    const timer = setTimeout(() => void this.flush(runId), TERMINAL_FLUSH_MS);
    this.terminal.set(runId, { lines: [line], timer });
  }

  async flush(runId: string): Promise<void> {
    const pending = this.terminal.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.terminal.delete(runId);
    const text = pending.lines.join('\n');
    const logLine = text.length > MAX_LOG_LINE ? `…${text.slice(-(MAX_LOG_LINE - 1))}` : text;
    await this.emit(runId, 'TERMINAL_LOG', pending.lines[pending.lines.length - 1] ?? 'log', { logLine }).catch(() => undefined);
  }

  subscribe(runId: string, listener: (event: AgentStreamEvent) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  private async nextSeq(runId: string): Promise<number> {
    let current = this.sequences.get(runId);
    if (current === undefined) current = (await this.repository.getRun(runId))?.lastEventSeq ?? 0;
    const seq = current + 1;
    this.sequences.set(runId, seq);
    return seq;
  }
}
