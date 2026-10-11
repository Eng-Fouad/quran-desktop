//! User data: library (bookmarks, highlights, notes, collections, tags, marks) and study data (positions, history,
//! memorisation, loop presets) (§5.10). Ids of library items are UUIDv7 strings.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{GapSetting, MushafLayout};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BookmarkKind {
    Ayah,
    Page,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HighlightColor {
    Yellow,
    Green,
    Blue,
    Red,
    Purple,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaggableKind {
    Bookmark,
    Note,
    Highlight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PositionContext {
    Mushaf,
    Translation,
    Audio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HistoryMode {
    Read,
    Listen,
    Memorize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MemoStatus {
    New,
    Learning,
    Memorized,
    Review,
}

/// Which slice of user data changed (`UserDataChanged` event).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UserDataKind {
    Bookmarks,
    ReadingBookmark,
    Highlights,
    Notes,
    Collections,
    Tags,
    Positions,
    History,
    Memo,
    Presets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub kind: BookmarkKind,
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub layout: Option<MushafLayout>,
    pub page: Option<u32>,
    pub label: Option<String>,
    pub collection_ids: Vec<String>,
    pub tag_ids: Vec<String>,
    pub created_at: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkInput {
    /// `null` ⇒ create.
    pub id: Option<String>,
    pub kind: BookmarkKind,
    pub ayah_id: u32,
    pub layout: Option<MushafLayout>,
    pub page: Option<u32>,
    pub label: Option<String>,
    pub collection_ids: Vec<String>,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkFilter {
    pub kind: Option<BookmarkKind>,
    pub collection_id: Option<String>,
    pub tag_id: Option<String>,
    pub surah: Option<u32>,
    pub limit: u32,
}

/// Result of `bookmark_toggle_ayah`; `active = false` ⇒ just tombstoned (undo = restore).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkToggle {
    pub bookmark: Bookmark,
    pub active: bool,
}

/// The single "where I stopped reading" ribbon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingBookmark {
    pub ayah_id: u32,
    pub layout: MushafLayout,
    pub page: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingBookmarkInput {
    pub ayah_id: u32,
    pub layout: MushafLayout,
    pub page: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingBookmarkMove {
    pub previous: Option<ReadingBookmark>,
    pub current: ReadingBookmark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub color: HighlightColor,
    pub tag_ids: Vec<String>,
    pub created_at: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HighlightInput {
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub color: HighlightColor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub title: Option<String>,
    pub body: String,
    pub tag_ids: Vec<String>,
    pub created_at: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    /// `null` ⇒ create.
    pub id: Option<String>,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub title: Option<String>,
    pub body: String,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteFilter {
    pub from_ayah_id: Option<u32>,
    pub to_ayah_id: Option<u32>,
    pub tag_id: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub item_count: u32,
    pub sort_key: i32,
    pub created_at: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInput {
    /// `null` ⇒ create.
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub sort_key: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub usage_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    /// `null` ⇒ create.
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahMark {
    pub ayah_id: u32,
    pub bookmark_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageMark {
    pub page: u32,
    pub bookmark_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HighlightMark {
    pub id: String,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub color: HighlightColor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMark {
    pub id: String,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
}

/// Everything the Mushaf draws for user data on the visible pages (`user_marks`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMarks {
    pub bookmarks: Vec<AyahMark>,
    pub page_bookmarks: Vec<PageMark>,
    pub highlights: Vec<HighlightMark>,
    pub notes: Vec<NoteMark>,
    pub reading_ayah_id: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub context: PositionContext,
    pub layout: Option<MushafLayout>,
    pub page: Option<u32>,
    pub ayah_id: u32,
    pub scroll_px: Option<u32>,
    /// Ignored on input.
    pub updated_at: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInput {
    pub mode: HistoryMode,
    pub layout: Option<MushafLayout>,
    pub page: Option<u32>,
    pub ayah_id: u32,
    pub dwell_s: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u32,
    pub at: u32,
    pub mode: HistoryMode,
    pub layout: Option<MushafLayout>,
    pub page: Option<u32>,
    pub ayah_id: u32,
    pub dwell_s: u32,
}

/// Per-ayah memorisation state; `strength` 0..=5 (Leitner-style schedule, §5.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoProgress {
    pub ayah_id: u32,
    pub status: MemoStatus,
    pub strength: u32,
    pub reviews: u32,
    pub lapses: u32,
    pub last_reviewed_at: Option<u32>,
    pub due_at: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoReviewInput {
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    /// 1 (again) ..= 4 (easy).
    pub rating: u32,
    pub mistakes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoTest {
    pub id: u32,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub start_ayah_id: u32,
    pub started_at: u32,
    pub finished_at: Option<u32>,
    pub reveals: Option<u32>,
    pub mistakes: Option<u32>,
    pub rating: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoTestResult {
    pub id: u32,
    pub reveals: u32,
    pub mistakes: u32,
    pub rating: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoopPreset {
    pub id: u32,
    pub name: String,
    pub reciter_id: Option<u32>,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub ayah_repeat: u32,
    pub range_repeat: u32,
    pub gap: GapSetting,
    pub speed_pct: u32,
    pub created_at: u32,
    pub updated_at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoopPresetInput {
    /// `null` ⇒ create.
    pub id: Option<u32>,
    pub name: String,
    pub reciter_id: Option<u32>,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub ayah_repeat: u32,
    pub range_repeat: u32,
    pub gap: GapSetting,
    pub speed_pct: u32,
}
