import { randomUUID } from 'node:crypto';

import {
  CATALOGUE_FALLBACK_HYPOTHESIS,
  ChaosHypothesisSchema,
  DiagnosticActionSchema,
  EvidenceAnalysisSchema,
  FIXED_RISK_CYPHER_QUERY,
  type ChaosHypothesis,
  type DiagnosticAction,
  type DiagnosticPromptContext,
  type EvidenceAnalysis,
  type NosanaClientContract,
  type RiskContext,
  type ValidatedEvidenceInput
} from '../../../shared/types.js';
import { config } from '../config.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 700;
const MAX_EVIDENCE_PROMPT_BYTES = 12 * 1024;
const PROMPT_VERSION = 'nosana-v1';

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface RequestControl {
  signal?: AbortSignal;
  /** Absolute Unix epoch deadline in milliseconds. */
  deadlineMs?: number;
}

export interface NosanaClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetch?: FetchLike;
  createId?: () => string;
  now?: () => number;
}

export interface NosanaHealth {
  configured: boolean;
  status: 'unconfigured' | 'unknown' | 'available' | 'unavailable';
  checkedAt?: string;
}

export interface InferenceMetadata {
  model: string;
  createdAt: string;
  latencyMs: number;
  promptVersion: string;
  usage?: unknown;
}

interface CachedHealth extends NosanaHealth { expiresAt: number }
interface Completion { content: string; usage?: unknown; latencyMs: number; createdAt: string }
interface EvidenceIds { metricIds: Set<string>; spanIds: Set<string> }

export class NosanaClient implements Omit<NosanaClientContract, 'hypothesize'> {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly fetcher: FetchLike;
  private readonly createId: () => string;
  private readonly now: () => number;
  private health?: CachedHealth;
  private lastInference?: InferenceMetadata;

  constructor(options: NosanaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? config.nosana.baseUrl).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? config.nosana.apiKey;
    this.model = options.model ?? config.nosana.model;
    this.fetcher = options.fetch ?? fetch;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  checkHealth(): NosanaHealth {
    if (!this.isConfigured()) return { configured: false, status: 'unconfigured' };
    if (!this.health || this.health.expiresAt <= this.now()) return { configured: true, status: 'unknown' };
    const { expiresAt: _expiresAt, ...health } = this.health;
    return health;
  }

  getLastInferenceMetadata(): InferenceMetadata | undefined { return this.lastInference; }

