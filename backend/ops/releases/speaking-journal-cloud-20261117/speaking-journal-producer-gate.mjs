import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const path = '/producer/speaking-homework';
const endpoint = 'https://izone-speaking-journal-ingress.tranhoangduc90.workers.dev/producer-spool/speaking-homework';
const requestMax = 720 * 1024;
const replyMax = 256 * 1024;

async function readBytes(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('SPEAKING_FORWARD_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

export function createSpeakingProducerGate({ modeFile,fetcher=fetch,clock=Date.now,
  measure=()=>{} } = {}) {
  if (!modeFile) return async () => false;
  const configured = isAbsolute(modeFile);
  let nextRead = 0;
  let lane = 'hold';
  let pendingMode;
  let active = 0;
  async function mode() {
    if (!configured) return 'hold';
    if (clock()<nextRead) return lane;
    pendingMode ??= (async () => {
      try {
        const value = (await readFile(modeFile,'utf8')).trim();
        lane = ['collector','cloud','hold'].includes(value) ? value : 'hold';
      } catch { lane = 'hold'; }
      finally { nextRead = clock()+5000;pendingMode = null; }
      return lane;
    })();
    return pendingMode;
  }
  return async (request,response) => {
    const {remoteAddress} = request.socket ?? {};
    if (request.url!==path || request.method!=='POST' || request.headers.origin ||
        !['127.0.0.1','::ffff:127.0.0.1'].includes(remoteAddress)) return false;
    const selected = await mode();
    if (selected==='collector') return false;
    if (selected==='hold' || active>=2) { response.writeHead(503).end();return true; }
    if (Number(request.headers['content-length'] ?? 0)>requestMax) { response.writeHead(413).end();return true; }
    active++;
    const started = performance.now();
    try {
      const bytes = await readBytes(request,requestMax);
      const reply = await fetcher(endpoint,{
        method:'POST',headers:{'content-type':'application/json'},body:bytes,cache:'no-store',
        redirect:'error',signal:AbortSignal.timeout(12_000),
      });
      const body = await readBytes(reply.body ?? [],replyMax);
      response.writeHead(reply.status,{'content-type':'application/json','cache-control':'no-store'}).end(body);
      try { measure({ status:reply.status,requestBytes:bytes.length,responseBytes:body.length,
        durationMs:performance.now()-started }); } catch {}
    } catch {
      if (!response.headersSent) response.writeHead(503).end();
    } finally { active--; }
    return true;
  };
}
