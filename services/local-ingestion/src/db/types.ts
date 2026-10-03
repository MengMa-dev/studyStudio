export type ItemType = "webpage" | "conversation" | "document";
export type ReadStatus = "unread" | "read";
export type OrganizeStatus = "pending" | "ingested" | "rejected" | "failed";
export type NoteScope = "fuzzy" | "item" | "entry";
export type ExclusionRuleKind = "url" | "domain" | "url_prefix" | "list_page";

export type EventRow = {
  id: string;
  type: string;
  occurred_at: string;
  day: string;
  channel: string | null;
  site: string | null;
  url: string | null;
  canonical_url: string | null;
  session_id: string | null;
  item_id: string | null;
  payload: string;
  received_at: string;
};

export type ItemRow = {
  id: string;
  type: ItemType;
  title: string | null;
  url: string | null;
  canonical_url: string | null;
  site: string | null;
  captured_at: string;
  reason: string | null;
  is_strong_learning: number;
  read_status: ReadStatus;
  organize_status: OrganizeStatus;
  dirty: number;
  content_hash: string | null;
  edited_at: string | null;
  reading_total_seconds: number;
  reading_session_count: number;
  last_read_at: string | null;
  doc_pages: number | null;
  doc_read_pages: number | null;
  deleted_at: string | null;
  capture_session_id: string | null;
};

export type ItemContentRow = {
  item_id: string;
  markdown: string | null;
  plain_text: string | null;
  sanitized_html: string | null;
  question: string | null;
  reasoning: string | null;
  extractor: string | null;
  meta: string | null;
  original_markdown: string | null;
};

export type ReadingSessionRow = {
  id: string;
  item_id: string;
  started_at: string | null;
  seconds: number;
  is_first: number;
  pages: string | null;
};

export type ItemExposureRow = {
  item_id: string;
  section_key: string;
  heading: string | null;
  chars: number | null;
  exposed_seconds: number | null;
  coverage: number | null;
  top_blocks: string | null;
  updated_at: string | null;
};

export type AssetRow = {
  id: string;
  item_id: string;
  kind: string | null;
  sha256: string | null;
  mime: string | null;
  size: number | null;
  source_url: string | null;
};

export type NoteRow = {
  id: string;
  scope: NoteScope;
  target_id: string | null;
  text: string;
  origin: string;
  derived_from: string | null;
  used_at: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
};

export type RuleRow = {
  id: string;
  kind: ExclusionRuleKind | string;
  value: string;
  note: string | null;
  created_at: string;
};

export type SettingRow = {
  key: string;
  value: string | null;
  updated_at: string | null;
};

export type TrashRow = {
  id: string;
  kind: string | null;
  target_ids: string | null;
  snapshot: string | null;
  deleted_at: string | null;
  expires_at: string | null;
};

export type KbCategoryRow = {
  id: string;
  name: string | null;
  description: string | null;
  sort: number | null;
};

export type KbEntryRow = {
  id: string;
  name: string;
  category_id: string | null;
  kind: string | null;
  /** JSON string[] */
  aliases: string | null;
  summary: string | null;
  body_markdown: string | null;
  completeness: string | null;
  mastery: number | null;
  mastery_source: string | null;
  user_edited: number;
  stale: number;
  orphan: number;
  patch_count: number;
  dirty: number;
  updated_at: string | null;
  deleted_at: string | null;
};

export type KbEdgeRow = {
  src: string;
  dst: string;
  type: string;
};

export type KbEdgeSourceRow = {
  src: string;
  dst: string;
  type: string;
  item_id: string | null;
  description: string | null;
};

export type KbEntrySourceRow = {
  entry_id: string;
  item_id: string;
  evidence: string | null;
  source_kind: string | null;
  added_at: string | null;
};

export type KbIgnoreRow = {
  name: string;
  created_at: string | null;
};

export type OrganizeResultRow = {
  item_id: string;
  summary: string | null;
  points: string | null;
  model: string | null;
  prompt_version: string | null;
  input_hash: string | null;
  run_id: string | null;
  updated_at: string | null;
  episode_id: string | null;
  decision: string | null;
  route: string | null;
  value_score: number | null;
  target_entry_ids: string | null;
  output: string | null;
  reject_reason: string | null;
  reason: string | null;
  override: string | null;
};

export type EpisodeRow = {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  active_seconds: number | null;
  status: string;
  is_learning: number | null;
  confidence: number | null;
  topic: string | null;
  learning_goal: string | null;
  judge_output: string | null;
  run_id: string | null;
  prompt_version: string | null;
  created_at: string | null;
};

export type OrganizeRunRow = {
  id: string;
  trigger: string | null;
  scope: string | null;
  requirement: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  stats: string | null;
  tokens: number | null;
  model: string | null;
  /** JSON { itemIds?, entryIds? } */
  scope_ids: string | null;
  progress: string | null;
};

export type OrganizeJobRow = {
  id: string;
  run_id: string | null;
  kind: string | null;
  target_id: string | null;
  status: string | null;
  attempts: number | null;
  error: string | null;
  updated_at: string | null;
};
