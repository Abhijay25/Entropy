// Bounded post-run investigation: a separate SDK-created sandbox holds sanitized evidence;
// the model picks from a fixed action set; the backend maps actions to discovered Daytona
// MCP tools with fixed arguments. Tool output is untrusted data, never instructions.
import {
  type DiagnosticAction,
  type DiagnosticSession,
  type DiagnosticTraceEntry,
  type RunSnapshot
} from '../../../shared/types.js';
import { loadMapping, DaytonaMcpClient, type McpCallResult, type McpToolMapping, type ToolBinding } from '../sandbox/mcpClient.js';
import { loadPreparedPayload } from '../sandbox/payloadManifest.js';
import { BudgetExhaustedError, REMOTE_WORKDIR, type SandboxBudget, type SandboxProvider } from '../sandbox/provider.js';
import type { EventHub } from './events.js';
import { persistedComparison, selectEvidence, type DiagnosticLauncher, type NosanaPort, type Repository } from './orchestrator.js';

const MAX_MCP_CALLS = 2;
const MAX_MODEL_TURNS = 3;
const EVIDENCE_REMOTE_PATH = '.entropy-diagnostic/evidence.json';

export interface McpPort {
  call(binding: ToolBinding, sandboxId: string, value: string): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface DiagnosticAgentDeps {
  repository: Repository;
  nosana: NosanaPort;
  provider: SandboxProvider;
  budget: SandboxBudget;
  events: EventHub;
  payloadSelector?: string;
  connectMcp?: () => Promise<McpPort>;
  mapping?: () => McpToolMapping | undefined;
}

function text(value: string, fallback: string, limit: number): string {
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, limit);
}

export class DiagnosticAgent implements DiagnosticLauncher {
  private openClients = new Set<McpPort>();

  constructor(private readonly deps: DiagnosticAgentDeps) {}

  async close(): Promise<void> {
    await Promise.all([...this.openClients].map((client) => client.close()));
  }

