# ASIP 1.0

Make a machine readable to an agent.

An agent that opens a session on your machine knows a great deal about Linux and
nothing about *this* Linux. So it guesses, you correct it, and next session it
guesses again. `asip` sets up one markdown file that says what the machine is,
and one rule that keeps that file true.

That is the whole idea. No daemon, no protocol, nothing to log into.

## Install

```
curl -fsSL https://raw.githubusercontent.com/M-o-liver/asip-linux/main/install.sh | sh
```

Installs one shell script to `~/.local/bin`. No sudo, no rc files touched,
nothing else on the machine changed. It is 57 lines if you would rather read
it first — `curl -fsSLO` the same URL and run `sh install.sh`.

Then tell your agent:

```
run `asip bootstrap` and do what it says
```

The agent is the installer. It writes the file, wires itself to read it, learns
the machine, and fills it in. You watch.

## Commands

| | |
|---|---|
| `asip bootstrap` | The setup protocol, addressed to the agent. Six steps. |
| `asip skeleton` | An empty `MACHINE.md` — eight headings, each a prompt. |
| `asip discover` | A read-only fill-in checklist chosen for *this* machine. |
| `asip rule <harness>` | The startup rule to append to a harness's memory file. |
| `asip doctor` | What is present, what is empty, what is unwired. |

**Every command prints to stdout and does nothing else.** No files written, no
packages installed, no network, no model called. This tool cannot break your
agent, because nothing in it runs when your agent runs.

## The file

Eight sections. Seven of them an agent can fill by inspection in a few minutes.
The eighth is the point:

```markdown
## Decision Log

**msi-ec DKMS driver (2026-07-22, reverted 2026-07-23):** built to fix the
battery misreading. It never bound — the driver reads the firmware, refuses
this model, returns ENOTSUP, and took systemd-modules-load.service down on
every boot. Do not install it. Revisit only if the supported-devices list
adds this model.
```

Nothing derives that from the machine. It cost a day to learn, it is invisible
to inspection, and without it the next agent installs it again — because the
failure mode of a capable agent is not ignorance, it is helpfulness.

So `asip` ships the file **empty**, and `bootstrap` explicitly instructs the
agent not to invent decision-log entries. A fabricated one is worse than an
absent one, because it will be believed.

This means the tool is worth close to nothing the day you install it, and more
every month after. That is unusual for software and it is not a flaw to be
designed away. The value was always going to be in the accumulation.

## Why it works now

Documentation used to rot because writing it was unpaid work, done by someone
other than whoever made the change, after the fact. Every fix for that was
social, and every one of them failed.

What changed is not discipline. The marginal cost of a paragraph went to roughly
zero, and the thing writing it is now the same thing that made the change,
writing at the moment it made it. Given a skeleton and a standing instruction to
keep it current, a frontier model maintains this file without being asked twice.

`asip` is the skeleton and the instruction. The model is the feature.

## Scope

Not a config manager — it does not converge a machine toward a declared state.
Not a backup system. Not a sandbox, policy engine, or privilege boundary: it
holds no privilege and grants none. It writes nothing at all.

Earlier implementations and product experiments are history, not runtime
dependencies or a roadmap. Retained records live outside the application.

## Portability

POSIX `sh`, plus `awk`, `grep`, `sed`. Detects `dnf` / `apt` / `pacman` /
`zypper` / `apk` / `xbps` and the agent CLIs on `PATH`.
