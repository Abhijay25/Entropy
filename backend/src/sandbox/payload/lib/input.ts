import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { TrialKind } from '../../../../../shared/types.js';
import { ALLOWED_FAULT, workloadDefinition } from './constants.js';
import { hasOnlyKeys, isPlainObject } from './http.js';

export interface TrialInput {
  schemaVersion: 1;
  runId: string;
  trialId: string;
  kind: TrialKind;
  sourceSha: string;
  payloadHash: string;
  workloadHash: string;
  fault: null | { targetServiceId: 'redis-cache'; faultType: 'LATENCY_SPIKE'; delayMs: 3000; durationMs: 10_000 };
}

export const PAYLOAD_ENTRY_FILES = ['cluster.cjs', 'faultCtl.cjs', 'trafficGen.cjs', 'runTrial.cjs'] as const;

const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const KINDS: readonly TrialKind[] = ['baseline', 'control', 'chaos', 'reproduction-control', 'reproduction-chaos'];
const FAULT_KINDS: readonly TrialKind[] = ['chaos', 'reproduction-chaos'];

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Canonical JSON: object keys sorted recursively, so hashes do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function computeWorkloadHash(): string {
  return sha256(canonicalJson(workloadDefinition()));
}

/** Hash of the four bundled entry points, by name, in fixed order. */
export function computePayloadHash(files: ReadonlyArray<{ name: string; bytes: Buffer }>): string {
  const lines = [...files].sort((left, right) => left.name.localeCompare(right.name)).map((file) => `${file.name}:${sha256(file.bytes)}\n`);
  return sha256(lines.join(''));
}

export function computePayloadHashFromDir(payloadDir: string): string {
  return computePayloadHash(PAYLOAD_ENTRY_FILES.map((name) => ({ name, bytes: readFileSync(path.join(payloadDir, name)) })));
}

export function parseTrialInput(value: unknown): TrialInput {
  const fail = (reason: string): never => { throw new Error(`Invalid input.json: ${reason}`); };
  if (!isPlainObject(value)) return fail('not an object');
  if (!hasOnlyKeys(value, ['schemaVersion', 'runId', 'trialId', 'kind', 'sourceSha', 'payloadHash', 'workloadHash', 'fault'])) fail('unknown fields');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  for (const key of ['runId', 'trialId'] as const) if (typeof value[key] !== 'string' || !ENTITY_ID.test(value[key])) fail(`${key} is not a valid id`);
  if (!KINDS.includes(value.kind as TrialKind)) fail('unknown kind');
  if (typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceSha)) fail('sourceSha must be a full git sha');
  for (const key of ['payloadHash', 'workloadHash'] as const) if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) fail(`${key} must be sha256 hex`);
  const kind = value.kind as TrialKind;
  const fault = value.fault;
  if (FAULT_KINDS.includes(kind)) {
    if (!isPlainObject(fault) || !hasOnlyKeys(fault, ['targetServiceId', 'faultType', 'delayMs', 'durationMs'])
      || fault.targetServiceId !== ALLOWED_FAULT.targetServiceId || fault.faultType !== ALLOWED_FAULT.faultType
      || fault.delayMs !== ALLOWED_FAULT.delayMs || fault.durationMs !== ALLOWED_FAULT.durationMs) fail('fault trials accept only the fixed Redis latency intervention');
  } else if (fault !== null) {
    fail('healthy trials require fault: null');
  }
  return value as unknown as TrialInput;
}

export function readTrialInput(file: string): TrialInput {
  return parseTrialInput(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
