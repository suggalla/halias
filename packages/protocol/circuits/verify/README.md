Single-template wrappers, built only so Picus has something with declared outputs
to check. `transact.circom` itself declares none — every public signal is an
*input* — which makes Picus's default verdict vacuous and its `--strong` verdict
undecidable at 94k constraints. See ../../docs/static-analysis.md.
