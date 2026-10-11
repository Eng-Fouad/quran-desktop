//! Where the main window opens (§13.5, §9.6): the saved size and position, fitted into a monitor's work area.
//!
//! tauri-plugin-window-state saves the window (size, position, maximised, fullscreen) on exit; the main window is
//! restored here instead of by the plugin (`skip_initial_state`, see `lib.rs`), for two reasons found in the real app:
//! - **Size drift.** The plugin saves `inner_size()` and restores it with `set_size()`. On Windows the main window is
//!   undecorated with a shadow, and tao sizes it by adding the window's current window-minus-client offset to the size
//!   asked for. A window just created (hidden) has not had its frame calculated yet (`WM_NCCALCSIZE`): it still reports
//!   the client area of a captioned window, 43 physical px shorter at 150 %. Restoring then sized the window for that
//!   phantom caption, so it came back 43 px taller, and was saved so on exit: the window grew on every launch until it
//!   was taller than the screen. (A restore that asked for exactly the stale size changed nothing, and the first show
//!   enlarged the window instead.) [`Geometry::settle_frame`] makes Windows calculate the frame first
//!   (`SWP_FRAMECHANGED`), so the sizes read and set here are the ones the shown window has, and
//!   [`set_inner_size_exact`] checks what `set_size` produced, so saving and restoring use the same measure.
//! - **No fit.** Nothing kept a restored window on screen. [`fit`] places the window inside the work area (the monitor
//!   minus the taskbar or dock) of the monitor it was on: no larger than that area, moved inside it when it sticks out,
//!   and centred on the primary monitor when it lies on no monitor at all (a disconnected display). The first launch,
//!   with nothing saved, fits the config size the same way (a 940 px tall window on a 1392 px work area at 150 %).
//!
//! Everything here works in physical pixels, as the plugin's file does.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_window_state::StateFlags;

use crate::MAIN_WINDOW;

/// What the window-state plugin saves (and the main window restores from).
pub const SAVED_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

/// One window's entry in the plugin's file (tauri-plugin-window-state 2.5.0 `WindowState`, physical px): the inner
/// size, the outer position, and the position before maximising.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub prev_x: i32,
    pub prev_y: i32,
    pub maximized: bool,
    pub fullscreen: bool,
}

impl Saved {
    /// The main window's entry of the plugin's JSON (`{ "main": { … } }`); `None` when there is none, it is unreadable
    /// or it has no size (the plugin's default entry).
    #[must_use]
    pub fn parse(json: &str) -> Option<Self> {
        let mut all: std::collections::HashMap<String, Self> = serde_json::from_str(json).ok()?;
        all.remove(MAIN_WINDOW)
            .filter(|s| s.width > 0 && s.height > 0)
    }

    /// The outer position to restore: the one before maximising when the window was maximised.
    #[must_use]
    pub const fn position(&self) -> (i32, i32) {
        if self.maximized {
            (self.prev_x, self.prev_y)
        } else {
            (self.x, self.y)
        }
    }
}

/// The plugin's file: `<app config dir>/.window-state.json`, or `<QD_DATA_DIR>/window-state.json` in an isolated debug
/// run (`setup::dev_window_state_file`).
pub fn saved_file<R: Runtime, M: Manager<R>>(manager: &M) -> Option<PathBuf> {
    if let Some(file) = crate::setup::dev_window_state_file() {
        return Some(file);
    }
    match manager.path().app_config_dir() {
        Ok(dir) => Some(dir.join(tauri_plugin_window_state::DEFAULT_FILENAME)),
        Err(e) => {
            log::debug!("window state: no config dir ({e})");
            None
        }
    }
}

/// A rectangle in physical px (a monitor's work area, or a window's outer frame).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// The area two rectangles share, in px².
    fn overlap(self, other: Self) -> u64 {
        let w = self.right().min(other.right()) - i64::from(self.x.max(other.x));
        let h = self.bottom().min(other.bottom()) - i64::from(self.y.max(other.y));
        if w <= 0 || h <= 0 {
            0
        } else {
            u64::try_from(w).unwrap_or(0) * u64::try_from(h).unwrap_or(0)
        }
    }
}

/// Where a window goes ([`fit`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fitted {
    /// The outer frame: position and size.
    pub frame: Rect,
    /// The window lay on no monitor and was centred on the primary one.
    pub recentred: bool,
}

