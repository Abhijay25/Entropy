import { describe, expect, it } from 'vitest';

import type { DiagnosticPromptContext, RiskContext, ValidatedEvidenceInput } from '../../../shared/types.js';
import { buildEvidencePrompt, NosanaClient } from './nosanaClient.js';

const validHypothesis = JSON.stringify({
  title: 'Redis delay can constrain Payment', question: 'Will a Redis delay affect checkout?',
  targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', faultParams: { delayMs: 3000, durationSec: 10 },
  predictedBlastRadiusIds: ['redis-cache', 'auth-service', 'payment-service'],
  rationale: 'The configured Redis delay can keep authentication calls open and consume the bounded Payment gate.'
});
const metric = (id: string) => ({ id, serviceId: 'payment-service', channel: 'business', status: 'DEGRADED', requestsStarted: 100, requestsCompleted: 100, errorsTotal: 10, timeoutsTotal: 5, errorRate: .1, latencyP50Ms: 10, latencyP95Ms: 3200, latencyP99Ms: 3200, sampleCount: 100, smallSample: false });
const span = (id: string, faultApplied = false) => ({ id, kind: 'server', traceId: `trace-${id}`, serviceId: 'payment-service', channel: 'business', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 20, faultApplied });
const evidence = {
  control: { metrics: [metric('metric-control')], spans: [span('span-control')] },
  chaos: { metrics: [metric('metric-chaos')], spans: [span('span-chaos', true)] },
  comparison: { actualBlastRadiusIds: ['payment-service'] },
  metricIds: ['metric-control', 'metric-chaos'], spanIds: ['span-control', 'span-chaos']
} as unknown as ValidatedEvidenceInput;
const context = {
  runId: 'run-1', pathsToRedis: [['frontend', 'auth-service', 'redis-cache']], fixedCypherQuery: 'MATCH p RETURN p', fixedCypherParameters: { redisKey: 'redis' },
  graph: { nodes: ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache', 'postgres-db'].map((id) => ({ id })), edges: [] }
} as unknown as RiskContext;

function completion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(responses: Array<Response | Error>, prompts: string[] = [], options: { now?: () => number } = {}): NosanaClient {
  const mockedFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    prompts.push(body.messages[0]?.content ?? '');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? completion('{}', 500);
  };
  return new NosanaClient({ baseUrl: 'https://nosana.example/v1', apiKey: 'test-key', model: 'model-1', fetch: mockedFetch, createId: () => 'generated-id', ...options });
}

function analysis(metricIds = ['metric-chaos'], spanIds = ['span-chaos']): string {
  return JSON.stringify({ summary: 'Payment latency increased under the witnessed delay.', hypotheses: [{ explanation: 'The Redis delay held Payment capacity.', metricIds, spanIds }], remediation: [] });
}

function invalidHypothesis(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(validHypothesis), ...patch });
}

