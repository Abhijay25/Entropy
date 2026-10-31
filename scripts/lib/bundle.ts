import { mkdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { build, version as esbuildVersion } from 'esbuild';

import { computePayloadHash, PAYLOAD_ENTRY_FILES } from '../../backend/src/sandbox/payload/lib/input.js';

export interface PayloadBundle {
  outDir: string;
  files: Array<{ name: string; bytes: Buffer }>;
  payloadHash: string;
  esbuildVersion: string;
}

const PAYLOAD_RELATIVE = path.join('backend', 'src', 'sandbox', 'payload');

/**
 * Bundles the four payload entry points into self-contained CommonJS that imports
 * only Node built-ins. `sourceRoot` is a repository root (a git archive or the checkout).
 */
export async function bundlePayload(sourceRoot: string, outDir: string): Promise<PayloadBundle> {
  const payloadDir = path.join(sourceRoot, PAYLOAD_RELATIVE);
  mkdirSync(outDir, { recursive: true });
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: PAYLOAD_ENTRY_FILES.map((name) => ({ in: path.join(payloadDir, name.replace(/\.cjs$/, '.ts')), out: name.replace(/\.cjs$/, '') })),
    outdir: outDir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    logLevel: 'silent'
  });
  // Type-only imports are erased; any other non-payload input means a runtime dependency leaked in.
  const leaked = Object.keys(result.metafile.inputs).filter((input) => !path.resolve(sourceRoot, input).startsWith(payloadDir + path.sep));
  if (leaked.length) throw new Error(`Payload bundle pulled in non-payload modules: ${leaked.join(', ')}`);
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    const external = output.imports.filter((entry) => entry.external && !entry.path.startsWith('node:') && !isBuiltin(entry.path));
    if (external.length) throw new Error(`${file} imports non-builtin modules: ${external.map((entry) => entry.path).join(', ')}`);
  }
  const files = PAYLOAD_ENTRY_FILES.map((name) => ({ name, bytes: readFileSync(path.join(outDir, name)) }));
  return { outDir, files, payloadHash: computePayloadHash(files), esbuildVersion };
}

function isBuiltin(specifier: string): boolean {
  return builtinModules.includes(specifier);
}
