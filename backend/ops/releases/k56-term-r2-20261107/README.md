# K56 Term CBT · R2 direct

Scope is the Term 1 and Term 2 K56 offline preparation route. After native
identity, session, generation and owner checks, a new client can request
`audioTransport: "r2-direct-v1"`. The response optionally includes an R2 GET
capability for the pinned MP3, valid for 600 seconds and marked no-store.
Old clients, started attempts, a mismatched legacy pin and a disabled flag
keep the existing native contracts. Mini and answer sheets have no R2 grant
from this change.

## Build and verify

`python backend/ops/releases/k56-term-r2-20261107/patch-live.py <live-src> <new-overlay-dir>`
checks the current K56 offline receiver and cross-checks the two MP3 manifests.
It reuses the Listening R2 signer and the canonical R2 object catalog. Only
four files go into the runtime overlay. No SQL migration or package install
is required.

Run this folder's `test.mjs` and the Term offline HTTP/SQL regression suite for
each `K56_TEST_PRODUCT=1|2`. Point `TERM2_RUNTIME_ROOT` at the isolated runtime
with the overlay, and `TERM2_DEPS_PACKAGE` at the local backend package with
installed dependencies. Use the default isolated PGlite fixture.

## Rollout and rollback

Keep `AUDIO_R2_DIRECT_ENABLED` and the read-only directory bind for
`AUDIO_R2_DIRECT_CONFIG_FILE` in the operator config. The private JSON has the
bucket-scoped Object Read only credential, `enabled`, and the exact SHA allowlist.
Each enable operation is an atomic file replacement. Keep the previous K56
container and Compose bytes available. Preserve the existing Term offline flags,
journal/Portal config, network, runtime, and DB. Deploy with the SHA allowlist
empty, confirm compatibility, release Pages, then enable the Term 1 SHA and
both SHAs after source and range canaries.

For a source incident, use the deployed operator's `flag` action without slug
arguments to stop issuing fresh R2 grants. The released Pages client then uses
the verified GitHub Pages file. Keep credentials and CORS available to issued
links and preserve existing offline Blobs. For a backend rollback restore the
prior container and Compose configuration from the same release and verify
health. Keep stored submissions and pending operations. Record the exact
build, flags, canary and data checks privately.
