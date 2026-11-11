# Speaking Share limits, 2026-11-11

The patches are for the exact running independent and mapping API sources. The release diffs use zero context. Apply with `git apply --unidiff-zero` only after matching the baseline source hashes and retaining each service's runtime overlays and configuration. The canonical source changes cover the shared behavior. The comparison checker is also included in the live patches.

Use the existing conversation snapshot budget of 160,000 message characters. Test with the provider disabled at the limit and test one long synthetic conversation through the provider. Replace the independent API before the mapping API, compare source hashes and check health. Keep each previous container for code rollback. Read back progress from the live services. The release requires no data migration.
