// Explicit development mode: runs trials as local child processes. Results are labeled
// executionMode=development-local and never satisfy live sponsor acceptance.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ENTROPY_DIR } from './payloadManifest.js';
import { ProviderTimeoutError, TRUSTED_COMMANDS, type ExecuteResult, type SandboxHandle, type SandboxLabels, type SandboxProvider, type TrustedCommand } from './provider.js';

const OUTPUT_LIMIT = 64 * 1024;

export class LocalProcessProvider implements SandboxProvider {
  readonly executionMode = 'development-local' as const;
  /** The mock mesh binds fixed loopback ports, so local trials must serialize. */
  readonly maxConcurrent = 1;

  /**
   * Process groups per sandbox, killed on destroy (the trial harness spawns a mesh grandchild).
   * Also recorded on disk so a restarted backend can reconcile groups left by a crash.
   */
  private readonly processes = new Map<string, Set<number>>();

  constructor(private readonly root = path.join(ENTROPY_DIR, 'local-sandboxes')) {}

  async create(labels: SandboxLabels): Promise<SandboxHandle> {
    const id = `local-${randomUUID()}`;
    mkdirSync(this.workdir(id), { recursive: true });
    writeFileSync(path.join(this.root, id, 'labels.json'), JSON.stringify(labels));
    return { id, labels: { ...labels } };
  }

  async upload(sandboxId: string, files: ReadonlyArray<{ remotePath: string; bytes: Buffer }>): Promise<void> {
    for (const file of files) {
      const target = this.resolve(sandboxId, file.remotePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
  }

  execute(sandboxId: string, command: TrustedCommand, timeoutSec: number): Promise<ExecuteResult> {
    const { args } = TRUSTED_COMMANDS[command];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...args], { cwd: this.workdir(sandboxId), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const group = child.pid;
      if (group !== undefined) {
        const groups = this.processes.get(sandboxId) ?? new Set<number>();
        groups.add(group);
        this.processes.set(sandboxId, groups);
        writeFileSync(this.groupsFile(sandboxId), JSON.stringify([...groups]));
        child.once('exit', () => groups.delete(group));
      }
      let output = '';
      const append = (chunk: Buffer) => { if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8'); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => { killGroup(group); reject(new ProviderTimeoutError(`execute ${command}`)); }, timeoutSec * 1000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output: output.slice(0, OUTPUT_LIMIT) }); });
    });
  }

  async fileSize(sandboxId: string, remotePath: string): Promise<number | null> {
    const target = this.resolve(sandboxId, remotePath);
    return existsSync(target) ? statSync(target).size : null;
  }

  async download(sandboxId: string, remotePath: string): Promise<Buffer> {
    return readFileSync(this.resolve(sandboxId, remotePath));
  }

  async destroy(sandboxId: string): Promise<void> {
    const recorded = existsSync(this.groupsFile(sandboxId)) ? JSON.parse(readFileSync(this.groupsFile(sandboxId), 'utf8')) as number[] : [];
    for (const group of new Set([...recorded, ...(this.processes.get(sandboxId) ?? [])])) killGroup(group);
    this.processes.delete(sandboxId);
    rmSync(this.sandboxDir(sandboxId), { recursive: true, force: true });
  }

  async listOwned(labels: Partial<SandboxLabels>): Promise<SandboxHandle[]> {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((id) => id.startsWith('local-')).flatMap((id) => {
      try {
        const stored = JSON.parse(readFileSync(path.join(this.root, id, 'labels.json'), 'utf8')) as Record<string, string>;
        const matches = Object.entries(labels).every(([key, value]) => stored[key] === value);
        return matches ? [{ id, labels: stored }] : [];
      } catch {
        return [];
      }
    });
  }

  private sandboxDir(sandboxId: string): string {
    if (!/^local-[a-f0-9-]{36}$/.test(sandboxId)) throw new Error('Unknown local sandbox id.');
    return path.join(this.root, sandboxId);
  }

  private groupsFile(sandboxId: string): string {
    return path.join(this.sandboxDir(sandboxId), 'process-groups.json');
  }

  private workdir(sandboxId: string): string {
    return path.join(this.sandboxDir(sandboxId), 'workdir');
  }

  private resolve(sandboxId: string, remotePath: string): string {
    const base = this.workdir(sandboxId);
    const target = path.resolve(base, remotePath);
    if (!target.startsWith(base + path.sep)) throw new Error('Path escapes the sandbox workdir.');
    return target;
  }
}

function killGroup(group: number | undefined): void {
  if (group === undefined) return;
  try { process.kill(-group, 'SIGKILL'); } catch { /* already exited */ }
}
