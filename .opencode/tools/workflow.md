## Post-Change Review Workflow - MANDATORY

After ANY code change (implementation, fix, refactor), you MUST:

1. **Send to reviewer**: Delegate the changed files to the `reviewer` agent for analysis.
2. **Apply fixes**: If the reviewer reports issues, fix them.
3. **Re-review**: After fixing, send back to the `reviewer` agent to confirm no remaining problems.
4. **Report**: Only after the reviewer confirms the code is clean, report completion to the orchestrator.

This loop ensures code quality before any task is considered done.

Exception: Pure documentation changes (README, docs/) may skip this workflow.
