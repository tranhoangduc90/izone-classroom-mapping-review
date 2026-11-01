import {workDispatchContract} from '../../test-support/work-dispatch-contract.mjs';
import {fixture} from './helpers.js';
import {createDocsWorker} from '../src/docs.js';
import {registerWorkPublisher} from '../src/test-work-runtime.js';
import {readConfig} from '../src/config.js';
import {uuid,secret} from '../src/domain.js';
workDispatchContract({product:'Listening',schema:'listening_practice',fixture,createDocsWorker,registerWorkPublisher,readConfig,uuid,secret});
