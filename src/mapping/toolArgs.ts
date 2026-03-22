import { join } from "path";
import { PROJECT_SKILLS_ROOT, SKILLS_ALIAS_GLOBAL, SKILLS_ALIAS_PROJECT } from "../core/constants.js";

function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;
	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, PROJECT_SKILLS_ROOT);
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, PROJECT_SKILLS_ROOT);
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, PROJECT_SKILLS_ROOT);
	}
	return pathValue;
}

export function mapToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};
	const resolvePath = (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value);

	switch (normalized) {
		case "read":
			return {
				path: resolvePath(input.file_path ?? input.path),
				offset: input.offset,
				limit: input.limit,
			};
		case "write":
			return {
				path: resolvePath(input.file_path ?? input.path),
				content: input.content,
			};
		case "edit":
			return {
				path: resolvePath(input.file_path ?? input.path),
				oldText: input.old_string ?? input.oldText ?? input.old_text,
				newText: input.new_string ?? input.newText ?? input.new_text,
			};
		case "bash":
			return {
				command: input.command,
				timeout: input.timeout,
			};
		case "grep":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
				glob: input.glob,
				limit: input.head_limit ?? input.limit,
			};
		case "find":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
			};
		default:
			return input;
	}
}
