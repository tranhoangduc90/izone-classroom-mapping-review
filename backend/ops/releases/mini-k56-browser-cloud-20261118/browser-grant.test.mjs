import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mountMiniK56BrowserCloud, pilotId } from './mount.mjs';

const runtime = pathToFileURL(process.env.MINI_NATIVE_JOURNAL_ROOT + '/');
const provider = pathToFileURL(process.env.MINI_BROWSER_WORKER_ROOT + '/');
const { canonical, JournalError } = await import(new URL('src/contract.mjs', runtime));
const { termOwnerResolver } = await import(new URL('adapters/term.mjs', runtime));
const { createProductJournal, mountExpressJournal } = await import(new URL('src/product.mjs', runtime));
const { JournalStore } = await import(new URL('src/store.mjs', runtime));
const { createK67PilotTicket } = await import(new URL('k67-pilot-ticket.mjs', provider));
const { createK67PilotIngress } = await import(new URL('k67-pilot-http.mjs', provider));
const { verifyK67Archive } = await import(new URL('mini-k56-cbt-admission.mjs', provider));
const { fixture } = await import(new URL('../mini-k56-cbt-parallel-entry-20261118/native-fixture.mjs', import.meta.url));
const express = createRequire(process.env.TERM2_DEPS_PACKAGE)('express');
const origin = 'https://mini-fixture.invalid';
const slug = 'mini-test-k56';
const product = 'term-mini-k56';
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');

