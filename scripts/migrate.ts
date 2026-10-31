import { config } from '../backend/src/config.js';
import { Neo4jGraphRepository } from '../backend/src/graph/neo4jClient.js';

async function main(): Promise<void> {
  if (!config.neo4j.uri || !config.neo4j.password) {
    throw new Error('NEO4J_URI and NEO4J_PASSWORD must be configured to run db:migrate.');
  }
  const repository = new Neo4jGraphRepository({
    uri: config.neo4j.uri,
    username: config.neo4j.username,
    password: config.neo4j.password,
    database: config.neo4j.database
  });
  try {
    await repository.verifyConnectivity();
    await repository.ensureSchema();
    const graph = await repository.seedTopology();
    process.stdout.write(`Schema ensured; template topology: ${graph.nodes.length} nodes, ${graph.edges.length} configured edges.\n`);
  } finally {
    await repository.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