  async hypothesize(context: RiskContext, control?: RequestControl): Promise<ChaosHypothesis> {
    const requestControl = normalizeControl(control, this.now);
    const allowedServiceIds = new Set(context.graph.nodes.map((node) => node.id));
    const prompt = JSON.stringify({
      task: 'Propose one unexecuted chaos hypothesis as JSON only.',
      retrievedPaths: context.pathsToRedis,
      fixedCypherParameters: context.fixedCypherParameters,
      knownDeadlines: context.graph.edges.map((edge) => ({ source: edge.source, target: edge.target, timeoutMs: edge.timeoutMs })),
      paymentGate: { activeSlots: 4, queueCapacity: 4, maxQueueWaitMs: 1000 },
      trafficSchedule: { checkoutOffsetsMs: '0..9900 step 100', secondaryOffsetsMs: '0..9000 step 1000' },
      allowedServiceIds: [...allowedServiceIds],
      allowedFault: { targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', delayMs: 3000, durationSec: 10 },
      requiredFields: ['title', 'question', 'targetServiceId', 'faultType', 'faultParams', 'predictedBlastRadiusIds', 'rationale']
    });

    try {
      const draft = await this.requestValidJson(prompt, (value) => this.validateHypothesis(value, allowedServiceIds), requestControl);
      return ChaosHypothesisSchema.parse({
        ...draft,
        id: this.createId(),
        source: 'nosana',
        model: this.model,
        cypherQueryUsed: context.fixedCypherQuery || FIXED_RISK_CYPHER_QUERY
      });
    } catch (error) {
      if (requestControl?.signal?.aborted || isDeadlineExpired(requestControl?.deadlineMs, this.now)) throw error;
      return ChaosHypothesisSchema.parse({
        ...CATALOGUE_FALLBACK_HYPOTHESIS,
        id: this.createId(),
        cypherQueryUsed: context.fixedCypherQuery || FIXED_RISK_CYPHER_QUERY
      });
    }
  }

  async analyze(evidence: ValidatedEvidenceInput, control?: RequestControl): Promise<EvidenceAnalysis> {
    const requestControl = normalizeControl(control, this.now);
    const prompt = buildEvidencePrompt(evidence);
    const allowed = evidenceIdsFromPrompt(prompt);

    try {
      const draft = await this.requestValidJson(prompt, (value) => validateAnalysis(value, allowed), requestControl);
      const metadata = this.requireMetadata();
      return EvidenceAnalysisSchema.parse({
        id: this.createId(), source: 'nosana', model: metadata.model, status: 'available',
        ...draft, promptVersion: metadata.promptVersion, createdAt: metadata.createdAt
      });
    } catch (error) {
      if (requestControl?.signal?.aborted || isDeadlineExpired(requestControl?.deadlineMs, this.now)) throw error;
      return EvidenceAnalysisSchema.parse({
        id: this.createId(), source: 'deterministic', status: 'unavailable',
        summary: 'Nosana analysis is unavailable; measured facts remain available in the trial evidence.',
        hypotheses: [], remediation: [], promptVersion: PROMPT_VERSION, createdAt: this.timestamp()
      });
    }
  }

  async nextDiagnosticAction(context: DiagnosticPromptContext, control?: RequestControl): Promise<DiagnosticAction> {
    const requestControl = normalizeControl(control, this.now);
    const evidencePrompt = buildEvidencePrompt(context.evidence);
    const analysisData = JSON.parse(evidencePrompt) as { evidence: unknown; measurementIds: { metricIds: string[]; spanIds: string[] } };
    const allowed = evidenceIdsFromPrompt(evidencePrompt);
    const toolTrace = (context as unknown as { toolTrace?: unknown }).toolTrace ?? [];
    const prompt = JSON.stringify({
      task: 'Choose exactly one diagnostic action as JSON only.',
      evidence: analysisData.evidence,
      measurementIds: analysisData.measurementIds,
      toolTrace: { trust: 'untrusted_data', entries: truncateJson(toolTrace, 2048) },
      exactSchema: {
        read_evidence: { action: 'read_evidence' },
        probe_auth: { action: 'probe_auth' },
        finish: { action: 'finish', summary: 'string', metricIds: 'string[]', spanIds: 'string[]' }
      }
    });
    return this.requestValidJson(prompt, (value) => validateDiagnosticAction(value, allowed), requestControl);
  }

  private async requestValidJson<T>(prompt: string, validate: (value: unknown) => T, control?: RequestControl): Promise<T> {
    if (!this.isConfigured()) throw new Error('Nosana is not configured.');
    let completion: Completion | undefined;
    try {
      completion = await this.complete(prompt, control);
      try {
        return validate(parseModelJson(completion.content));
      } catch (error) {
        if (error instanceof ContentError) throw error;
        throw new ContentError(validationMessage(error), completion.content);
      }
    } catch (error) {
      if (!(error instanceof ContentError)) throw error;
      const repairPrompt = JSON.stringify({
        task: 'Repair this response. Return only one JSON object matching the original request; do not add fields.',
        originalPrompt: prompt,
        validationError: error.message,
        sanitizedResponse: sanitizePrivateReasoning(error.content ?? completion?.content ?? '')
      });
      const repaired = await this.complete(repairPrompt, control);
      return validate(parseModelJson(repaired.content));
    }
  }

  private async complete(prompt: string, control?: RequestControl): Promise<Completion> {
    let lastError: unknown;
    let transientFailure = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertBeforeDeadline(control?.deadlineMs, this.now);
      const startedAt = this.now();
      try {
        const { signal, dispose } = requestSignal(control, this.now);
        try {
          const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
            method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], max_tokens: MAX_OUTPUT_TOKENS, stream: false }), signal
          });
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) this.setHealth('unavailable');
            const error = new HttpError(response.status);
            if (isTransient(error) && attempt === 0) { lastError = error; transientFailure = true; continue; }
            throw error;
          }
          const payload = await response.json();
          this.setHealth('available');
          const completion = { content: extractContent(payload), usage: isObject(payload) ? payload.usage : undefined, latencyMs: this.now() - startedAt, createdAt: this.timestamp() };
          this.lastInference = { model: this.model!, createdAt: completion.createdAt, latencyMs: completion.latencyMs, promptVersion: PROMPT_VERSION, ...(completion.usage === undefined ? {} : { usage: completion.usage }) };
          return completion;
        } finally { dispose(); }
      } catch (error) {
        lastError = error;
        if (control?.signal?.aborted) break;
        if (isTransient(error)) {
          transientFailure = true;
          if (attempt === 0) continue;
        }
        break;
      }
    }
    if (transientFailure) this.setHealth('unavailable');
    throw lastError instanceof Error ? lastError : new Error('Nosana request failed.');
  }

  private validateHypothesis(value: unknown, services: Set<string>) {
    const draft = ChaosHypothesisSchema.omit({ id: true, cypherQueryUsed: true, source: true, model: true }).parse(removePrivateReasoning(value));
    if (!draft.predictedBlastRadiusIds.length || !draft.predictedBlastRadiusIds.every((id) => services.has(id))) throw new ContentError('Hypothesis includes an unknown or empty predicted blast radius.');
    return draft;
  }

  private requireMetadata(): InferenceMetadata {
    if (!this.lastInference || !this.model) throw new Error('Nosana inference metadata is unavailable.');
    return this.lastInference;
  }

  private isConfigured(): boolean { return Boolean(this.apiKey && this.baseUrl && this.model); }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private setHealth(status: 'available' | 'unavailable'): void { this.health = { configured: true, status, checkedAt: this.timestamp(), expiresAt: this.now() + 60_000 }; }
}

