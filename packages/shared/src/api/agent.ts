import { z } from "zod";

export const AGENT_SKILL_TARGETS = ["cursor", "claude", "codex"] as const;
export const agentSkillTargetSchema = z.enum(AGENT_SKILL_TARGETS);
export type AgentSkillTarget = z.infer<typeof agentSkillTargetSchema>;

export const agentConfigResponseSchema = z.object({
  /** `http://127.0.0.1:<port>/mcp` */
  url: z.string().min(1),
  token: z.string().min(1),
  skillVersion: z.number().int().positive(),
  /** Skill present and MCP config carries the current token, per client. */
  installed: z.record(agentSkillTargetSchema, z.boolean())
});
export type AgentConfigResponse = z.infer<typeof agentConfigResponseSchema>;

export const agentInstallRequestSchema = z.object({
  target: agentSkillTargetSchema
});
export type AgentInstallRequest = z.infer<typeof agentInstallRequestSchema>;

export const agentInstallResultSchema = z.object({
  target: agentSkillTargetSchema,
  ok: z.boolean(),
  skillPath: z.string(),
  /** Config file written (or the command run); null when MCP registration failed. */
  mcpConfig: z.string().nullable(),
  /** What the user must do by hand when `ok` is false. */
  manual: z.string().nullable()
});
export type AgentInstallResult = z.infer<typeof agentInstallResultSchema>;

export const AGENT_API = {
  config: "/v1/agent/config",
  tokenReset: "/v1/agent/token/reset",
  install: "/v1/agent/install"
} as const;