describe('NosanaClient', () => {
  it('uses shared schema fields for a valid Markdown-fenced hypothesis', async () => {
    const result = await client([completion(`<think>private</think>\n\`\`\`json\n${validHypothesis}\n\`\`\``)]).hypothesize(context);
    expect(result).toMatchObject({ id: 'generated-id', source: 'nosana', cypherQueryUsed: 'MATCH p RETURN p' });
  });

  it('does not retry a 401 and records unavailable health', async () => {
    const prompts: string[] = [];
    const service = client([completion('unauthorized', 401), completion(validHypothesis)], prompts);
    const result = await service.hypothesize(context);
    expect(prompts).toHaveLength(1);
    expect(result.source).toBe('catalogue_fallback');
    expect(service.checkHealth().status).toBe('unavailable');
  });

  it('retries one 5xx request exactly once', async () => {
    const prompts: string[] = [];
    const result = await client([completion('temporary', 503), completion(validHypothesis)], prompts).hypothesize(context);
    expect(prompts).toHaveLength(2);
    expect(result.source).toBe('nosana');
  });

  it('repairs malformed output with original prompt, validation error, and no think content', async () => {
    const prompts: string[] = [];
    const result = await client([completion('<think>secret without close {bad'), completion(validHypothesis)], prompts).hypothesize(context);
    const repair = JSON.parse(prompts[1] ?? '{}') as Record<string, string>;
    expect(prompts).toHaveLength(2);
    expect(result.source).toBe('nosana');
    expect(repair.originalPrompt).toContain('retrievedPaths');
    expect(repair.validationError).toContain('Invalid Nosana JSON');
    expect(repair.sanitizedResponse).not.toMatch(/think|secret/i);
  });

  it.each([
    ['unknown service ID', invalidHypothesis({ predictedBlastRadiusIds: ['unknown-service'] })],
    ['unapproved fault', invalidHypothesis({ faultParams: { delayMs: 5000, durationSec: 10 } })],
    ['unknown command field', invalidHypothesis({ command: 'rm -rf /' })],
    ['unknown Cypher field', invalidHypothesis({ cypher: 'MATCH (n) RETURN n' })]
  ])('rejects a hypothesis with %s before accepting the repair', async (_name, invalid) => {
    const prompts: string[] = [];
    const result = await client([completion(invalid), completion(validHypothesis)], prompts).hypothesize(context);
    expect(prompts).toHaveLength(2);
    expect(result.source).toBe('nosana');
  });

  it('returns the exact shared EvidenceAnalysis shape with inference metadata', async () => {
    const result = await client([completion(analysis())]).analyze(evidence);
    expect(result).toMatchObject({ id: 'generated-id', status: 'available', source: 'nosana', model: 'model-1', promptVersion: 'nosana-v1' });
    expect(result.hypotheses).toHaveLength(1);
  });

  it('rejects span IDs used as metric IDs and empty hypothesis metric IDs', async () => {
    const spanAsMetric = await client([completion(analysis(['span-chaos'])), completion(analysis(['span-chaos']))]).analyze(evidence);
    const emptyMetrics = await client([completion(analysis([])), completion(analysis([]))]).analyze(evidence);
    expect(spanAsMetric.status).toBe('unavailable');
    expect(emptyMetrics.status).toBe('unavailable');
  });

  it('rejects invented finish metric and span IDs', async () => {
    const invented = JSON.stringify({ action: 'finish', summary: 'Evidence read.', metricIds: ['invented-metric'], spanIds: ['invented-span'] });
    await expect(client([completion(invented), completion(invented)]).nextDiagnosticAction({ runId: 'run-1', diagnosticId: 'diagnostic-1', allowedServiceIds: ['payment-service'], evidence } as DiagnosticPromptContext)).rejects.toThrow();
  });

  it('uses a single absolute deadline and never retries after it expires', async () => {
    let now = 100;
    let calls = 0;
    const service = new NosanaClient({
      baseUrl: 'https://nosana.example', apiKey: 'key', model: 'model', now: () => now,
      fetch: async () => { calls += 1; now = 200; return completion('temporary', 503); }
    });
    await expect(service.hypothesize(context, { deadlineMs: 150 })).rejects.toThrow(/deadline/i);
    expect(calls).toBe(1);
    await expect(service.hypothesize(context, { deadlineMs: 100 })).rejects.toThrow(/deadline/i);
    expect(calls).toBe(1);
  });

  it('honors AbortSignal cancellation without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    const mockedFetch: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    });
    const service = new NosanaClient({ baseUrl: 'https://nosana.example', apiKey: 'key', model: 'model', fetch: mockedFetch });
    const pending = service.nextDiagnosticAction({ runId: 'run-1', diagnosticId: 'diagnostic-1', allowedServiceIds: ['payment-service'], evidence } as DiagnosticPromptContext, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });

  it('caps witnesses and spans under 12 KiB while allowing displayed witness citations', async () => {
    const oversized = {
      ...evidence,
      chaos: { ...evidence.chaos, spans: Array.from({ length: 2000 }, (_, index) => span(`span-${index}`, index < 100)) }
    } as unknown as ValidatedEvidenceInput;
    const prompt = buildEvidencePrompt(oversized);
    const parsed = JSON.parse(prompt) as { instructions: string[]; evidence: { faultWitnesses: Array<{ id: string }>; supportingSpans: unknown[] }; measurementIds: { spanIds: string[] } };
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(12 * 1024);
    expect(parsed.instructions.length).toBeGreaterThan(0);
    expect(parsed.evidence.faultWitnesses).toHaveLength(20);
    expect(parsed.evidence.supportingSpans.length).toBeGreaterThan(0);
    const witnessId = parsed.evidence.faultWitnesses[0]?.id ?? '';
    expect(parsed.measurementIds.spanIds).toContain(witnessId);
    const diagnostic = { runId: 'run-1', diagnosticId: 'diagnostic-1', allowedServiceIds: ['payment-service'], evidence: oversized } as DiagnosticPromptContext;
    const action = JSON.stringify({ action: 'finish', summary: 'Witness read.', metricIds: ['metric-chaos'], spanIds: [witnessId] });
    await expect(client([completion(action)]).nextDiagnosticAction(diagnostic)).resolves.toMatchObject({ action: 'finish', spanIds: [witnessId] });
  });

  it('keeps diagnostic prompts separate from analysis instructions and schemas', async () => {
    const prompts: string[] = [];
    const diagnostic = { runId: 'run-1', diagnosticId: 'diagnostic-1', allowedServiceIds: ['payment-service'], evidence, toolTrace: [{ output: 'untrusted tool result' }] } as unknown as DiagnosticPromptContext;
    await client([completion(JSON.stringify({ action: 'finish', summary: 'Evidence read.', metricIds: ['metric-chaos'], spanIds: ['span-chaos'] }))], prompts).nextDiagnosticAction(diagnostic);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('untrusted_data');
    expect(prompt).toContain('measurementIds');
    expect(prompt).not.toContain('Explain supplied measured evidence');
    expect(prompt).not.toContain('outputSchema');
  });
});
