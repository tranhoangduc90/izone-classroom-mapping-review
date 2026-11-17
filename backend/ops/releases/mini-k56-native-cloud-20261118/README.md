# Mini K56 CBT native journal overlay

This folder contains the runtime overlay and isolated tests. Running the recipe alone does not enable a production route or provision cloud resources; deployment state and canary proofs are recorded separately in the private GOAL Test plan.

`stage.py <captured-journal-directory> <new-output-directory>` adds a Mini CBT router to the captured serving journal. It pins the outer adapter and receipt helper hashes, retains both Term routers and emits a hash manifest. The four modules here are the reviewed generated Mini modules; compare staged bytes before releasing. Keep the complete captured baseline and rollback configuration privately.

Mini receipts are read from committed Mini operation/run rows with the authenticated source session, generation, definition, class and student. Continuing from profile B into official attempt A retains B's receipt and journey. Only CBT is admitted. Mini Writing uses Task 2; job metadata for another Task is rejected. The technical projection excludes answers and preserves audio-report status/incident metadata. Content continues through the existing Collector path.

Run the two policy tests against `MINI_NATIVE_JOURNAL_ROOT`, the isolated staged journal directory:

```text
node --max-old-space-size=96 --test backend/ops/releases/mini-k56-native-cloud-20261118/native-event-policy.test.mjs
```

The loaded-adapter test also needs the existing Mini business native fixture, synthetic runtime/dependencies and SQL migration. Set `TERM2_RUNTIME_ROOT` to the isolated Mini business runtime, `TERM2_DEPS_PACKAGE` to its package.json, `MINI_NATIVE_FIXTURE` and `MINI_NATIVE_MIGRATION` to the sibling Mini business release's native-fixture.mjs and parallel-attempts.sql. Set `K56_REAL_ROSTER_FIXTURE=1`, `K56_MINI_CBT_PARALLEL_ENTRY_MODE=on`, `MINI_K56_CBT_OFFLINE_NEW=true`, and `TERM2_FIXTURE_IMPORT_ONLY=1`.

```text
node --max-old-space-size=128 --test backend/ops/releases/mini-k56-native-cloud-20261118/native-loaded-adapter.test.mjs
```

This finite test uses synthetic roster/content and HTTP/PGlite, then feeds the actual native callbacks into the loaded journal adapter. It checks three seals, one Task 2 run/job, source-profile receipt binding, job/report metadata, SQL/content preservation during spool failure, Collector rollback and wrong-variant denial. Optional `MINI_K56_CBT_WORKER_FIXTURE` writes a new synthetic Worker input file (must not exist); it contains no real student data. Signed loopback spool responses do not prove Agent persistence or Google/R2/GCS delivery. Production canary/readback, browser sources, content migration, backlog and representative operating evidence remain separate.

Runtime settings: `K56_MINI_CBT_NATIVE_ROUTE_FILE`, `K56_MINI_CBT_NATIVE_SPOOL_KEY_FILE`, `K56_MINI_CBT_NATIVE_SPOOL_ENDPOINT`. Transport is `term-mini-k56-mini-cbt-cloud`; retain the committed receipt store when disabling the log route. Never roll the business API back to code that cannot handle already issued parallel Mini scopes.
