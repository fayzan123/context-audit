---
name: reviewer
description: A single-file agent whose body talks about the USER's files.
---

Open `src/components/Button.tsx` and `tests/unit/button.test.ts`, then read
`skill-dir/SKILL.md` for the house style before you comment on anything.

Write the result to `docs/review.md` and leave `notes.md` alone.

A single-file asset ships no bundled files, so not one of the paths above is
a file this asset could be missing. Two of them (`skill-dir/SKILL.md`,
`notes.md`) resolve against this file's PARENT and three do not — which is
exactly the shape that produced 97 phantom "missing" paths on the reference
machine when refs were resolved for single-file assets.
