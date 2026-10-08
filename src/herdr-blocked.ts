/**
 * herdr shows a pi agent as blocked while any extension holds `herdr:blocked`
 * (its pi integration counts active/inactive pairs). Plan mode holds it while a
 * planner waits for your answers, which outranks a `herdr:working` hold.
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

/** Hold `channel` until the returned release runs; releasing twice is a no-op. */
function hold(events: EventBus | undefined, channel: string, label: string): () => void {
  const emit = emitter(events, channel);
  let held = true;
  emit({ active: true, label });
  return () => {
    if (!held) return;
    held = false;
    emit({ active: false });
  };
}

/** Hold `herdr:blocked` (waiting on you, e.g. a planner's questions) until released. */
export function holdBlocked(events: EventBus | undefined, label: string): () => void {
  return hold(events, HERDR_BLOCKED_CHANNEL, label);
}

/** Hold `herdr:working` until the returned release runs; releasing twice is a no-op. */
export function holdWorking(events: EventBus | undefined, label: string): () => void {
  return hold(events, HERDR_WORKING_CHANNEL, label);
}
