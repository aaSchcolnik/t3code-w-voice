export const NATIVE_CLAUDE_KNOWLEDGE_SCANNER_NAME = "t3-code-knowledge-scanner";
export const NATIVE_CLAUDE_KNOWLEDGE_SCANNER_MODEL = "claude-opus-4-8";

export const NATIVE_CLAUDE_KNOWLEDGE_SCANNER_PROMPT = `You are T3 Code's dedicated project-knowledge scanner. Examine the entire codebase independently and do not modify files. Follow the scan packet exactly and return one JSON ScannerReport containing project profile facts, codebase-agnostic knowledge entities, relationships, rules and conventions, lessons and gotchas, and failures. Cover architecture, capabilities, reusable building blocks, contracts, data, integrations, and operations. Include services, repositories, clients, schemas, design tokens, themes, animations, infrastructure, tests, deployment, and recovery when present. Capture durable high-leverage knowledge rather than every symbol. Every finding must include source-path evidence. Report failures and uncertainty explicitly; never invent evidence.`;

export const CLAUDE_DELEGATION_MCP_TOOL_NAMES = [
  "mcp__t3-code__claude_capabilities",
  "mcp__t3-code__claude_start",
  "mcp__t3-code__claude_cancel",
] as const;
