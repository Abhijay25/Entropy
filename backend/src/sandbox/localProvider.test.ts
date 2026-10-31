import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalProcessProvider } from './localProvider.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('LocalProcessProvider', () => {
  it('kills the trial process and its grandchildren when destroyed mid-execution', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'entropy-local-'));
    roots.push(root);
    const provider = new LocalProcessProvider(root);
    const handle = await provider.create({ project: 'entropy', runId: 'run-1', trialId: 'trial-1', purpose: 'trial', createdAt: new Date().toISOString() });
    const fakeTrial = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    await provider.upload(handle.id, [{ remotePath: 'payload/runTrial.cjs', bytes: Buffer.from(fakeTrial) }]);
    const execution = provider.execute(handle.id, 'run-trial', 30).catch(() => undefined);
    const pidFile = path.join(root, handle.id, 'workdir', 'pids.json');
    const pids = await vi.waitFor(() => JSON.parse(readFileSync(pidFile, 'utf8')) as number[], { timeout: 5000 });
    expect(pids.every(alive)).toBe(true);

    await provider.destroy(handle.id);
    await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 3000 });
    await execution;
    expect(await provider.listOwned({ runId: 'run-1' })).toEqual([]);
  });

  it('lets a fresh provider instance (after a backend crash) kill groups recorded on disk', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'entropy-local-'));
    roots.push(root);
    const crashed = new LocalProcessProvider(root);
    const handle = await crashed.create({ project: 'entropy', runId: 'run-3', trialId: 'trial-3', purpose: 'trial', createdAt: new Date().toISOString() });
    await crashed.upload(handle.id, [{ remotePath: 'payload/runTrial.cjs', bytes: Buffer.from("require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);") }]);
    void crashed.execute(handle.id, 'run-trial', 30).catch(() => undefined);
    const pid = await vi.waitFor(() => Number(readFileSync(path.join(root, handle.id, 'workdir', 'pid'), 'utf8')), { timeout: 5000 });
    expect(alive(pid)).toBe(true);
    await new LocalProcessProvider(root).destroy(handle.id);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });

  it('refuses paths that escape the sandbox workdir', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'entropy-local-'));
    roots.push(root);
    const provider = new LocalProcessProvider(root);
    const handle = await provider.create({ project: 'entropy', runId: 'run-2', trialId: 'trial-2', purpose: 'trial', createdAt: new Date().toISOString() });
    await expect(provider.upload(handle.id, [{ remotePath: '../escape.txt', bytes: Buffer.from('x') }])).rejects.toThrow('escapes');
    await expect(provider.destroy('../../etc')).rejects.toThrow('Unknown local sandbox id');
  });
});
