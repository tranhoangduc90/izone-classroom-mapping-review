import { createHash } from 'node:crypto';
import { canonical, requireValue } from '../../src/contract.mjs';
import { ProducerSpoolClient } from '../../src/producer-client.mjs';

export const miniK56CbtCloudTransport = 'term-mini-k56-mini-cbt-cloud';

export function createMiniK56CbtCloudSpool(options) {
  const spool = new ProducerSpoolClient({ ...options, productId: miniK56CbtCloudTransport });
  return {
    async append(scope, events) {
      requireValue(scope.product === 'term-mini-k56' && scope.testSlug === 'mini-test-k56',
        'PILOT_NATIVE_SCOPE_DENIED', 403);
      const queued = await spool.append({ ...scope, product: miniK56CbtCloudTransport }, events);
      return { ...queued, scopeId: createHash('sha256').update(canonical(scope)).digest('hex') };
    },
    close: () => spool.close(),
    metrics: () => spool.metrics(),
  };
}
