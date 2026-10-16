import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("Windows background runtime probes", () => {
  test("hides real detection, summary and hook-runtime subprocess requests", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.resetModules();
    const execSync = vi.fn((command: string) =>
      command.startsWith("where ") ? "C:\\Tools\\runtime.exe\r\n" : "1.3.14\r\n",
    );
    const execFileSync = vi.fn(() => { throw new Error("unexpected POSIX subprocess"); });
    vi.doMock("node:child_process", () => ({ execSync, execFileSync }));
    const { detectRuntimes, getRuntimeSummary, resolveHookRuntime } = await import("../src/runtime.js");
    const runtimes = detectRuntimes();
    expect(runtimes.python).toBe("python3");
    expect(getRuntimeSummary(runtimes)).toContain("1.3.14");
    expect(resolveHookRuntime().isBun).toBe(true);
    expect(execSync.mock.calls.length).toBeGreaterThan(8);
    for (const call of execSync.mock.calls as unknown as Array<[string, { windowsHide?: boolean }]>) {
      expect(call[1], call[0]).toEqual(expect.objectContaining({ windowsHide: true }));
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  // Guard cold/repair/timeout branches without executing installers, taskkill,
  // codesign, or a compiler. Removing any flag makes this contract fail.
  test.each([
    "src/runtime.ts",
    "src/executor.ts",
    "hooks/ensure-deps.mjs",
    "hooks/platform-bridge.mjs",
  ])("hides every shell-backed execSync in %s", (file) => {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "execSync") calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const options = call.arguments[1];
      expect(options && ts.isObjectLiteralExpression(options), call.getText(source)).toBe(true);
      const hidden = options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
        ts.isPropertyAssignment(property) && property.name.getText(source) === "windowsHide" && property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
      expect(hidden, call.getText(source)).toBe(true);
    }
  });
});
