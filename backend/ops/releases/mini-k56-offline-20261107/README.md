# Mini Test K56 offline

The native Mini route keeps the current roster, attempt mode, definition pin,
generation, score rules and LMS pipeline. The new receiver admits a matching
unstarted attempt and a local device. Once enrolled, requests from the old write
path are rejected with a recoverable message. Readback and pre-existing active
attempts retain their contracts.

CBT uses the verified MP3 and a signed R2 descriptor with Pages fallback.
Answer sheets only accept L/R with null deadlines and manual sealing. Both modes
use the same durable, idempotent receipt protocol. Writing seals preserve the
canonical Task 2. A blank seal stores a terminal marker in Mini's own run and
receipt, returning `mode: blank` without grading rows, jobs or Portal Writing
grade. Nonblank seals use the existing LMS pipeline and its release policy.

## Build and test

Run `python patch-live.py <verified-live-src> <new-overlay-dir>` in this release
directory. Compare each file against the current K56 production source and keep
all existing Term, journal, Portal, network and environment overlays.

Run `test.mjs` with `MINI_RUNTIME_ROOT` pointing to the isolated candidate and
`TERM2_DEPS_PACKAGE` pointing to the backend package with its dependencies.
The fixture uses PGlite and synthetic data. No production exam or LMS jobs are
created by the test.

## Deployment

Create only the two new Mini tables and their indexes from `mini-offline.mjs`'s
schema for the physical K56 schema, with the same application grants as the
existing offline tables. Keep a verified private database backup and a hash
inventory of prior rows. Apply the overlay with both admissions disabled and
check startup and legacy behavior before publishing Pages.

Use a read-only mounted directory for `MINI_K56_OFFLINE_CONFIG_FILE`. Its JSON
has independent boolean `cbt` and `paper` flags. `classes` is a class-code
allowlist during canary, or null to keep existing native class access. For CBT,
add the Mini SHA to the existing R2 configuration without altering Term
allowlists. Admission can be disabled independently per mode, while status and
operations continue to accept permits already issued. Once permits have been
issued, use the flag rollback to preserve the receiver and already saved work.
