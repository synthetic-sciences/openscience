---
description: git commit and push
model: openscience/glm-4.7
subtask: true
---

commit and push

use a conventional commit prefix with an optional scope, matching CONTRIBUTING.md:
feat:
fix:
docs:
refactor:
perf:
chore:
test:
ci:

For anything in frontend/docs use the docs: prefix.

For anything in frontend/workspace use feat(app): or fix(app):.

feat, fix, docs, refactor, and perf commits appear in the generated release
notes; chore, test, and ci do not.

prefer to explain WHY something was done from an end user perspective instead of
WHAT was done.

do not do generic messages like "improved agent experience" be very specific
about what user facing changes were made

if there are changes do a git pull --rebase
if there are conflicts DO NOT FIX THEM. notify me and I will fix them

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`

## GIT STATUS --short

!`git status --short`
