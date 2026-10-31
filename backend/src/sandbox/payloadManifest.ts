import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIGURED_TOPOLOGY } from '../../../shared/types.js';
import { computePayloadHash, computeWorkloadHash, PAYLOAD_ENTRY_FILES } from './payload/lib/input.js';

export interface PayloadManifest {
  schemaVersion: 1;
  sourceSha: string;
  archiveSha256: string;
  productLockSha256: string;
  buildTool: { name: 'esbuild'; version: string };
  payloadHash: string;
  files: Array<{ name: string; sha256: string; sizeBytes: number }>;
  topologyHash: string;
  workloadHash: string;
  targetRuntime: 'node22';
  sandboxImage: string;
  createdAt: string;
  /** True when bundled from the working tree: never a recorded immutable source. */
  development: boolean;
}

export const DEVELOPMENT_PAYLOAD = 'development';

export const ENTROPY_DIR = path.resolve(__dirname, '..', '..', '..', '.entropy');

export function payloadDirFor(sourceSha: string): string {
  if (sourceSha !== DEVELOPMENT_PAYLOAD && !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('A full 40-character git SHA is required.');
  return path.join(ENTROPY_DIR, 'payload', sourceSha);
}

/** Same derivation as the Neo4j repository's topology hash. */
export function topologyHash(): string {
  return createHash('sha256').update(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY)).digest('hex');
}

export interface LoadedPayload {
  manifest: PayloadManifest;
  files: Array<{ name: string; bytes: Buffer }>;
}

/**
 * Loads a prepared payload and re-validates every hash before it may be uploaded.
 * `selector` is a full SHA, or DEVELOPMENT_PAYLOAD for an explicitly labeled working-tree bundle.
 */
export function loadPreparedPayload(selector: string): LoadedPayload {
  const dir = payloadDirFor(selector);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`No prepared payload for ${selector}. Run: npm run prepare:payload -- ${selector === DEVELOPMENT_PAYLOAD ? '--development' : selector}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PayloadManifest;
  const development = selector === DEVELOPMENT_PAYLOAD;
  if (manifest.schemaVersion !== 1 || manifest.development !== development || (!development && manifest.sourceSha !== selector)) throw new Error('Payload manifest identity does not match the requested source.');
  const files = PAYLOAD_ENTRY_FILES.map((name) => ({ name, bytes: readFileSync(path.join(dir, 'payload', name)) }));
  for (const file of files) {
    const recorded = manifest.files.find((entry) => entry.name === file.name);
    const actual = createHash('sha256').update(file.bytes).digest('hex');
    if (!recorded || recorded.sha256 !== actual) throw new Error(`Bundle file ${file.name} does not match its manifest hash.`);
  }
  if (computePayloadHash(files) !== manifest.payloadHash) throw new Error('Bundle hash does not match the manifest.');
  if (computeWorkloadHash() !== manifest.workloadHash) throw new Error('Workload definition changed since the payload was prepared; prepare a new committed revision.');
  return { manifest, files };
}
