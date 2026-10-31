import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  evaluateBaselineTrial,
  evaluateMatchedPairAndBlastRadius,
  TrialTelemetrySchema,
  type ChaosHypothesis,
  type ComparisonResult,
  type DiagnosticAction,
  type DiagnosticPromptContext,
  type EntityId,
  type EvidenceAnalysis,
  type GraphRepository,
  type OrchestratorContract,
  type RiskContext,
  type RunSnapshot,
  type RunStatus,
  type TrialKind,
  type TrialTelemetry,
  type ValidatedEvidenceInput
} from '../../../shared/types.js';
import { ENTROPY_DIR, loadPreparedPayload, type LoadedPayload } from '../sandbox/payloadManifest.js';
import { BudgetExhaustedError, type SandboxBudget, type SandboxProvider } from '../sandbox/provider.js';
import { emptyTrial, faultFor, TrialFailure, TrialRunner, type PreparedTrial, type TrialSpec } from '../sandbox/trialRunner.js';
import type { EventHub } from './events.js';

export interface RequestControl { signal?: AbortSignal; deadlineMs?: number }

export interface NosanaPort {
  hypothesize(context: RiskContext, control?: RequestControl): Promise<ChaosHypothesis>;
  analyze(evidence: ValidatedEvidenceInput, control?: RequestControl): Promise<EvidenceAnalysis>;
  nextDiagnosticAction(context: DiagnosticPromptContext, control?: RequestControl): Promise<DiagnosticAction>;
}

export type Repository = GraphRepository & {
  saveComparison(runId: EntityId, result: ComparisonResult, pair?: { controlTrialId?: string; chaosTrialId?: string }): Promise<void>;
};

/** Starts a diagnostic session for a terminal run; supplied by diagnosticAgent.ts. */
export interface DiagnosticLauncher {
  launch(run: RunSnapshot, diagnosticId: string, signal: AbortSignal): Promise<void>;
}

export interface OrchestratorDeps {
  repository: Repository;
  nosana: NosanaPort;
  provider: SandboxProvider;
  budget: SandboxBudget;
  events: EventHub;
  /** Full SHA of a prepared payload, or 'development' for an explicitly labeled working-tree bundle. */
  payloadSelector?: string;
  diagnostics?: DiagnosticLauncher;
  /** Shown in events; the development in-memory store must not claim to be Neo4j. */
  graphSourceLabel?: string;
  createId?: () => string;
  recoveryDir?: string;
  limits?: Partial<typeof WORKFLOW_LIMITS>;
}

export const WORKFLOW_LIMITS = { runDeadlineMs: 6 * 60_000, reproductionDeadlineMs: 4 * 60_000, diagnosticDeadlineMs: 3 * 60_000, allocationsPerRun: 8 } as const;

