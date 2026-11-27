# K56 Writing callback locks and lease ownership

This release applies to the API serving /mapping-api-k56/ on localhost port 19861. It keeps the live image, build configuration and database. The Writing module is a release overlay. Apply writing.patch to the exact module checked out at /opt/izone-k56-term-compat-20261112/src/term-test-writing-grading.js.

| Artifact | SHA-256 |
|---|---|
| Live input module | 3f2f3757f6cf77b8f59d9a093d8202a7b9589a92e233975bef39757f6db1ce64 |
| Patched module | c78aa862d731a77da3ed2b9a3a6a00b9fb82161d6cce9f360c280f66fa296b02 |

The patch locks the attempt before the job and run, checks worker and lease after obtaining those locks, and returns the saved result on duplicate callbacks. A callback that finds results already saved can retry destination delivery without rewriting the score. The active production publisher deduplicates the destination event. Mini continues to return its homework link.

The PostgreSQL 16 fixture ran the exact module, dispatch and reclaim for Term 1 Task 2, Term 2 Task 1 and Mini Task 2 homework. The original module wrote with an expired lease. The patched module rejected the expired callback before any result and passed 18 tests, including three waves of 17 essays per profile and a separate native Portal outbox test per profile. There was one outbox event per Term attempt and none for Mini. All students and destination data in the lab were synthetic.

## Deploy and verify

Save and verify the original bytes before building the overlay. Use LF for the patch input and output, especially if working from a Windows checkout that converts line endings. Stage the finished module as term-test-writing-grading.js in /opt/izone-k56-writing-callback-locks-20261127 alongside cutover.py. Verify the file hash and run the Node syntax check. Run cutover.py with stage to create and inspect the prepared container. Run it with switch after staging. The command checks the pinned origin, open exam deadlines and active leases and keeps the prior container. It reads the exact module hash through the new container and checks health. Its output gives the retained container and version, or the reason it stayed on the previous version.

Follow by reading Docker health, the public /mapping-api-k56/health and the Writing lease and Portal outbox status. Check the other exam routes independently. No database migration or backfill accompanies the release.

Run cutover.py with rollback to return to the retained container when the same quiet-window check passes. Keep the database and existing queue records.
