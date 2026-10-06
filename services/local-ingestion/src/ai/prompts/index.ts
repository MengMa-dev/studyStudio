import type { GenerativeAiTask } from "../types";
import * as entryRestructure from "./entry-restructure";
import * as knowledgeAlign from "./knowledge-align";
import * as knowledgeExtract from "./knowledge-extract";
import * as learningJudge from "./learning-judge";
import {
  entryRestructureOutputSchema,
  knowledgeAlignOutputSchema,
  knowledgeExtractOutputSchema,
  learningJudgeOutputSchema,
  type EntryRestructureInput,
  type KnowledgeAlignInput,
  type KnowledgeExtractInput,
  type LearningJudgeInput
} from "./schemas.draft";

export type PromptTask = "learning_judge" | "knowledge_extract" | "knowledge_align" | "entry_rewrite";

export type TaskInput = {
  learning_judge: LearningJudgeInput;
  knowledge_extract: KnowledgeExtractInput;
  knowledge_align: KnowledgeAlignInput;
  entry_rewrite: EntryRestructureInput;
};

export const PROMPTS = {
  learning_judge: {
    task: "learning_judge" as GenerativeAiTask,
    version: learningJudge.PROMPT_VERSION,
    system: learningJudge.SYSTEM,
    buildUserPrompt: learningJudge.buildUserPrompt,
    outputSchema: (_input: LearningJudgeInput) => learningJudgeOutputSchema
  },
  knowledge_extract: {
    task: "knowledge_processing" as GenerativeAiTask,
    version: knowledgeExtract.PROMPT_VERSION,
    system: knowledgeExtract.SYSTEM,
    buildUserPrompt: knowledgeExtract.buildUserPrompt,
    outputSchema: (_input: KnowledgeExtractInput) => knowledgeExtractOutputSchema
  },
  knowledge_align: {
    task: "knowledge_processing" as GenerativeAiTask,
    version: knowledgeAlign.PROMPT_VERSION,
    system: knowledgeAlign.SYSTEM,
    buildUserPrompt: knowledgeAlign.buildUserPrompt,
    outputSchema: (_input: KnowledgeAlignInput) => knowledgeAlignOutputSchema
  },
  entry_rewrite: {
    task: "entry_rewrite" as GenerativeAiTask,
    version: entryRestructure.PROMPT_VERSION,
    system: entryRestructure.SYSTEM,
    buildUserPrompt: entryRestructure.buildUserPrompt,
    outputSchema: (_input: EntryRestructureInput) => entryRestructureOutputSchema
  }
} as const;
