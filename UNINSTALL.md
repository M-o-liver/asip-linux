# Uninstall ASIP

Software removal and deletion of durable ASIP state are separate operations.

From an account with a trusted administrative path, run:

```sh
pkexec /usr/bin/env ASIP_SOURCE_ROOT="$HOME/.local/bin" \
  "$HOME/.local/bin/asip" uninstall --software
```

`--software` schedules a systemd job for 10 seconds later. It stops and removes
the Core services, installed code, launchers, and ASIP audit rule after the
current request can finish its journal record. It retains `/etc/asip`, `/var/lib/asip`,
and user-owned state so a later install can retain the same machine history.
It does not remove unrelated services or user files.

To erase ASIP's durable host state as well, use `uninstall --purge` instead.
That permanently removes the policy, journal, evidence, and credentials stored
by ASIP under `/etc/asip` and `/var/lib/asip` when the deferred removal job
runs. User-owned state remains. Export or back up anything you may need first.
Purge is irreversible and should be an explicit operator decision.
