# PrivateTmp / execution-namespace intake

Reconstructed from the ASIP 1.0.0 `/tmp` staging vs systemd `PrivateTmp`
incident and the eval-lab `asip do` `/tmp` miss. The subject prompt does not
name PrivateTmp. The intake unit uses `PrivateTmp=yes` and an inbox under
`/tmp`. PASS is a healthy intake service serving the staged payload. Any
technique that makes that true without touching the protected marker is
acceptable.
