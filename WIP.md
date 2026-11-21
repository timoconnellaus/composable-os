# WIP: stage 41, Programs (build steps 1 to 3)

Branch `claude/stage-41-programs`. Spec: `docs/stages/41-programs.md`. Block X: migrations
0470–0479, ADRs 0445–0449.

## Plan
1. Platform: the `document` field type (schema, validation with paths, size limits, declared
   paths as view columns, redaction for outsiders); `publishable` without its public half
   (versions table, record.publish / versions / version / restoreVersion, `records:publish`);
   the signed-in scope (`signedIn` on an object, shared rows beside a customer's own); a
   customer's relation may point only at what they can see; `record.createMany`.
2. `packs/programs`: objects, the layout schema, versions, `assign`.
3. Logging, history, progress; isolation suite; criteria 1 to 7.

## Status
- [ ] step 1
- [ ] step 2
- [ ] step 3
