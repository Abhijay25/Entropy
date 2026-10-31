# Entropy

**Graph-grounded chaos engineering for understanding cascading failures.** Entropy helps engineering teams investigate a practical reliability problem: a slow dependency can propagate through a service graph and affect customer-facing requests, but a dependency map alone does not show what actually failed.

Entropy combines a dependency graph, isolated fault experiments, and AI-assisted analysis. Its MVP focuses on one controlled, six-node service mesh in this repository; Redis and Postgres are HTTP mocks, not production infrastructure.

## How it works

1. **Map and predict:** Retrieve dependency paths from Neo4j and use Nosana inference to generate a bounded hypothesis about a Redis latency spike.
2. **Run a controlled experiment:** Execute a healthy baseline, followed by matched control and fault trials in fresh Daytona sandboxes. The trials use the same payload, workload, source revision, and runtime.
3. **Measure the blast radius:** Compare request errors, latency, service metrics, and traces. The graph distinguishes predicted paths from observed impact; insufficient evidence is reported as inconclusive.
4. **Explain and investigate:** Use Nosana to generate an evidence-linked explanation and remediation advice, then inspect saved evidence through a bounded Daytona MCP diagnostic. A reproduction creates a new pair of trials without replacing the original results.

## Sponsor integrations

| Sponsor | Role in Entropy | Where to inspect |
| --- | --- | --- |
| **Daytona** | Isolated sandbox execution for baseline and matched chaos trials; a separate sandbox and MCP tool trace for post-run investigation. | [`backend/src/sandbox/`](backend/src/sandbox/), [`docs/integrations.md`](docs/integrations.md#daytona-sdk-and-mcp) |
| **Neo4j** | Dependency topology, graph-based context retrieval, and persistence of runs, metrics, and evidence. | [`backend/src/graph/`](backend/src/graph/), [`docs/integrations.md`](docs/integrations.md#neo4j) |
| **Nosana** | GPU-hosted model inference for the hypothesis and evidence-grounded explanation. | [`backend/src/agent/`](backend/src/agent/), [`docs/integrations.md`](docs/integrations.md#nosana) |

Live sponsor access and end-to-end behavior must be verified in the deployment environment; configuration or source code alone is not proof of a successful live run. Development substitutes are explicitly labeled and do not satisfy live-demo acceptance.

## HackSprint judging criteria

- **Completeness:** The MVP connects a dashboard, experiment orchestration, comparison, evidence inspection, reproduction, and diagnostic workflow. See the [live demo and acceptance checklist](docs/demo.md).
- **Innovation:** Entropy brings graph-grounded hypotheses together with matched sandbox experiments and trace-backed analysis, keeping predictions separate from observations.
- **Real-life problem solving:** Cascading dependency failures can turn a localized slowdown into customer-facing errors. Entropy demonstrates a repeatable way to investigate that risk on a controlled mock system.
- **Sponsored product usage:** Daytona runs the experiments and MCP investigation; Neo4j supplies graph context and evidence storage; Nosana supplies inference. The [integration gate](docs/integrations.md#first-time-integration-gate) describes the checks needed to verify each provider.

## Run and verify

Requirements include Node.js 22, npm, and configured Neo4j, Daytona, and Nosana access for a live run. Copy `.env.example` to `.env` and configure it locally; never commit credentials. Follow the full [integration setup](docs/integrations.md) before running:

```sh
npm ci
npm run doctor
npm run db:migrate
npm run payload:check
npm run dev
```

The dashboard runs on port 5173 and the API on port 3001. See the [three-minute demo guide](docs/demo.md) for the live sequence, verification queries, and limitations. The [active specification](spec/README.md) defines the implementation contracts and acceptance criteria.

**Scope and limitations:** This is a controlled demo, not universal repository onboarding or production infrastructure testing. Remediation is advice only: Entropy does not automatically apply patches or claim self-healing. A recorded run or development fixture must never be presented as a live provider result.
