# Pull Request

## Summary

<!-- One paragraph explaining the change and motivation. -->

## Motivation

<!-- Why is this change needed? Link issues: `Fixes #123`, `Refs #456`. -->

## Changes

<!-- Bullet list of concrete changes. -->

-
-

## Tests

<!-- How is this tested? -->

- [ ] New tests added / existing tests updated
- [ ] All tests pass locally: `pnpm -r test`
- [ ] Typecheck passes: `pnpm -r typecheck`
- [ ] Format check passes: `pnpm format:check`

## Breaking changes

<!-- If any, describe migration path. Write "None" if none. -->

## Checklist

- [ ] Core stays host-agnostic (no MCP/openclaw imports in `@co-engram/core`)
- [ ] No new tool registered without adding to `contracts.tools` in manifest
- [ ] Documentation updated (README / docs/) if behavior changed
- [ ] CHANGELOG updated if user-facing
- [ ] No secrets, absolute paths, or personal information in code or commits
- [ ] Commit messages follow conventional-ish style (`feat:`, `fix:`, etc.)

## Notes for reviewer

<!-- Anything reviewers should pay attention to? -->
