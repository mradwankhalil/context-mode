import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ current: "/repo/linked", main: "/repo/main", calls: 0, fail: false }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: () => { throw new Error("sync git forbidden"); },
  execFile: (cmd: string, args: string[], options: any, callback: Function) => {
    state.calls++;
    expect(cmd).toBe("git");
    expect(args.slice(0, 2)).toEqual(["-C", "/fixture"]);
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(2000);
    setTimeout(() => callback(state.fail ? new Error("git unavailable") : null,
      args.includes("rev-parse") ? state.current : `worktree ${state.main}\nHEAD abc\n`), 5);
  },
}));

beforeEach(() => {
  vi.resetModules(); vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", undefined);
  state.current = "/repo/linked"; state.main = "/repo/main"; state.calls = 0; state.fail = false;
});
afterEach(() => vi.unstubAllEnvs());

test("async suffix yields, shares pending git calls and preserves the canonical hash", async () => {
  const db = await import("../../src/session/db.js");
  expect(db.getWorktreeSuffixAsync).toBeTypeOf("function");
  const first = db.getWorktreeSuffixAsync("/fixture");
  let settled = false; void first.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  const second = db.getWorktreeSuffixAsync("/fixture");
  const expected = "__" + createHash("sha256").update("/repo/linked").digest("hex").slice(0, 8);
  expect(await first).toBe(expected);
  expect(await second).toBe(expected);
  expect(state.calls).toBe(2);
  expect(db.getWorktreeSuffix("/fixture")).toBe(expected);
});

test("main tree, missing git and explicit empty/nonempty suffix keep compatibility", async () => {
  const db = await import("../../src/session/db.js");
  expect(db.getWorktreeSuffixAsync).toBeTypeOf("function");
  state.current = state.main;
  expect(await db.getWorktreeSuffixAsync("/fixture")).toBe("");
  db._resetWorktreeSuffixCacheForTests(); state.fail = true;
  expect(await db.getWorktreeSuffixAsync("/fixture")).toBe("");
  const calls = state.calls;
  vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "explicit");
  expect(await db.getWorktreeSuffixAsync("/fixture")).toBe("__explicit");
  vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "");
  expect(await db.getWorktreeSuffixAsync("/fixture")).toBe("");
  expect(state.calls).toBe(calls);
});

test("async path resolver retains legacy migration and never falls back to sync git", async () => {
  const db = await import("../../src/session/db.js");
  expect(db.resolveSessionDbPathAsync).toBeTypeOf("function");
  const dir = mkdtempSync(join(tmpdir(), "ctx-async-migrate-"));
  try {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "kept");
    const projectDir = "/MixedCase/Project";
    const legacy = join(dir, db.hashProjectDirLegacy(projectDir) + "__kept.db");
    writeFileSync(legacy, "history");
    const resolved = await db.resolveSessionDbPathAsync({ projectDir, sessionsDir: dir });
    expect(readFileSync(resolved, "utf8")).toBe("history");
    expect(resolved).toBe(join(dir, db.hashProjectDirCanonical(projectDir) + "__kept.db"));
    if (legacy !== resolved) expect(existsSync(legacy)).toBe(false);
    expect(state.calls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
