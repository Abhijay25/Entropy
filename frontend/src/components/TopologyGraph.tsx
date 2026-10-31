import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DependencyEdge, ServiceNode, TopologyGraph as Topology } from '@entropy/shared';

const POSITIONS: Record<string, { x: number; y: number }> = {
  frontend: { x: 0, y: 145 }, 'order-service': { x: 260, y: 65 }, 'auth-service': { x: 260, y: 245 },
  'payment-service': { x: 520, y: 65 }, 'redis-cache': { x: 520, y: 245 }, 'postgres-db': { x: 780, y: 65 }
};
export type EdgeStyle = 'configured' | 'predicted' | 'observed';
export function edgeStyle(edge: DependencyEdge): EdgeStyle { return edge.evidenceKind; }
interface Props { graph?: Topology; predictedIds: readonly string[]; selectedNodeId?: string; onSelect: (serviceId: string) => void; }

function graphNode(node: ServiceNode, selectedNodeId?: string): Node {
  return { id: node.id, position: POSITIONS[node.id] ?? { x: 0, y: 0 }, data: { label: <><strong>{node.name}</strong><small>{node.mock ? 'mock datastore' : `:${node.port}`} - {node.status}</small></> }, className: `topology-node status-${node.status.toLowerCase()}${selectedNodeId === node.id ? ' is-selected' : ''}` };
}
export function flowEdge(edge: DependencyEdge): Edge {
  const style = edgeStyle(edge);
  const styles: Record<EdgeStyle, Edge> = {
    configured: { id: edge.id, source: edge.source, target: edge.target, label: edge.relationship, className: 'topology-edge configured-edge', style: { stroke: '#75808d' } },
    predicted: { id: edge.id, source: edge.source, target: edge.target, label: 'predicted', className: 'topology-edge prediction-edge', style: { stroke: '#d9a441', strokeDasharray: '6 5' } },
    observed: { id: edge.id, source: edge.source, target: edge.target, label: 'observed cascade', animated: true, className: 'topology-edge observed-edge', style: { stroke: '#ef6b73', strokeWidth: 3 } }
  };
  return styles[style];
}
export function predictedEdges(graph: Topology, predictedIds: readonly string[]): Edge[] {
  return predictedIds.slice(1).flatMap((serviceId, index) => {
    const previous = predictedIds[index];
    if (!previous) return [];
    const edge = graph.edges.find((candidate) => candidate.evidenceKind === 'configured' && ((candidate.source === previous && candidate.target === serviceId) || (candidate.source === serviceId && candidate.target === previous)));
    if (!edge) return [];
    return [flowEdge({ ...edge, id: `prediction:${edge.id}`, evidenceKind: 'predicted' })];
  });
}

export function TopologyGraph({ graph, predictedIds, selectedNodeId, onSelect }: Props) {
  if (!graph) return <section className="panel topology-panel"><p className="eyebrow">Topology</p><h2>Loading topology</h2><p className="muted">Waiting for the live topology API.</p></section>;
  const nodes = graph.nodes.map((node) => graphNode(node, selectedNodeId));
  return <section className="panel topology-panel" aria-label="Service topology"><div className="panel-heading"><div><p className="eyebrow">Topology</p><h2>Configured dependencies and measured cascade</h2></div><span className="status-text unknown">● telemetry governs health</span></div><div className="topology-canvas"><ReactFlow nodes={nodes} edges={[...graph.edges.map(flowEdge), ...predictedEdges(graph, predictedIds)]} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.45} maxZoom={1.8} onNodeClick={(_, node) => onSelect(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable><Background gap={18} size={1} color="#2a3038" /><Controls showInteractive={false} /></ReactFlow></div><div className="legend"><span><i className="legend-line" /> configured caller → dependency</span><span><i className="legend-line predicted" /> proposed path</span><span><i className="legend-line observed" /> observed dependency → affected caller</span><span>UNKNOWN = no samples</span></div></section>;
}
