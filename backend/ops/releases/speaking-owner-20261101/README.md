# Speaking Docs owner response repair — 2026-11-01

The shared student entry requires `assignment.selectedStudentRef` before allowing a personal Homework link to open. `createIndependentDocuments.open()` returned the single verified student for linked Classroom documents and standalone documents without this field. Return the same verified reference as the student row; retain class checks, profile locks, session validation, templates and all stored work.

Only `src/speaking-independent-documents.js` changes at runtime. No migration, data repair, Docs write or student submission is required. Generic fixture tests cover the linked and standalone owner response and reject the wrong class.

Validation: both new owner assertions fail on the original implementation and pass after repair. The independent suite passes 19 tests; two native PostgreSQL concurrency cases require their separate fixture database and were not run. The other Speaking suites pass 236 tests. Their first parallel run had a local Node memory initialization failure in the Share reader file; its 10 cases pass when run separately. Browser validation uses a clean public student context and does not start or submit student work.

Production packaging overlays exactly this module on live image `sha256:a0aff8c02d4c259784f3ed35b89e115aa89812359f0dc966f411362df35bb566`, preserving all other source and configuration. Released image: `sha256:ace91bf985dd544271c70abf32f978c056d9a11a0f0ef350ce7dab996de2efb6`. Canary workers are disabled. Environment, bind mounts, host configuration and networks are checked against the original container; Docker's null-to-empty-array normalization is treated as equivalent.

Private deployment evidence, backup and exact live source are under `/opt/izone-speaking-owner-fix-20261101/` on VPS1 and `E:/Codex-Data/qa/speaking-owner-fix-20261101/` locally. These locations contain private Homework contexts and must not be committed to a public repository. Production roster verification and before/after row digests are recorded there, separately from fixture results.

Rollback, only when authorized and after checking current deployment: stop and retain the replacement container, rename `speaking67-independent-api-before-owner-fix-20261101` back to `speaking67-independent-api`, and start it. Keep current database and student work; do not restore the backup to roll back application code. The Mapping API, Progress Log and other product containers are outside this release.
