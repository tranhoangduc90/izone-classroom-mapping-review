# Mini Test K56 Listening reporting

The K56 native overlay adds a separate image/message queue and provider receipt.
Offline requires the native accepted interruption. Online requires a signed proof
from the current playback owner's native manual checkpoint. Only TCP/HTTP to the
configured Bot API destination is used. No test credentials live in the repo.

Assemble against the six files read from the current K56 container. The manifest
pins both source and output bytes. Build with the reviewed journal transport
`contract.mjs` and `telegram-alerts.mjs` that passed the photo test.

```
node assemble-overlay.mjs <captured-runtime-src> <journal-src> <new-output-directory>
```

The release directory also needs this operator, the 40-hex backend release SHA
in `release-sha.txt`, the verified group ID in `authorized-destination.private.txt`,
and `policy/config.json` containing `{"enabled":true}`.
Use the existing K56 compose owner and credential mounted from the current
Collector. The operator validates source, route, database, isolated destination
and app activity, takes a verified backup, and preserves the existing container
as a rollback target. Use `preflight` first; apply only in a clear exam window.
Publish the browser entry once the native route is healthy.

To pause reporting independently, atomically replace the mounted policy file
with `{"enabled":false}`. Browser, native receiver and grading continue.
The backend stops admitting reports and claiming new sends. An already claimed
send may finish and its receipt must be checked by incident ID. Do not re-send
a delivery with unknown ACK. Keep the additive queue table on code rollback;
do not restore the database snapshot over subsequent exam work.
