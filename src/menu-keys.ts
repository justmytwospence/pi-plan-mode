import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type MenuDefinition, type RunMenuOptions, runMenu } from "@narumitw/pi-tui-kit";

type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Keybindings = Parameters<CustomFactory>[2];
type Keybinding = Parameters<Keybindings["matches"]>[1];
type Screen = { kind: string; items?: readonly { id: string; label: string; to?: unknown }[] };
type MenuEvent = { kind: string; itemId?: string };

/** Keys that move in every menu, including type-to-search lists. */
const CONTROL_ALIASES: Partial<Record<string, readonly string[]>> = {
  "tui.select.up": ["ctrl+p"],
  "tui.select.down": ["ctrl+n"],
};

/** Letter keys, only where letters do not type into a search box. */
const LETTER_ALIASES: Partial<Record<string, readonly string[]>> = {
  "tui.select.up": ["k", "p"],
  "tui.select.down": ["j", "n"],
  "tui.select.cancel": ["h"],
};

/**
 * An item `l` may open: a submenu, or an action whose label ends in "…" because it opens another
 * screen instead of doing something at once.
 */
export function opensSubmenu(item: { label: string; to?: unknown } | undefined) {
  return item !== undefined && (item.to !== undefined || item.label.trimEnd().endsWith("…"));
}

/**
 * `runMenu` with vim-style keys. `ctrl+n`/`ctrl+p` move in every menu. Where the screen has no
 * search box, `j`/`n` and `k`/`p` move, `h` goes back, and on an action list `l` opens a submenu
 * (it never runs an action). Screens with a search box keep letters for searching.
 */
export function runMenuWithVimKeys<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends ExtensionContext = ExtensionContext,
>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
) {
  let current: Screen | undefined;
  const screens = Object.fromEntries(
    Object.entries(definition.screens).map(([id, factory]) => [
      id,
      (input: unknown) => {
        const screen = (factory as (input: unknown) => Screen)(input);
        current = screen;
        return screen;
      },
    ]),
  ) as typeof definition.screens;
  return runMenu(
    withVimKeys(ctx, () => current),
    { ...definition, screens },
    options,
  );
}

/** The real context behind each wrapped one, so a menu opened from another menu wraps it only once. */
const unwrapped = new WeakMap<object, ExtensionContext>();

function withVimKeys<Context extends ExtensionContext>(
  wrapped: Context,
  currentScreen: () => Screen | undefined,
): Context {
  const ctx = (unwrapped.get(wrapped) ?? wrapped) as Context;
  const ui = ctx.ui;
  const custom: typeof ui.custom = (factory, customOptions) =>
    ui.custom((tui, theme, keybindings, done) => {
      const screen = currentScreen();
      let kit = false;
      let letters = false;
      let lastInput: string | undefined;
      const keys = Object.create(keybindings) as Keybindings;
      keys.matches = (data: string, binding: Keybinding) => {
        if (keybindings.matches(data, binding)) return true;
        if (!kit) return false;
        const aliases = [
          ...(CONTROL_ALIASES[binding] ?? []),
          ...(letters ? (LETTER_ALIASES[binding] ?? []) : []),
          ...(letters && binding === "tui.select.confirm" && screen?.kind === "actions" ? ["l"] : []),
        ];
        return aliases.some((key) => matchesKey(data, key as never));
      };
      const finish = (result: Parameters<typeof done>[0]) => {
        const event = result as MenuEvent | undefined;
        if (lastInput === "l" && event?.kind === "activate") {
          const item = screen?.items?.find((candidate) => candidate.id === event.itemId);
          // `l` on an action that runs something at once: reopen the same screen instead.
          if (!opensSubmenu(item)) return done({ kind: "transition", transition: { kind: "stay" } } as never);
        }
        done(result);
      };
      const wrap = (component: Awaited<ReturnType<typeof factory>>) => {
        // Only plain pi-tui-kit menu screens; a text field (search or input) keeps its letters.
        if (!(component as { __piTuiKitScreen?: boolean }).__piTuiKitScreen) return component;
        kit = true;
        letters = !("focused" in component);
        const handleInput = component.handleInput?.bind(component);
        if (handleInput) {
          component.handleInput = (data: string) => {
            lastInput = data;
            try {
              handleInput(data);
            } finally {
              lastInput = undefined;
            }
          };
        }
        return component;
      };
      const created = factory(tui, theme, keys, finish);
      return created instanceof Promise ? created.then(wrap) : wrap(created);
    }, customOptions);
  const vimUi = new Proxy(ui, {
    get(target, property) {
      if (property === "custom") return custom;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const proxy = new Proxy(ctx, {
    get(target, property) {
      if (property === "ui") return vimUi;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  unwrapped.set(proxy, ctx);
  return proxy;
}
