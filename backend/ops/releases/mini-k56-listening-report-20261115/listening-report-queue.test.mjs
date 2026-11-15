import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createMiniListeningReportQueue,miniListeningReportSchema} from './listening-report-queue.mjs';

const require=createRequire(process.env.SUBMIT_DEPS_PACKAGE||new URL('../../../../products/term-mini-k67/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=','base64');
const table='assessment.mini_k56_listening_report';
const success=messageId=>({acceptedByProvider:true,messageId});

test('Mini K56: durable report, late photo, owner binding, lost ACK and safe retries',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec('CREATE SCHEMA assessment;'+miniListeningReportSchema);
  const query=db.query.bind(db);
  const scope={attemptId:randomUUID(),generation:3};
  const signals=[];
  let outcome='confirmed';
  const queue=createMiniListeningReportQueue({query,
    async sendText(value){signals.push({kind:'text',...value});return success('31');},
    async sendPhoto(value){
      assert.deepEqual(value.png,png);
      signals.push({kind:'photo',id:value.id,caption:value.caption,replyToMessageId:value.replyToMessageId});
      if(outcome==='timeout')throw Object.assign(new Error('ALERT_TELEGRAM_DELIVERY_UNKNOWN'),{});
      if(outcome==='429')throw Object.assign(new Error('quota'),{providerStatus:429,retryAtMs:Date.now()+45000});
      return success('32');
    },
  });
  const base=()=>({scope,operationId:randomUUID(),caption:'Lớp DEMO · Học viên giả'});
  const row=id=>query('SELECT * FROM '+table+' WHERE incident_id=$1',[id]).then(result=>result.rows[0]);
  const due=id=>query("UPDATE "+table+" SET ready_at=now()-interval '1 second' WHERE incident_id=$1",[id]);

  await t.test('lặp operation dùng một incident, đã giao ảnh thì dọn dữ liệu',async()=>{
    const input={...base(),png};
    const created=await queue.enqueue(input);
    assert.deepEqual(await queue.enqueue({...input,caption:'giá trị lần lặp'}),created);
    const results=await Promise.all([queue.runOne(),queue.runOne()]);
    assert.deepEqual(results.filter(Boolean),[{incidentId:created.incidentId,status:'sent',
      attemptId:scope.attemptId,generation:scope.generation,operationId:input.operationId,phase:'delivery'}]);
    const stored=await row(created.incidentId);
    assert.equal(stored.state,'sent');
    assert.equal(stored.photo_message_id,'32');
    assert.equal(stored.caption,null);
    assert.equal(stored.png,null);
    assert.equal(signals.filter(signal=>signal.id===created.incidentId).length,1);
  });

  await t.test('chờ ảnh 4 giây, gửi chữ trước, ảnh chỉ vào đúng tin và đúng owner',async()=>{
    const input=base();
    const created=await queue.enqueue(input);
    assert.equal(await queue.runOne(),null);
    await due(created.incidentId);
    assert.equal((await queue.runOne()).status,'text_sent');
    assert.equal((await row(created.incidentId)).state,'waiting_photo');
    const photo={scope,incidentId:created.incidentId,operationId:input.operationId,png};
    assert.equal(await queue.attachPhoto({...photo,scope:{...scope,generation:4}}),false);
    assert.equal(await queue.attachPhoto({...photo,operationId:randomUUID()}),false);
    assert.equal(await queue.attachPhoto(photo),true);
    assert.equal(await queue.attachPhoto(photo),false);
    assert.equal((await queue.runOne()).status,'sent');
    assert.equal(signals.at(-1).replyToMessageId,'31');
    assert.equal((await row(created.incidentId)).caption,null);
  });

  await t.test('429 chờ đến mốc, mất ACK và claim bị bỏ không gửi lại',async()=>{
    outcome='429';
    const retry=await queue.enqueue({...base(),png});
    assert.equal((await queue.runOne()).status,'retry_wait');
    assert.equal(await queue.runOne(),null);
    const delayed=await row(retry.incidentId);
    assert.ok(new Date(delayed.ready_at).getTime()>Date.now()+30000);
    await due(retry.incidentId);
    outcome='timeout';
    assert.equal((await queue.runOne()).status,'delivery_unknown');
    assert.equal(await queue.runOne(),null);
    const stale=await queue.enqueue({...base(),png});
    await query("UPDATE "+table+" SET state='sending',claim_id=$2,claimed_at=now()-interval '3 minutes' WHERE incident_id=$1",
      [stale.incidentId,randomUUID()]);
    await queue.expire();
    assert.equal((await row(stale.incidentId)).state,'delivery_unknown');
    assert.equal((await row(stale.incidentId)).png,null);
    assert.equal(await queue.runOne(),null);
  });
});
