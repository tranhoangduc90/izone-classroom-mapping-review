# Mini K56 Listening recovery

Mini K56 CBT uses `mini-k56-recovery-core.mjs` in the main profile and the shared `k56-offline-core.mjs` in DEMO. The release overlay adds a Mini endpoint backed by its own clock and receipt tables. It uses the current attempt's existing offline permit, owner and generation. The answer-sheet mode keeps its existing draft, submission and receipt paths.

The clock records confirmed interruptions and resumption verified at 1×. Normal playback stays local. An identical operation returns its original receipt when retried. Drafts and the confirmed Listening report still use the existing operation endpoint.

## Prepare and verify

Capture the serving core and Term journal adapter separately for each profile. Use separate staging paths and verify the capture and resulting file hashes.

```text
node integrate-mini-clock.mjs CAPTURE/CORE STAGE/src/CORE CAPTURE/term.mjs STAGE/src/exam-journal-runtime/adapters/term.mjs
```

Replace `CORE` with the serving filename for that profile. The overlay writes `mini-k56-listening-clock.mjs` alongside it. Generate the additive SQL with `node print-listening-clock-migration.mjs k56-ic2264` or `node print-listening-clock-migration.mjs k56-demo`. The schema and grants differ by profile.

Run `listening-clock-rollout.test.mjs` and the Pages native browser test using each app's `MINI_NATIVE_RECOVERY_FIXTURE`. These tests use synthetic identities and isolated SQL. Verify past and new CBT runs, both exam orders, stable receipts across transport loss, preserved drafts, and the refusal to accept an answer-sheet clock update.

## Release and rollback

Keep `MINI_K56_LISTENING_RECOVERY_V1` off while staging the migration, API and pinned frontend. Open DEMO first and read the browser journal and SQL receipts for both exam orders before opening the main profile. Preserve the existing Term 1 and Term 2 settings and routes.

Turn the flag off to stop enrollment. Keep the new API, tables and compatible frontend entrypoint available for attempts that already received the capability. Retain previous immutable assets for sessions still using their original pinned shell.
