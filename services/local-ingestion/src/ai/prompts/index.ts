import * as entryRewrite from "./entry-rewrite";
import * as knowledgeProcessing from "./knowledge-processing";
import * as learningJudge from "./learning-judge";
import {
  entryRewriteOutputSchema,
  knowledgeProcessingAdoptOutputSchema,
  knowledgeProcessingOutputSchema,
  learningJudgeOutputSchema,
  type EntryRewriteInput,
  type KnowledgeProcessingInput,
  type LearningJudgeInput
} from "./schemas.draft";

export type PromptTask = "learning_judge" | "knowledge_processing" | "entry_rewrite";

export type TaskInput = {
  learning_judge: LearningJudgeInput;
  knowledge_processing: KnowledgeProcessingInput;
  entry_rewrite: EntryRewriteInput;
};

export const PROMPTS = {
  learning_judge: {
    version: learningJudge.PROMPT_VERSION,
    system: learningJudge.SYSTEM,
    buildUserPrompt: learningJudge.buildUserPrompt,
    outputSchema: (_input: LearningJudgeInput) => learningJudgeOutputSchema
  },
  knowledge_processing: {
    version: knowledgeProcessing.PROMPT_VERSION,
    system: knowledgeProcessing.SYSTEM,
    buildUserPrompt: knowledgeProcessing.buildUserPrompt,
    outputSchema: (input: KnowledgeProcessingInput) => (input.mode === "adopt" ? knowledgeProcessingAdoptOutputSchema : knowledgeProcessingOutputSchema)
  },
  entry_rewrite: {
    version: entryRewrite.PROMPT_VERSION,
    system: entryRewrite.SYSTEM,
    buildUserPrompt: entryRewrite.buildUserPrompt,
    outputSchema: (_input: EntryRewriteInput) => entryRewriteOutputSchema
  }
} as const;
