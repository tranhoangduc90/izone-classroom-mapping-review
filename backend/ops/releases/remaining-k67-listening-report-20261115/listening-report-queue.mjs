import {randomUUID} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function reportTable(key) {
  if (!['term1', 'mini', 'pretest'].includes(key)) throw Error('LISTENING_REPORT_PROFILE_UNKNOWN');
  return 'assessment.k67_'+key+'_listening_report';
}

export const k67ListeningReportSchema = key => {
  const table = reportTable(key);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  incident_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  operation_id uuid NOT NULL,
  caption text,
  png bytea,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','sending','waiting_photo','sent','delivery_unknown','failed','expired')),
  ready_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  text_message_id text,
  photo_message_id text,
  UNIQUE (attempt_id,generation,operation_id)
);
CREATE INDEX IF NOT EXISTS k67_${key}_report_open ON ${table} (ready_at,created_at) WHERE state='open';
`;
};

const isId = value => typeof value === 'string' && uuid.test(value);
const validReceipt = receipt => receipt?.acceptedByProvider === true
  && typeof receipt.messageId === 'string' && /^[1-9]\d{0,15}$/.test(receipt.messageId);
const normalizedScope = scope => {
  if (!isId(scope?.attemptId) || !Number.isSafeInteger(scope?.generation) || scope.generation < 0) {
    throw new TypeError('LISTENING_REPORT_SCOPE_INVALID');
  }
  return [scope.attemptId, scope.generation];
};
function checkPng(bytes) {
  if (bytes == null) return null;
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 768 * 1024
      || !bytes.subarray(0, 8).equals(pngMagic) || bytes.readUInt32BE(8) !== 13
      || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new TypeError('LISTENING_REPORT_IMAGE_INVALID');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if (width < 1 || width > 1600 || height < 1 || height > 1600) {
    throw new TypeError('LISTENING_REPORT_IMAGE_INVALID');
  }
  return bytes;
}

/**
 * The API supplies scope/operation and caption after native owner verification.
 * Only the image is client evidence. No answer payload, session token, or target enters the queue.
 */
export function createK67ListeningReportQueue({key, query, sendText, sendPhoto}) {
  const table = reportTable(key);
  async function enqueue({scope, operationId, caption, png}) {
    const [attemptId, generation] = normalizedScope(scope);
    if (!isId(operationId) || typeof caption !== 'string' || !caption.trim() || [...caption].length > 950) {
      throw new TypeError('LISTENING_REPORT_INVALID');
    }
    const photo = checkPng(png);
    const {rows:[row]} = await query(`
      INSERT INTO ${table} AS r (incident_id,attempt_id,generation,operation_id,caption,png,ready_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()+CASE WHEN $6::bytea IS NULL THEN interval '4 seconds' ELSE interval '0 seconds' END)
      ON CONFLICT (attempt_id,generation,operation_id) DO UPDATE SET operation_id=r.operation_id
      RETURNING incident_id,state,(png IS NOT NULL OR photo_message_id IS NOT NULL) AS has_photo`,
      [randomUUID(),attemptId,generation,operationId,caption,photo]);
    const result={incidentId:row.incident_id,status:row.state,hasPhoto:row.has_photo};
    if(photo&&!row.has_photo&&await attachPhoto({scope,operationId,incidentId:row.incident_id,png:photo})){
      return {...result,status:'photo_queued',hasPhoto:true};
    }
    return result;
  }

  async function attachPhoto({scope, incidentId, operationId, png}) {
    const [attemptId, generation] = normalizedScope(scope);
    if (!isId(incidentId) || !isId(operationId) || !png) throw new TypeError('LISTENING_REPORT_IMAGE_INVALID');
    const photo = checkPng(png);
    const {rows} = await query(`
      UPDATE ${table} SET png=$4,ready_at=CASE WHEN attempts=0 THEN now() ELSE ready_at END,
        state=CASE WHEN state='waiting_photo' THEN 'open' ELSE state END
      WHERE incident_id=$1 AND attempt_id=$2 AND generation=$3 AND operation_id=$5
        AND png IS NULL AND photo_message_id IS NULL AND state IN ('open','sending','waiting_photo')
        AND caption IS NOT NULL AND created_at > now()-interval '1 hour' RETURNING incident_id`, [incidentId,attemptId,generation,photo,operationId]);
    if(rows.length===1)return true;
    const {rows:existing}=await query(`SELECT 1 FROM ${table} WHERE incident_id=$1 AND attempt_id=$2
      AND generation=$3 AND operation_id=$4 AND (png=$5 OR photo_message_id IS NOT NULL)`,
      [incidentId,attemptId,generation,operationId,photo]);
    return existing.length===1;
  }

  async function claim() {
    const {rows:[row]} = await query(`
      WITH next AS (
        SELECT incident_id FROM ${table}
        WHERE state='open' AND ready_at<=now() AND created_at>now()-interval '1 hour'
        ORDER BY ready_at,incident_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE ${table} r SET state='sending',claim_id=$1,claimed_at=now(),attempts=r.attempts+1
      FROM next WHERE r.incident_id=next.incident_id RETURNING r.*`, [randomUUID()]);
    return row;
  }

  async function runOne() {
    const row = await claim();
    if (!row) return null;
    const id = row.incident_id;
    const event=status=>({incidentId:id,status,attemptId:row.attempt_id,
      operationId:row.operation_id,generation:Number(row.generation),phase:'delivery'});
    const photo = row.png ? Buffer.from(row.png) : null;
    const claimKey = [id,row.claim_id];
    let receipt;
    try {
      receipt = photo
        ? await sendPhoto({id,caption:row.caption,png:photo,replyToMessageId:row.text_message_id||undefined})
        : await sendText({id,text:row.caption+'\nẢnh vùng thi chưa có.'});
    } catch (error) {
      if (error.providerStatus === 429 && row.attempts < 5 && Number.isFinite(error.retryAtMs)) {
        await query(`UPDATE ${table} SET state='open',ready_at=GREATEST(now()+interval '1 second',$3::timestamptz),
          claim_id=NULL,claimed_at=NULL WHERE incident_id=$1 AND claim_id=$2 AND state='sending'`,
        [...claimKey,new Date(error.retryAtMs).toISOString()]);
        return event('retry_wait');
      }
      const state = error.providerStatus >= 400 && error.providerStatus < 500 ? 'failed' : 'delivery_unknown';
      await finishFailure(claimKey,state);
      return event(state);
    }
    if (!validReceipt(receipt) || (photo && row.text_message_id === receipt.messageId)) {
      await finishFailure(claimKey,'delivery_unknown');
      return event('delivery_unknown');
    }
    const status = photo ? 'sent' : 'text_sent';
    const result = photo
      ? await query(`UPDATE ${table} SET state='sent',photo_message_id=$3,caption=NULL,png=NULL,claim_id=NULL,claimed_at=NULL
        WHERE incident_id=$1 AND claim_id=$2 AND state='sending' RETURNING incident_id`, [...claimKey,receipt.messageId])
      : await query(`UPDATE ${table}
        SET state=CASE WHEN png IS NULL THEN 'waiting_photo' ELSE 'open' END,
          text_message_id=$3,ready_at=now(),attempts=0,claim_id=NULL,claimed_at=NULL
        WHERE incident_id=$1 AND claim_id=$2 AND state='sending' RETURNING incident_id`, [...claimKey,receipt.messageId]);
    return event(result.rows.length === 1 ? status : 'delivery_unknown');
  }

  async function finishFailure(claimKey,state) {
    await query(`UPDATE ${table} SET state=$3,claim_id=NULL,claimed_at=NULL,caption=NULL,png=NULL
      WHERE incident_id=$1 AND claim_id=$2 AND state='sending'`, [...claimKey,state]);
  }

  async function expire() {
    // A crashed sender may have delivered. Reclaim stale work for investigation only.
    await query(`UPDATE ${table} SET state='delivery_unknown',claim_id=NULL,claimed_at=NULL,caption=NULL,png=NULL
      WHERE state='sending' AND claimed_at<now()-interval '2 minutes'`);
    await query(`UPDATE ${table} SET state='expired',caption=NULL,png=NULL
      WHERE state IN ('open','waiting_photo') AND created_at<=now()-interval '1 hour'`);
  }

  return {enqueue,attachPhoto,runOne,expire};
}
