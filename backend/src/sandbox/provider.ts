// Application boundary for sandbox execution. Commands are fixed trusted templates;
// nothing model- or browser-supplied is ever interpolated into them.
import os from 'node:os';

export const REMOTE_WORKDIR = '/tmp/entropy';

export type TrustedCommand = 'node-version' | 'run-trial' | 'diagnostic-probe';

export const TRUSTED_COMMANDS: Record<TrustedCommand, { program: 'node'; args: readonly string[] }> = {
  'node-version': { program: 'node', args: ['--version'] },
  'run-trial': { program: 'node', args: ['payload/runTrial.cjs', '--input', 'input.json', '--output-dir', 'out'] },
  'diagnostic-probe': { program: 'node', args: ['payload/runTrial.cjs', '--input', 'probe-input.json', '--output-dir', 'probe-out'] }
};

export function commandLine(command: TrustedCommand): string {
  const { program, args } = TRUSTED_COMMANDS[command];
  return [program, ...args].join(' ');
}

export type SandboxPurpose = 'smoke' | 'trial' | 'diagnostic';

/**
 * Identifies the backend that created a sandbox, so a restarted backend can delete its own
 * leftovers even when the run record was lost (in-memory store) without touching a teammate's.
 */
export const SANDBOX_OWNER = `${os.userInfo().username}-${os.hostname()}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63);

export interface SandboxLabels {
  project: 'entropy';
  owner: string;
  runId: string;
  trialId: string;
  purpose: SandboxPurpose;
  createdAt: string;
}

export interface SandboxHandle {
  id: string;
  labels: Record<string, string>;
  region?: string;
}

export interface ExecuteResult {
  exitCode: number;
  output: string;
}

export class ProviderTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} timed out`);
    this.name = 'ProviderTimeoutError';
  }
}

export interface SandboxProvider {
  readonly executionMode: 'daytona' | 'development-local';
  /** Maximum sandboxes this provider can run at once (local mode shares fixed ports: 1). */
  readonly maxConcurrent: number;
  create(labels: SandboxLabels, timeoutSec: number): Promise<SandboxHandle>;
  upload(sandboxId: string, files: ReadonlyArray<{ remotePath: string; bytes: Buffer }>, timeoutSec: number): Promise<void>;
  execute(sandboxId: string, command: TrustedCommand, timeoutSec: number): Promise<ExecuteResult>;
  /** Returns null when the file is absent. */
  fileSize(sandboxId: string, remotePath: string): Promise<number | null>;
  download(sandboxId: string, remotePath: string, timeoutSec: number): Promise<Buffer>;
  destroy(sandboxId: string, timeoutSec: number): Promise<void>;
  /** Lists Entropy-owned sandboxes matching every given label. */
  listOwned(labels: Partial<SandboxLabels>): Promise<SandboxHandle[]>;
}

/**
 * Global cap on live sandbox reservations across trials, retries, reproductions, and
 * diagnostics. A reservation is released only after deletion is confirmed, so failed
 * cleanup keeps capacity held rather than letting the pool silently exceed its cap.
 */
export class SandboxBudget {
  private readonly held = new Map<string, string>();
  private sequence = 0;

  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.held.size;
  }

  get available(): number {
    return this.capacity - this.held.size;
  }

  /** Reserves `count` slots atomically, or throws without reserving any. */
  reserve(count: number, owner: string): string[] {
    if (count > this.available) throw new BudgetExhaustedError(count, this.available, [...this.held.values()]);
    return Array.from({ length: count }, () => {
      const token = `reservation-${++this.sequence}`;
      this.held.set(token, owner);
      return token;
    });
  }

  release(token: string): void {
    this.held.delete(token);
  }

  holders(): string[] {
    return [...this.held.values()];
  }
}

export class BudgetExhaustedError extends Error {
  constructor(readonly requested: number, readonly available: number, readonly holders: string[]) {
    super(`Sandbox capacity exhausted: requested ${requested}, available ${available} (held by ${holders.join(', ') || 'nobody'}).`);
    this.name = 'BudgetExhaustedError';
  }
}
