import { TrialTelemetrySchema, type CleanupStatus, type Fault, type TrialKind, type TrialTelemetry } from '../../../shared/types.js';
import { collectTrialArtifacts } from '../evidence/collect.js';
import type { LoadedPayload } from './payloadManifest.js';
import { ProviderTimeoutError, SANDBOX_OWNER, type SandboxLabels, type SandboxProvider } from './provider.js';

export const LIMITS_SEC = { create: 60, trialCommand: 60, upload: 30, delete: 30 } as const;

export interface TrialSpec {
  runId: string;
  trialId: string;
  kind: TrialKind;
  fault: Fault;
}

export interface PreparedTrial {
  spec: TrialSpec;
  sandboxId: string;
  nodeVersion: string;
  preparedAt: string;
}

export interface TrialRunnerHooks {
  /** Counts a provider allocation (including retries) against the run budget; throws when exhausted. */
  countAllocation(spec: TrialSpec): void;
  log(line: string): void;
}

export class TrialFailure extends Error {
  constructor(readonly code: string, message: string, readonly sandboxId?: string) {
    super(message);
    this.name = 'TrialFailure';
  }
}

const FAULT_KINDS: readonly TrialKind[] = ['chaos', 'reproduction-chaos'];

export function faultFor(kind: TrialKind): Fault {
  return FAULT_KINDS.includes(kind) ? { targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', delayMs: 3000, durationMs: 10000 } : null;
}

export function emptyTrial(spec: TrialSpec, payload: LoadedPayload, executionMode: TrialTelemetry['executionMode'], overrides: Partial<TrialTelemetry> = {}): TrialTelemetry {
  return {
    id: spec.trialId, runId: spec.runId, kind: spec.kind, status: 'QUEUED', executionMode, cleanupStatus: 'NOT_CREATED',
    sourceSha: payload.manifest.sourceSha, payloadHash: payload.manifest.payloadHash, workloadHash: payload.manifest.workloadHash, runtimeIdentity: 'not-observed',
    faultWitnessed: false, metrics: [], spans: [], artifacts: [],
    clientSummary: { scheduled: 0, started: 0, completed: 0, skipped: 0, errors: 0, checkoutStarted: 0, checkoutCompleted: 0, checkoutErrors: 0, checkoutErrorRate: null, checkoutP95Ms: null },
    validity: 'invalid', warnings: [], ...overrides
  };
}

export class TrialRunner {
  /** Persists the sandbox ID before anything else happens to the sandbox. */
  onCreated?: (spec: TrialSpec, sandboxId: string) => Promise<void>;

  constructor(private readonly provider: SandboxProvider, readonly payload: LoadedPayload, private readonly hooks: TrialRunnerHooks) {}

  get executionMode(): TrialTelemetry['executionMode'] {
    return this.provider.executionMode;
  }

  /** Provision, upload, and check the runtime. Does not start the measured command. */
  async prepare(spec: TrialSpec): Promise<PreparedTrial> {
    const sandboxId = await this.createWithReconciliation(spec);
    const input = { schemaVersion: 1, runId: spec.runId, trialId: spec.trialId, kind: spec.kind, sourceSha: this.payload.manifest.sourceSha, payloadHash: this.payload.manifest.payloadHash, workloadHash: this.payload.manifest.workloadHash, fault: spec.fault };
    await this.provider.upload(sandboxId, [
      ...this.payload.files.map((file) => ({ remotePath: `payload/${file.name}`, bytes: file.bytes })),
      { remotePath: 'input.json', bytes: Buffer.from(`${JSON.stringify(input, null, 2)}\n`) }
    ], LIMITS_SEC.upload);
    const version = await this.provider.execute(sandboxId, 'node-version', 30);
    const nodeVersion = version.output.trim();
    if (version.exitCode !== 0 || !/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new TrialFailure('RUNTIME_UNAVAILABLE', 'Sandbox did not report a Node runtime.', sandboxId);
    if (Number(nodeVersion.slice(1).split('.')[0]) < 22) throw new TrialFailure('RUNTIME_TOO_OLD', `Sandbox Node ${nodeVersion} is older than the required 22.`, sandboxId);
    this.hooks.log(`${spec.trialId}: sandbox ${sandboxId} prepared (node ${nodeVersion})`);
    return { spec, sandboxId, nodeVersion, preparedAt: new Date().toISOString() };
  }

  /** Runs the single blocking trial command and turns its outputs into validated telemetry. */
  async execute(prepared: PreparedTrial, cleanupStatus: CleanupStatus): Promise<{ trial: TrialTelemetry; dispatchedAt: string; returnedAt: string }> {
    const { spec, sandboxId } = prepared;
    const dispatchedAt = new Date().toISOString();
    let exitCode: number;
    let output = '';
    try {
      const result = await this.provider.execute(sandboxId, 'run-trial', LIMITS_SEC.trialCommand);
      exitCode = result.exitCode;
      output = result.output;
    } catch (error) {
      if (error instanceof ProviderTimeoutError) throw new TrialFailure('TRIAL_COMMAND_TIMEOUT', 'The trial command exceeded 60 seconds.', sandboxId);
      throw error;
    }
    const returnedAt = new Date().toISOString();
    const collected = await collectTrialArtifacts(this.provider, sandboxId, spec.runId, spec.trialId);
    const base = { sandboxId, cleanupStatus, artifacts: collected.artifacts, startedAt: dispatchedAt, finishedAt: returnedAt };
    if (exitCode !== 0) {
      return { dispatchedAt, returnedAt, trial: emptyTrial(spec, this.payload, this.executionMode, { ...base, status: 'FAILED', error: { code: 'HARNESS_FAILED', message: `runTrial exited ${exitCode}: ${output.trim().slice(-400) || 'no output'}` }, warnings: collected.errors.slice(0, 32) }) };
    }
    return { dispatchedAt, returnedAt, trial: this.validateReport(prepared, collected.contents.metrics, collected.contents.runtime, base, collected.errors) };
  }

  /** Deletes with one retry. Returns the cleanup status; never throws. */
  async destroy(sandboxId: string): Promise<CleanupStatus> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.provider.destroy(sandboxId, LIMITS_SEC.delete);
        this.hooks.log(`sandbox ${sandboxId} deleted`);
        return 'DELETED';
      } catch (error) {
        this.hooks.log(`sandbox ${sandboxId} delete attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return 'FAILED';
  }

  private async createWithReconciliation(spec: TrialSpec): Promise<string> {
    const labels: SandboxLabels = { project: 'entropy', owner: SANDBOX_OWNER, runId: spec.runId, trialId: spec.trialId, purpose: 'trial', createdAt: new Date().toISOString() };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.hooks.countAllocation(spec);
      try {
        const handle = await this.provider.create(labels, LIMITS_SEC.create);
        await this.onCreated?.(spec, handle.id);
        return handle.id;
      } catch (error) {
        if (!(error instanceof ProviderTimeoutError)) throw error;
        // A timed-out create may still have produced a sandbox: find it by label before retrying.
        const found = await this.provider.listOwned({ runId: spec.runId, trialId: spec.trialId });
        if (found[0]) {
          await this.onCreated?.(spec, found[0].id);
          for (const extra of found.slice(1)) await this.destroy(extra.id);
          this.hooks.log(`${spec.trialId}: create timed out but sandbox ${found[0].id} exists; adopting it`);
          return found[0].id;
        }
        this.hooks.log(`${spec.trialId}: create attempt ${attempt} timed out with no sandbox found`);
      }
    }
    throw new TrialFailure('SANDBOX_CREATE_TIMEOUT', 'Sandbox creation timed out twice.');
  }

  private validateReport(prepared: PreparedTrial, reportBytes: Buffer | undefined, runtimeBytes: Buffer | undefined, base: Pick<TrialTelemetry, 'sandboxId' | 'cleanupStatus' | 'artifacts' | 'startedAt' | 'finishedAt'>, collectionErrors: string[]): TrialTelemetry {
    const { spec } = prepared;
    const fail = (code: string, message: string) => emptyTrial(spec, this.payload, this.executionMode, { ...base, status: 'FAILED', error: { code, message: message.slice(0, 512) }, warnings: collectionErrors.slice(0, 32) });
    if (!reportBytes || !runtimeBytes) return fail('REPORT_MISSING', 'trial.json or runtime.json was not collected.');
    let raw: Record<string, unknown>;
    let runtime: Record<string, unknown>;
    try {
      raw = JSON.parse(reportBytes.toString('utf8')) as Record<string, unknown>;
      runtime = JSON.parse(runtimeBytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      return fail('REPORT_MALFORMED', 'trial.json or runtime.json is not valid JSON.');
    }
    if (raw.schemaVersion !== 1) return fail('REPORT_SCHEMA', 'trial.json schemaVersion is not 1.');
    const { schemaVersion: _schemaVersion, ...report } = raw;
    const observed = (runtime.observed ?? {}) as Record<string, unknown>;
    const manifest = this.payload.manifest;
    const mismatches = [
      report.id !== spec.trialId && 'trial id', report.runId !== spec.runId && 'run id', report.kind !== spec.kind && 'kind',
      report.sourceSha !== manifest.sourceSha && 'source sha', report.payloadHash !== manifest.payloadHash && 'payload hash', report.workloadHash !== manifest.workloadHash && 'workload hash',
      runtime.payloadHash !== manifest.payloadHash && 'in-sandbox bundle hash', observed.node !== prepared.nodeVersion && 'node version',
      (spec.fault !== null) !== FAULT_KINDS.includes(spec.kind) && 'fault/kind'
    ].filter(Boolean);
    if (mismatches.length) return fail('REPORT_IDENTITY_MISMATCH', `Report identity mismatch: ${mismatches.join(', ')}.`);
    const parsed = TrialTelemetrySchema.safeParse({
      ...report, ...base,
      // Provider-owned and backend-observed fields; the payload cannot assert these.
      executionMode: this.executionMode,
      runtimeIdentity: `node-${prepared.nodeVersion}|${String(observed.platform)}-${String(observed.arch)}|image:${manifest.sandboxImage}`,
      warnings: [...((report.warnings as string[] | undefined) ?? []), ...collectionErrors].slice(0, 32)
    });
    if (!parsed.success) return fail('REPORT_INVALID', `trial.json failed validation: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    return parsed.data;
  }
}
