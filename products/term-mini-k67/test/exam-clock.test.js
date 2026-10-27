import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';

test('server clock reads PostgreSQL time without reading or writing exam data',async()=>{
  let calls=0;
  const pool={query(sql){calls++;assert.equal(sql,'SELECT clock_timestamp() AS server_now');return {rows:[{server_now:'2026-10-26T12:00:00Z'}]};},connect(){throw Error('clock must not start a transaction');}};
  const app=createApp({pool,config:{authMode:'legacy',allowedOrigins:new Set(['https://tranhoangduc90.github.io'])}});
  for(const slug of ['term-test-1','term-test-2','mini-test-lesson-5']){
    const response=await request(app).get(`/api/term-tests/${slug}/clock`);
    assert.equal(response.status,200);assert.equal(response.body.ok,true);
    assert.match(response.headers['cache-control'],/no-store/);
    assert.equal(response.body.serverNow,'2026-10-26T12:00:00.000Z');
  }
  assert.equal((await request(app).get('/api/term-tests/unknown/clock')).status,404);
  assert.equal(calls,3);
});
