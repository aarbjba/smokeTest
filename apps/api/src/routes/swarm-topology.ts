/**
 * Topology metadata route.
 *
 * GET /api/swarm/topology — list of all available topologies, each with name,
 *                          description, ASCII diagram, options schema and
 *                          a runnable sample config.
 *
 * The frontend "Topologien testen"-Tab consumes this to render per-topology
 * cards without hard-coding any topology-specific UI logic.
 */
import { Router } from 'express';
import { TOPOLOGY_METADATA } from '../services/swarm-topology/metadata.js';

export const swarmTopologyRouter = Router();

swarmTopologyRouter.get('/topology', (_req, res) => {
  res.json({ topologies: Object.values(TOPOLOGY_METADATA) });
});

swarmTopologyRouter.get('/topology/:topology', (req, res) => {
  const meta = TOPOLOGY_METADATA[req.params.topology as keyof typeof TOPOLOGY_METADATA];
  if (!meta) { res.status(404).json({ error: 'Unknown topology' }); return; }
  res.json(meta);
});
