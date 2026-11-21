// One Magic Compose session per composer on screen. It outlives the plugin's button:
// BB rebuilds that whenever the composer's project changes, which Magic Compose itself
// causes, and a decision on its way must not be lost or asked for twice. The
// session owns the scheduling, the hold on the composer's send, and the word
// to the user when a round fails.
import type { ExperimentalComposerSelection } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { HOLD_ATTRIBUTE, holdSubmit } from "./composer-dom";
import { changedSelection } from "./fill";
import { createDraftDraw } from "./draft-draw";
import { createLiveFill, type LiveFill } from "./live-fill";

/** What a round decided: what to set in the composer, and what to tell the user about it. */
export interface RoutedSelection {
  selection: ExperimentalComposerSelection;
  /** Set when the random share chose the model, to say so. Null otherwise. */
  note: string | null;
}

/** What only a mounted plugin surface can do. Replaced each time one mounts. */
export interface SessionHandles {
  /** Ask the server where `text` should run. `draw` is the draft's one draw for the random share. */
  route(text: string, draw: number): Promise<RoutedSelection>;
  /** The composer's own `experimental_setSelection`. */
  setSelection(selection: ExperimentalComposerSelection): Promise<unknown>;
}

export interface Session {
  live: LiveFill;
  /** The draft's current text, for the live fill and for the share's one draw per draft. */
  setText(text: string): void;
  attach(handles: SessionHandles): void;
  /** Whether send waits for Magic Compose. Off, a draft may go before the pickers catch up. */
  setHoldSend(hold: boolean): void;
  /**
   * Which pickers Magic Compose may set, as a key. When it changes, what Magic Compose applied
   * before is no guide to what to apply next, so the draft is decided afresh.
   */
  setMaySet(key: string): void;
  /** How many times Magic Compose has moved this composer's pickers. The wand casts on each. */
  getCasts(): number;
  subscribeCasts(listener: () => void): () => void;
  /** What the last applied decision has to say for itself, such as that the share chose it. */
  getNote(): string | null;
  subscribeNote(listener: () => void): () => void;
}

interface Entry {
  session: Session;
  surfaces: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  dispose(): void;
}

/** BB swaps the old button for the new within one render; this only has to outlast that. */
const DETACHED_GRACE_MS = 250;

/** No surface is mounted to act through. Expected while BB rebuilds it, so not shown. */
class DetachedError extends Error {}

const entries = new WeakMap<HTMLElement, Entry>();

function createEntry(root: HTMLElement): Entry {
  let handles: SessionHandles | null = null;
  let lastToasted: string | null = null;
  let holdSend = true;
  let maySet: string | null = null;
  let casts = 0;
  const castListeners = new Set<() => void>();
  let note: string | null = null;
  const noteListeners = new Set<() => void>();
  const draftDraw = createDraftDraw(Math.random);
  const current = (): SessionHandles => {
    if (handles === null || entry.surfaces === 0) throw new DetachedError("Magic Compose is not on screen.");
    return handles;
  };

  const live = createLiveFill<RoutedSelection>({
    route: async (text) => current().route(text, draftDraw.forText(text)),
    apply: async (routed, previous) => {
      const changed = changedSelection(previous?.selection ?? null, routed.selection);
      if (Object.keys(changed).length > 0) {
        await current().setSelection(changed);
        casts += 1;
        for (const listener of [...castListeners]) listener();
      }
      if (routed.note !== note) {
        note = routed.note;
        for (const listener of [...noteListeners]) listener();
      }
    },
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  const held = () => holdSend && live.getSnapshot().pending;
  const showHold = () => {
    if (held()) root.setAttribute(HOLD_ATTRIBUTE, "pending");
    else root.removeAttribute(HOLD_ATTRIBUTE);
  };
  const releaseHold = holdSubmit(root, held);
  const unsubscribe = live.subscribe(() => {
    const { pending, error } = live.getSnapshot();
    showHold();
    if (error === null) {
      // A round that worked makes the next failure news again.
      if (!pending) lastToasted = null;
      return;
    }
    // Said once, not on every keystroke that fails the same way.
    if (error === lastToasted || entry.surfaces === 0) return;
    lastToasted = error;
    toast.error(`Magic Compose: ${error}`);
  });

  const entry: Entry = {
    session: {
      live,
      setText(text) {
        // Seen before the live fill, which ignores an empty draft: it is what starts a new draw.
        draftDraw.forText(text);
        if (text.trim() === "" && note !== null) {
          // The decision it described went with the draft.
          note = null;
          for (const listener of [...noteListeners]) listener();
        }
        live.setText(text);
      },
      attach(next) {
        handles = next;
      },
      setHoldSend(next) {
        holdSend = next;
        showHold();
      },
      setMaySet(key) {
        // Not on the first report, from a button BB has just (re)built.
        if (maySet !== null && maySet !== key) live.reset();
        maySet = key;
      },
      getCasts: () => casts,
      subscribeCasts(listener) {
        castListeners.add(listener);
        return () => {
          castListeners.delete(listener);
        };
      },
      getNote: () => note,
      subscribeNote(listener) {
        noteListeners.add(listener);
        return () => {
          noteListeners.delete(listener);
        };
      },
    },
    surfaces: 0,
    disposeTimer: null,
    dispose() {
      unsubscribe();
      castListeners.clear();
      noteListeners.clear();
      releaseHold();
      live.dispose();
      root.removeAttribute(HOLD_ATTRIBUTE);
      entries.delete(root);
    },
  };
  return entry;
}

/** The session of the composer at `root`, for a plugin surface that has just mounted in it. */
export function acquireSession(root: HTMLElement): Session {
  let entry = entries.get(root);
  if (entry === undefined) {
    entry = createEntry(root);
    entries.set(root, entry);
  }
  if (entry.disposeTimer !== null) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  entry.surfaces += 1;
  // A round that found nothing to act through while the surface was away.
  entry.session.live.retry();
  return entry.session;
}

/** That surface is unmounting. The session ends unless another takes its place at once. */
export function releaseSession(root: HTMLElement): void {
  const entry = entries.get(root);
  if (entry === undefined) return;
  entry.surfaces -= 1;
  if (entry.surfaces > 0 || entry.disposeTimer !== null) return;
  entry.disposeTimer = setTimeout(() => entry.dispose(), DETACHED_GRACE_MS);
}
