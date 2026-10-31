import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LIMITS, type ArtifactRef } from '../../../shared/types.js';
import { config } from '../config.js';
import { ENTROPY_DIR } from '../sandbox/payloadManifest.js';
import type { SandboxProvider } from '../sandbox/provider.js';

export const ARTIFACT_ROOT = path.join(ENTROPY_DIR, 'artifacts');
const COLLECT_TIMEOUT_SEC = 30;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

type ArtifactKind = ArtifactRef['kind'];

interface ArtifactSpec {
  remotePath: string;
  fileName: string;
  kind: ArtifactKind;
  limitBytes: number;
  contentType: 'application/json' | 'application/x-ndjson' | 'text/plain';
  /** Required evidence may not be truncated; a too-large file is unavailable instead. */
  required: boolean;
}

export const TRIAL_ARTIFACTS: readonly ArtifactSpec[] = [
  { remotePath: 'out/trial.json', fileName: 'trial.json', kind: 'metrics', limitBytes: LIMITS.maxArtifactReportBytes, contentType: 'application/json', required: true },
  { remotePath: 'out/spans.jsonl', fileName: 'spans.jsonl', kind: 'spans', limitBytes: LIMITS.maxArtifactReportBytes, contentType: 'application/x-ndjson', required: true },
  { remotePath: 'out/fault-witness.json', fileName: 'fault-witness.json', kind: 'fault_witness', limitBytes: LIMITS.maxArtifactLogBytes, contentType: 'application/json', required: true },
  { remotePath: 'out/runtime.json', fileName: 'runtime.json', kind: 'runtime', limitBytes: 64 * 1024, contentType: 'application/json', required: true },
  { remotePath: 'out/terminal.log', fileName: 'terminal.log', kind: 'terminal', limitBytes: LIMITS.maxArtifactLogBytes, contentType: 'text/plain', required: false }
];

export interface RegisteredArtifact extends ArtifactRef {
  runId: string;
  trialId: string;
  fileName: string;
  contentType: string;
}

export interface CollectedTrial {
  artifacts: ArtifactRef[];
  contents: Partial<Record<ArtifactKind, Buffer>>;
  errors: string[];
}

function secrets(): string[] {
  return [config.daytona.apiKey, config.nosana.apiKey, config.neo4j.password].filter((value): value is string => Boolean(value && value.length >= 6));
}

/** Removes configured secrets and terminal escape codes from retained text. */
export function redact(text: string, extraSecrets: readonly string[] = []): string {
  let result = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const secret of [...secrets(), ...extraSecrets]) result = result.split(secret).join('[REDACTED]');
  // The literal demo token is a documented non-secret and stays readable.
  return result
    .replace(/Bearer (?!entropy-demo-token\b)[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[REDACTED]');
}

export function trialArtifactDir(runId: string, trialId: string): string {
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(trialId)) throw new Error('Unsafe artifact path segment.');
  return path.join(ARTIFACT_ROOT, runId, trialId);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes bounded, redacted, hashed artifacts locally and records them in a per-trial index. */
export function storeArtifacts(runId: string, trialId: string, entries: Array<{ spec: Pick<ArtifactSpec, 'fileName' | 'kind' | 'contentType'>; bytes: Buffer | null; truncated: boolean }>): ArtifactRef[] {
  const dir = trialArtifactDir(runId, trialId);
  mkdirSync(dir, { recursive: true });
  const registered: RegisteredArtifact[] = entries.map(({ spec, bytes, truncated }) => {
    const id = `${trialId}:${spec.kind}`.slice(0, 128);
    if (!bytes) return { id, kind: spec.kind, sizeBytes: 0, sha256: '0'.repeat(64), truncated, available: false, runId, trialId, fileName: spec.fileName, contentType: spec.contentType };
    const clean = Buffer.from(redact(bytes.toString('utf8')), 'utf8');
    writeFileSync(path.join(dir, spec.fileName), clean);
    return { id, kind: spec.kind, sizeBytes: clean.length, sha256: sha256(clean), truncated, available: true, runId, trialId, fileName: spec.fileName, contentType: spec.contentType };
  });
  writeFileSync(path.join(dir, 'artifacts.json'), `${JSON.stringify(registered, null, 2)}\n`);
  return registered.map(({ id, kind, sizeBytes, sha256: hash, truncated, available }) => ({ id, kind, sizeBytes, sha256: hash, truncated, available }));
}

/** Downloads each output after checking its size; never downloads beyond the per-trial budget. */
export async function collectTrialArtifacts(provider: SandboxProvider, sandboxId: string, runId: string, trialId: string): Promise<CollectedTrial> {
  const contents: CollectedTrial['contents'] = {};
  const errors: string[] = [];
  const entries: Parameters<typeof storeArtifacts>[2] = [];
  let total = 0;
  for (const spec of TRIAL_ARTIFACTS) {
    try {
      const size = await provider.fileSize(sandboxId, spec.remotePath);
      if (size === null) { errors.push(`${spec.fileName} missing`); entries.push({ spec, bytes: null, truncated: false }); continue; }
      if (size > spec.limitBytes || total + size > LIMITS.maxArtifactBytes) {
        errors.push(`${spec.fileName} is ${size} bytes, above its bound`);
        entries.push({ spec, bytes: null, truncated: true });
        continue;
      }
      const bytes = await provider.download(sandboxId, spec.remotePath, COLLECT_TIMEOUT_SEC);
      total += bytes.length;
      contents[spec.kind] = bytes;
      entries.push({ spec, bytes, truncated: false });
    } catch (error) {
      errors.push(`${spec.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      entries.push({ spec, bytes: null, truncated: false });
    }
  }
  return { artifacts: storeArtifacts(runId, trialId, entries), contents, errors };
}

/** Looks up a registered artifact by ID; only files listed in an index are ever served. */
export function findArtifact(artifactId: string): { artifact: RegisteredArtifact; filePath: string } | null {
  if (!SAFE_SEGMENT.test(artifactId) || !existsSync(ARTIFACT_ROOT)) return null;
  for (const runId of readdirSync(ARTIFACT_ROOT)) {
    if (!SAFE_SEGMENT.test(runId)) continue;
    const runDir = path.join(ARTIFACT_ROOT, runId);
    for (const trialId of readdirSync(runDir)) {
      if (!SAFE_SEGMENT.test(trialId) || !artifactId.startsWith(`${trialId}:`)) continue;
      const indexPath = path.join(runDir, trialId, 'artifacts.json');
      if (!existsSync(indexPath)) continue;
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as RegisteredArtifact[];
      const artifact = index.find((entry) => entry.id === artifactId);
      if (!artifact) continue;
      const filePath = path.resolve(runDir, trialId, artifact.fileName);
      if (!filePath.startsWith(path.join(runDir, trialId) + path.sep)) return null;
      return { artifact, filePath };
    }
  }
  return null;
}
