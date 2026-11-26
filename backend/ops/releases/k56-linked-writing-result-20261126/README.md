# Writing results when a student reopens a K56 test

The K56 result route already looks up the official attempt for the same test, class, student and generation when a student reopens the test in another browser. The linked response included Listening and Reading but only returned Writing when Listening had been interrupted. The result screen consequently showed a pending status after the Writing report was ready.

The overlay reads the official submitted Writing through the same serializer used for student results. It retains the current browser's attempt and session tokens. The existing two-hour publication delay applies to the linked result. The read leaves grading jobs, grades, Portal delivery and paper routes unchanged.

## Apply and verify

Capture `src/k56-exam-order.js` from the serving container. Apply the overlay to a separate file with `node integrate.mjs BASE CANDIDATE`. The script stops if the running handler does not match the expected code. Inspect the diff and run `node --check CANDIDATE`.

Run `node --test result-route.test.mjs` with `K56_LINKED_WRITING_RUNTIME` set to the captured file and then to the candidate. The test uses the registered result handler with synthetic records. It covers linked attempts across Term 1, Term 2 and Mini, the publication delay, an unsubmitted Writing, the official owner and interrupted Listening. A successful K56 result response and the report readback are decisive in production. Relay only readiness, score and report presence in operations output.

Release only the matching runtime overlay and retain the original file. Verify the container health and module hash after switching. If the canary fails, restore the module and restart the same API; do not restore the database over later attempts.
