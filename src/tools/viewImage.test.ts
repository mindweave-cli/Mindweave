/**
 * viewImage.test.ts — looking at an image file opens nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewImage } from "./viewImage.js";
import type { ToolContext } from "./types.js";

/** The smallest real PNG: an 8-byte signature, IHDR with a size, then IEND. */
function pngBytes(width = 4, height = 3): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}

async function context(): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "mw-viewimage-"));
  return { cwd, reads: new Map() } as unknown as ToolContext;
}

const run = (ctx: ToolContext, path: string) => viewImage.execute({ path }, ctx);

test("an image file comes back as an image, with no process started", async () => {
  const ctx = await context();
  const file = join(ctx.cwd, "shot.png");
  await writeFile(file, pngBytes(120, 80));

  const result = await run(ctx, "shot.png");
  assert.equal(result.isError, undefined, result.output);
  assert.equal(result.images?.length, 1, "no image was attached to the result");
  assert.equal(result.images?.[0]?.path, file);
  assert.match(result.output, /120x80/);
});

test("it takes an absolute path too", async () => {
  const ctx = await context();
  const file = join(ctx.cwd, "abs.png");
  await writeFile(file, pngBytes());
  assert.equal((await run(ctx, file)).images?.length, 1);
});

test("a text file is refused, and says to use read_file", async () => {
  // The two tools must not be interchangeable in the model's mind: this one is for
  // pictures, and the error is what teaches that.
  const ctx = await context();
  await writeFile(join(ctx.cwd, "notes.txt"), "hello");
  const result = await run(ctx, "notes.txt");
  assert.equal(result.isError, true);
  assert.match(result.output, /read_file/);
});

test("a format that cannot be sent is named as such, not reported missing", async () => {
  const ctx = await context();
  await writeFile(join(ctx.cwd, "diagram.bmp"), Buffer.alloc(64));
  const result = await run(ctx, "diagram.bmp");
  assert.equal(result.isError, true);
  assert.ok(!/not found/i.test(result.output), `reported missing: ${result.output}`);
});

test("a missing file says so plainly", async () => {
  const ctx = await context();
  const result = await run(ctx, "nope.png");
  assert.equal(result.isError, true);
  assert.match(result.output, /not found/i);
});

test("a directory is not an image", async () => {
  const ctx = await context();
  await mkdir(join(ctx.cwd, "pics.png"));
  const result = await run(ctx, "pics.png");
  assert.equal(result.isError, true);
  assert.match(result.output, /directory/i);
});

test("an empty path is refused rather than resolving to the working directory", async () => {
  const ctx = await context();
  for (const bad of ["", "   "]) {
    const result = await run(ctx, bad);
    assert.equal(result.isError, true);
    assert.match(result.output, /needs a `path`/);
  }
});

test("the description tells the model NOT to open a viewer", async () => {
  // The whole reason the tool exists. Without this the model goes back to launching a
  // browser and photographing it, which is what left windows open all over the machine.
  assert.match(viewImage.description, /never open one in a viewer or a browser/i);
  assert.match(viewImage.description, /screenshot/i);
});

test("it is read-only, so it can run beside other reads", () => {
  assert.equal(viewImage.readOnly, true);
});

// ── The default-browser rule lives in run_command's description ──────────────

test("run_command tells the model to let the SYSTEM choose the app", async () => {
  // A named browser launches an app the user does not use. The rule sits in the tool
  // description rather than the system prompt because that is what the model reads at
  // the moment it is about to write the command.
  const { runCommand } = await import("./runCommand.js");
  assert.match(runCommand.description, /Never name a browser or a viewer yourself/i);
  assert.match(runCommand.description, /no application named|xdg-open/i);
  // And it points at the tool that removes the need to open an image at all.
  assert.match(runCommand.description, /view_image/);
});