  async launch(run: RunSnapshot, diagnosticId: string, signal: AbortSignal): Promise<void> {
    let session: DiagnosticSession = { id: diagnosticId, runId: run.id, status: 'QUEUED', cleanupStatus: 'NOT_CREATED', createdAt: new Date().toISOString(), toolTrace: [] };
    const save = async (patch: Partial<DiagnosticSession>) => { session = { ...session, ...patch }; await this.deps.repository.saveDiagnostic(session); };
    await save({});
    let reservation: string | undefined;
    let sandboxId: string | undefined;
    let mcp: McpPort | undefined;
    try {
      if (this.deps.provider.executionMode !== 'daytona') throw new DiagnosticError('MCP_REQUIRES_DAYTONA', 'Daytona MCP investigation needs real Daytona sandboxes; development-local mode cannot run it.');
      const mapping = (this.deps.mapping ?? loadMapping)();
      if (!mapping) throw new DiagnosticError('MCP_NOT_DISCOVERED', 'No discovered Daytona MCP tool mapping; run npm run doctor first.');
      const control = run.trials.find((trial) => trial.kind === 'control');
      const chaos = run.trials.find((trial) => trial.kind === 'chaos');
      if (!control || !chaos) throw new DiagnosticError('NO_EVIDENCE', 'The run has no measured control/chaos pair.');
      const evidence = selectEvidence(run, control, chaos, persistedComparison(run));
      const payload = loadPreparedPayload(this.deps.payloadSelector ?? run.sourceSha);
      if (payload.manifest.payloadHash !== run.payloadHash) throw new DiagnosticError('PAYLOAD_MISMATCH', 'The prepared payload differs from the run being investigated.');

      try {
        [reservation] = this.deps.budget.reserve(1, `${run.id}:diagnostic`);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) throw new DiagnosticError('CAPACITY_EXHAUSTED', error.message);
        throw error;
      }
      await save({ status: 'PREPARING' });
      const handle = await this.deps.provider.create({ project: 'entropy', runId: run.id, trialId: diagnosticId, purpose: 'diagnostic', createdAt: new Date().toISOString() }, 60);
      sandboxId = handle.id;
      await save({ sandboxId, cleanupStatus: 'PENDING' });
      const sanitized = {
        runId: run.id, allowedServiceIds: run.graph.nodes.map((node) => node.id),
        metrics: [...control.metrics, ...chaos.metrics].filter((metric) => evidence.metricIds.includes(metric.id)),
        spans: chaos.spans.filter((span) => evidence.spanIds.includes(span.id)),
        graphPaths: run.graph.edges.map((edge) => ({ source: edge.source, target: edge.target, relationship: edge.relationship, evidenceKind: edge.evidenceKind })),
        artifactIds: [...control.artifacts, ...chaos.artifacts].map((artifact) => artifact.id),
        actualBlastRadiusIds: run.actualBlastRadiusIds, comparisonValidity: run.comparisonValidity
      };
      await this.deps.provider.upload(sandboxId, [
        ...payload.files.map((file) => ({ remotePath: `payload/${file.name}`, bytes: file.bytes })),
        { remotePath: EVIDENCE_REMOTE_PATH, bytes: Buffer.from(JSON.stringify(sanitized, null, 2)) }
      ], 30);
      if (signal.aborted) throw signal.reason;

      mcp = await (this.deps.connectMcp ?? DaytonaMcpClient.connect)();
      this.openClients.add(mcp);
      await save({ status: 'RUNNING' });
      const trace: DiagnosticTraceEntry[] = [];
      let finish: Extract<DiagnosticAction, { action: 'finish' }> | undefined;
      for (let turn = 1; turn <= MAX_MODEL_TURNS && !finish; turn += 1) {
        if (signal.aborted) throw signal.reason;
        const forceFinish = turn === MAX_MODEL_TURNS || trace.length >= MAX_MCP_CALLS;
        const context = { runId: run.id, diagnosticId, allowedServiceIds: sanitized.allowedServiceIds, evidence, toolTrace: trace.map((entry) => ({ action: entry.action, toolName: entry.toolName, success: entry.success, untrustedResult: entry.resultSummary })), ...(forceFinish ? { instruction: 'Respond with the finish action now.' } : {}) };
        const action = await this.deps.nosana.nextDiagnosticAction(context as unknown as Parameters<NosanaPort['nextDiagnosticAction']>[0], { signal, deadlineMs: Date.now() + 40_000 });
        if (action.action === 'finish') { finish = action; break; }
        if (trace.length >= MAX_MCP_CALLS) continue;
        const entry = await this.runAction(action, mapping, mcp, sandboxId, trace.length);
        trace.push(entry);
        await save({ toolTrace: [...trace] });
        await this.deps.events.emit(run.id, 'DIAGNOSTIC_TOOL_RESULT', `${entry.toolName} (${entry.action}) ${entry.success ? 'succeeded' : 'failed'} in ${Math.round(entry.elapsedMs)} ms`, { diagnosticId });
      }
      await save({ status: 'ANALYZING' });
      const usedTool = trace.some((entry) => entry.success && entry.toolName !== 'none');
      if (!finish) {
        await save({ status: 'FAILED', error: { code: 'NO_FINISH', message: 'The model did not produce a final explanation within three turns.' }, finishedAt: new Date().toISOString() });
        return;
      }
      await save({
        status: 'COMPLETED', finalExplanation: text(finish.summary, 'No explanation provided.', 2000), finishedAt: new Date().toISOString(),
        ...(usedTool ? {} : { error: { code: 'NO_TOOL_EVIDENCE', message: 'The model finished without a successful Daytona MCP call; this session does not count as MCP evidence.' } })
      });
      await this.deps.events.emit(run.id, 'ANALYSIS_GENERATED', `Diagnostic finished${usedTool ? ' with Daytona MCP evidence' : ' WITHOUT tool evidence'}.`, { diagnosticId });
    } catch (error) {
      const cancelled = signal.aborted && !(error instanceof DiagnosticError);
      await save({
        status: cancelled ? 'CANCELLED' : 'FAILED', finishedAt: new Date().toISOString(),
        error: error instanceof DiagnosticError ? { code: error.code, message: error.message.slice(0, 512) } : { code: cancelled ? 'CANCELLED' : 'DIAGNOSTIC_ERROR', message: text(error instanceof Error ? error.message : String(error), 'Unknown error.', 512) }
      }).catch(() => undefined);
      await this.deps.events.emit(run.id, 'ERROR', `Diagnostic ${cancelled ? 'cancelled' : 'failed'}: ${session.error?.message ?? ''}`, { diagnosticId, errorCode: session.error?.code ?? 'DIAGNOSTIC_ERROR' }).catch(() => undefined);
    } finally {
      if (mcp) { await mcp.close(); this.openClients.delete(mcp); }
      if (sandboxId) {
        let cleanup: DiagnosticSession['cleanupStatus'] = 'FAILED';
        for (let attempt = 1; attempt <= 2 && cleanup !== 'DELETED'; attempt += 1) {
          try { await this.deps.provider.destroy(sandboxId, 30); cleanup = 'DELETED'; } catch { /* retry once */ }
        }
        await save({ cleanupStatus: cleanup }).catch(() => undefined);
        if (cleanup === 'DELETED' && reservation) this.deps.budget.release(reservation);
      } else if (reservation) {
        this.deps.budget.release(reservation);
      }
      await this.deps.events.emit(run.id, 'CLEANUP_COMPLETE', `Diagnostic sandbox cleanup: ${session.cleanupStatus}.`, { diagnosticId }).catch(() => undefined);
    }
  }

  private async runAction(action: Exclude<DiagnosticAction, { action: 'finish' }>, mapping: McpToolMapping, mcp: McpPort, sandboxId: string, index: number): Promise<DiagnosticTraceEntry> {
    const startedAt = new Date();
    const started = performance.now();
    const entry = (toolName: string, success: boolean, argumentSummary: string, resultSummary: string, error?: string): DiagnosticTraceEntry => ({
      id: `${sandboxId.slice(0, 40)}-call-${index + 1}`.replace(/[^A-Za-z0-9:_-]/g, '-'), action: action.action, toolName: text(toolName, 'none', 160), success,
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
      argumentSummary: text(argumentSummary, 'none', 1024), resultSummary: text(resultSummary, '(empty)', 4096), ...(error ? { error: text(error, 'error', 512) } : {})
    });
    if (action.action === 'probe_auth') {
      // The optional probe is cut from this build (plan section 11: cut first when time is short).
      return entry('none', false, 'probe_auth requested', 'Not executed.', 'probe_auth is not enabled in this build.');
    }
    const remotePath = `${REMOTE_WORKDIR}/${EVIDENCE_REMOTE_PATH}`;
    const result = await mcp.call(mapping.readFile, sandboxId, remotePath);
    return entry(result.toolName, result.ok, `${mapping.readFile.sandboxArg}=<diagnostic sandbox>, ${mapping.readFile.valueArg}=${remotePath}`, result.text, result.ok ? undefined : 'Tool returned an error.');
  }
}

class DiagnosticError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DiagnosticError';
  }
}
