/**
 * herdr shows a pi agent as blocked while any extension holds `herdr:blocked`
 * (its pi integration counts active/inactive pairs). Plan-mode dialogs wait on
 * the user, so they hold it for as long as they are open.
 *
 * `herdr:working` is the opposite hold, for work that runs outside the main
 * agent's turn (planner runs, planner replies). The herdr attention bridge
 * reports it as the pane's `activity=working`, and does not treat a dialog
 * opened during the hold (the live planner traces) as a question.
 */
export const HERDR_BLOCKED_CHANNEL = "herdr:blocked";
export const HERDR_WORKING_CHANNEL = "herdr:working";

interface EventBus {
  emit(channel: string, data: unknown): void;
}

function emitter(events: EventBus | undefined, channel: string) {
  return (data: unknown) => {
    try {
      events?.emit(channel, data);
    } catch {
      // A listener failing must not break the dialog or the work.
    }
  };
}

export async function whileBlocked<T>(events: EventBus | undefined, label: string, run: () => Promise<T>): Promise<T> {
  const emit = emitter(events, HERDR_BLOCKED_CHANNEL);
  emit({ active: true, label });
  try {
    return await run();
  } finally {
    emit({ active: false });
  }
}

/** Hold `herdr:working` until the returned release runs; releasing twice is a no-op. */
export function holdWorking(events: EventBus | undefined, label: string): () => void {
  const emit = emitter(events, HERDR_WORKING_CHANNEL);
  let held = true;
  emit({ active: true, label });
  return () => {
    if (!held) return;
    held = false;
    emit({ active: false });
  };
}
