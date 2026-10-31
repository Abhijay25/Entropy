import { useEffect, useState } from 'react';
import type { AgentStreamEvent } from '@entropy/shared';
import { parseStreamEvent } from '../api';

const SNAPSHOT_EVENTS = new Set(['HYPOTHESIS_GENERATED', 'BASELINE_TRAFFIC_COMPLETE', 'TRIAL_STARTED', 'FAULT_INJECTED', 'TELEMETRY_COLLECTED', 'CASCADE_DETECTED', 'NEO4J_BLAST_RADIUS_UPDATED', 'ANALYSIS_GENERATED', 'REMEDIATION_PROPOSED', 'DIAGNOSTIC_TOOL_RESULT', 'CLEANUP_COMPLETE', 'RUN_COMPLETE', 'ERROR']);
const EVENT_TYPES = [...SNAPSHOT_EVENTS, 'GRAPH_LOADED', 'SANDBOX_PROVISIONING', 'TERMINAL_LOG', 'RESYNC'];
interface Props { runId: string; terminal: boolean; onResync: (runId: string) => Promise<void>; }
export function TerminalFeed({ runId, terminal, onResync }: Props) {
  const [events, setEvents] = useState<readonly AgentStreamEvent[]>([]);
  const [connection, setConnection] = useState<'idle' | 'live' | 'reconnecting'>('idle');
  useEffect(() => { setEvents([]); }, [runId]);
  useEffect(() => {
    if (terminal) { setConnection('idle'); return; }
    let disposed = false;
    const source = new EventSource(`/api/stream?runId=${encodeURIComponent(runId)}`);
    const record = (message: Event) => {
      const event = parseStreamEvent(message as MessageEvent<string>);
      if (!event || disposed) return;
      setEvents((current) => [...current.filter((item) => item.id !== event.id), event].slice(-250));
      if (event.type === 'RESYNC' || SNAPSHOT_EVENTS.has(event.type)) void onResync(runId);
    };
    source.onopen = () => { if (!disposed) setConnection('live'); };
    source.onmessage = record;
    EVENT_TYPES.forEach((type) => source.addEventListener(type, record));
    source.onerror = () => { if (!disposed) { setConnection('reconnecting'); void onResync(runId); } };
    return () => { disposed = true; source.close(); };
  }, [runId, terminal, onResync]);
  return <section className="panel terminal"><div className="panel-heading"><div><p className="eyebrow">Terminal events</p><h2>Recorded stream</h2></div><span className={`status-text ${connection === 'live' ? 'healthy' : 'unknown'}`}>● {connection}</span></div><pre aria-live="polite">{events.length ? events.map((event) => `${event.timestamp}  ${event.type}  ${event.message}`).join('\n') : 'No events recorded.'}</pre></section>;
}
