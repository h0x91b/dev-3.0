/**
 * Tiny bootstrap that flips DEV3_HEADLESS=1 BEFORE the main entry loads.
 *
 * Why this exists: ES module `import` statements hoist, so writing
 *     process.env.DEV3_HEADLESS = "1";
 *     import "./headless-entry";
 * does NOT work — the import resolves transitively and evaluates
 * `electrobun-platform.ts` before the assignment runs.
 *
 * A dynamic `await import()` is a *statement*, not a hoistable declaration,
 * so we can run arbitrary code before it. That's what we do here.
 *
 * Build target:
 *   bun build src/bun/headless-bootstrap.ts --compile --outfile dist/dev3-server
 */

process.env.DEV3_HEADLESS = "1";
await import("./headless-entry");
