import { describe, expect, it } from "vite-plus/test";

import { sanitizeTerminalCommandPlainText, TerminalReplaySanitizer } from "./outputSanitizer.ts";

describe("TerminalReplaySanitizer", () => {
  it("removes OSC clipboard sequences, NULs, and unsafe controls", () => {
    const sanitizer = new TerminalReplaySanitizer();
    expect(sanitizer.push("safe\u0000\u001b]52;c;secret\u0007text\u0001", true)).toBe("safetext");
  });

  it("holds split escape sequences until they are complete", () => {
    const sanitizer = new TerminalReplaySanitizer();
    expect(sanitizer.push("before\u001b]52;c;sec")).toBe("before");
    expect(sanitizer.push("ret\u001b\\after")).toBe("after");
  });

  it("keeps safe color sequences for replay but strips them from plain text", () => {
    const value = "\u001b[31mfailed\u001b[0m";
    const sanitizer = new TerminalReplaySanitizer();
    expect(sanitizer.push(value, true)).toBe(value);
    expect(sanitizeTerminalCommandPlainText(value)).toBe("failed");
  });

  it("preserves SGR color and CRLF output together", () => {
    const value = "\u001b[32mfirst\u001b[0m\r\nsecond\r\n";
    const sanitizer = new TerminalReplaySanitizer();
    expect(sanitizer.push(value, true)).toBe(value);
  });
});
