import type { AgentStreamEvent, DiagnosticSession, RunSnapshot, TopologyGraph } from '@entropy/shared';

export interface IntegrationStatus { name: 'Daytona' | 'Neo4j' | 'Nosana' | 'MCP' | string; status: 'available' | 'unavailable' | 'unknown' | 'unconfigured' | string; checkedAt?: string; detail?: string; }
type IntegrationRecord = { available: boolean; checkedAt?: string; message?: string; model?: string };
type IntegrationPayload = Record<'daytona' | 'neo4j' | 'nosana' | 'mcp', IntegrationRecord>;
export interface RunSummary { id: string; status: string; createdAt: string; sourceSha: string; }
export interface ArtifactContent { id: string; content: string; contentType?: string; }
interface ApiErrorBody { error?: { code?: string; message?: string; requestId?: string }; }

export function normalizeIntegrations(value: IntegrationStatus[] | { integrations: IntegrationStatus[] } | IntegrationPayload): IntegrationStatus[] {
  if (Array.isArray(value)) return value;
  if ('integrations' in value) return value.integrations;
  return Object.entries(value).map(([name, status]) => ({ name: name === 'neo4j' ? 'Neo4j' : name === 'mcp' ? 'MCP' : `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`, status: status.available ? 'available' : 'unavailable', checkedAt: status.checkedAt, detail: status.message ?? status.model }));
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined; let transportError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) try { response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } }); break; } catch (error) { transportError = error; }
  if (!response) throw transportError instanceof Error ? transportError : new Error('Network request failed.');
  if (!response.ok) { const body = (await response.json().catch(() => ({}))) as ApiErrorBody; throw new Error(body.error?.message ?? `${response.status} ${response.statusText}`); }
  if (response.status === 202 || response.status === 204) {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }
  return (await response.json()) as T;
}
const post = <T>(path: string, headers?: HeadersInit) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({}) });
export const api = {
  integrations: () => request<IntegrationStatus[] | { integrations: IntegrationStatus[] } | IntegrationPayload>('/api/integrations'),
  topology: (runId?: string) => request<TopologyGraph>(`/api/topology${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`),
  runs: () => request<RunSummary[] | { runs: RunSummary[] }>('/api/runs'), run: (runId: string) => request<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`),
  startRun: (key: string) => post<{ runId: string }>('/api/chaos/run', { 'Idempotency-Key': key }), cancel: (runId: string) => post<void>(`/api/runs/${encodeURIComponent(runId)}/cancel`),
  reproduce: (runId: string, key: string) => post<{ reproductionId: string; trialIds?: string[] }>(`/api/runs/${encodeURIComponent(runId)}/reproduce`, { 'Idempotency-Key': key }), investigate: (runId: string, key: string) => post<{ diagnosticId: string }>(`/api/runs/${encodeURIComponent(runId)}/investigate`, { 'Idempotency-Key': key }),
  diagnostic: (id: string) => request<DiagnosticSession>(`/api/diagnostics/${encodeURIComponent(id)}`), cancelDiagnostic: (id: string) => post<void>(`/api/diagnostics/${encodeURIComponent(id)}/cancel`),
  artifact: async (id: string): Promise<ArtifactContent> => { const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}`); if (!response.ok) throw new Error(`Artifact unavailable (${response.status})`); return { id, content: await response.text(), contentType: response.headers.get('content-type') ?? undefined }; }
};
export function listFrom<T>(value: T[] | { runs: T[] } | { integrations: T[] }): T[] { return Array.isArray(value) ? value : ('runs' in value ? value.runs : value.integrations); }
export function parseStreamEvent(event: MessageEvent<string>): AgentStreamEvent | undefined { try { return JSON.parse(event.data) as AgentStreamEvent; } catch { return undefined; } }
