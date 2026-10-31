// The only module that imports @daytona/sdk. Everything else uses SandboxProvider.
import { Daytona, DaytonaNotFoundError, DaytonaTimeoutError, type Sandbox } from '@daytona/sdk';

import { config } from '../config.js';
import { commandLine, ProviderTimeoutError, REMOTE_WORKDIR, type ExecuteResult, type SandboxHandle, type SandboxLabels, type SandboxProvider, type TrustedCommand } from './provider.js';

/** Documented default endpoint; the region is selected separately with DAYTONA_TARGET. */
export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

export interface DaytonaProviderOptions {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DaytonaTimeoutError || (error instanceof Error && /timed? ?out/i.test(error.message));
}

function remote(remotePath: string): string {
  if (remotePath.startsWith('/') || remotePath.split('/').includes('..')) throw new Error('Remote paths must be relative to the Entropy workdir.');
  return `${REMOTE_WORKDIR}/${remotePath}`;
}

export class DaytonaProvider implements SandboxProvider {
  readonly executionMode = 'daytona' as const;
  readonly maxConcurrent: number;
  readonly apiUrl: string;
  private readonly client: Daytona;
  private readonly sandboxes = new Map<string, Sandbox>();

  constructor(private readonly options: DaytonaProviderOptions, maxConcurrent = config.entropy.maxSandboxes) {
    // Always explicit: the SDK refuses an endpoint it cannot attribute when .env defines DAYTONA_API_URL.
    this.apiUrl = options.apiUrl ?? DEFAULT_DAYTONA_API_URL;
    this.client = new Daytona({ apiKey: options.apiKey, apiUrl: this.apiUrl, ...(options.target ? { target: options.target } : {}) });
    this.maxConcurrent = maxConcurrent;
  }

  static fromConfig(): DaytonaProvider {
    if (!config.daytona.apiKey) throw new Error('DAYTONA_API_KEY is not configured.');
    return new DaytonaProvider({ apiKey: config.daytona.apiKey, apiUrl: config.daytona.apiUrl, target: config.daytona.target, snapshot: config.daytona.snapshot });
  }

  async create(labels: SandboxLabels, timeoutSec: number): Promise<SandboxHandle> {
    const base = {
      labels: { ...labels },
      language: 'typescript',
      // Provider backstops; explicit cleanup remains the primary mechanism.
      autoStopInterval: 15,
      autoDeleteInterval: 30,
      ephemeral: false
    };
    try {
      // Snapshot resources may be inherited; only image-based creation accepts overrides.
      const sandbox = this.options.snapshot
        ? await this.client.create({ ...base, snapshot: this.options.snapshot }, { timeout: timeoutSec })
        : await this.client.create({ ...base }, { timeout: timeoutSec });
      this.sandboxes.set(sandbox.id, sandbox);
      await sandbox.fs.createFolder(REMOTE_WORKDIR, '755').catch(() => undefined);
      return { id: sandbox.id, labels: sandbox.labels, region: sandbox.target };
    } catch (error) {
      if (isTimeout(error)) throw new ProviderTimeoutError('sandbox create');
      throw error;
    }
  }

  async upload(sandboxId: string, files: ReadonlyArray<{ remotePath: string; bytes: Buffer }>, timeoutSec: number): Promise<void> {
    const sandbox = await this.sandbox(sandboxId);
    const folders = new Set(files.map((file) => file.remotePath.split('/').slice(0, -1).join('/')).filter(Boolean));
    for (const folder of folders) await sandbox.fs.createFolder(remote(folder), '755').catch(() => undefined);
    await sandbox.fs.uploadFiles(files.map((file) => ({ source: file.bytes, destination: remote(file.remotePath) })), timeoutSec);
  }

  async execute(sandboxId: string, command: TrustedCommand, timeoutSec: number): Promise<ExecuteResult> {
    const sandbox = await this.sandbox(sandboxId);
    try {
      const response = await sandbox.process.executeCommand(commandLine(command), REMOTE_WORKDIR, undefined, timeoutSec);
      return { exitCode: response.exitCode, output: response.artifacts?.stdout ?? response.result };
    } catch (error) {
      if (isTimeout(error)) throw new ProviderTimeoutError(`execute ${command}`);
      throw error;
    }
  }

  async fileSize(sandboxId: string, remotePath: string): Promise<number | null> {
    const sandbox = await this.sandbox(sandboxId);
    try {
      return (await sandbox.fs.getFileDetails(remote(remotePath))).size;
    } catch (error) {
      if (error instanceof DaytonaNotFoundError || (error instanceof Error && /not found|no such file/i.test(error.message))) return null;
      throw error;
    }
  }

  async download(sandboxId: string, remotePath: string, timeoutSec: number): Promise<Buffer> {
    const sandbox = await this.sandbox(sandboxId);
    return sandbox.fs.downloadFile(remote(remotePath), timeoutSec);
  }

  async destroy(sandboxId: string, timeoutSec: number): Promise<void> {
    try {
      const sandbox = await this.sandbox(sandboxId);
      // wait=true: report DELETED (and free capacity) only once the sandbox is actually destroyed.
      await this.client.delete(sandbox, timeoutSec, true);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return;
      if (isTimeout(error)) throw new ProviderTimeoutError('sandbox delete');
      throw error;
    } finally {
      this.sandboxes.delete(sandboxId);
    }
  }

  async listOwned(labels: Partial<SandboxLabels>): Promise<SandboxHandle[]> {
    const owned: SandboxHandle[] = [];
    for await (const sandbox of this.client.list({ labels: { ...labels, project: 'entropy' } as Record<string, string> })) {
      if (sandbox.labels.project === 'entropy') owned.push({ id: sandbox.id, labels: sandbox.labels });
    }
    return owned;
  }

  private async sandbox(sandboxId: string): Promise<Sandbox> {
    const cached = this.sandboxes.get(sandboxId);
    if (cached) return cached;
    const sandbox = await this.client.get(sandboxId);
    if (sandbox.labels.project !== 'entropy') throw new Error('Refusing to operate on a sandbox Entropy does not own.');
    this.sandboxes.set(sandboxId, sandbox);
    return sandbox;
  }
}
