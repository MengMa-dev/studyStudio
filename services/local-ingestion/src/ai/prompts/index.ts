import type { GenerativeAiTask } from "../types";
import * as entryRewrite from "./entry-rewrite";
import * as knowledgeCompose from "./knowledge-compose";
import * as knowledgeExtract from "./knowledge-extract";
import * as knowledgeTriage from "./knowledge-triage";
import * as learningJudge from "./learning-judge";
import {
  entryRewriteOutputSchema,
  knowledgeComposeOutputSchema,
  knowledgeExtractOutputSchema,
  knowledgeTriageAdoptOutputSchema,
  knowledgeTriageOutputSchema,
  learningJudgeOutputSchema,
  type EntryRewriteInput,
  type KnowledgeComposeInput,
  type KnowledgeExtractInput,
  type KnowledgeTriageInput,
  type LearningJudgeInput
} from "./schemas.draft";

export type PromptTask = "learning_judge" | "knowledge_triage" | "knowledge_extract" | "knowledge_compose" | "entry_rewrite";

export type TaskInput = {
  learning_judge: LearningJudgeInput;
  knowledge_triage: KnowledgeTriageInput;
  knowledge_extract: KnowledgeExtractInput;
  knowledge_compose: KnowledgeComposeInput;
  entry_rewrite: EntryRewriteInput;
};

// ponytail: triage / extract borrow the learning_judge (small) model config; add dedicated AI tasks when they need separate tuning.
export const PROMPTS = {
  learning_judge: {
    task: "learning_judge" as GenerativeAiTask,
    version: learningJudge.PROMPT_VERSION,
    system: learningJudge.SYSTEM,
    buildUserPrompt: learningJudge.buildUserPrompt,
    outputSchema: (_input: LearningJudgeInput) => learningJudgeOutputSchema
  },
  knowledge_triage: {
    task: "learning_judge" as GenerativeAiTask,
    version: knowledgeTriage.PROMPT_VERSION,
    system: knowledgeTriage.SYSTEM,
    buildUserPrompt: knowledgeTriage.buildUserPrompt,
    outputSchema: (input: KnowledgeTriageInput) => (input.mode === "adopt" ? knowledgeTriageAdoptOutputSchema : knowledgeTriageOutputSchema)
  },
  knowledge_extract: {
    task: "learning_judge" as GenerativeAiTask,
    version: knowledgeExtract.PROMPT_VERSION,
    system: knowledgeExtract.SYSTEM,
    buildUserPrompt: knowledgeExtract.buildUserPrompt,
    outputSchema: (_input: KnowledgeExtractInput) => knowledgeExtractOutputSchema
  },
  knowledge_compose: {
    task: "knowledge_processing" as GenerativeAiTask,
    version: knowledgeCompose.PROMPT_VERSION,
    system: knowledgeCompose.SYSTEM,
    buildUserPrompt: knowledgeCompose.buildUserPrompt,
    outputSchema: (_input: KnowledgeComposeInput) => knowledgeComposeOutputSchema
  },
  entry_rewrite: {
    task: "entry_rewrite" as GenerativeAiTask,
    version: entryRewrite.PROMPT_VERSION,
    system: entryRewrite.SYSTEM,
    buildUserPrompt: entryRewrite.buildUserPrompt,
    outputSchema: (_input: EntryRewriteInput) => entryRewriteOutputSchema
  }
} as const;
