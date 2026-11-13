---
description: Show Honcho memory status — resolved config, workspace, and pending upload queue
---

Run this with the Bash tool and summarize the result for me (workspace, peer,
endpoint, and any pending un-uploaded queue entries):

```sh
node "$HOME/.kimi-code/plugins/managed/kimi-honcho/hooks/hook.mjs" status
```

If that path does not exist (plugin installed under a different id or a custom
`KIMI_CODE_HOME`), run `kimi-honcho status` instead.
