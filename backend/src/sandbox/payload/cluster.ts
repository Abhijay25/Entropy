// Entry: node payload/cluster.cjs --output-dir out
// Six loopback mock services plus the private controller in one process.
import { startMesh } from './lib/mesh.js';

async function main(): Promise<void> {
  const mesh = await startMesh({ log: (line) => process.stdout.write(`${line}\n`) });
  const stop = async () => {
    await mesh.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  await mesh.shutdownRequested;
  await stop();
}

main().catch((error: unknown) => {
  process.stderr.write(`cluster failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
