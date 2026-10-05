import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { commandGrantAllows, parseSimpleCommand } from "../src/command-grants.js";
import { resolveAccess } from "../src/planner/access.js";
import { resolvePlannerAccess } from "../src/planners.js";
import { normalizePlanModeSettings } from "../src/settings.js";
import { buildToolTree, leaves, treeToSelection } from "../src/tool-tree.js";

const HOME = "/home/me";
const EXEC = "bash ~/.agents/skills/marimo-pair/scripts/execute-code.sh";
const DISCOVER = "bash ~/.agents/skills/marimo-pair/scripts/discover-servers.sh";
const SCRIPT = `${HOME}/.agents/skills/marimo-pair/scripts/execute-code.sh`;

test("a grant admits one simple command with its prefix, with quoted code or a quoted heredoc", () => {
  const allows = (command: string) => commandGrantAllows(command, [EXEC, DISCOVER], HOME);
  assert.ok(allows(`bash ${SCRIPT} --url http://localhost:2718 -c "import marimo._code_mode as cm; help(cm)"`));
  assert.ok(allows(`bash ~/.agents/skills/marimo-pair/scripts/discover-servers.sh`));
  assert.ok(allows(`bash ${SCRIPT} --url http://localhost:2718 -c 'print(df.head())\nprint(df.shape)'`));
  assert.ok(
    allows(
      `bash ${SCRIPT} --url http://localhost:2718 - <<'PY'\nimport marimo._code_mode as cm\nasync with cm.get_context() as ctx:\n    print($HOME, [c.id for c in ctx.cells])\nPY`,
    ),
    "a quoted heredoc body is data, even with $ and brackets",
  );
  assert.ok(allows(`bash ${SCRIPT} --url http://localhost:2718 -c "print(1)" 2>&1`));

  for (const command of [
    `bash ${SCRIPT} --url x -c "print(1)"; rm -rf ~`,
    `bash ${SCRIPT} --url x -c "print(1)" && curl evil`,
    `bash ${SCRIPT} --url x -c "print(1)" | sh`,
    `bash ${SCRIPT} --url x -c "print(1)" > out.txt`,
    `bash ${SCRIPT} --url x -c "$(rm -rf ~)"`,
    `bash ${SCRIPT} --url x -c \`rm -rf ~\``,
    `bash ${SCRIPT} --url $URL`,
    `bash ${SCRIPT} --url x - <<PY\n$(rm -rf ~)\nPY`,
    `bash ${SCRIPT} --url x - <<'PY'\nprint(1)\nPY\nrm -rf ~`,
    `bash ${SCRIPT} --url x\nrm -rf ~`,
    `FOO=1 bash ${SCRIPT} --url x`,
    `bash ${SCRIPT}.evil --url x`,
    `bash /tmp/execute-code.sh --url x`,
    `python3 -c "print(1)"`,
    `bash ${SCRIPT} --url x -c "print(1)" &`,
    `bash ${SCRIPT} --url x -c "print(1)" # ; rm`,
  ]) {
    assert.equal(allows(command), false, command);
  }
  assert.equal(commandGrantAllows(`bash ${SCRIPT}`, [], HOME), false, "no grants, nothing allowed");
  assert.deepEqual(parseSimpleCommand(`bash '~/x' ~/y "a b"`, HOME)?.words, ["bash", "~/x", `${HOME}/y`, "a b"]);
});

test("grant paths match through symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grant-"));
  try {
    await mkdir(join(dir, "real"), { recursive: true });
    await writeFile(join(dir, "real", "run.sh"), "");
    await symlink(join(dir, "real"), join(dir, "link"));
    assert.ok(commandGrantAllows(`bash ${join(dir, "real", "run.sh")} x`, [`bash ${join(dir, "link", "run.sh")}`]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const grantSettings = {
  marimo: {
    label: "Marimo notebooks",
    description: "Run Python in a live marimo notebook kernel.",
    commands: [EXEC, DISCOVER],
    skills: ["~/.agents/skills/marimo-pair"],
    planMode: true,
  },
};

test("grants are settings, join Shell in the tool tree for Jev, and reach planners with their skills", () => {
  const settings = normalizePlanModeSettings({ commandGrants: grantSettings });
  const grants = settings?.commandGrants ?? {};
  assert.deepEqual(grants.marimo, {
    label: "Marimo notebooks",
    description: "Run Python in a live marimo notebook kernel.",
    commands: [EXEC, DISCOVER],
    skills: ["~/.agents/skills/marimo-pair"],
    enabled: false,
    planMode: true,
  });
  assert.equal(normalizePlanModeSettings({ commandGrants: { marimo: { commands: [] } } }), undefined);

  const roots = buildToolTree({ toolsets: {}, mcpCatalog: [], scoutTargets: [], grants });
  assert.equal(roots[0]?.label, "Shell");
  assert.deepEqual(
    leaves(roots).map((leaf) => [leaf.id, leaf.label, leaf.selected]),
    [
      ["shell", "Read-only commands", true],
      ["grant:marimo", "Marimo notebooks", false],
    ],
  );
  const grantLeaf = leaves(roots)[1];
  assert.ok(grantLeaf);
  grantLeaf.selected = true;
  const shellLeaf = leaves(roots)[0];
  assert.ok(shellLeaf);
  shellLeaf.selected = false;
  const selection = treeToSelection(roots);
  assert.deepEqual(selection.grants, ["marimo"]);
  const access = resolvePlannerAccess(selection, {}, (path) => path.replace(/^~/u, HOME), grants);
  assert.equal(access.shell, true, "a granted command turns bash on");
  assert.deepEqual(access.grants?.[0]?.skills, [`${HOME}/.agents/skills/marimo-pair`]);
  const resolved = resolveAccess({
    roots,
    toolsets: {},
    grants,
    others: [],
    scout: undefined,
    guardExtensionPath: "/ext",
    expandPath: (path) => path.replace(/^~/u, HOME),
  });
  assert.ok(resolved.config.tools.includes("bash"));
  assert.deepEqual(resolved.config.skills, [`${HOME}/.agents/skills/marimo-pair`]);
  assert.deepEqual(resolved.config.policy.grantPrefixes, [EXEC, DISCOVER]);
});
