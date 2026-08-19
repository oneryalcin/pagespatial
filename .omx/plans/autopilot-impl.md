# PageSpatial implementation plan

1. Define canonical types, runtime schemas, deterministic identities, and adapter contracts.
2. Port the proven geometry transform, text normalization, association, reading-order, relation, and diagnostic logic into strict TypeScript modules.
3. Add the page builder and bounded-concurrency document parser.
4. Add Markdown projection as a derived view.
5. Add tests for transforms, conflicts, chart relations, schema validity, progressive callbacks, and adapter equivalence.
6. Document browser/server architecture, evaluation gates, and Evidence Search migration.
7. Install pinned dependencies, run build/typecheck/tests, review package contents, initialize Git, and create the initial commit.

