import type {
  AgentStreamEvent,
  DiagnosticSession,
  RunSnapshot,
  TopologyGraph
} from '@entropy/shared';

export interface IntegrationStatus {
  name: 'Daytona' | 'Neo4j' | 'Nosana' | 'MCP' | string;
  status: 'available' | 'unavailable' | 'unknown' | 'unconfigured' | string;
  checkedAt?: string;
  detail?: string;
}

type IntegrationRecord = { available: boolean; checkedAt?: string; message?: string; model?: string };
type IntegrationPayload = Record<'daytona' | 'neo4j' | 'nosana' | 'mcp', IntegrationRecord>;

export function normalizeIntegrations(value: IntegrationStatus[] | { integrations: IntegrationStatus[] } | IntegrationPayload): IntegrationStatus[] {
  if (Array.isArray(value)) return value;
  if ('integrations' in value) return value.integrations;
  return Object.entries(value).map(([name, status]) => ({
    name: name === 'neo4j' ? 'Neo4j' : name === 'mcp' ? 'MCP' : `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`,
    status: status.available ? 'available' : 'unavailable',
    checkedAt: status.checkedAt,
    detail: status.message ?? status.model
  }));
}

export interface RunSummary {
  id: string;
  status: string;
  createdAt: string;
  sourceSha: string;
}

export interface ArtifactContent {
  id: string;
  content: string;
  contentType?: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; requestId?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined;
  let transportError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } });
      break;
    } catch (error) {
      transportError = error;
    }
  }
  if (!response) throw transportError instanceof Error ? transportError : new Error('Network request failed.');
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  integrations: () => request<IntegrationStatus[] | { integrations: IntegrationStatus[] } | IntegrationPayload>('/api/integrations'),
  topology: (runId?: string) => request<TopologyGraph>(`/api/topology${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`),
  runs: () => request<RunSummary[] | { runs: RunSummary[] }>('/api/runs'),
  run: (runId: string) => request<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`),
  startRun: (idempotencyKey: string) => request<{ runId: string }>('/api/chaos/run', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
  cancel: (runId: string) => request<void>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  reproduce: (runId: string, idempotencyKey: string) => request<{ reproductionId: string }>('/api/runs/' + encodeURIComponent(runId) + '/reproduce', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
  investigate: (runId: string, idempotencyKey: string) => request<{ diagnosticId: string }>('/api/runs/' + encodeURIComponent(runId) + '/investigate', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
  diagnostic: (id: string) => request<DiagnosticSession>(`/api/diagnostics/${encodeURIComponent(id)}`),
  cancelDiagnostic: (id: string) => request<void>(`/api/diagnostics/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  artifact: async (id: string): Promise<ArtifactContent> => {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Artifact unavailable (${response.status})`);
    return { id, content: await response.text(), contentType: response.headers.get('content-type') ?? undefined };
  }
};

export function listFrom<T>(value: T[] | { runs: T[] } | { integrations: T[] }, key: 'runs' | 'integrations'): T[] {
  if (Array.isArray(value)) return value;
  return 'runs' in value ? value.runs : value.integrations;
}

export function parseStreamEvent(event: MessageEvent<string>): AgentStreamEvent | undefined {
  try {
    return JSON.parse(event.data) as AgentStreamEvent;
  } catch {
    return undefined;
  }
}
