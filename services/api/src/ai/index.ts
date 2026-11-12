export { assembleDashboard, selectCandidates, widgetId, MAX_WIDGETS, type AssembleInput } from './assemble';
export { chooseGrain, classify, generateCandidates, SOURCE_ID, type Candidate, type ClassifiedFields, type Pattern } from './candidates';
export {
  ClaudeRanker,
  compactCandidates,
  compactProfile,
  RankerRefusedError,
  RuleRanker,
  sanitizeRanking,
  type ClaudeRankerOptions,
  type Ranker,
  type RankInput,
  type RankResult,
  type RankedItem,
} from './ranker';
export { Recommender, type RecommenderOptions, type RecommendInput } from './recommender';
export {
  applyPatch,
  AssistantDeclinedError,
  DashboardAssistant,
  type AssistantModelClient,
  type AssistantRequest,
  type AssistantResponse,
  type ChatMessage,
  type DashboardAssistantOptions,
  type PatchOp,
} from './assistant';
export { specReference } from './spec-reference';
export { fromOllamaResponse, OllamaAssistantClient, OllamaRanker, toOllamaMessages, type OllamaOptions } from './ollama';
