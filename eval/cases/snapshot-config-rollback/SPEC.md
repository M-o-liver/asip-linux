# Snapshot / config rollback

The eval-base snapshot leaves `asip-eval-tuner` healthy on `profile=balanced`.
The requested profile is `low-latency`. A leftover draft config sets
`worker_count=0`, which the binary rejects for that profile. Snapper is
installed so `asip snap` / `asip rollback` work. PASS requires the requested
profile and a healthy health endpoint, not merely restoring `balanced`.
