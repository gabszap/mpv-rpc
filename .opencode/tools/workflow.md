## Post-Change Review Workflow - MANDATORY

After ANY code change (implementation, fix, refactor), you MUST:

1. **Send to reviewer**: Delegate the changed files to the `reviewer` agent for analysis.
2. **Apply fixes**: If the reviewer reports issues, fix them.
3. **Re-review**: After fixing, send back to the `reviewer` agent to confirm no remaining problems.
4. **Report**: Only after the reviewer confirms the code is clean, report completion to the orchestrator.

This loop ensures code quality before any task is considered done.

Exception: Pure documentation changes (README, docs/) may skip this workflow.

### How to invoke the reviewer

Use the `delegate` tool with the `reviewer` agent. Include a clear prompt listing the changed files and what to focus on:

```
delegate(agent="reviewer", prompt="Review files: src/foo.ts, src/bar.ts. Focus on: security, error handling, code style per AGENTS.md. Report critical/major issues.")
```

After receiving the review:
- If **APPROVE**: task is done.
- If **REQUEST_CHANGES**: fix the issues, then re-delegate to `reviewer` with "Confirm fixes for issues X, Y, Z."
- Loop until APPROVE.
