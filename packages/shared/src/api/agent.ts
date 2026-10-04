import { z } from "zod";

export const AGENT_SKILL_TARGETS = ["cursor", "claude", "codex"] as const;
export const agentSkillTargetSchema = z.enum(AGENT_SKILL_TARGETS);
export type AgentSkillTarget = z.infer<typeof agentSkillTargetSchema>;

export const agentConfigResponseSchema = z.object({
  /** `http://127.0.0.1:<port>/mcp` */
  url: z.string().min(1),
  token: z.string().min(1),
  skillVersion: z.number().int().positive()
});
export type AgentConfigResponse = z.infer<typeof agentConfigResponseSchema>;

export const agentSkillInstallRequestSchema = z.object({
  targets: z.array(agentSkillTargetSchema).min(1)
});
export type AgentSkillInstallRequest = z.infer<typeof agentSkillInstallRequestSchema>;

export const agentSkillInstallResponseSchema = z.object({
  /** Absolute paths of the written SKILL.md files. */
  paths: z.array(z.string())
});
export type AgentSkillInstallResponse = z.infer<typeof agentSkillInstallResponseSchema>;

export const AGENT_API = {
  config: "/v1/agent/config",
  tokenReset: "/v1/agent/token/reset",
  skillInstall: "/v1/agent/skill/install"
} as const;
