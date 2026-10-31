// npm run cleanup [-- --dry-run] — deletes only sandboxes labeled project=entropy.
import { config } from '../backend/src/config.js';
import { DaytonaProvider } from '../backend/src/sandbox/daytonaRunner.js';
import { LocalProcessProvider } from '../backend/src/sandbox/localProvider.js';
import type { SandboxProvider } from '../backend/src/sandbox/provider.js';

async function sweep(name: string, provider: SandboxProvider, dryRun: boolean): Promise<number> {
  const owned = await provider.listOwned({ project: 'entropy' });
  let failures = 0;
  for (const handle of owned) {
    const label = `${name} ${handle.id} run=${handle.labels.runId ?? '?'} trial=${handle.labels.trialId ?? '?'} purpose=${handle.labels.purpose ?? '?'}`;
    if (dryRun) { console.log(`would delete ${label}`); continue; }
    try {
      await provider.destroy(handle.id, 30);
      console.log(`deleted ${label}`);
    } catch (error) {
      failures += 1;
      console.log(`FAILED  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!owned.length) console.log(`${name}: no Entropy-owned sandboxes.`);
  return failures;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  let failures = await sweep('local', new LocalProcessProvider(), dryRun);
  if (config.daytona.apiKey) failures += await sweep('daytona', DaytonaProvider.fromConfig(), dryRun);
  else console.log('daytona: DAYTONA_API_KEY not set; skipped.');
  process.exit(failures ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