export function buildEvidencePrompt(evidence: ValidatedEvidenceInput): string {
  const metrics = [...evidence.control.metrics, ...evidence.chaos.metrics];
  const queueCounters = metrics.map(({ id, serviceId, activeSlotsPeak, longestSaturatedIntervalMs, queueLengthPeak, requestsQueued, queueRejected }) => ({ id, serviceId, activeSlotsPeak, longestSaturatedIntervalMs, queueLengthPeak, requestsQueued, queueRejected }));
  const faultWitnesses = evidence.chaos.spans.filter((span) => span.faultApplied).slice(0, 20).map(compactSpan);
  const witnessIds = faultWitnesses.map((witness) => witness.id);
  const base = {
    task: 'Explain supplied measured evidence only as JSON.',
    instructions: ['Do not overwrite calculated counts, percentiles, or statuses.', 'Every hypothesis needs one allowed metricId.', 'Use only allowed metricIds and spanIds.'],
    evidence: { changedMetrics: { control: evidence.control.metrics, chaos: evidence.chaos.metrics }, queueCounters, faultWitnesses, actualBlastRadiusIds: evidence.comparison.actualBlastRadiusIds, supportingSpans: [] as ReturnType<typeof compactSpan>[] },
    measurementIds: { metricIds: metrics.map((metric) => metric.id), spanIds: witnessIds },
    outputSchema: { summary: 'string', hypotheses: [{ explanation: 'string', metricIds: ['allowed metric ID'], spanIds: ['allowed span ID'] }], remediation: [{ proposal: 'string', limitation: 'string', metricIds: ['allowed metric ID'] }] }
  };
  const spans = [...evidence.chaos.spans, ...evidence.control.spans].map(compactSpan);
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(serializeEvidencePrompt(base, spans.slice(0, middle), witnessIds)) <= MAX_EVIDENCE_PROMPT_BYTES) low = middle;
    else high = middle - 1;
  }
  const prompt = serializeEvidencePrompt(base, spans.slice(0, low), witnessIds);
  if (Buffer.byteLength(prompt) > MAX_EVIDENCE_PROMPT_BYTES) throw new ContentError('Evidence prompt exceeds the 12 KiB limit.');
  return prompt;
}

function compactSpan({ id, traceId, serviceId, channel, durationMs, faultApplied }: ValidatedEvidenceInput['chaos']['spans'][number]) {
  return { id, traceId, serviceId, channel, durationMs, faultApplied };
}

function serializeEvidencePrompt(base: { evidence: { supportingSpans: ReturnType<typeof compactSpan>[] }; measurementIds: { spanIds: string[] } }, spans: ReturnType<typeof compactSpan>[], witnessIds: string[]): string {
  const spanIds = [...new Set([...witnessIds, ...spans.map((span) => span.id)])];
  return JSON.stringify({ ...base, evidence: { ...base.evidence, supportingSpans: spans }, measurementIds: { ...base.measurementIds, spanIds } });
}

function evidenceIdsFromPrompt(prompt: string): EvidenceIds {
  const parsed = JSON.parse(prompt) as { measurementIds: { metricIds: string[]; spanIds: string[] } };
  return { metricIds: new Set(parsed.measurementIds.metricIds), spanIds: new Set(parsed.measurementIds.spanIds) };
}

