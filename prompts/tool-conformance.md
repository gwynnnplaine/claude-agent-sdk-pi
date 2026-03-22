# Claude Agent SDK tool conformance prompt

Paste this entire prompt into pi TUI while using a `claude-agent-sdk/...` model.

```text
Tool conformance smoke test. Execute each step in order and print each result.

1) read: README.md (first 3 lines)
2) bash: `echo TOOL_BASH_OK && pwd`
3) write: `.tmp/sdk-tools.txt` with content `one`
4) edit: in `.tmp/sdk-tools.txt`, replace `one` with `two`
5) read: `.tmp/sdk-tools.txt` (full file)
6) find: list `src/**/*.ts`
7) bash: `rm -f .tmp/sdk-tools.txt`

After step 7, output a compact PASS/FAIL table with one row per tool:
- read
- bash
- write
- edit
- find

If any step fails, include the exact error text and likely cause in one line.
```

## Expected signals

- Step 5 should return `two`.
- PASS rows for all listed tools.
- No auth/process errors (e.g. invalid API key, `/login`, exited code 1).
