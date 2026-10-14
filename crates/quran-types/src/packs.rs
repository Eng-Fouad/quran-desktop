//! Packs, download jobs and disk usage. Sizes are `u32` KiB (`*_kib`).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{AppError, L10nText, TextDir};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PackKind {
    MushafFonts,
    Decor,
    Translation,
    Tafsir,
    Recitation,
    Wbw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum InstallMode {
    Whole,
    OnDemand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    Queued,
    Downloading,
    Verifying,
    Installing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PackState {
    NotInstalled,
    Partial {
        items_present: u32,
        items_total: u32,
    },
    Installed {
        version: String,
    },
    UpdateAvailable {
        installed: String,
        latest: String,
    },
    Paused {
        items_present: u32,
        items_total: u32,
    },
    Failed {
        error: AppError,
    },
}

/// Pages (mushaf fonts), surahs (recitation) or chapters (wbw, tafsir).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum InstallScope {
    All,
    Items { items: Vec<u32> },
}

/// One per present or queued item of an on-demand pack (`packs_items`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackItemState {
    /// Page / surah / chapter number.
    pub item: u32,
    /// Explicitly downloaded (`false` = stream-cached or fetched on demand).
    pub pinned: bool,
    /// Part of a running or paused job, not yet present.
    pub queued: bool,
    /// 0 while queued.
    pub kib: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub text: L10nText,
    pub url: String,
    pub licence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: u32,
    pub pack_id: String,
    pub phase: JobPhase,
    pub received_kib: u32,
    pub total_kib: u32,
    pub items_done: u32,
    pub items_total: u32,
    pub rate_kib_s: u32,
    pub eta_s: Option<u32>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub id: String,
    pub kind: PackKind,
    pub title: L10nText,
    pub description: L10nText,
    pub language: Option<String>,
    pub direction: Option<TextDir>,
    pub version: String,
    pub install_mode: InstallMode,
    pub requires: Vec<String>,
    pub size_kib: u32,
    pub item_count: u32,
    pub recommended: bool,
    pub revalidate_days: Option<u32>,
    pub attribution: Attribution,
    pub state: PackState,
    pub installed_kib: u32,
    pub job: Option<JobSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub id: String,
    pub kind: PackKind,
    pub title: L10nText,
    pub language: Option<String>,
    pub state: PackState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdate {
    pub pack_id: String,
    pub installed: String,
    pub latest: String,
    pub size_kib: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub total_kib: u32,
    pub mushaf_kib: u32,
    pub decor_kib: u32,
    pub translation_kib: u32,
    pub tafsir_kib: u32,
    pub audio_pinned_kib: u32,
    pub audio_stream_kib: u32,
    pub content_db_kib: u32,
    pub user_db_kib: u32,
    pub data_dir: String,
}

/// `packs_subscribe` Channel payload (at most 10 Hz per job).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DownloadEvent {
    Queued {
        job_id: u32,
        pack_id: String,
    },
    Started {
        job_id: u32,
        pack_id: String,
        total_kib: u32,
        items_total: u32,
    },
    Progress {
        job_id: u32,
        pack_id: String,
        received_kib: u32,
        total_kib: u32,
        items_done: u32,
        items_total: u32,
        rate_kib_s: u32,
        eta_s: Option<u32>,
    },
    Verifying {
        job_id: u32,
        pack_id: String,
    },
    Installing {
        job_id: u32,
        pack_id: String,
    },
    Paused {
        job_id: u32,
        pack_id: String,
    },
    Completed {
        job_id: u32,
        pack_id: String,
    },
    Failed {
        job_id: u32,
        pack_id: String,
        error: AppError,
    },
    Cancelled {
        job_id: u32,
        pack_id: String,
    },
}
