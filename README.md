# 🧭 pi-plan-mode — Plan Before Pi Edits Code

A [Pi](https://pi.dev) extension: `/plan` opens a full-screen planner. One or two models plan your
task read-only while you watch, answer their questions, and talk to them. With two, the pane below
them is your own main agent, which gets every plan, talks them over with you, questions the
planners, and writes the merged plan when you ask. Then you implement the plan you like, with the
model, effort, and context you choose.

Started as a fork of [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode)
(MIT, history preserved); the planner has since been rebuilt around in-process planner sessions.

## 📦 Install

Pi loads `src/index.ts` through jiti; there is no build step.

```bash
git clone https://github.com/justmytwospence/pi-plan-mode
cd pi-plan-mode && npm ci --omit=dev
pi install ./pi-plan-mode        # or add the absolute path to "packages" in ~/.pi/agent/settings.json
```

Requires Pi 0.99 or newer. Install only from sources you trust: Pi extensions run with Pi's permissions.

## 🚀 Use it

```text
/plan Add rate limiting to the public API
```

`/plan` (with or without a task) is the only command; everything else happens on the screen, which
covers the whole terminal. A step bar at the top right shows where you are:

**Settings → Tools → Planning → Review → Implement**

1. **Settings.** One page with the task, the planners, and your preferences. ↑/↓ (or ctrl+j/ctrl+k)
   pick a row, ←/→ (or ctrl+h/ctrl+l) change its value, Enter edits a text row, Tab goes on.
   - **Task**: shown in full, wrapped, in the room the other rows leave. Enter edits it in place in
     a multi-line editor (shift+Enter for a new line, Enter to save, Esc to cancel). Empty plans
     what the conversation so far is about.
   - **Planner A** and its **effort** and **subagents** (the model its read-only helpers run on,
     with their own **effort**; new subagent models start at `medium`).
   - **Planner B**: `none` plans with one model; pick a model to plan the same task with two in
     parallel. Two is the maximum.
   - **Time limit** per planner turn (it is asked to wrap up at 80%, stopped at the limit).
   - Preferences: whether Jev picks tools, where implementation starts by default, the export path,
     and the shortcut that opens the planner.

   Changes are saved as your defaults (`~/.pi/agent/pi-plan-mode.json`). Efforts are always real
   levels, starting from your session's level.
2. **Tools.** What the planners may use: Shell (read-only commands and any command grants),
   Subagents, your toolsets (e.g. web research), MCP servers and their tools, and **Other tools**
   from your other Pi extensions. Jev (TypeSafe) scores every tool for the task while you look,
   including Other tools, and preselects the ones that would make the plan better informed; your
   own changes win. Tools in `alwaysOffer` (by default web research, Context7 docs, and Jev
   judgments) are always preselected and marked `always`: Jev scores them but never turns them
   off. Enter asks
   `Start planning with N planners?`; Enter again starts.
3. **Planning.** Above the lanes, one live row per planner (and M, your main agent) shows
   its state, how long its turn has run, its tool calls, subagent tasks, tokens, cost, and what it
   is doing now. One lane per planner, side by side. Each shows what its planner is doing (or its
   plan, once it has one), the subagents it has running, and a line to talk to it. Type and press
   Enter to steer a working planner or to start a new turn with an idle one; both planners can be
   working on your messages at once. When a planner asks a question, the lane shows it with its
   options: ↑/↓ and Enter pick one, or type your own answer. With several questions, ←/→ (or
   Backspace) on an empty answer line move between them to change an earlier answer; nothing is sent
   until all are answered. Tab moves between the lanes, the M pane (with two planners), and the
   actions; ctrl+u/ctrl+d (or the wheel) scroll a lane; ctrl+o switches a lane between its plan and
   its chat. A lane's chat (and M's) is drawn by Pi's own components, as in pi itself: Markdown,
   thinking, and every tool call with its own renderer (extension tools included); ctrl+e expands
   or collapses tool output, as ctrl+o does in pi. A restored planner's chat shows its history.
