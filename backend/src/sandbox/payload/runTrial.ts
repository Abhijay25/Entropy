// Entry: node payload/runTrial.cjs --input input.json --output-dir out
// Exit 0: a complete, well-formed measurement was written (service requests may still have failed).
// Exit nonzero: harness, process, or report failure.
import path from 'node:path';

import { argValue, readTrialInput } from './lib/input.js';
import { runTrialHarness } from './lib/trial.js';

async function main(): Promise<void> {
  const inputPath = argValue(process.argv, '--input');
  const outputDir = argValue(process.argv, '--output-dir');
  if (!inputPath || !outputDir) throw new Error('Usage: runTrial --input input.json --output-dir out');
  const input = readTrialInput(inputPath);
  const payloadDir = path.dirname(process.argv[1] ?? '.');
  const { report } = await runTrialHarness({ input, outputDir, cluster: { mode: 'child', payloadDir }, verifyPayloadHash: true });
  process.stdout.write(`${JSON.stringify({ trialId: report.id, validity: report.validity, faultWitnessed: report.faultWitnessed, clientSummary: report.clientSummary })}\n`);
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`runTrial failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
