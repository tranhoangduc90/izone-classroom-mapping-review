# Term Test 1 K56 Listening fallback continuity

The browser uses the existing section-scoped grant and the native offline operation queue. The grant can record a Listening interruption after a valid start. The existing transaction writes the interruption marker and its idempotent receipt. Reading and Writing grant boundaries and the next-skill dependency stay in place. A stopped Listening run is ineligible for another grant on the same attempt.

Build into an isolated folder with `python patch-live.py <live-src> <overlay-src>`. The manifest pins both source and result. The route advertises `listeningContinuityVersion: 1` only for the Listening grant; an already interrupted run gets its own marker and no audio ticket. No database migration is required.

Run `node --test fallback-interruption.test.mjs` with `TERM2_RUNTIME_ROOT` and `TERM2_DEPS_PACKAGE` set to the isolated runtime and its dependencies. The fixture checks both exam orders, scope rejection, receipt replay, no score or Portal dispatch, and the next skill. Deploy outside active exams, retain the previous mount config and container, and verify source, grant and skill paths after cutover.
