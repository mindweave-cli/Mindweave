/**
 * pastedText.ts — how a large paste is stored, and how it is shown again.
 *
 * A paste is split three ways: the chat shows a short chip, the model gets the whole
 * thing, and the TRANSCRIPT stores the model's copy. That last one is what a resumed
 * session rebuilds the chat from, which is why the convention lives here beside the
 * transcript rather than with the input that produces it — both the writer and the
 * reader need it, and they are on opposite sides of the app.
 */
/**
 * Wrap a large paste so it can be told apart from what was typed.
 *
 * The chat shows a `[Pasted text …]` chip and the model gets the whole thing, which is
 * the right split — but the model's copy is what the transcript stores, and a resumed
 * session rebuilds the chat from that. Spliced in bare, the paste was indistinguishable
 * from typing: `/continue` replayed thousands of lines into the chat as if the user had
 * sat and typed them, which is the one place the collapse mattered most.
 *
 * A boundary is also better for the model than a bare splice. It says where the pasted
 * material starts and stops, and that it was pasted rather than written — the same thing
 * `<attached_file>` says about a file, in the same shape.
 */
export function wrapPastedText(content: string): string {
  return `<pasted_text lines="${content.split("\n").length}">\n${content}\n</pasted_text>`;
}

/**
 * Turn wrapped pastes back into their chips, for display.
 *
 * Collapsed, not removed — the counterpart to `stripAttachments`, and the difference is
 * deliberate. An attached file was NAMED in the line the user typed, so its body can go
 * entirely and the sentence still reads. A paste has no name: drop it and the message
 * loses the only sign that anything was there.
 */
export function collapsePastes(content: string): string {
  return content.replace(
    /<pasted_text lines="(\d+)">\n[\s\S]*?\n<\/pasted_text>/g,
    (_match, lines: string) => `[Pasted text +${lines} lines]`,
  );
}
