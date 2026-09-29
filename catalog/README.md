# Catalog build

`node catalog/build.mjs` (or `npm run catalog`) reads `sources/seed.json` and
`sources/manual.json` and writes `src/catalog/catalog.json`. The build makes no network
requests, and the same inputs always produce the same output.

- `sources/seed.json` is a port of the Axiom Layer seed catalog, reduced as described in its
  `_origin` field. Reviewed changes to it are listed in `SEED_ADJUSTMENTS` in `build.mjs`.
- `sources/manual.json` holds the MVP additions. To add an entry, put one object in `apps` and
  link the vendor's own site in the pull request as evidence (DESIGN §7 step 4).
- Not built yet: the Wikidata candidate query and the awesome-generative-ai name list
  (DESIGN §7 steps 2-3). Both need a maintainer to review the results before merging.

`tests/catalog.test.ts` checks the output. It fails on a schema error, a duplicate domain, a
missing provenance source, a logo or URL, or a size over 300 KB.
