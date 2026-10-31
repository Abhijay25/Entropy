// Entry: node payload/faultCtl.cjs --input input.json
// Sends the fixed fault command derived from a validated input file to a running cluster.
import { CONTROL_PORT } from './lib/constants.js';
import { callJson } from './lib/http.js';
import { argValue, readTrialInput } from './lib/input.js';

async function main(): Promise<void> {
  const inputPath = argValue(process.argv, '--input');
  if (!inputPath) throw new Error('Usage: faultCtl --input input.json');
  const input = readTrialInput(inputPath);
  const body = input.fault ? { mode: 'redis_latency', delayMs: input.fault.delayMs, durationMs: input.fault.durationMs } : { mode: 'healthy' };
  const outcome = await callJson({ port: CONTROL_PORT, method: 'POST', path: '/control/fault', body, deadlineMs: 5000 });
  if (outcome.kind !== 'response' || outcome.statusCode !== 200) throw new Error(`Controller rejected fault command (${outcome.kind === 'response' ? outcome.statusCode : outcome.kind}).`);
  process.stdout.write(`${JSON.stringify(outcome.body)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`faultCtl failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
