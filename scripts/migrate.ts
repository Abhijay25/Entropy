// npm run db:migrate — idempotent Neo4j constraints and the six-node template topology.
import { config } from '../backend/src/config.js';
import { Neo4jGraphRepository } from '../backend/src/graph/neo4jClient.js';

async function main(): Promise<void> {
  const { uri, username, password, database } = config.neo4j;
  if (!uri || !password) throw new Error('NEO4J_URI and NEO4J_PASSWORD are required.');
  const repository = new Neo4jGraphRepository({ uri, username, password, database });
  try {
    await repository.ensureSchema();
    const graph = await repository.seedTopology();
    console.log(`Schema ensured; template topology: ${graph.nodes.length} nodes, ${graph.edges.length} configured edges.`);
  } finally {
    await repository.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
