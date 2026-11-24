# Term Test 2 K56 Listening recovery

The offline CBT clock accepts two events, `paused` and `running` after the device verifies resumption at 1×. During uninterrupted playback the browser keeps periodic checkpoints locally. Drafts and the final Listening submission continue through the existing offline operation endpoint.

Each event belongs to the offline permit's attempt, session, owner and generation. A UUID identifies the delivery and a revision orders accepted transitions. The same UUID and payload replay the original receipt. A changed payload using the same UUID is rejected. A paired pause/resume shares one interruption ID. Each receipt includes the observed position, remaining time, player ID and disposition. A replay has its own journal action and leaves the database revision unchanged.

## Build and test

Copy `k56-offline-core.mjs` and `exam-journal-runtime/adapters/term.mjs` from each serving K56 profile into a private staging directory. Use separate input and output paths for the overlays. Verify the preimage and candidate diffs for each profile.

```text
node integrate-k56-clock.mjs CAPTURE/k56-offline-core.mjs STAGE/src/k56-offline-core.mjs CAPTURE/term.mjs STAGE/src/exam-journal-runtime/adapters/term.mjs
```

The integration writes `term2-listening-clock.mjs` next to the candidate core. `clockSchema` is the additive database migration for both tables. Test the HTTP app in isolation with the migration, then run the Pages `term2-k56-listening-clock-native-browser.test.mjs` against its local fixture for each profile. The fixture must populate a synthetic class and learner and expose the original HTTP application and isolated SQL readback. The browser test loses the response for both transitions after the database accepts them.

## Release and rollback

The default is disabled. With `TERM2_LISTENING_RECOVERY_V1=true`, fresh CBT offline attempts receive `listeningRecoveryVersion: 1`. Existing Listening attempts and paper routes keep their original path. Apply the additive database migration and stage the backend before switching the Pages entrypoints. Enabling the flag is a separate cutover step after pilot acceptance.

To stop enrollment, turn off `TERM2_LISTENING_RECOVERY_V1` and verify that a fresh attempt has no capability. Retain the endpoint, tables and pinned frontend assets for attempts already enrolled. Keep the existing receipt and draft data. Restore the baseline entrypoints if the frontend requires rollback.
