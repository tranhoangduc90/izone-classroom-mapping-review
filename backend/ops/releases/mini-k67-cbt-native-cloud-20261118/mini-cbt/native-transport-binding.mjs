import {createHash} from 'node:crypto';
import {canonical, requireValue} from '../../src/contract.mjs';
import {ProducerSpoolClient} from '../../src/producer-client.mjs';
import {miniK67CbtCloudTransport,miniK67JournalProduct,miniK67Slug,checkMiniK67CbtNativeEvent} from './native-event-policy.mjs';

export function createMiniK67CbtCloudSpool(options) {
  const client=new ProducerSpoolClient({...options,productId:miniK67CbtCloudTransport});
  return {
    async append(scope,events) {
      requireValue(scope.product===miniK67JournalProduct && scope.testSlug===miniK67Slug,
        'PILOT_NATIVE_SCOPE_DENIED',403);
      events.forEach(event=>checkMiniK67CbtNativeEvent(event,scope));
      const result=await client.append({...scope,product:miniK67CbtCloudTransport},events);
      return {...result,scopeId:createHash('sha256').update(canonical(scope)).digest('hex')};
    },
    close:()=>client.close(),
    metrics:()=>client.metrics(),
  };
}
