/**
 * Barrel export for the story module.
 *
 * Usage:
 *   import { InteractionEvent, GenerationEnvelope, StoryState,
 *            createInitialState, summarizeState, applyPatch,
 *            validatePatch } from "./story/index.js";
 */

// Types and schemas
export {
  // Event types
  InteractionEventSchema,
  GenerationEnvelopeSchema,
  StoryStateSchema,
  StoryStatePatchSchema,
  PlanningPatchSchema,
  BranchCandidateSchema,
  AutocompleteResultSchema,
} from "./types.js";

export type {
  // Event types
  InteractionMode,
  InteractionOption,
  InputSpec,
  InteractionEvent,
  GeneratedEvent,
  GenerationEnvelope,
  // State types
  StoryThread,
  CharacterState,
  StoryState,
  StoryStatePatch,
  PlanningPatch,
  // Branch types
  BranchSource,
  BranchStatus,
  BranchCandidate,
  // Autocomplete
  AutocompleteResult,
  // Re-exports from schema.ts
  DialogueDraftEvent,
  NarrationDraftEvent,
  Portrait,
  ChoiceOption,
  EndEvent,
} from "./types.js";

// State utilities
export { createInitialState, summarizeState } from "./state.js";

// Patch utilities
export { applyPatch, validatePatch } from "./patch.js";
