# Notes

A single-segment name that DOES exist in the bundle. The asymmetry it pins:
a bare `notes.md` counts toward `checked` because it resolved, while a bare
`package.json` that resolves to nothing is dropped rather than reported
missing — it is the user's file, not this skill's.
