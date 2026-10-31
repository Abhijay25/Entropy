// Entry: node payload/trafficGen.cjs --input input.json --output-dir out
// Local debugging: runs the measured schedule against an already running cluster.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { argValue, readTrialInput } from './lib/input.js';
import { runMeasuredWorkload, summarizeClient } from './lib/traffic.js';

async function main(): Promise<void> {
  const inputPath = argValue(process.argv, '--input');
  const outputDir = argValue(process.argv, '--output-dir');
  if (!inputPath || !outputDir) throw new Error('Usage: trafficGen --input input.json --output-dir out');
  const input = readTrialInput(inputPath);
  const result = await runMeasuredWorkload(input.trialId);
  mkdirSync(outputDir, { recursive: true });
  const summary = summarizeClient(result);
  writeFileSync(path.join(outputDir, 'traffic.json'), `${JSON.stringify({ summary, samples: result.samples, skipped: result.skipped }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`trafficGen failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
