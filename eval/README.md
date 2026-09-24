# Local evaluation fixtures

`asip eval` runs small, deterministic Linux fixtures for checking observable
machine state and ASIP change evidence. It does not launch a model or collect
private reasoning. The available cases and versioned suite files are under
`eval/cases/` and `eval/suites/`.

Evaluation runs are local data. Do not publish raw run records, hostnames,
journals, command output, or machine policy. Eval results are not evidence of
general platform support or a guarantee that ASIP actions are safe.

```sh
asip eval list
asip eval start asip-discipline-baseline
asip eval prompt RUN_ID
asip eval grade RUN_ID
asip eval status RUN_ID --human
```

See `asip eval --help` for the exact flags available in the installed version.
Live fixture setup and grading that need privileged host state belong only in a
disposable Linux VM.