/// Fits the outer frame `wanted` into a work area: the one it overlaps most (ties: the first), else `primary` (else the
/// first area) with the frame centred on it. The frame is shrunk to the area, then moved inside it. `None` without any
/// work area (the window is left as it is).
#[must_use]
pub fn fit(wanted: Rect, areas: &[Rect], primary: Option<usize>) -> Option<Fitted> {
    let (area, recentred) = match areas
        .iter()
        .enumerate()
        .map(|(i, a)| (a.overlap(wanted), i))
        .filter(|&(overlap, _)| overlap > 0)
        .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
    {
        Some((_, i)) => (*areas.get(i)?, false),
        None => (
            *primary
                .and_then(|i| areas.get(i))
                .or_else(|| areas.first())?,
            true,
        ),
    };
    let width = wanted.width.min(area.width);
    let height = wanted.height.min(area.height);
    let span = |start: i32, len: u32, area_start: i32, area_len: u32| -> i32 {
        let max_start = i64::from(area_start) + i64::from(area_len) - i64::from(len);
        let start = if recentred {
            i64::from(area_start) + (i64::from(area_len) - i64::from(len)) / 2
        } else {
            i64::from(start).clamp(i64::from(area_start), max_start.max(i64::from(area_start)))
        };
        i32::try_from(start).unwrap_or(area_start)
    };
    Some(Fitted {
        frame: Rect {
            x: span(wanted.x, width, area.x, area.width),
            y: span(wanted.y, height, area.y, area.height),
            width,
            height,
        },
        recentred,
    })
}

/// What [`restore`] needs from a window: its geometry and the monitors around it (implemented for the real window and,
/// in tests, for a simulated one that reproduces the Windows size drift).
pub trait Geometry {
    fn inner_size(&self) -> Option<PhysicalSize<u32>>;
    fn outer_size(&self) -> Option<PhysicalSize<u32>>;
    fn outer_position(&self) -> Option<PhysicalPosition<i32>>;
    fn set_inner_size(&self, size: PhysicalSize<u32>);
    fn set_outer_position(&self, position: PhysicalPosition<i32>);
    /// Has the platform calculate the window's frame now, as showing it would, so that the client area it reports is
    /// the one the window will have on screen (a no-op where that is always so).
    fn settle_frame(&self);
    /// Every monitor's work area, and the index of the primary monitor among them.
    fn work_areas(&self) -> (Vec<Rect>, Option<usize>);
    fn maximize(&self);
    fn set_fullscreen(&self);
}

/// Sets the inner size and checks what the platform made of it. tao measures the frame afresh on every request, so a
/// request skewed by a stale frame is simply made again; a platform that overshoots by the same amount every time is
/// asked for the size less that amount, once. Returns the inner size reached.
pub fn set_inner_size_exact(
    window: &impl Geometry,
    target: PhysicalSize<u32>,
) -> PhysicalSize<u32> {
    window.set_inner_size(target);
    let Some(mut got) = window.inner_size() else {
        return target;
    };
    if got != target {
        log::debug!(
            "window: set_size({}×{}) gave {}×{}; asking again",
            target.width,
            target.height,
            got.width,
            got.height
        );
        window.set_inner_size(target);
        got = window.inner_size().unwrap_or(target);
    }
    if got != target {
        let correct = |want: u32, got: u32| -> u32 {
            let corrected = i64::from(want) * 2 - i64::from(got);
            u32::try_from(corrected.max(1)).unwrap_or(want)
        };
        let corrected = PhysicalSize::new(
            correct(target.width, got.width),
            correct(target.height, got.height),
        );
        log::debug!(
            "window: set_size({}×{}) gives {}×{} every time; asking {}×{}",
            target.width,
            target.height,
            got.width,
            got.height,
            corrected.width,
            corrected.height
        );
        window.set_inner_size(corrected);
        got = window.inner_size().unwrap_or(target);
    }
    got
}