export class OrchestratorError extends Error {
  constructor(readonly code: string, readonly httpStatus: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

class CancelledError extends Error {
  constructor() { super('Workflow cancelled.'); this.name = 'CancelledError'; }
}
class DeadlineError extends Error {
  constructor() { super('Workflow deadline exceeded.'); this.name = 'DeadlineError'; }
}
class PersistenceError extends Error {
  constructor(message: string) { super(message); this.name = 'PersistenceError'; }
}

interface ActiveWorkflow {
  kind: 'run' | 'reproduction' | 'diagnostic';
  id: string;
  runId: string;
  operationKey: string;
  controller: AbortController;
  done: Promise<void>;
}

const TERMINAL_RUN: readonly RunStatus[] = ['COMPLETED', 'BASELINE_FAILED', 'INCONCLUSIVE', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
const TERMINAL_TRIAL: readonly TrialTelemetry['status'][] = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

/** Rejects as soon as the signal aborts; the underlying work is cleaned up by the caller's finally. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Changed metrics first, then remaining measured ones; fault witnesses and observed-edge spans. */
export function selectEvidence(run: RunSnapshot, control: TrialTelemetry, chaos: TrialTelemetry, comparison: ComparisonResult): ValidatedEvidenceInput {
  const controlById = new Map(control.metrics.map((metric) => [`${metric.serviceId}:${metric.channel}`, metric]));
  const measured = chaos.metrics.filter((metric) => metric.sampleCount > 0);
  const changed = measured.filter((metric) => controlById.get(`${metric.serviceId}:${metric.channel}`)?.status !== metric.status);
  const metricIds = [...new Set([...changed, ...measured].map((metric) => metric.id))].slice(0, 24);
  const witnessSpanIds = chaos.spans.filter((span) => span.faultApplied && span.channel === 'business').map((span) => span.id);
  const edgeSpanIds = comparison.observedCascadeEdges.flatMap((edge) => edge.supportingSpanIds);
  const spanIds = [...new Set([...witnessSpanIds.slice(0, 8), ...edgeSpanIds])].slice(0, 24);
  return { run, control, chaos, comparison, metricIds, spanIds };
}

/** Rebuilds the persisted comparison for a run (original pair). */
export function persistedComparison(run: RunSnapshot): ComparisonResult {
  return { comparisonValidity: run.comparisonValidity, comparisonReasons: run.comparisonReasons, actualBlastRadiusIds: run.actualBlastRadiusIds, observedCascadeEdges: run.graph.edges.filter((edge) => edge.evidenceKind === 'observed').slice(0, 6) };
}

export class Orchestrator implements OrchestratorContract {
  private active?: ActiveWorkflow;
  private persistenceHalted?: string;
  private readonly allocations = new Map<string, number>();
  private readonly createId: () => string;
  private readonly recoveryDir: string;
  private readonly limits: typeof WORKFLOW_LIMITS;

  constructor(private readonly deps: OrchestratorDeps) {
    this.createId = deps.createId ?? randomUUID;
    this.recoveryDir = deps.recoveryDir ?? path.join(ENTROPY_DIR, 'recovery');
    this.limits = { ...WORKFLOW_LIMITS, ...deps.limits };
  }

  get activeWorkflow(): Readonly<Pick<ActiveWorkflow, 'kind' | 'id' | 'runId'>> | undefined {
    return this.active && { kind: this.active.kind, id: this.active.id, runId: this.active.runId };
  }

  /** Resolves when the current workflow (if any) settles. Used by tests and shutdown. */
  async idle(): Promise<void> {
    await this.active?.done.catch(() => undefined);
  }

  // ---------------------------------------------------------------- public actions

  async startRun(operationKey: string): Promise<{ runId: EntityId }> {
    if (this.active?.operationKey === operationKey && this.active.kind === 'run') return { runId: this.active.runId };
    this.assertSchedulable();
    const payload = this.loadPayload();
    const runId = this.createId();
    const claim = await this.deps.repository.claimOperationKey(operationKey, 'run', runId);
    if (claim.targetId && claim.targetId !== runId) {
      if (claim.action !== 'run') throw new OrchestratorError('OPERATION_KEY_REUSED', 409, 'This operation key was used for a different action.');
      return { runId: claim.targetId };
    }
    // Re-check after the await: another request may have started a workflow meanwhile.
    this.assertSchedulable();
    await this.deps.repository.createRun({ id: runId, sourceSha: payload.manifest.sourceSha, payloadHash: payload.manifest.payloadHash, topologyHash: payload.manifest.topologyHash });
    const warnings = this.payloadWarnings(payload);
    if (warnings.length) await this.deps.repository.updateRun(runId, { warnings });
    this.begin({ kind: 'run', id: runId, runId, operationKey }, (signal) => this.runExperiment(runId, payload, signal), this.limits.runDeadlineMs);
    return { runId };
  }

  async cancel(runId: EntityId): Promise<RunSnapshot> {
    const run = await this.requireRun(runId);
    if (this.active?.runId === runId) {
      this.active.controller.abort(new CancelledError());
      return run;
    }
    if (TERMINAL_RUN.includes(run.status)) return run;
    // Not owned by this process (e.g. left over from a crash): it cannot still be running here.
    return this.deps.repository.updateRun(runId, { status: 'CANCELLED', finishedAt: new Date().toISOString() });
  }

  async reproduce(runId: EntityId, operationKey: string): Promise<{ reproductionId: EntityId; trialIds: EntityId[] }> {
    const reproductionId = `${runId}-repro`;
    const trialIds = [`${runId}-repro-control`, `${runId}-repro-chaos`];
    if (this.active?.operationKey === operationKey && this.active.kind === 'reproduction') return { reproductionId, trialIds };
    const run = await this.requireRun(runId);
    const claim = await this.deps.repository.claimOperationKey(operationKey, 'reproduce', reproductionId);
    if (claim.targetId && claim.targetId !== reproductionId) throw new OrchestratorError('OPERATION_KEY_REUSED', 409, 'This operation key was used for a different action.');
    if (run.trials.some((trial) => trial.kind === 'reproduction-control' || trial.kind === 'reproduction-chaos')) return { reproductionId, trialIds };
    this.assertSchedulable();
    if (!TERMINAL_RUN.includes(run.status)) throw new OrchestratorError('RUN_NOT_TERMINAL', 409, 'Reproduction requires the original run to be finished.');
    if (!run.trials.some((trial) => trial.kind === 'control') || !run.trials.some((trial) => trial.kind === 'chaos')) throw new OrchestratorError('NO_MATCHED_PAIR', 409, 'The original run has no measured control/chaos pair to reproduce.');
    const payload = this.loadPayload();
    if (payload.manifest.payloadHash !== run.payloadHash || payload.manifest.sourceSha !== run.sourceSha) throw new OrchestratorError('PAYLOAD_MISMATCH', 409, 'The prepared payload differs from the original run; reproduction must use the identical manifest.');
    this.begin({ kind: 'reproduction', id: reproductionId, runId, operationKey }, (signal) => this.runReproduction(run, payload, trialIds, signal), this.limits.reproductionDeadlineMs);
    return { reproductionId, trialIds };
  }

  async investigate(runId: EntityId, operationKey: string): Promise<{ diagnosticId: EntityId }> {
    const diagnosticId = `${runId}-diagnostic`;
    if (this.active?.operationKey === operationKey && this.active.kind === 'diagnostic') return { diagnosticId };
    const run = await this.requireRun(runId);
    const claim = await this.deps.repository.claimOperationKey(operationKey, 'investigate', diagnosticId);
    if (claim.targetId && claim.targetId !== diagnosticId) throw new OrchestratorError('OPERATION_KEY_REUSED', 409, 'This operation key was used for a different action.');
    if (await this.deps.repository.getDiagnostic(diagnosticId)) return { diagnosticId };
    this.assertSchedulable();
    if (!this.deps.diagnostics) throw new OrchestratorError('DIAGNOSTICS_UNAVAILABLE', 503, 'Daytona MCP diagnostics are not configured.');
    if (!TERMINAL_RUN.includes(run.status) || !run.trials.some((trial) => trial.kind === 'chaos' && trial.status === 'COMPLETED')) throw new OrchestratorError('RUN_NOT_TERMINAL', 409, 'Investigation requires a finished run with measured chaos evidence.');
    const launcher = this.deps.diagnostics;
    this.begin({ kind: 'diagnostic', id: diagnosticId, runId, operationKey }, (signal) => launcher.launch(run, diagnosticId, signal), this.limits.diagnosticDeadlineMs);
    return { diagnosticId };
  }

  cancelDiagnostic(diagnosticId: string): boolean {
    if (this.active?.kind !== 'diagnostic' || this.active.id !== diagnosticId) return false;
    this.active.controller.abort(new CancelledError());
    return true;
  }

  // ---------------------------------------------------------------- restart reconciliation

  /** Marks unfinished work interrupted, replays recovery files, and deletes leftover sandboxes. */
  async recover(): Promise<{ interrupted: string[]; deleted: string[]; failedCleanup: string[] }> {
    await this.replayRecoveryFiles();
    const interrupted: string[] = [];
    for (const summary of await this.deps.repository.listRuns(20)) {
      if (TERMINAL_RUN.includes(summary.status)) continue;
      const run = await this.deps.repository.getRun(summary.id);
      if (!run) continue;
      for (const trial of run.trials.filter((candidate) => !TERMINAL_TRIAL.includes(candidate.status))) {
        await this.deps.repository.saveTrial({ ...trial, status: 'INTERRUPTED', warnings: [...trial.warnings, 'Backend restarted during this trial; it was not resumed.'].slice(0, 32) });
      }
      await this.deps.repository.updateRun(run.id, { status: 'INTERRUPTED', finishedAt: new Date().toISOString(), warnings: [...run.warnings, 'Backend restarted before this run finished; unfinished work was not resumed.'].slice(0, 32) });
      interrupted.push(run.id);
    }
    const deleted: string[] = [];
    const failedCleanup: string[] = [];
    for (const resource of await this.deps.repository.findUnfinishedResources()) {
      const run = await this.deps.repository.getRun(resource.runId);
      const trial = run?.trials.find((candidate) => candidate.id === resource.trialId);
      const status = await this.destroySandbox(resource.sandboxId);
      (status === 'DELETED' ? deleted : failedCleanup).push(resource.sandboxId);
      if (trial) await this.deps.repository.saveTrial({ ...trial, cleanupStatus: status });
      if (status !== 'DELETED') this.holdOrphan(resource.sandboxId);
    }
    // Labeled sandboxes for runs this repository knows about but no record still owns.
    try {
      for (const handle of await this.deps.provider.listOwned({ project: 'entropy' })) {
        if (deleted.includes(handle.id) || failedCleanup.includes(handle.id)) continue;
        const runId = handle.labels.runId;
        if (!runId || !(await this.deps.repository.getRun(runId))) continue;
        const status = await this.destroySandbox(handle.id);
        (status === 'DELETED' ? deleted : failedCleanup).push(handle.id);
        if (status !== 'DELETED') this.holdOrphan(handle.id);
      }
    } catch (error) {
      failedCleanup.push(`listing failed: ${message(error)}`);
    }
    return { interrupted, deleted, failedCleanup };
  }

  // ---------------------------------------------------------------- workflows

  private begin(meta: Omit<ActiveWorkflow, 'controller' | 'done'>, work: (signal: AbortSignal) => Promise<void>, deadlineMs: number): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DeadlineError()), deadlineMs);
    const workflow: ActiveWorkflow = { ...meta, controller, done: Promise.resolve() };
    this.active = workflow;
    workflow.done = work(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        if (this.active === workflow) this.active = undefined;
      });
  }

  private async runExperiment(runId: string, payload: LoadedPayload, signal: AbortSignal): Promise<void> {
    const runner = this.runner(runId, payload);
    try {
      await this.transition(runId, { status: 'HYPOTHESIZING' }, 'GRAPH_LOADED', `Loaded six-node topology from ${this.deps.graphSourceLabel ?? 'Neo4j'}.`);
      const context = await abortable(this.deps.repository.retrieveRiskContext(runId), signal);
      const hypothesis = await abortable(this.deps.nosana.hypothesize(context, { signal, deadlineMs: Date.now() + 45_000 }), signal);
      await this.deps.repository.saveHypothesis(runId, hypothesis);
      await this.deps.events.emit(runId, 'HYPOTHESIS_GENERATED', hypothesis.source === 'nosana'
        ? `Nosana (${hypothesis.model ?? 'model'}) predicted: ${hypothesis.predictedBlastRadiusIds.join(' → ')}`
        : `Nosana unavailable or invalid; using the labeled catalogue fallback hypothesis.`);

      await this.transition(runId, { status: 'BASELINING' }, 'SANDBOX_PROVISIONING', 'Provisioning a fresh healthy baseline sandbox.');
      const [baseline] = await this.runTrials(runner, [this.spec(runId, `${runId}-baseline`, 'baseline')], false, signal);
      if (!baseline || baseline.status !== 'COMPLETED') return this.finish(runId, 'FAILED', `Baseline trial failed: ${baseline?.error?.message ?? 'no report'}`);
      const baselineGate = evaluateBaselineTrial(baseline);
      if (baselineGate.validity !== 'valid') return this.finish(runId, 'BASELINE_FAILED', 'Healthy baseline did not pass its gates; matched trials were not scheduled.', baselineGate.reasons);
      await this.deps.events.emit(runId, 'BASELINE_TRAFFIC_COMPLETE', `Baseline healthy: ${baseline.clientSummary.completed}/130 completed, checkout p95 ${baseline.clientSummary.checkoutP95Ms?.toFixed(1) ?? 'not measured'} ms.`, { trialId: baseline.id, trialStatus: baseline.status });

      const parallel = this.deps.provider.maxConcurrent >= 2 && this.deps.budget.capacity >= 2;
      if (!parallel) await this.addRunWarning(runId, 'Single-slot development mode: control and chaos ran serially, not in parallel.');
      await this.transition(runId, { status: 'RUNNING_TRIALS' }, 'SANDBOX_PROVISIONING', parallel ? 'Provisioning matched control and chaos sandboxes in parallel.' : 'Running control then chaos serially (single slot).');
      const [control, chaos] = await this.runTrials(runner, [this.spec(runId, `${runId}-control`, 'control'), this.spec(runId, `${runId}-chaos`, 'chaos')], parallel, signal);
      if (!control || !chaos || control.status !== 'COMPLETED' || chaos.status !== 'COMPLETED') {
        return this.finish(runId, 'FAILED', `Matched trials did not both complete: control=${control?.status ?? 'missing'} chaos=${chaos?.status ?? 'missing'}.`);
      }

      const run = await this.requireRun(runId);
      const comparison = evaluateMatchedPairAndBlastRadius(control, chaos, run.graph);
      await this.deps.repository.saveComparison(runId, comparison, { controlTrialId: control.id, chaosTrialId: chaos.id });
      await this.emitComparison(runId, comparison, chaos.id);

      await this.transition(runId, { status: 'ANALYZING' }, 'TELEMETRY_COLLECTED', 'Requesting Nosana explanation of the measured evidence.');
      await this.analyze(runId, control, chaos, comparison, signal);
      await this.finish(runId, comparison.comparisonValidity === 'valid' ? 'COMPLETED' : 'INCONCLUSIVE', comparison.comparisonValidity === 'valid'
        ? `Run complete: measured affected set [${comparison.actualBlastRadiusIds.join(', ')}].`
        : 'Run measured but comparison is inconclusive; blast radius not evaluated.', comparison.comparisonReasons);
    } catch (error) {
      await this.failWorkflow(runId, error);
    }
  }

  private async runReproduction(original: RunSnapshot, payload: LoadedPayload, trialIds: string[], signal: AbortSignal): Promise<void> {
    const runId = original.id;
    const runner = this.runner(runId, payload);
    try {
      const parallel = this.deps.provider.maxConcurrent >= 2 && this.deps.budget.capacity >= 2;
      await this.deps.events.emit(runId, 'SANDBOX_PROVISIONING', `Reproduction: provisioning a new matched pair${parallel ? ' in parallel' : ' serially (single slot)'}. Original evidence is unchanged.`);
      const [control, chaos] = await this.runTrials(runner, [this.spec(runId, trialIds[0]!, 'reproduction-control'), this.spec(runId, trialIds[1]!, 'reproduction-chaos')], parallel, signal);
      if (!control || !chaos || control.status !== 'COMPLETED' || chaos.status !== 'COMPLETED') {
        await this.deps.events.emit(runId, 'ERROR', 'Reproduction trials did not both complete.', { errorCode: 'REPRODUCTION_FAILED' });
        return;
      }
      const comparison = evaluateMatchedPairAndBlastRadius(control, chaos, original.graph);
      await this.deps.repository.saveComparison(runId, comparison, { controlTrialId: control.id, chaosTrialId: chaos.id });
      const updated = await this.requireRun(runId);
      await this.deps.events.emit(runId, 'RUN_COMPLETE', `Reproduction ${updated.reproduction?.classification ?? 'inconclusive'}: affected [${comparison.actualBlastRadiusIds.join(', ') || 'not evaluated'}].`, { affectedIds: comparison.actualBlastRadiusIds, comparisonValidity: comparison.comparisonValidity });
    } catch (error) {
      const code = error instanceof CancelledError ? 'CANCELLED' : error instanceof DeadlineError ? 'DEADLINE' : 'REPRODUCTION_FAILED';
      await this.deps.events.emit(runId, 'ERROR', `Reproduction stopped: ${message(error)}`, { errorCode: code }).catch(() => undefined);
    } finally {
      await this.deps.events.flush(runId);
    }
  }

  /**
   * Runs trials with fresh sandboxes. In parallel mode every sandbox is provisioned and
   * prepared before a shared barrier releases all trial commands at once.
   */
  private async runTrials(runner: TrialRunner, specs: TrialSpec[], parallel: boolean, signal: AbortSignal): Promise<TrialTelemetry[]> {
    if (!parallel) {
      const results: TrialTelemetry[] = [];
      for (const spec of specs) results.push(...await this.runTrials(runner, [spec], true, signal));
      return results;
    }
    const runId = specs[0]!.runId;
    const payload = runner.payload;
    const trials = new Map<string, TrialTelemetry>(specs.map((spec) => [spec.trialId, emptyTrial(spec, payload, runner.executionMode)]));
    const save = async (trialId: string, patch: Partial<TrialTelemetry>) => {
      const next = { ...trials.get(trialId)!, ...patch };
      trials.set(trialId, next);
      await this.saveTrial(next);
      return next;
    };
    let reservations: string[];
    try {
      reservations = this.deps.budget.reserve(specs.length, `${runId}:${specs.map((spec) => spec.kind).join('+')}`);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw new TrialFailure('CAPACITY_EXHAUSTED', error.message);
      throw error;
    }
    const prepared = new Map<string, PreparedTrial>();
    const created = new Map<string, string>();
    let preparing: Promise<unknown> | undefined;
    runner.onCreated = (spec, sandboxId) => {
      created.set(spec.trialId, sandboxId);
      // A late create (after cancellation) records the sandbox but never moves a terminal trial backwards.
      const status = TERMINAL_TRIAL.includes(trials.get(spec.trialId)!.status) ? trials.get(spec.trialId)!.status : 'PREPARING';
      return save(spec.trialId, { sandboxId, cleanupStatus: 'PENDING', status }).then(() => undefined);
    };
    try {
      for (const spec of specs) await save(spec.trialId, { status: 'PROVISIONING' });
      const preparation = Promise.allSettled(specs.map((spec) => runner.prepare(spec)));
      preparing = preparation;
      const outcomes = await abortable(preparation, signal);
      const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [{ spec: specs[index]!, error: outcome.reason as unknown }] : []);
      outcomes.forEach((outcome, index) => { if (outcome.status === 'fulfilled') prepared.set(specs[index]!.trialId, outcome.value); });
      if (failures.length) {
        for (const spec of specs) {
          const failure = failures.find((candidate) => candidate.spec.trialId === spec.trialId);
          await save(spec.trialId, failure
            ? { status: 'FAILED', error: { code: failure.error instanceof TrialFailure ? failure.error.code : 'PREPARE_FAILED', message: message(failure.error) } }
            : { status: 'CANCELLED', warnings: ['Partner trial failed during preparation; this trial was not started.'] });
        }
        return specs.map((spec) => trials.get(spec.trialId)!);
      }

      // Barrier: every sandbox is ready; dispatch all trial commands together.
      for (const spec of specs) await save(spec.trialId, { status: 'RUNNING' });
      await this.deps.events.emit(runId, 'TRIAL_STARTED', specs.length > 1 ? `Dispatching ${specs.map((spec) => spec.kind).join(' and ')} concurrently from a shared start barrier.` : `Dispatching ${specs[0]!.kind} trial command.`, { trialId: specs[0]!.trialId, trialStatus: 'RUNNING' });
      for (const spec of specs) if (spec.fault) await this.deps.events.emit(runId, 'FAULT_INJECTED', `${spec.kind}: Redis +3000 ms latency command dispatched; the in-sandbox controller records witnesses.`, { trialId: spec.trialId });
      const executions = await abortable(Promise.allSettled(specs.map((spec) => runner.execute(prepared.get(spec.trialId)!, 'PENDING'))), signal);
      for (const [index, outcome] of executions.entries()) {
        const spec = specs[index]!;
        if (outcome.status === 'fulfilled') {
          const trial = await save(spec.trialId, { ...outcome.value.trial, cleanupStatus: 'PENDING' });
          await this.deps.events.emit(runId, 'TELEMETRY_COLLECTED', `${spec.kind}: ${trial.status === 'COMPLETED' ? `${trial.clientSummary.checkoutCompleted} checkouts, error rate ${trial.clientSummary.checkoutErrorRate?.toFixed(2) ?? 'n/a'}, ${trial.spans.length} spans` : `report rejected (${trial.error?.code ?? 'unknown'})`} [${outcome.value.dispatchedAt} → ${outcome.value.returnedAt}]`, { trialId: spec.trialId, trialStatus: trial.status });
          if (spec.fault && trial.faultWitnessed) await this.deps.events.emit(runId, 'FAULT_INJECTED', `${spec.kind}: Redis delay witnessed on actual business requests.`, { trialId: spec.trialId });
        } else {
          await save(spec.trialId, { status: 'FAILED', error: { code: outcome.reason instanceof TrialFailure ? outcome.reason.code : 'EXECUTE_FAILED', message: message(outcome.reason) } });
        }
      }
      return specs.map((spec) => trials.get(spec.trialId)!);
    } catch (error) {
      const cancelled = error instanceof CancelledError || error instanceof DeadlineError;
      for (const spec of specs) {
        const trial = trials.get(spec.trialId)!;
        if (!TERMINAL_TRIAL.includes(trial.status)) await save(spec.trialId, { status: cancelled ? 'CANCELLED' : 'FAILED', ...(cancelled ? {} : { error: { code: 'TRIAL_ERROR', message: message(error) } }) }).catch(() => undefined);
      }
      throw error;
    } finally {
      // A cancelled create may still complete; wait for it (bounded by its own timeouts) so the
      // sandbox is recorded and deleted below instead of leaking.
      if (preparing) await preparing.catch(() => undefined);
      runner.onCreated = undefined;
      // Cleanup is never cut: every created sandbox is deleted or its failure is recorded.
      const released = new Set<string>();
      for (const spec of specs) {
        const sandboxId = created.get(spec.trialId);
        if (!sandboxId) { await save(spec.trialId, { cleanupStatus: 'NOT_CREATED' }).catch(() => undefined); continue; }
        const status = await runner.destroy(sandboxId);
        await save(spec.trialId, { cleanupStatus: status }).catch(() => undefined);
        if (status === 'DELETED') released.add(spec.trialId);
        else this.deps.events.log(runId, `cleanup FAILED for sandbox ${sandboxId}; capacity stays reserved until reconciled`);
      }
      // Release capacity only for confirmed deletions (and for trials that never created one).
      specs.forEach((spec, index) => { if (released.has(spec.trialId) || !created.has(spec.trialId)) this.deps.budget.release(reservations[index]!); });
      await this.deps.events.emit(runId, 'CLEANUP_COMPLETE', specs.map((spec) => `${spec.kind}=${trials.get(spec.trialId)?.cleanupStatus ?? 'unknown'}`).join(', ')).catch(() => undefined);
    }
  }

  private async analyze(runId: string, control: TrialTelemetry, chaos: TrialTelemetry, comparison: ComparisonResult, signal: AbortSignal): Promise<void> {
    const run = await this.requireRun(runId);
    let analysis: EvidenceAnalysis;
    try {
      analysis = await abortable(this.deps.nosana.analyze(selectEvidence(run, control, chaos, comparison), { signal, deadlineMs: Date.now() + 45_000 }), signal);
    } catch (error) {
      if (error instanceof CancelledError || error instanceof DeadlineError) throw error;
      // Analysis failure never changes measured results or a valid run's completion status.
      await this.addRunWarning(runId, `Nosana analysis failed: ${message(error)}`);
      analysis = { id: this.createId(), source: 'deterministic', status: 'unavailable', summary: 'Nosana analysis is unavailable; the measured facts above are authoritative.', hypotheses: [], remediation: [], promptVersion: 'orchestrator-unavailable', createdAt: new Date().toISOString() };
    }
    await this.deps.repository.saveAnalysis(runId, analysis);
    await this.deps.events.emit(runId, 'ANALYSIS_GENERATED', analysis.status === 'available' ? `Nosana (${analysis.model ?? 'model'}) explanation linked to ${analysis.hypotheses.length} evidence-backed hypotheses.` : 'Nosana analysis unavailable; measured facts remain authoritative.');
    if (analysis.remediation.length) await this.deps.events.emit(runId, 'REMEDIATION_PROPOSED', `Proposed (not applied): ${analysis.remediation[0]!.proposal}`.slice(0, 1024));
  }

  private async emitComparison(runId: string, comparison: ComparisonResult, chaosTrialId: string): Promise<void> {
    if (comparison.comparisonValidity === 'valid' && comparison.actualBlastRadiusIds.length) {
      await this.deps.events.emit(runId, 'CASCADE_DETECTED', `Observed failure path: ${comparison.actualBlastRadiusIds.join(', ')} degraded versus the healthy control.`, { trialId: chaosTrialId, affectedIds: comparison.actualBlastRadiusIds, comparisonValidity: 'valid' });
    }
    await this.deps.events.emit(runId, 'NEO4J_BLAST_RADIUS_UPDATED', comparison.comparisonValidity === 'valid'
      ? `Persisted measured graph: ${comparison.actualBlastRadiusIds.length} affected nodes, ${comparison.observedCascadeEdges.length} observed CASCADED_TO edges.`
      : `Comparison inconclusive (${comparison.comparisonReasons.length} reasons); blast radius not evaluated.`, { affectedIds: comparison.actualBlastRadiusIds, comparisonValidity: comparison.comparisonValidity });
  }

  // ---------------------------------------------------------------- helpers

  private runner(runId: string, payload: LoadedPayload): TrialRunner {
    return new TrialRunner(this.deps.provider, payload, {
      countAllocation: () => {
        const used = (this.allocations.get(runId) ?? 0) + 1;
        if (used > this.limits.allocationsPerRun) throw new TrialFailure('ALLOCATION_BUDGET', `Run exceeded ${this.limits.allocationsPerRun} sandbox allocations.`);
        this.allocations.set(runId, used);
      },
      log: (line) => this.deps.events.log(runId, line)
    });
  }

  private spec(runId: string, trialId: string, kind: TrialKind): TrialSpec {
    return { runId, trialId, kind, fault: faultFor(kind) };
  }

  private async transition(runId: string, patch: Partial<RunSnapshot>, type: Parameters<EventHub['emit']>[1], text: string): Promise<void> {
    const run = await this.deps.repository.updateRun(runId, patch);
    await this.deps.events.emit(runId, type, text, { status: run.status });
  }

  private async finish(runId: string, status: RunStatus, text: string, reasons: string[] = []): Promise<void> {
    const run = await this.requireRun(runId);
    const warnings = [...run.warnings, ...reasons.map((reason) => reason.slice(0, 512))].slice(0, 32);
    await this.deps.repository.updateRun(runId, { status, finishedAt: new Date().toISOString(), warnings });
    await this.deps.events.flush(runId);
    await this.deps.events.emit(runId, status === 'COMPLETED' || status === 'INCONCLUSIVE' ? 'RUN_COMPLETE' : 'ERROR', text, { status });
  }

  private async failWorkflow(runId: string, error: unknown): Promise<void> {
    const status: RunStatus = error instanceof CancelledError ? 'CANCELLED' : 'FAILED';
    if (error instanceof PersistenceError) this.persistenceHalted = error.message;
    const text = error instanceof CancelledError ? 'Run cancelled; partial evidence preserved and sandboxes cleaned up.'
      : error instanceof DeadlineError ? 'Run exceeded its 6-minute wall deadline.'
      : `Run failed: ${message(error)}`;
    try {
      await this.finish(runId, status, text, status === 'FAILED' ? [text] : []);
    } catch {
      // Persistence itself failed; the recovery file and halted flag preserve the state.
    }
  }

  private async addRunWarning(runId: string, warning: string): Promise<void> {
    const run = await this.requireRun(runId);
    if (!run.warnings.includes(warning)) await this.deps.repository.updateRun(runId, { warnings: [...run.warnings, warning].slice(0, 32) });
  }

  /** Writes normalized recovery JSON before the Neo4j transaction; removes it once durable. */
  private async saveTrial(trial: TrialTelemetry): Promise<void> {
    const file = path.join(this.recoveryDir, `${trial.id}.json`);
    mkdirSync(this.recoveryDir, { recursive: true });
    writeFileSync(file, JSON.stringify(trial));
    try {
      await this.deps.repository.saveTrial(trial);
      rmSync(file, { force: true });
    } catch (error) {
      this.persistenceHalted = `Trial persistence failed: ${message(error)}`;
      throw new PersistenceError(this.persistenceHalted);
    }
  }

  private async replayRecoveryFiles(): Promise<void> {
    if (!existsSync(this.recoveryDir)) return;
    for (const name of readdirSync(this.recoveryDir).filter((file) => file.endsWith('.json'))) {
      const file = path.join(this.recoveryDir, name);
      const parsed = TrialTelemetrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
      if (!parsed.success) continue;
      // Idempotent MERGE by trial id; a replay never duplicates.
      await this.deps.repository.saveTrial(parsed.data);
      rmSync(file, { force: true });
    }
  }

  private async destroySandbox(sandboxId: string): Promise<'DELETED' | 'FAILED'> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.deps.provider.destroy(sandboxId, 30);
        return 'DELETED';
      } catch {
        // Retry once, then report.
      }
    }
    return 'FAILED';
  }

  private holdOrphan(sandboxId: string): void {
    try { this.deps.budget.reserve(1, `orphan:${sandboxId}`); } catch { /* capacity already fully held */ }
  }

  private assertSchedulable(): void {
    if (this.persistenceHalted) throw new OrchestratorError('PERSISTENCE_HALTED', 503, `New work is stopped: ${this.persistenceHalted}`);
    if (this.active) throw new OrchestratorError('BUSY', 409, `A ${this.active.kind} workflow (${this.active.id}) is already active.`);
  }

  private loadPayload(): LoadedPayload {
    if (!this.deps.payloadSelector) throw new OrchestratorError('PAYLOAD_NOT_CONFIGURED', 503, 'ENTROPY_SOURCE_SHA is not set; prepare a payload and configure it.');
    try {
      return loadPreparedPayload(this.deps.payloadSelector);
    } catch (error) {
      throw new OrchestratorError('PAYLOAD_NOT_PREPARED', 503, message(error));
    }
  }

  private payloadWarnings(payload: LoadedPayload): string[] {
    const warnings: string[] = [];
    if (payload.manifest.development) warnings.push(`DEVELOPMENT payload bundled from the working tree at HEAD ${payload.manifest.sourceSha.slice(0, 12)}; not a recorded immutable source.`);
    if (this.deps.provider.executionMode === 'development-local') warnings.push('DEVELOPMENT execution: trials ran as local processes, not Daytona sandboxes. Excluded from live acceptance.');
    return warnings;
  }

  private async requireRun(runId: EntityId): Promise<RunSnapshot> {
    const run = await this.deps.repository.getRun(runId);
    if (!run) throw new OrchestratorError('NOT_FOUND', 404, `Unknown run: ${runId}`);
    return run;
  }
}
