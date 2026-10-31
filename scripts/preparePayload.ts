// npm run prepare:payload -- <full-git-sha>
// Extracts committed sources with `git archive`, bundles the payload from that archive,
// and writes .entropy/payload/<sha>/manifest.json. Untracked or uncommitted files never enter.
//
// npm run prepare:payload -- --development
// Bundles the working tree into .entropy/payload/development, labeled development=true.
// Such runs are explicitly development-only and never recorded as an immutable source.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { version as installedEsbuild } from 'esbuild';

import { computeWorkloadHash } from '../backend/src/sandbox/payload/lib/input.js';
import { config } from '../backend/src/config.js';
import { bundlePayload } from './lib/bundle.js';
import { DEVELOPMENT_PAYLOAD, payloadDirFor, topologyHash, type PayloadManifest } from '../backend/src/sandbox/payloadManifest.js';

const ROOT = path.resolve(__dirname, '..');

function lockedEsbuildVersion(lockText: string): string | undefined {
  const lock = JSON.parse(lockText) as { packages?: Record<string, { version?: string }> };
  return lock.packages?.['node_modules/esbuild']?.version;
}

function writeManifest(outDir: string, manifest: PayloadManifest): void {
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${manifest.development ? 'DEVELOPMENT ' : ''}payload ${manifest.payloadHash} from ${manifest.sourceSha} at ${outDir}`);
}

async function prepareDevelopment(): Promise<void> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const outDir = payloadDirFor(DEVELOPMENT_PAYLOAD);
  rmSync(outDir, { recursive: true, force: true });
  const bundle = await bundlePayload(ROOT, path.join(outDir, 'payload'));
  const lockText = readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  writeManifest(outDir, {
    schemaVersion: 1, sourceSha: head, archiveSha256: '0'.repeat(64), productLockSha256: createHash('sha256').update(lockText).digest('hex'),
    buildTool: { name: 'esbuild', version: bundle.esbuildVersion }, payloadHash: bundle.payloadHash,
    files: bundle.files.map((file) => ({ name: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex'), sizeBytes: file.bytes.length })),
    topologyHash: topologyHash(), workloadHash: computeWorkloadHash(), targetRuntime: 'node22', sandboxImage: config.daytona.snapshot ?? 'daytona-default-snapshot',
    createdAt: new Date().toISOString(), development: true
  });
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested === '--development') return prepareDevelopment();
  if (!requested || !/^[a-f0-9]{40}$/.test(requested)) throw new Error('Usage: npm run prepare:payload -- <full 40-character git sha>');
  const resolved = execFileSync('git', ['rev-parse', '--verify', `${requested}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (resolved !== requested) throw new Error(`${requested} does not resolve to itself (got ${resolved}).`);

  const outDir = payloadDirFor(resolved);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'entropy-archive-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', resolved], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    const sourceDir = path.join(temp, 'src');
    mkdirSync(sourceDir);
    execFileSync('tar', ['-x', '-C', sourceDir], { input: archive });

    if (!existsSync(path.join(sourceDir, 'backend', 'src', 'sandbox', 'payload', 'runTrial.ts'))) throw new Error(`Commit ${resolved} does not contain the payload sources; commit them before preparing a recorded payload.`);
    const lockText = readFileSync(path.join(sourceDir, 'package-lock.json'), 'utf8');
    const locked = lockedEsbuildVersion(lockText);
    if (locked !== installedEsbuild) throw new Error(`Installed esbuild ${installedEsbuild} differs from the archived lockfile (${locked ?? 'absent'}). Run npm ci at a matching revision.`);

    rmSync(outDir, { recursive: true, force: true });
    const bundle = await bundlePayload(sourceDir, path.join(outDir, 'payload'));
    const manifest: PayloadManifest = {
      schemaVersion: 1,
      sourceSha: resolved,
      archiveSha256,
      productLockSha256: createHash('sha256').update(lockText).digest('hex'),
      buildTool: { name: 'esbuild', version: bundle.esbuildVersion },
      payloadHash: bundle.payloadHash,
      files: bundle.files.map((file) => ({ name: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex'), sizeBytes: file.bytes.length })),
      topologyHash: topologyHash(),
      workloadHash: computeWorkloadHash(),
      targetRuntime: 'node22',
      sandboxImage: config.daytona.snapshot ?? 'daytona-default-snapshot',
      createdAt: new Date().toISOString(),
      development: false
    };
    writeManifest(outDir, manifest);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
