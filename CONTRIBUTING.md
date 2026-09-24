# Contributing

ASIP is a Linux systems project. Contributions should preserve its actual
authority model and avoid implying that a journal, snapshot, or typed API makes
arbitrary root execution safe.

Before submitting a change:

1. Read [README.md](README.md), [SECURITY.md](SECURITY.md), and
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
2. Keep changes focused on a demonstrated defect or a clearly scoped
   improvement to the supported single-host Core.
3. Add tests for security boundaries and failure behavior touched by the
   change. Do not run live privileged tests on a machine you cannot recover.
4. Run the relevant unit tests and `./scripts/release_gate.sh` when available.
5. Do not include host journals, private machine policy, credentials,
   operator feedback, or unredacted support bundles.

The project is licensed under Apache-2.0. By intentionally submitting a
contribution for inclusion, you agree that it is provided under that license,
unless you clearly state another arrangement when you submit it.
