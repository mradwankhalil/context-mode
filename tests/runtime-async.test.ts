import { afterEach, beforeEach, expect, test, vi } from "vitest";

const probes = vi.hoisted(() => ({ calls: [] as string[], files: new Set<string>() }));
vi.mock("node:child_process", () => ({
  execSync: () => { throw new Error("synchronous discovery forbidden"); },
  execFileSync: () => { throw new Error("synchronous discovery forbidden"); },
  execFile: (cmd: string, args: string[], opts: any, cb: Function) => {
    probes.calls.push([cmd, ...args].join(" "));
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBeGreaterThan(0);
    setTimeout(() => {
      const name = cmd === "where.exe" ? args[0] : args.at(-1)?.replace("command -v ", "");
      const hits: Record<string, string> = {
        bash: "C:\\Windows\\System32\\bash.exe\r\nC:\\Git\\bin\\bash.exe",
        python3: "C:\\Users\\test\\Microsoft\\WindowsApps\\python3.exe",
        python: "C:\\Python\\python.exe", node: "C:\\node.exe", ruby: "/bin/ruby",
      };
      if (args.includes("--version")) cb(null, "Python 3.12", "");
      else cb(hits[name!] ? null : new Error("not found"), hits[name!] ?? "", "");
    }, 1);
    return { on() {} };
  },
  exec: (command: string, opts: any, cb: Function) => {
    probes.calls.push(command);
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBeGreaterThan(0);
    setTimeout(() => cb(null, "Python 3.12", ""), 1);
    return { on() {} };
  },
}));
vi.mock("node:fs/promises", () => ({ access: async (p: string) => {
  if (!probes.files.has(p)) throw new Error("ENOENT");
} }));

beforeEach(() => {
  vi.resetModules();
  probes.calls.length = 0;
  probes.files.clear();
  vi.stubEnv("PATH", `fixture-${Math.random()}`);
  vi.stubEnv("SHELL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("discovery is asynchronous, coalesced and shared across module evaluations", async () => {
  const first = await import("../src/runtime.js");
  expect(probes.calls).toEqual([]);
  expect(first.detectRuntimesAsync).toBeTypeOf("function");
  const a = first.detectRuntimesAsync();
  const b = first.detectRuntimesAsync();
  const [one, two] = await Promise.all([a, b]);
  expect(one).toBe(two);
  const count = probes.calls.length;
  expect(count).toBeGreaterThan(0);
  vi.resetModules();
  const next = await import("../src/runtime.js");
  expect(await next.detectRuntimesAsync()).toBe(one);
  expect(probes.calls).toHaveLength(count);
  vi.stubEnv("PATH", "changed-path");
  expect(await next.detectRuntimesAsync()).not.toBe(one);
  expect(probes.calls.length).toBeGreaterThan(count);
});

test("Windows rejects WSL and Store stubs, preserves Git Bash and stale execPath fallback", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SHELL", "C:\\Windows\\System32\\bash.exe");
  probes.files.add(process.env.SHELL!);
  const { detectRuntimesAsync } = await import("../src/runtime.js");
  expect(detectRuntimesAsync).toBeTypeOf("function");
  const result = await detectRuntimesAsync();
  expect(result.shell).toBe("C:\\Git\\bin\\bash.exe");
  expect(result.python).toBe("python");
  expect(result.javascript).toBe("node");
  expect(probes.calls.some(c => /python3"? --version/.test(c))).toBe(false);
  expect(probes.calls).toContain('"python" --version');
});

test("SHELL and Bun fallback inputs invalidate the cache; non-shell override is refused", async () => {
  const { detectRuntimesAsync } = await import("../src/runtime.js");
  expect(detectRuntimesAsync).toBeTypeOf("function");
  const before = await detectRuntimesAsync();
  vi.stubEnv("SHELL", "/custom/zsh"); probes.files.add("/custom/zsh");
  expect((await detectRuntimesAsync()).shell).toBe("/custom/zsh");
  vi.stubEnv("SHELL", "/custom/python"); probes.files.add("/custom/python");
  expect((await detectRuntimesAsync()).shell).not.toBe("/custom/python");
  vi.stubEnv("HOME", "/new-home");
  const bun = process.platform === "win32" ? "/new-home\\.bun\\bin\\bun.exe" : "/new-home/.bun/bin/bun";
  probes.files.add(bun);
  const after = await detectRuntimesAsync();
  expect(after.javascript).toBe(bun);
  expect(after.typescript).toBe(bun);
  expect(after).not.toBe(before);
});

test("a cached live process.execPath is invalidated when a version manager deletes it", async () => {
  probes.files.add(process.execPath);
  const { detectRuntimesAsync } = await import("../src/runtime.js");
  expect((await detectRuntimesAsync()).javascript).toBe(process.execPath);
  probes.files.delete(process.execPath);
  expect((await detectRuntimesAsync()).javascript).toBe("node");
});

test("Windows canonical Git Bash takes priority over ambient system cmd SHELL", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SHELL", "C:\\Windows\\System32\\cmd.exe");
  probes.files.add(process.env.SHELL!);
  probes.files.add("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  const { detectRuntimesAsync } = await import("../src/runtime.js");
  expect((await detectRuntimesAsync()).shell).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
});
