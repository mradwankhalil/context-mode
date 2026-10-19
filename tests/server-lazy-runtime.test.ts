import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ discoveries: 0, constructions: 0 }));
vi.mock("../src/runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime.js")>(),
  detectRuntimes: () => { throw new Error("synchronous runtime discovery"); },
  hasBunRuntime: () => { throw new Error("eager Bun probe"); },
  detectRuntimesAsync: async () => {
    state.discoveries++;
    return { javascript: "node", typescript: null, python: null, shell: "sh" };
  },
}));
vi.mock("../src/executor.js", () => ({ PolyglotExecutor: class {
  constructor(opts: any) {
    expect(opts.runtimes.javascript).toBe("node");
    state.constructions++;
  }
  async execute() { return { stdout: "lazy-ok", stderr: "", exitCode: 0 }; }
} }));

let dataDir: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("registration and stats do not discover runtimes; execution awaits and supplies the map", async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ctx-lazy-runtime-"));
  vi.stubEnv("CONTEXT_MODE_DATA_DIR", dataDir);
  vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "");
  const { REGISTERED_CTX_TOOLS } = await import("../src/server.js");
  expect(REGISTERED_CTX_TOOLS.length).toBeGreaterThan(0);
  expect(state.discoveries).toBe(0);
  expect(state.constructions).toBe(0);
  const stats = REGISTERED_CTX_TOOLS.find(t => t.name === "ctx_stats")!;
  await stats.handler({});
  expect(state.discoveries).toBe(0);
  const execute = REGISTERED_CTX_TOOLS.find(t => t.name === "ctx_execute")!;
  const result = await execute.handler({ language: "javascript", code: "console.log('lazy-ok')" });
  expect(JSON.stringify(result)).toContain("lazy-ok");
  expect(state.discoveries).toBe(1);
  expect(state.constructions).toBe(1);
});
