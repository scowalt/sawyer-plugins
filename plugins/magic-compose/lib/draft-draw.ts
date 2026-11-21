// The composer routes the draft again with each pause in typing. One random
// draw per draft keeps the share's answer steady across those rounds: without
// it the pickers would flip between the share target and the rotation as the
// user types.

export function createDraftDraw(random: () => number): { forText(text: string): number } {
  let current = random();
  return {
    forText(text) {
      // An empty composer is a new draft, so it gets its own draw.
      if (text.trim() === "") current = random();
      return current;
    },
  };
}