/// Restores the saved placement (or fits the window as created when nothing is saved): the frame is calculated first
/// ([`Geometry::settle_frame`]), the inner size is exact ([`set_inner_size_exact`]) and the frame fits a work area
/// ([`fit`]); then maximised and fullscreen state. Never fails: what cannot be read or applied leaves the window as the
/// config made it.
pub fn restore_with(window: &impl Geometry, saved: Option<Saved>) {
    window.settle_frame();
    let (Some(inner), Some(outer), Some(pos)) = (
        window.inner_size(),
        window.outer_size(),
        window.outer_position(),
    ) else {
        return;
    };
    // The frame around the client area (title bar and borders of a decorated window; nothing on Windows).
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);
    let (width, height, (x, y)) = match saved {
        Some(s) => (s.width, s.height, s.position()),
        None => (inner.width, inner.height, (pos.x, pos.y)),
    };
    let wanted = Rect {
        x,
        y,
        width: width.saturating_add(frame_w),
        height: height.saturating_add(frame_h),
    };
    let (areas, primary) = window.work_areas();
    let Some(fitted) = fit(wanted, &areas, primary) else {
        return;
    };
    if fitted.frame != wanted || fitted.recentred {
        log::info!(
            "window: {}×{} at ({}, {}) fitted to the work area as {}×{} at ({}, {}){}",
            wanted.width,
            wanted.height,
            wanted.x,
            wanted.y,
            fitted.frame.width,
            fitted.frame.height,
            fitted.frame.x,
            fitted.frame.y,
            if fitted.recentred {
                " (it was on no monitor)"
            } else {
                ""
            }
        );
    }
    // Position first: moving to another monitor can rescale the window (a DPI change), the size then wins.
    window.set_outer_position(PhysicalPosition::new(fitted.frame.x, fitted.frame.y));
    let target = PhysicalSize::new(
        fitted.frame.width.saturating_sub(frame_w).max(1),
        fitted.frame.height.saturating_sub(frame_h).max(1),
    );
    let reached = set_inner_size_exact(window, target);
    log::debug!(
        "window: {}×{} at ({}, {}){}",
        reached.width,
        reached.height,
        fitted.frame.x,
        fitted.frame.y,
        if saved.is_some() {
            ""
        } else {
            " (nothing saved)"
        }
    );
    if let Some(s) = saved {
        if s.maximized {
            window.maximize();
        }
        if s.fullscreen {
            window.set_fullscreen();
        }
    }
}

/// [`restore_with`] the main window's saved entry in `file`.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, file: Option<&Path>) {
    let saved = file
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|json| Saved::parse(&json));
    restore_with(window, saved);
}

impl<R: Runtime> Geometry for WebviewWindow<R> {
    fn inner_size(&self) -> Option<PhysicalSize<u32>> {
        WebviewWindow::inner_size(self)
            .map_err(|e| log::debug!("window: inner_size: {e}"))
            .ok()
    }

    fn outer_size(&self) -> Option<PhysicalSize<u32>> {
        WebviewWindow::outer_size(self)
            .map_err(|e| log::debug!("window: outer_size: {e}"))
            .ok()
    }

    fn outer_position(&self) -> Option<PhysicalPosition<i32>> {
        WebviewWindow::outer_position(self)
            .map_err(|e| log::debug!("window: outer_position: {e}"))
            .ok()
    }

    fn set_inner_size(&self, size: PhysicalSize<u32>) {
        if let Err(e) = self.set_size(size) {
            log::warn!("window: set_size: {e}");
        }
    }

    fn set_outer_position(&self, position: PhysicalPosition<i32>) {
        if let Err(e) = self.set_position(position) {
            log::warn!("window: set_position: {e}");
        }
    }

