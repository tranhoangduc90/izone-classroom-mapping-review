# Term Test 2 K56 Listening recovery

The offline CBT clock accepts two events, `paused` and `running` after the device verifies resumption at 1×. During uninterrupted playback the browser keeps periodic checkpoints locally. Drafts and the final Listening submission continue through the existing offline operation endpoint.

Each event belongs to the offline permit's attempt, session, owner and generation. A UUID identifies the delivery and a revision orders accepted transitions. The same UUID and payload replay the original receipt. A changed payload using the same UUID is rejected. A paired pause/resume shares one interruption ID. Each receipt includes the observed position, remaining time, player ID and disposition. A replay has its own journal action and leaves the database revision unchanged.

## Build and test

Copy `k56-offline-core.mjs` and `exam-journal-runtime/adapters/term.mjs` from each serving K56 profile into a private staging directory. Use separate input and output paths for the overlays. Verify the preimage and candidate diffs for each profile.

```text
node integrate-k56-clock.mjs CAPTURE/k56-offline-core.mjs STAGE/src/k56-offline-core.mjs CAPTURE/term.mjs STAGE/src/exam-journal-runtime/adapters/term.mjs
```

The integration writes `term2-listening-clock.mjs` next to the candidate core. Generate the additive SQL with `node print-listening-clock-migration.mjs k56-ic2264` or `node print-listening-clock-migration.mjs k56-demo`. The regular CBT pool rewrites logical `assessment` names to `assessment_k56`. The isolated DEMO uses `assessment`. The generated migration selects the profile's schema and grants its runtime the privileges needed to upsert the clock and append receipts. Run the SQL as the schema owner or equivalent migration role after verifying the target database and the runtime role. The command only prints SQL.

Test the HTTP app in isolation with the migration, then run the Pages `term2-k56-listening-clock-native-browser.test.mjs` against its local fixture for each profile. The fixture must populate a synthetic class and learner and expose the original HTTP application and isolated SQL readback. The browser test loses the response for both transitions after the database accepts them.

## Release and rollback

The default is disabled. With `TERM2_LISTENING_RECOVERY_V1=true`, a Term 2 CBT attempt receives `listeningRecoveryVersion: 1` when the server creates its offline run. Previously prepared runs keep their original capability, including those in the waiting room or Reading. Paper routes keep their original path. Apply the additive database migration and stage the backend before switching the Pages entrypoints. Enabling the flag is a separate cutover step after pilot acceptance.

To stop enrollment, turn off `TERM2_LISTENING_RECOVERY_V1` and verify that a fresh attempt has no capability. Retain the endpoint, tables and pinned frontend assets for attempts already enrolled. Keep the existing receipt and draft data. Restore the baseline entrypoints if the frontend requires rollback.

The `listening-clock-rollout.test.mjs` HTTP check exercises this transition using each profile’s isolated `TERM2_NATIVE_RECOVERY_FIXTURE`. It covers prepared and active Listening attempts, enrollment at creation, and continued delivery of clock events and receipts after closing enrollment.