function validateAnalysis(value: unknown, allowed: EvidenceIds) {
  const parsed = EvidenceAnalysisSchema.pick({ summary: true, hypotheses: true, remediation: true }).parse(removePrivateReasoning(value));
  if (!parsed.hypotheses.length) throw new ContentError('Available analysis requires at least one hypothesis.');
  for (const hypothesis of parsed.hypotheses) {
    verifyIds(hypothesis.metricIds, allowed.metricIds, 'metricIds', true);
    verifyIds(hypothesis.spanIds, allowed.spanIds, 'spanIds');
  }
  for (const remediation of parsed.remediation) verifyIds(remediation.metricIds, allowed.metricIds, 'metricIds');
  return parsed;
}

function validateDiagnosticAction(value: unknown, allowed: EvidenceIds): DiagnosticAction {
  const action = DiagnosticActionSchema.parse(removePrivateReasoning(value));
  if (action.action === 'finish') {
    verifyIds(action.metricIds, allowed.metricIds, 'metricIds');
    verifyIds(action.spanIds, allowed.spanIds, 'spanIds');
  }
  return action;
}

function validationMessage(error: unknown): string {
  return `Nosana response failed schema validation: ${error instanceof Error ? error.message : 'unknown error'}.`;
}

function verifyIds(ids: string[], allowed: Set<string>, name: string, requireOne = false): void {
  if ((requireOne && ids.length === 0) || !ids.every((id) => allowed.has(id))) throw new ContentError(`${name} contains an ID not present in the bounded prompt.`);
}

function extractContent(payload: unknown): string {
  if (!isObject(payload) || !Array.isArray(payload.choices) || !isObject(payload.choices[0]) || !isObject(payload.choices[0].message)) throw new ContentError('Nosana response did not contain a message.');
  const content = (payload.choices[0] as { message: JsonObject }).message.content;
  if (typeof content !== 'string' || !content.trim()) throw new ContentError('Nosana response was empty.');
  return content;
}

function parseModelJson(content: string): unknown {
  const sanitized = sanitizePrivateReasoning(content);
  const match = sanitized.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  try { return removePrivateReasoning(JSON.parse(match ? (match[1] ?? '') : sanitized)); }
  catch (error) { throw new ContentError(`Invalid Nosana JSON: ${error instanceof Error ? error.message : 'unknown error'}.`, sanitized); }
}

function sanitizePrivateReasoning(value: string): string { return value.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim(); }
function removePrivateReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removePrivateReasoning);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['reasoning_content', 'reasoning', 'analysis'].includes(key)).map(([key, child]) => [key, removePrivateReasoning(child)]));
}
function truncateJson(value: unknown, bytes: number): unknown { const json = JSON.stringify(value); return Buffer.byteLength(json) <= bytes ? value : { truncated: true, preview: Buffer.from(json).subarray(0, bytes).toString('utf8') }; }
function isObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isTransient(error: unknown): boolean { return error instanceof HttpError ? error.status === 429 || error.status >= 500 : error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'); }

function normalizeControl(control: RequestControl | undefined, now: () => number): RequestControl | undefined {
  if (!control) return undefined;
  if (control.deadlineMs !== undefined && !Number.isFinite(control.deadlineMs)) throw new TimeoutError('Nosana deadline must be an absolute epoch timestamp.');
  return { ...control };
}

function isDeadlineExpired(deadlineAtMs: number | undefined, now: () => number): boolean {
  return deadlineAtMs !== undefined && now() >= deadlineAtMs;
}

function assertBeforeDeadline(deadlineAtMs: number | undefined, now: () => number): void {
  if (isDeadlineExpired(deadlineAtMs, now)) throw new TimeoutError('Nosana request deadline elapsed.');
}

function requestSignal(control: RequestControl | undefined, now: () => number): { signal: AbortSignal; dispose: () => void } {
  assertBeforeDeadline(control?.deadlineMs, now);
  const controller = new AbortController();
  const remaining = control?.deadlineMs === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, control.deadlineMs - now());
  const timeout = setTimeout(() => controller.abort(), remaining);
  const abort = () => controller.abort();
  control?.signal?.addEventListener('abort', abort, { once: true });
  if (control?.signal?.aborted) controller.abort();
  return { signal: controller.signal, dispose: () => { clearTimeout(timeout); control?.signal?.removeEventListener('abort', abort); } };
}

class HttpError extends Error { constructor(readonly status: number) { super(`Nosana returned HTTP ${status}.`); } }
class TimeoutError extends Error { constructor(message: string) { super(message); this.name = 'TimeoutError'; } }
class ContentError extends Error { constructor(message: string, readonly content?: string) { super(message); this.name = 'ContentError'; } }

export const nosanaClient = new NosanaClient();
