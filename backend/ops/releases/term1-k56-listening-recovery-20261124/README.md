# Term Test 1 K56 Listening recovery

The offline CBT and journal DEMO profiles run `term1-skill-offline-core.mjs`. This overlay adds a Term 1 clock endpoint and tables tied to `term1_offline_run`. The offline permit binds the attempt, session, learner and generation. A Listening skill delegated to a fallback is excluded from the main endpoint.

The browser sends a confirmed pause and a verified 1× resume through `/offline/listening-clock`. Ordinary progress stays on the device. The existing operation endpoint continues to carry drafts, answers and Listening reports. Each transition has a stable operation ID and a server revision. Replaying an identical operation returns the original receipt without writing a second transition. The scoped journal also records accepted and replayed receipts.

## Prepare and verify

Capture the serving core and journal adapter separately for the main profile and DEMO. Generate each overlay into its own staging directory and review the diff against its matching preimage.

```text
node integrate-term1-clock.mjs CAPTURE/term1-skill-offline-core.mjs STAGE/src/term1-skill-offline-core.mjs CAPTURE/term.mjs STAGE/src/exam-journal-runtime/adapters/term.mjs
```

The integration writes `term1-listening-clock.mjs` alongside the staged core. Generate additive SQL with `node print-listening-clock-migration.mjs k56-ic2264` for the CBT pool and `node print-listening-clock-migration.mjs k56-demo` for DEMO. Verify the target database, schema and runtime role before applying SQL as a migration owner. The generator prints SQL without connecting to a database.

Run the shared `listening-clock-rollout.test.mjs` with `TERM1_NATIVE_RECOVERY_FIXTURE` against each captured HTTP application with a synthetic roster and isolated SQL. Run the Pages native browser test with that fixture for both exam orders. It checks offline reload, reconnect, lost responses, draft readback, and receipt count.

## Release and rollback

The flag defaults to off. Stage the additive SQL and backend with the flag off. Review the candidate Pages entrypoints and keep the previously pinned assets. `TERM1_LISTENING_RECOVERY_V1=true` enrolls newly prepared offline CBT attempts of this slug. Existing prepared attempts keep their original capability. Check DEMO separately before enabling the main profile.

Before the first enrollment, a frontend rollback can restore both entrypoint HTML files to their baseline. After enrollment starts, disable the flag and verify a fresh attempt has no capability. Keep the endpoint, tables, compatible entrypoints, and pinned resources available while enrolled attempts can still reopen or deliver pending operations. Preserve existing drafts and receipts.
