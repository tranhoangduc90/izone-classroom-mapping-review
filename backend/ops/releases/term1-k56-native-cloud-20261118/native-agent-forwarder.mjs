import { createServer } from 'node:http';
import { createAgentForwarder } from './forwarder-core.mjs';

const productId='term-mini-k56-term1-cbt-cloud';
const endpoint='https://izone-journal-prod-261116-k56-ingress.tranhoangduc90.workers.dev/producer-spool/'+productId;
const forward=createAgentForwarder({productId,endpoint,onTransfer:row=>console.log(JSON.stringify({type:'term1_k56_native_forward',...row}))});
const server=createServer({requestTimeout:15000,headersTimeout:5000},forward);
server.maxConnections=8;
server.listen(13989,'127.0.0.1');