4. **Review.** With two planners, the full-width pane below the lanes is **M, your main agent**:
   the agent of the session you started `/plan` from, so it has all your context. What you type
   there goes to it (a new turn, or a steer while it works), and the pane shows its replies as they
   stream; you can talk to it while A and B are still working. Each plan, and each revision, lands
   in your main conversation in full as it arrives, with what you and that planner said since its
   previous version. While a run is active your agent has two tools:
   - `plan_ask_planner`: ask planner A or B about its plan or what it found; the planner answers
     from its own research (the question shows in its lane as `main agent › …`).
   - `plan_submit_merged`: when you ask for it, record the merged (or adjusted) plan as **plan M**;
     the M pane shows it (ctrl+o switches between the plan and the chat).

   You do not have to word that request yourself: **Write plan M** in the actions asks M to merge
   both plans and what you decided into plan M, and once there is one, **Revise plan M** asks it to
   fold in what you discussed since. Either moves you to M's pane to watch it write.

   It is asked, not forced, to leave files alone while planning is underway. The focused pane gets
   the room: M takes the bottom third while you talk to it and shrinks to a few lines otherwise.
   To choose the split yourself, drag M's title rule (the divider) with the mouse, or press
   shift+↑/↓ to move it a row; that size then holds (for the rest of the pi session), and a
   double-click on the divider goes back to the automatic sizing.

   Once plans are in, the actions below are:
   - **Write plan M** (with two plans in, until M has one; not while M is working)
   - **Implement M… / Implement A… / Implement B…** (the merged plan first, once there is one)
   - **Revise plan M** (right after Implement M, once M has a plan)
   - **Add a planner…** (with one): plan the same task with a second model; the first keeps its
     plan and everything it read.
   - **Export M… / Export A… / Export B…**: write that plan to a Markdown file (path prefilled from
     settings).
   - **Save & close** and **Discard**.
   - **Log in to <provider>…**, first, when a planner failed because its provider refused its
     credentials (an expired or revoked login): it opens Pi's login dialog in place, as `/login`
     does, and the planner tries again once you are logged in.

   You can keep talking to either planner in Review, too.
5. **Implement.** The same row page: which plan, the **model**, its **effort**, and the **context**
   (this conversation plus the plan, or a fresh session with only the plan). Defaults come from
   `implementationModelMap` (keyed by the model that wrote the plan), else your session's model.
   Enter closes the planner and starts implementing.

**Esc** asks before leaving: **Hide** keeps the planners working in the background (the footer
shows `plan: A working · B ready (/plan)`, and you are notified once when one asks something or a
new plan version is ready), **Stop planning** stops the working planners, **Back** returns. `/plan` reopens the
screen where you left it, also after `/reload` or resuming the session: planners keep their sessions
on disk, so you can keep talking to them. A planner whose turn the reload or restart
cut off, or whose last turn failed, resumes by itself; its lane shows `continue (resumed …)`.

## 🧠 How it works

Each planner is its own **in-process Pi session** (created with Pi's SDK, as pi-btw and
pi-subagents do), so one planner and two planners are the same thing:

