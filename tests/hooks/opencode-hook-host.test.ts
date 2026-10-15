import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const project = mkdtempSync(resolve(tmpdir(), "ctx-hook-host-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

function runHook(hook: string, host?: string, child = false) {
  const result = spawnSync(process.env.CONTEXT_MODE_TEST_RUNTIME || process.execPath, [resolve("hooks", hook)], {
    input: JSON.stringify({
      hook_host: host,
      ...(child ? { agent_id: "child-probe", agent_type: "general" } : {}),
      session_id: `host-probe-${host ?? "claude"}`,
      cwd: project,
      source: "startup",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
    }),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: project, CLAUDE_PROJECT_DIR: project },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

describe("Claude-compatible hooks hosted by OpenCode", () => {
  it("uses OpenCode tool names while retaining the Claude hook envelope", () => {
    const result = runHook("pretooluse.mjs", "opencode");
    expect(result.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const text = JSON.stringify(result);
    expect(text).toContain("context-mode_ctx_fetch_and_index");
    expect(text).not.toContain("mcp__plugin_context-mode_context-mode__");
  });

  it("retains native Claude naming without an explicit host", () => {
    const text = JSON.stringify(runHook("pretooluse.mjs"));
    expect(text).toContain("mcp__plugin_context-mode_context-mode__ctx_fetch_and_index");
  });

  it("retains available OpenCode plugin tools in a child session", () => {
    const text = JSON.stringify(runHook("pretooluse.mjs", "opencode", true));
    expect(text).toContain("context-mode_ctx_fetch_and_index");
    expect(text).not.toContain("mcp__plugin_context-mode_context-mode__");
  });

  it("does not redirect a native Claude child to unavailable MCP tools", () => {
    expect(runHook("pretooluse.mjs", undefined, true)).toBeNull();
  });

  it("uses OpenCode names in session-start guidance too", () => {
    const text = JSON.stringify(runHook("sessionstart.mjs", "opencode"));
    expect(text).toContain("context-mode_ctx_execute");
    expect(text).not.toContain("mcp__plugin_context-mode_context-mode__");
  });
});
