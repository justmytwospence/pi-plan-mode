# pi-plan-mode settings reference

[Back to README](../README.md#%EF%B8%8F-settings)

Settings live in `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`).
The file may be a symlink; saves write through it, preserve unknown fields, and publish atomically.
The Settings step of `/plan` edits planners, efforts, subagent models, the time limit, Jev tool
selection, the default implementation context, the export path, and the shortcut; everything else
is edited in the file. An invalid file is ignored (defaults apply) and never overwritten.

### Safe shell subcommands

`safeSubcommands` maps any command prefix to subcommand prefixes that the user chooses to trust completely in limited `bash` and `powershell`.
For example, `"kubectl": ["get", "apply"]` trusts commands beginning with `kubectl get` or `kubectl apply`, while `"npm": ["run inspect-custom"]` trusts commands beginning with `npm run inspect-custom`.
Command keys and subcommand entries are trimmed and must be non-empty strings.
Matches are literal and case-sensitive after leading whitespace in the submitted command is ignored.
A match requires the complete `<command> <subcommand>` prefix followed by whitespace, a shell control operator, or the end of the submitted command, so `"kubectl": ["apply"]` does not match `kubectl applies`.
Duplicate values and command keys that become equal after trimming are merged in first-seen order.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.

When a configured prefix matches, the planners' policy permits the complete submitted command without parsing or applying any command, argument, mutation, chain, redirect, expansion, substitution, multiline, or PowerShell syntax checks.
For example, `"kubectl": ["apply"]` also permits `kubectl apply -f deployment.yaml && rm -rf build`.
Likewise, `"gh": ["pr view"]` permits `gh pr view 218 --web`, `gh pr view 218 > pr.txt`, and any trailing shell content.
The setting therefore delegates the complete shell decision to the user and can allow arbitrary code execution with Pi's permissions.
It is not a sandbox, confirmation gate, or read-only guarantee.
Choose entries that are as specific as your workflow permits, and configure them only for commands and repositories you fully trust.

Commands that do not match still use the built-in fail-closed reviewed policy.
That default policy includes Git `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, and `grep`, with command-specific argument checks.
It rejects output and input redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff, textconv, filter, or signature helpers, mutating flags, malformed command layouts, and any parsed chain containing an unsafe segment.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked unless explicitly trusted through `safeSubcommands`.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while configured commands can expose or modify any data available to Pi's process.
A built-in-policy `git -C <path>` inspection is accepted only when the path keeps Git in Pi's current working directory.
The default policy reduces accidental mutation and cross-repository executable configuration; configured `safeSubcommands` bypass that protection.
A non-object `safeSubcommands`, empty command or subcommand string, non-array value, or non-string entry invalidates the entire settings file and triggers the normal warning/default fallback on session start.

