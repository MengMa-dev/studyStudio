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
