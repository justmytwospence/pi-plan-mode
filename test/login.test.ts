import assert from "node:assert/strict";
import { test } from "vitest";
import { isAuthError, type LoginDialog, loginInDialog, loginMethod, providerName } from "../src/login.js";

test("login errors are told apart from other failures", () => {
  for (const message of [
    "Encountered invalidated oauth token for user, failing request",
    "401 Unauthorized",
    "Incorrect API key provided",
    "No API key found for openai",
    "Your refresh token has expired; log in again",
  ]) {
    assert.ok(isAuthError(message), message);
  }
  for (const message of ["Rate limit reached", "529 Overloaded", "context length exceeded", undefined]) {
    assert.ok(!isAuthError(message), String(message));
  }
});

test("a provider logs in with OAuth when it has it, else an API key it can prompt for", () => {
  const runtime = (auth: unknown) => ({ getProvider: () => ({ name: "OpenAI", auth }) as never });
  assert.equal(loginMethod(runtime({ oauth: {}, apiKey: {} }), "x"), "oauth");
  assert.equal(loginMethod(runtime({ apiKey: { login: () => undefined } }), "x"), "api_key");
  assert.equal(loginMethod(runtime({ apiKey: {} }), "x"), undefined);
  assert.equal(providerName(runtime({ oauth: { name: "ChatGPT Plus/Pro (Codex)" } }), "x"), "ChatGPT Plus/Pro (Codex)");
  assert.equal(providerName({ getProvider: () => undefined }, "openai-codex"), "openai-codex");
});

test("the login flow drives Pi's login dialog", async () => {
  const shown: string[] = [];
  const dialog: LoginDialog = {
    signal: new AbortController().signal,
    showAuth: (url) => shown.push(`auth ${url}`),
    showDeviceCode: (info) => shown.push(`code ${info.userCode}`),
    showManualInput: async () => "pasted",
    showPrompt: async (message) => (message.includes("1. ") ? "2" : "typed"),
    showInfo: (message) => shown.push(`info ${message}`),
    showWaiting: (message) => shown.push(`wait ${message}`),
    showProgress: (message) => shown.push(`progress ${message}`),
  };
  const answers: string[] = [];
  const runtime = {
    getProvider: () => ({ name: "OpenAI", auth: { oauth: {} } }) as never,
    login: async (providerId: string, type: string, interaction: never, options?: { getDeviceId?: () => string }) => {
      const flow = interaction as {
        prompt(prompt: unknown): Promise<string>;
        notify(event: unknown): void;
      };
      assert.equal(providerId, "openai-codex");
      assert.equal(type, "oauth");
      assert.equal(options?.getDeviceId?.(), "device");
      flow.notify({ type: "auth_url", url: "https://auth.example" });
      flow.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://x" });
      flow.notify({ type: "progress", message: "exchanging" });
      answers.push(await flow.prompt({ type: "manual_code", message: "paste" }));
      answers.push(await flow.prompt({ type: "text", message: "name" }));
      answers.push(
        await flow.prompt({
          type: "select",
          message: "which",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        }),
      );
      return {} as never;
    },
  };
  await loginInDialog(runtime, "openai-codex", dialog, () => "device");
  assert.deepEqual(shown, [
    "auth https://auth.example",
    "code ABCD",
    "wait Waiting for authentication...",
    "progress exchanging",
  ]);
  assert.deepEqual(answers, ["pasted", "typed", "b"]);
  await assert.rejects(
    loginInDialog({ getProvider: () => undefined, login: runtime.login }, "nope", dialog, () => "d"),
    /has no login flow/u,
  );
});
