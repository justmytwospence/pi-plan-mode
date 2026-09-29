/**
 * herdr shows a pi agent as blocked while any extension holds `herdr:blocked`
 * (its pi integration counts active/inactive pairs). Plan-mode dialogs wait on
 * the user, so they hold it for as long as they are open.
 */
export const HERDR_BLOCKED_CHANNEL = "herdr:blocked";

interface EventBus {
  emit(channel: string, data: unknown): void;
}

export async function whileBlocked<T>(events: EventBus | undefined, label: string, run: () => Promise<T>): Promise<T> {
  const emit = (data: unknown) => {
    try {
      events?.emit(HERDR_BLOCKED_CHANNEL, data);
    } catch {
      // A listener failing must not break the dialog.
    }
  };
  emit({ active: true, label });
  try {
    return await run();
  } finally {
    emit({ active: false });
  }
}
