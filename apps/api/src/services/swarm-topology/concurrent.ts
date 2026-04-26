/**
 * Concurrent topology — every coordinator runs in parallel, no aggregator.
 *
 * This is the original werkbank behavior, preserved verbatim so existing saved
 * configs (which default to topology="concurrent") run unchanged after the
 * dispatcher was introduced.
 */
import type { SwarmConfig } from '../../swarm-schemas.js';
import { spawnCoordinator, type RunContext } from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

export const concurrentHandler: TopologyHandler = {
  topology: 'concurrent',

  validate(_config: SwarmConfig): TopologyValidation {
    return { valid: true, errors: [] };
  },

  async run(ctx: RunContext): Promise<void> {
    await Promise.allSettled(
      ctx.config.coordinators.map(c => spawnCoordinator(c, ctx)),
    );
  },
};
