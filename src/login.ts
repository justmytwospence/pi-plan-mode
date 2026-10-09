// Logging in again from /plan: a planner whose provider rejected its credentials (an expired,
// revoked or missing login) gets a "Log in to <provider>" action. It runs Pi's own login flow, in
// Pi's login dialog, without leaving the planning screen; the planner then tries again with the
// new credentials (planner sessions re-read auth.json when it changes).
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type AuthType = Parameters<ModelRuntime["login"]>[1];

/** Provider errors that a fresh login fixes. */
const AUTH_ERROR =
  /invalidated oauth token|oauth token .*(?:expired|invalid|revoked)|unauthori[sz]ed|\b401\b|invalid[ _-]?api[ _-]?key|incorrect api key|authentication (?:failed|error)|no api key|not logged in|log ?in again|re-?authenticate|token (?:has )?expired|refresh token/iu;

export function isAuthError(message: string | undefined): boolean {
  return message !== undefined && AUTH_ERROR.test(message);
}

/** The parts of Pi's LoginDialogComponent the flow drives. */
export interface LoginDialog {
  readonly signal: AbortSignal;
  showAuth(url: string, instructions?: string): void;
  showDeviceCode(info: { userCode: string; verificationUri: string }): void;
  showManualInput(prompt: string): Promise<string>;
  showPrompt(message: string, placeholder?: string): Promise<string>;
  showInfo(message: string, links?: readonly { label?: string; url: string }[]): void;
  showWaiting(message: string): void;
  showProgress(message: string): void;
}

type LoginRuntime = Pick<ModelRuntime, "getProvider" | "login">;

/** How the provider logs in: OAuth when it has it (subscriptions), else an API key it can prompt for. */
export function loginMethod(runtime: Pick<ModelRuntime, "getProvider">, providerId: string): AuthType | undefined {
  const auth = runtime.getProvider(providerId)?.auth as { oauth?: unknown; apiKey?: { login?: unknown } } | undefined;
  if (auth?.oauth) return "oauth";
  if (auth?.apiKey?.login) return "api_key";
  return undefined;
}

export function providerName(runtime: Pick<ModelRuntime, "getProvider">, providerId: string): string {
  const provider = runtime.getProvider(providerId) as
    | { name?: string; auth?: { oauth?: { name?: string } } }
    | undefined;
  return provider?.auth?.oauth?.name || provider?.name || providerId;
}

/** Run the provider's login in `dialog`, as /login does; rejects with "Login cancelled" on esc. */
export async function loginInDialog(
  runtime: LoginRuntime,
  providerId: string,
  dialog: LoginDialog,
  getDeviceId: () => string,
): Promise<void> {
  const method = loginMethod(runtime, providerId);
  if (!method) throw new Error(`${providerId} has no login flow; set its credentials in Pi instead.`);
  await runtime.login(
    providerId,
    method,
    {
      signal: dialog.signal,
      prompt: (prompt) => {
        if (prompt.type === "manual_code") return dialog.showManualInput(prompt.message);
        if (prompt.type === "select") {
          // Pi's dialog has no selector: list the choices and take a number or an id.
          const options = prompt.options;
          const listed = options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
          return dialog.showPrompt(`${prompt.message}\n${listed}`, "number").then((answer) => {
            const picked = options[Number.parseInt(answer, 10) - 1] ?? options.find((option) => option.id === answer);
            if (!picked) throw new Error(`No such choice: ${answer}`);
            return picked.id;
          });
        }
        return dialog.showPrompt(prompt.message, prompt.placeholder);
      },
      notify: (event) => {
        if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
        else if (event.type === "device_code") {
          dialog.showDeviceCode(event);
          dialog.showWaiting("Waiting for authentication...");
        } else if (event.type === "info") dialog.showInfo(event.message, event.links);
        else dialog.showProgress(event.message);
      },
    },
    { getDeviceId },
  );
}