    #[cfg(windows)]
    fn settle_frame(&self) {
        use windows::Win32::UI::WindowsAndMessaging::{
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
            SWP_NOZORDER, SetWindowPos,
        };
        let hwnd = match self.hwnd() {
            Ok(hwnd) => hwnd,
            Err(e) => {
                log::debug!("window: no handle to settle the frame ({e})");
                return;
            }
        };
        // SAFETY: `hwnd` is this live window; the call only recalculates its frame (`WM_NCCALCSIZE`): nothing moves,
        // resizes, reorders or activates.
        let settled = unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE,
            )
        };
        if let Err(e) = settled {
            log::debug!("window: settling the frame: {e}");
        }
    }

    #[cfg(not(windows))]
    fn settle_frame(&self) {}

    fn work_areas(&self) -> (Vec<Rect>, Option<usize>) {
        let monitors = self.available_monitors().unwrap_or_default();
        let primary = self.primary_monitor().ok().flatten();
        let areas: Vec<Rect> = monitors
            .iter()
            .map(|m| {
                let a = m.work_area();
                Rect {
                    x: a.position.x,
                    y: a.position.y,
                    width: a.size.width,
                    height: a.size.height,
                }
            })
            .collect();
        let primary = primary.and_then(|p| {
            monitors
                .iter()
                .position(|m| m.position() == p.position() && m.size() == p.size())
        });
        (areas, primary)
    }

    fn maximize(&self) {
        if let Err(e) = WebviewWindow::maximize(self) {
            log::warn!("window: maximize: {e}");
        }
    }

    fn set_fullscreen(&self) {
        if let Err(e) = WebviewWindow::set_fullscreen(self, true) {
            log::warn!("window: set_fullscreen: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use std::cell::Cell;

    use super::*;

    const fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// The review machine: 2560×1440 at 150 %, a 48 px taskbar at the bottom.
    const WORK: Rect = rect(0, 0, 2560, 1392);

    #[test]
    fn a_window_that_fits_stays_where_it_was() {
        let wanted = rect(300, 20, 2160, 1350);
        let fitted = fit(wanted, &[WORK], Some(0)).unwrap();
        assert_eq!(fitted.frame, wanted);
        assert!(!fitted.recentred);
    }

    #[test]
    fn a_window_taller_than_the_screen_is_shrunk_into_the_work_area() {
        // The drifted state found on the review machine: 2160×6140 physical.
        let fitted = fit(rect(200, 40, 2160, 6140), &[WORK], Some(0)).unwrap();
        assert_eq!(fitted.frame, rect(200, 0, 2160, 1392));
        // Sticking out at the bottom right: moved inside, size kept.
        let fitted = fit(rect(1800, 1000, 1000, 600), &[WORK], Some(0)).unwrap();
        assert_eq!(fitted.frame, rect(1560, 792, 1000, 600));
        // Above or left of the area: moved inside.
        let fitted = fit(rect(-50, -30, 800, 600), &[WORK], Some(0)).unwrap();
        assert_eq!(fitted.frame, rect(0, 0, 800, 600));
    }

    #[test]
    fn a_window_on_no_monitor_is_centred_on_the_primary_one() {
        let second = rect(2560, 0, 1920, 1040);
        let fitted = fit(rect(9000, 9000, 1000, 800), &[second, WORK], Some(1)).unwrap();
        assert!(fitted.recentred);
        assert_eq!(fitted.frame, rect(780, 296, 1000, 800));
        // Without a known primary monitor: the first one.
        let fitted = fit(rect(-9000, 0, 4000, 800), &[second, WORK], None).unwrap();
        assert_eq!(fitted.frame, rect(2560, 120, 1920, 800));
        assert!(fit(rect(0, 0, 10, 10), &[], None).is_none());
    }

    #[test]
    fn a_window_across_two_monitors_goes_to_the_one_it_covers_most() {
        let second = rect(2560, 0, 1920, 1040);
        // 300 px on the first monitor, 900 px on the second.
        let fitted = fit(rect(2260, 100, 1200, 700), &[WORK, second], Some(0)).unwrap();
        assert_eq!(fitted.frame, rect(2560, 100, 1200, 700));
    }

    #[test]
    fn the_plugin_file_is_read_leniently() {
        let json = r#"{
          "main": { "width": 2160, "height": 1466, "x": 120, "y": 40, "prev_x": 7, "prev_y": 8,
                    "maximized": true, "visible": true, "decorated": false, "fullscreen": false },
          "other": { "width": 1, "height": 1 }
        }"#;
        let saved = Saved::parse(json).unwrap();
        assert_eq!((saved.width, saved.height), (2160, 1466));
        assert_eq!(saved.position(), (7, 8), "maximised: the position before");
        assert!(saved.maximized && !saved.fullscreen);
        // No main entry, the plugin's empty default entry, or garbage: nothing to restore.
        assert_eq!(Saved::parse(r#"{"other":{"width":5,"height":5}}"#), None);
        assert_eq!(Saved::parse(r#"{"main":{"width":0,"height":0}}"#), None);
        assert_eq!(Saved::parse("not json"), None);
        assert_eq!(
            Saved::parse(r#"{"main":{"width":10,"height":20}}"#).map(|s| s.position()),
            Some((0, 0))
        );
    }

    #[test]
    fn the_saved_flags_never_include_visibility_or_decorations() {
        assert!(SAVED_FLAGS.contains(StateFlags::SIZE | StateFlags::POSITION));
        assert!(SAVED_FLAGS.contains(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN));
        assert!(!SAVED_FLAGS.intersects(StateFlags::VISIBLE | StateFlags::DECORATIONS));
    }

    /// A window as tao makes it on Windows 11 at 150 % (undecorated, with shadow), or a platform that overshoots:
    /// - The client area is the window less `insets` (tao's `WM_NCCALCSIZE`: 11 px at the sides and bottom, 2 px on top),
    ///   but until the frame is first calculated (a resize, a show, [`Geometry::settle_frame`]) a new window reports it
    ///   `caption` px shorter, as for a captioned window.
    /// - `set_inner_size` adds the current window-minus-client offset to the size asked for (tao's `set_inner_size`),
    ///   plus `sticky` px; a size that does not change leaves the frame as it is (`SetWindowPos` sends no
    ///   `WM_NCCALCSIZE` then).
    struct DriftingWindow {
        outer: Cell<PhysicalSize<u32>>,
        position: Cell<PhysicalPosition<i32>>,
        insets: PhysicalSize<u32>,
        caption: u32,
        stale: Cell<bool>,
        sticky: u32,
        areas: Vec<Rect>,
        maximized: Cell<bool>,
    }

    impl DriftingWindow {
        /// The config's 1440×940 window (2160×1410 physical) as tao creates it, hidden, its frame not yet calculated.
        fn tao() -> Self {
            Self::new(PhysicalSize::new(22, 13), 43, 0)
        }

        fn new(insets: PhysicalSize<u32>, caption: u32, sticky: u32) -> Self {
            Self {
                outer: Cell::new(PhysicalSize::new(2160 + insets.width, 1410 + insets.height)),
                position: Cell::new(PhysicalPosition::new(200, 0)),
                insets,
                caption,
                stale: Cell::new(caption > 0),
                sticky,
                areas: vec![WORK],
                maximized: Cell::new(false),
            }
        }

        /// The same window on a monitor with this work area.
        fn on(mut self, area: Rect) -> Self {
            self.areas = vec![area];
            self
        }

        fn inner(&self) -> PhysicalSize<u32> {
            self.inner_size().unwrap()
        }

        /// The first show calculates the frame.
        fn show(&self) {
            self.stale.set(false);
        }

        /// What the window-state plugin saves on exit (the window was shown).
        fn save(&self) -> Saved {
            self.show();
            let size = self.inner();
            let pos = self.position.get();
            Saved {
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                ..Saved::default()
            }
        }
    }

    impl Geometry for DriftingWindow {
        fn inner_size(&self) -> Option<PhysicalSize<u32>> {
            let outer = self.outer.get();
            let stale = if self.stale.get() { self.caption } else { 0 };
            Some(PhysicalSize::new(
                outer.width - self.insets.width,
                outer.height - self.insets.height - stale,
            ))
        }
        fn outer_size(&self) -> Option<PhysicalSize<u32>> {
            Some(self.outer.get())
        }
        fn outer_position(&self) -> Option<PhysicalPosition<i32>> {
            Some(self.position.get())
        }
        fn set_inner_size(&self, size: PhysicalSize<u32>) {
            let (outer, inner) = (self.outer.get(), self.inner());
            let next = PhysicalSize::new(
                size.width + (outer.width - inner.width),
                size.height + (outer.height - inner.height) + self.sticky,
            );
            if next != outer {
                self.outer.set(next);
                self.stale.set(false);
            }
        }
        fn set_outer_position(&self, position: PhysicalPosition<i32>) {
            self.position.set(position);
        }
        fn settle_frame(&self) {
            self.stale.set(false);
        }
        fn work_areas(&self) -> (Vec<Rect>, Option<usize>) {
            (self.areas.clone(), Some(0))
        }
        fn maximize(&self) {
            self.maximized.set(true);
        }
        fn set_fullscreen(&self) {}
    }

    /// The machine the drift was reproduced on: 3840×2160 at 150 %, a 72 px taskbar.
    const LARGE: Rect = rect(0, 0, 3840, 2088);

    /// The regression: save → restore → save, launch after launch, keeps the size. It grew by the caption (43 physical
    /// px at 150 %) on every launch, and in the real app it alternated between two sizes: 1410 (the config's) restored
    /// as 1367, then 1367 (what a new window misreports) left as it was and shown as 1410.
    #[test]
    fn save_restore_save_keeps_the_size_across_launches() {
        for start in [1410, 1367, 1300] {
            let mut saved = Saved {
                width: 2160,
                height: start,
                x: 840,
                y: 339,
                ..Saved::default()
            };
            for launch in 0..5 {
                // Each launch creates the window afresh at the config size, then restores.
                let window = DriftingWindow::tao().on(LARGE);
                restore_with(&window, Some(saved));
                let next = window.save();
                assert_eq!(
                    (next.width, next.height, next.x, next.y),
                    (2160, start, 840, 339),
                    "from {start}, launch {launch}"
                );
                saved = next;
            }
        }
    }

    #[test]
    fn a_new_window_misreports_its_size_until_its_frame_is_settled() {
        // Why `restore_with` settles the frame first: asked for the very size the new window misreports, `set_size`
        // changes nothing and looks exact, and the first show then makes the window 43 px taller.
        let window = DriftingWindow::tao().on(LARGE);
        let stale = window.inner();
        assert_eq!(stale, PhysicalSize::new(2160, 1367));
        assert_eq!(set_inner_size_exact(&window, stale), stale);
        window.show();
        assert_eq!(window.inner(), PhysicalSize::new(2160, 1410));
        // Settled first, the same request is what the window shows.
        let window = DriftingWindow::tao().on(LARGE);
        window.settle_frame();
        assert_eq!(set_inner_size_exact(&window, stale), stale);
        window.show();
        assert_eq!(window.inner(), stale);
    }

    #[test]
    fn a_restored_window_never_exceeds_the_work_area_even_with_a_frame() {
        // A decorated window (Linux/macOS-like: a 4 px border around the client area) saved far too tall.
        let window = DriftingWindow::new(PhysicalSize::new(8, 8), 0, 0);
        restore_with(
            &window,
            Some(Saved {
                width: 2000,
                height: 6140,
                x: 0,
                y: 0,
                ..Saved::default()
            }),
        );
        assert_eq!(window.outer.get().height, WORK.height);
        assert_eq!(window.inner().height, WORK.height - 8);
        assert_eq!(window.position.get(), PhysicalPosition::new(0, 0));
    }

    #[test]
    fn the_first_launch_fits_the_config_size_and_maximised_state_is_restored() {
        // Nothing saved: the config's 940 logical px at 150 % (1410 physical, 1423 with the frame) is taller than the
        // 1392 px work area.
        let window = DriftingWindow::tao();
        restore_with(&window, None);
        assert_eq!(window.outer.get(), PhysicalSize::new(2182, 1392));
        assert_eq!(window.inner(), PhysicalSize::new(2160, 1379));
        assert!(!window.maximized.get());
        // On a larger screen the config size is kept as it is.
        let window = DriftingWindow::tao().on(LARGE);
        restore_with(&window, None);
        window.show();
        assert_eq!(window.inner(), PhysicalSize::new(2160, 1410));
        // A maximised window comes back at its earlier place, then maximised.
        let window = DriftingWindow::tao();
        restore_with(
            &window,
            Some(Saved {
                width: 1600,
                height: 1000,
                x: -8,
                y: -8,
                prev_x: 100,
                prev_y: 80,
                maximized: true,
                fullscreen: false,
            }),
        );
        assert_eq!(window.position.get(), PhysicalPosition::new(100, 80));
        assert_eq!(window.inner(), PhysicalSize::new(1600, 1000));
        assert!(window.maximized.get());
    }

    #[test]
    fn set_inner_size_exact_reaches_the_size_asked_for() {
        let want = PhysicalSize::new(800, 600);
        // An exact platform.
        let window = DriftingWindow::new(PhysicalSize::new(0, 0), 0, 0);
        assert_eq!(set_inner_size_exact(&window, want), want);
        // tao with a stale frame: the first request is skewed by the phantom caption, the second is exact.
        let window = DriftingWindow::tao();
        assert_eq!(set_inner_size_exact(&window, want), want);
        // A platform that overshoots by 43 px every time.
        let window = DriftingWindow::new(PhysicalSize::new(0, 0), 0, 43);
        assert_eq!(set_inner_size_exact(&window, want), want);
    }
}