- It starts with your main conversation's messages, so it has your context.
- It runs on its own model and effort, with only the tools you chose, under a read-only policy
  (this package's planner extension): no edits or writes, bash limited to reviewed read-only
  commands plus your command grants, MCP calls limited to the servers and tools you selected.
- It reaches models through the providers your session registered, so subscriptions and custom
  providers work without extra setup.
- It asks you questions with `plan_mode_question` (shown in its lane) and submits its plan with
  `plan_mode_complete`; resubmitting makes a new version.
- Its subagents (`plan_subagents`) are read-only `pi` subprocesses on the subagent model. They
  start without your extensions, so the one a provider needs (e.g. pi-anthropic-auth, which keeps a
  Claude subscription paying) is passed to them; `providerExtensions` overrides this per provider.

M is not another session: the M pane shows your main session's own events and sends what you
type to it. Each plan is added to that session as a message (without starting a turn; your agent
reads it on its next turn; in your main chat it shows collapsed, ctrl+o expands it), the run's two
tools are active only while a run is, and their guidelines tell your agent how to use them and to
change nothing while planning is underway. Implementing "in this conversation" then builds the
plan in the session that discussed it.

Planner sessions are stored under `~/.pi/agent/plan-mode/planners/`.

## ⚙️ Settings

`~/.pi/agent/pi-plan-mode.json` (a symlink is fine; saves write through it). The Settings step
edits the common ones; the rest are JSON-only:

```json
{
  "planners": ["anthropic/claude-fable-5-1:xhigh", "openai-codex/gpt-6-astra:xhigh"],
  "scoutModelMap": {
    "anthropic/claude-fable-5-1": "anthropic/claude-opus-5-5:high",
    "openai-codex/gpt-6-astra": "openai-codex/gpt-6.1-sol:high"
  },
  "plannerTimeoutSeconds": 2700,
  "implementationModelMap": {
    "anthropic/claude-fable-5-1": "anthropic/claude-opus-5-5:high"
  },
  "defaultImplementationContext": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "toggleShortcut": "shift+tab",
  "plannerToolsets": {
    "web": {
      "label": "Web research",
      "description": "Web search and page fetching.",
      "extensions": ["~/.pi/agent/npm/node_modules/pi-web-access"],
      "tools": ["web_search", "fetch_content", "get_search_content"]
    },
    "mcp": {
      "label": "MCP servers",
      "description": "Connected services.",
      "mcp": true,
      "extensions": ["builtin:mcp", "builtin:codemode"],
      "tools": ["codemode"]
    }
  },
  "commandGrants": {
    "jev": {
      "label": "Jev judgments",
      "description": "Ask TypeSafe's Jev for fast typed judgments mid-research: rank or filter many files or search hits, classify items, check claims against a source, triage long output.",
      "commands": ["~/.local/bin/jev-ask"],
      "skills": ["~/.agents/skills/jev-judgments"],
      "enabled": false
    }
  },
  "jevToolSelection": true,
  "jevThreshold": 0.5,
  "jevProvider": "typesafe",
  "jevModel": "jev-latest",
  "planCompleteCommand": ["bash", "~/.claude/hooks/save-plan-to-obsidian.sh"]
}
```

- Model specs are `provider/modelId`, optionally with `:off|minimal|low|medium|high|xhigh|max`.
- `planners`: planner A and (optionally) B, preselected on the Settings step.
- `scoutModelMap`: planner model → the model its subagents run on.
- `alwaysOffer`: tools planners always get, whatever Jev scores: a toolset, command grant, MCP
  server, or Other tool by id or name (`web`, `jev`, `context7`), or one tool of a group
  (`web/web_search`, `context7/query-docs`). Unset, it is
  `["web", "web_search", "fetch_content", "context7", "jev"]` (names your setup lacks are
  ignored); set it to replace that, or to `[]` to leave every tool to Jev.
- `plannerToolsets`: named bundles of extensions and tools; `mcp: true` expands into your MCP
  servers. `commandGrants`: extra commands bash may run (one per call), with skills that explain them.
- `planCompleteCommand` runs when you implement or export a plan, with Claude Code
  `PostToolUse`-shaped JSON on stdin (`tool_input.plan`, `tool_response.filePath`, `model`), so a hook
  written for Claude's `ExitPlanMode` works unchanged.
- `safeSubcommands` (JSON-only) fully trusts command prefixes in the planners' bash policy; see the
  [settings reference](./docs/settings.md).
- The shortcut changes after `/reload`.

## 🤝 Herdr

While planners work, the extension holds `herdr:working` on Pi's event bus, so
[herdr-attention-queue](https://github.com/justmytwospence/herdr-attention-queue) shows the pane
as working. Outside Herdr nothing listens and the events do nothing.

## 🗂️ Layout

```text
src/
├── index.ts            # entry: the planner app, or the MCP guard inside a scout
├── plan.ts             # /plan: settings, tools, runs, implement, export, restore
├── main-chat.ts        # your main agent as M: delivered plans, the run tools, the M pane's view
├── app/                # the full-screen pages: options rows, lanes, frame
├── planner/            # in-process planner sessions: agent, session, policy extension, access, prompts
├── tool-tree*.ts       # the tools tree and its screen
├── jev-tool-picker.ts  # Jev's tool scores
└── tool-policy.ts, command-grants.ts, mcp-tools.ts, scout-process.ts, settings.ts, …
```

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
