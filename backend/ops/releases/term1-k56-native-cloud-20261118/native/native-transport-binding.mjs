import { createHash } from 'node:crypto';
import { canonical, requireValue } from '../../src/contract.mjs';
import { ProducerSpoolClient } from '../../src/producer-client.mjs';

export const term1K56CloudTransport = 'term-mini-k56-term1-cbt-cloud';

export function createTerm1K56CloudSpool(options) {
  const spool = new ProducerSpoolClient({ ...options, productId: term1K56CloudTransport });
  return {
    async append(scope, events) {
      requireValue(scope.product === 'term-mini-k56' && scope.testSlug === 'term-test-1-k56',
        'PILOT_NATIVE_SCOPE_DENIED', 403);
      const queued = await spool.append({ ...scope, product: term1K56CloudTransport }, events);
      return { ...queued, scopeId: createHash('sha256').update(canonical(scope)).digest('hex') };
    },
    close: () => spool.close(),
    metrics: () => spool.metrics(),
  };
}