test('Mini owner grant reaches Worker admission and archive, with bounded renewal after drain', async () => {
  assert.equal(process.env.K56_REAL_ROSTER_FIXTURE, '1');
  assert.equal(process.env.TERM2_FIXTURE_IMPORT_ONLY, '1');
  assert.equal(process.env.TERM2_TEST_PG_URL, undefined);
  const f = await fixture('read_first', { skipPrepare: true, realtime: true, listeningInterruption: true });
  const temp = await mkdtemp(join(tmpdir(), 'mini-browser-grant-'));
  const policyFile = join(temp, 'route.json');
  let server, journal, browser;
  try {
    await f.db.exec('DELETE FROM assessment.term_test_attempt; DELETE FROM assessment.term_test_exam_session; CREATE ROLE k56_shared_api');
    const migration = await readFile(new URL('../mini-k56-cbt-parallel-entry-20261118/parallel-attempts.sql', import.meta.url), 'utf8');
    await f.db.exec(migration);
    await f.db.exec((await readFile(new URL('./enrollment.sql', import.meta.url), 'utf8')).replaceAll('assessment_k56.', 'assessment.'));
    const start = Date.now();
    const policy = { enabled: true, opensAt: start - 60_000, closesAt: start + 60_000, renewUntil: start + 120_000 };
    await writeFile(policyFile, JSON.stringify(policy));
    const who = { classCode: 'FIXTURE', studentRef: f.student, attemptMode: 'cbt', miniCbtContinuationVersion: 1 };
    const a = await f.request('/attempt/prepare', { ...who, mode: 'read_first' });
    const b = await f.request('/attempt/prepare', { ...who, mode: 'lis_first' });
    assert.equal(a.status, 200, JSON.stringify(a));
    assert.equal(b.status, 200, JSON.stringify(b));
    assert.notEqual(a.examSessionToken, b.examSessionToken);
    const query = (sql, ...args) => f.db.query(sql.replaceAll('assessment_k56.', 'assessment.'), ...args);
    const resolveOwner = termOwnerResolver({ query, schema: 'assessment_k56' });
    let now = Date.now();
    const clock = () => now;
    const tickets = createK67PilotTicket({ keys: { pilot: Buffer.alloc(32, 19) }, currentKeyId: 'pilot', pilotId, clock });
    const app = express();
    app.use(express.json());
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const loopback = `http://127.0.0.1:${server.address().port}`;
    const allowedOrigins = new Set([origin, loopback]);
    const encryptionKeys = { fixture: Buffer.alloc(32, 21) };
    journal = createProductJournal({ productId: product, resolveOwner, allowedOrigins, build: 'mini-browser-fixture',
      fixtureMode: true, clock, fixtureConfig: { version: 1, dataRoot: join(temp, 'collector'),
        identityKey: Buffer.alloc(32, 20), currentEncryptionKeyId: 'fixture', encryptionKeys,
        currentTicketKeyId: 'fixture', ticketKeys: { fixture: Buffer.alloc(32, 22) },
        products: { [product]: { maxPhysicalBytes: 20_000_000 } } } });
    await journal.ready;
    assert.equal(journal.status().ready, true);
    mountExpressJournal(app, { journal });
    mountMiniK56BrowserCloud(app, { query, resolveOwner, journal, tickets, canonical, JournalError,
      policyFile, clock, allowedOrigins });
    const grantUrl = `${loopback}/api/term-tests/${slug}/journal-pilot-context`;
    const grant = async (proof, from = origin) => {
      const response = await fetch(grantUrl, { method: 'POST', headers: { origin: from, 'content-type': 'application/json' },
        body: JSON.stringify(proof) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await grant({}, 'https://other.invalid')).status, 403);
    assert.equal((await grant({})).status, 401);
    assert.equal((await grant({ examSessionToken: a.examSessionToken, attemptToken: b.attemptToken })).status, 401);
    const proof = { examSessionToken: a.examSessionToken, attemptToken: a.attemptToken };
    const [first, concurrent] = await Promise.all([grant(proof), grant(proof)]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.destination, 'pubsub-v1');
    assert.equal(concurrent.body.bindingId, first.body.bindingId);
    assert.equal((await query('SELECT count(*)::int AS n FROM assessment_k56.journal_mini_cbt_cloud_enrollment')).rows[0].n, 1);
    const paperSession = randomUUID();
    await query(`INSERT INTO assessment_k56.term_test_exam_session
      (id, test_slug, attempt_mode, class_name_snapshot) VALUES ($1,$2,'paper','FIXTURE')`, [paperSession, slug]);
    assert.equal((await grant({ examSessionToken: paperSession })).body.destination, 'collector-v1');

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const topic = 'projects/isolation/topics/k56-mini';
    const subscription = 'projects/isolation/subscriptions/k56-mini-gcs';
    const publishes = [];
    const ingress = createK67PilotIngress({ origin, clock, admission: { product, testSlug: slug,
      classCode: 'FIXTURE', topic, privateKey, keyId: 'fixture', verifyPilotTicket: tickets.verify },
      consumeScopeQuota: async () => true, publish: async (bytes, attributes) => {
        const messageId = String(publishes.length + 1);
        publishes.push({ bytes, attributes, messageId, at: now });
        return messageId;
      } });
    const bindingId = first.body.bindingId;
    const event = { id: randomUUID(), pageVisitId: randomUUID(), sequence: 1, schemaVersion: 1,
      eventVersion: 1, type: 'audio_observed', source: 'client', occurredAt: new Date(now).toISOString(),
      elapsedMs: 0, build: 'mini-browser-fixture', data: { action: 'mini_k56_start_observation' } };
    const packet = (events, auth) => ({ schemaVersion: 1, bindingId, batchId: sha([bindingId, events.map(x => x.id).sort()]),
      eventPayloadSha256: sha(events), events, auth: { ticket: auth.ticket, ticketId: auth.ticketId } });
    const send = body => ingress(new Request('https://mini-worker.invalid/k67/pilot/journal-events', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const batch = packet([event], first.body);
    const privateEvent = { ...event, type: 'content_checkpoint', data: { answers: { 1: 'fixture only' } } };
    assert.equal((await send(packet([privateEvent], first.body))).status, 400);
    const ack = await send(batch);
    assert.equal(ack.status, 202, await ack.clone().text());
    const accepted = await ack.json();
    assert.deepEqual(accepted.acknowledgedIds, [event.id]);
    const published = publishes[0];
    const stored = verifyK67Archive(published.bytes, { subscription, messageId: published.messageId,
      publishTimeMs: published.at, attributeBatchId: published.attributes.batchId },
    { publicKeys: { fixture: publicKey }, topic, subscription, classCode: 'FIXTURE', product, testSlug: slug });
    assert.equal(stored.archive.scopeId, bindingId);
    assert.equal(stored.contentSha256, accepted.contentSha256);
    assert.equal(stored.archive.events[0].id, event.id);

    await writeFile(policyFile, JSON.stringify({ ...policy, enabled: false }));
    now = policy.closesAt + 1;
    assert.equal((await grant(proof)).body.destination, 'collector-v1');
    assert.equal((await send(batch)).status, 401);
    const sealed = { destination: 'pubsub-v1', pilotId, scopeId: bindingId,
      batchId: batch.batchId, eventPayloadSha256: batch.eventPayloadSha256 };
    assert.equal((await grant({ examSessionToken: b.examSessionToken, sealed })).status, 403);
    const renewed = await grant({ ...proof, sealed });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.expiresAt, policy.renewUntil);
    assert.equal((await send(packet([{ ...event, data: { action: 'different' } }], renewed.body))).status, 403);
    assert.equal((await send(packet([event], renewed.body))).status, 202);
    assert.equal(publishes.length, 2);

    if (process.env.MINI_BROWSER_PAGES_JOURNAL && process.env.MINI_BROWSER_PLAYWRIGHT_PACKAGE) {
      // Run real browser IndexedDB against the same owner API and isolated Worker.
      now = start + 5000;
      await writeFile(policyFile, JSON.stringify(policy));
      const localIngress = createK67PilotIngress({ origin: loopback, clock,
        admission: { product, testSlug: slug, classCode: 'FIXTURE', topic, privateKey, keyId: 'fixture', verifyPilotTicket: tickets.verify },
        consumeScopeQuota: async () => true, publish: async (bytes, attributes) => {
          const messageId = String(publishes.length + 1);
          publishes.push({ bytes, attributes, messageId, at: now });
          return messageId;
        } });
      let loseAck = true;
      app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><title>Mini journal fixture</title>'));
      app.use('/fixture-journal', express.static(process.env.MINI_BROWSER_PAGES_JOURNAL));
      app.post('/k67/pilot/journal-events', async (req, res) => {
        const reply = await localIngress(new Request(loopback + req.originalUrl, { method: 'POST',
          headers: { origin: req.get('origin'), 'content-type': 'application/json' }, body: JSON.stringify(req.body) }));
        if (reply.status === 202 && loseAck) {
          loseAck = false;
          return res.sendStatus(503);
        }
        res.status(reply.status).type('json').send(await reply.text());
      });
      const pw = createRequire(process.env.MINI_BROWSER_PLAYWRIGHT_PACKAGE)('playwright');
      browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === loopback ? route.continue() : route.abort());
      await page.goto(loopback + '/fixture');
      // IndexedDB's binding index breaks ties by event key, not by insertion time.
      const clientEvent = { ...event, id: '11111111-1111-4111-8111-111111111111', sequence: 2 };
      const contentEvent = { ...privateEvent, id: '22222222-2222-4222-8222-222222222222', sequence: 3,
        occurredAt: new Date(Date.parse(clientEvent.occurredAt) + 1).toISOString(),
        data: { fieldId: 'writing:task2', text: 'Synthetic response', revision: 0 } };
      const fill = async (save) => page.evaluate(async ({ proof, slug, clientEvent, contentEvent, save }) => {
        const { IndexedOutbox } = await import('/fixture-journal/outbox.mjs');
        const { createK67PilotFlush } = await import('/fixture-journal/transport-mini-browser-cloud-v1.mjs');
        const target = new URL('/api/term-tests/' + slug, location.origin);
        const response = await fetch(target.href + '/journal-context', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
        if (!response.ok) throw Error('Fixture Collector context ' + response.status);
        const context = await response.json();
        const auth = Object.fromEntries(['ticket', 'ticketId', 'issuedAt', 'expiresAt'].map(key => [key, context[key]]));
        const current = { bindingId: context.bindingId, auth };
        const outbox = new IndexedOutbox({ name: 'mini-k56-synthetic-journal' });
        try {
          await outbox.ready;
          if (save) {
            await outbox.put(current.bindingId, clientEvent, auth);
            await outbox.put(current.bindingId, contentEvent, auth);
          }
          const flush = createK67PilotFlush({ target, ingress: new URL('/k67/pilot/journal-events', location.origin).href,
            fetcher: fetch, outbox, recorder: { idle: async () => {} }, getCurrent: () => current, getProof: () => proof, onHealth() {} });
          const result = await flush({ force: true });
          return { result, remaining: (await outbox.list(current.bindingId, { maxCount: 10 })).map(item => item.id) };
        } finally { await outbox.close(); }
      }, { proof, slug, clientEvent, contentEvent, save });
      const lost = await fill(true);
      assert.equal(lost.result.status, 'degraded');
      assert.deepEqual(lost.remaining, [clientEvent.id, contentEvent.id]);
      await page.reload();
      await writeFile(policyFile, JSON.stringify({ ...policy, enabled: false }));
      const replay = await fill(false);
      assert.equal(replay.result.acknowledgedCount, 1, JSON.stringify(replay));
      assert.deepEqual(replay.remaining, [contentEvent.id]);
      const content = await fill(false);
      assert.equal(content.result.acknowledgedCount, 1, JSON.stringify(content));
      assert.deepEqual(content.remaining, []);
      assert.equal(publishes.length, 4);
      assert.deepEqual(publishes[2].bytes, publishes[3].bytes);
      const recovered = JSON.parse(publishes[3].bytes);
      assert.equal(recovered.archive.events[0].id, clientEvent.id);
      assert.equal(recovered.archive.events.length, 1);
      const scope = journal.scopeForOwner(await resolveOwner(proof, { testSlug: slug }));
      await journal.close();
      journal = undefined;
      const directory = join(temp, 'collector', product);
      const store = new JournalStore({ file: join(directory, 'journal.sqlite'), keys: encryptionKeys, currentKeyId: 'fixture',
        allowedProduct: product, archiveDir: join(directory, 'archive'), archiveBackupDir: join(directory, 'archive-mirror'),
        maxPhysicalBytes: 20_000_000, minFreeBytes: 0 });
      try {
        const rows = store.read(scope);
        assert.deepEqual(rows.map(row => row.id), [contentEvent.id]);
        assert.deepEqual(rows[0].data, contentEvent.data);
      } finally { store.close(); }
      console.log('Real IndexedDB: lost ACK, reload, exact cloud retry while drained, and content readback from the encrypted Collector.');
    }
    await query('UPDATE assessment_k56.term_test_exam_session SET superseded_at=now() WHERE id=$1', [a.examSessionToken]);
    assert.equal((await grant({ ...proof, sealed })).status, 403);
  } finally {
    await browser?.close();
    await journal?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await f.close();
    const target = await realpath(temp);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.match(basename(target), /^mini-browser-grant-[a-zA-Z0-9]+$/);
    await rm(target, { recursive: true });
  }
});
