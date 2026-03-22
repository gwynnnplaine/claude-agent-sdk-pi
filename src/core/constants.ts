import { homedir } from "os";
import { join } from "path";

export const PROVIDER_ID = "claude-agent-sdk";

export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
export const SKILLS_ALIAS_PROJECT = ".claude/skills";

export const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
export const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");

export const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");

export const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");
