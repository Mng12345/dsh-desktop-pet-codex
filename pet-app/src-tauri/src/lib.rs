//! The pet window: a transparent, always-on-top, click-through-until-hovered
//! frame that renders whatever the Host half publishes.
//!
//! The split mirrors the plugin: this process owns only window mechanics and
//! one piece of state (the endpoint it was told about). It never talks to the
//! Harness; the frontend does that over the loopback bridge.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

/// How often the pointer is sampled to decide whether the window is hovered.
/// Fast enough to feel immediate, slow enough to be free.
const CURSOR_POLL: Duration = Duration::from_millis(110);

/// The executable name whose main window a session click should raise.
const APP_PROCESS_NAME: &str = "DeepSeek Harness.exe";

/// Raising another application's window is inherently platform work.
#[cfg(windows)]
mod platform {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::time::Duration;

    use super::{FocusOutcome, FocusStatus};

    type Handle = *mut core::ffi::c_void;

    /// `ShowWindow`'s "restore from minimized" and "show in place".
    ///
    /// `SW_RESTORE` is not a raise: on a maximized or fullscreen window it
    /// un-maximizes it back to the placement it had before. It is only ever
    /// correct for a window that is minimized, which is why the caller checks
    /// `IsIconic` first.
    const SW_RESTORE: i32 = 9;
    const SW_SHOW: i32 = 5;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    /// A window smaller than this is a helper, not the application.
    const MIN_WIDTH: i32 = 400;
    const MIN_HEIGHT: i32 = 300;
    /// `GetWindow`'s owner index, and the extended style that marks a tool window.
    const GW_OWNER: u32 = 4;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(Handle, isize) -> i32, param: isize) -> i32;
        fn IsWindowVisible(window: Handle) -> i32;
        fn IsIconic(window: Handle) -> i32;
        fn IsZoomed(window: Handle) -> i32;
        fn GetWindowRect(window: Handle, rect: *mut Rect) -> i32;
        fn GetWindowThreadProcessId(window: Handle, pid: *mut u32) -> u32;
        fn GetClassNameW(window: Handle, buffer: *mut u16, capacity: i32) -> i32;
        fn GetWindow(window: Handle, command: u32) -> Handle;
        fn GetWindowLongPtrW(window: Handle, index: i32) -> isize;
        fn ShowWindow(window: Handle, command: i32) -> i32;
        fn SetForegroundWindow(window: Handle) -> i32;
        fn GetForegroundWindow() -> Handle;
        fn AttachThreadInput(attach: u32, attach_to: u32, attach_flag: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn GetCurrentThreadId() -> u32;
    }

    /// The executable path backing a process id, or `None` when not readable.
    fn process_image(pid: u32) -> Option<OsString> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buffer = [0u16; 512];
            let mut length = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            Some(OsString::from_wide(&buffer[..length as usize]))
        }
    }

    /// How promising a window is as the one to raise: lower wins.
    ///
    /// The ranks are the three placements a click can find the main window in,
    /// in the order they should be preferred. The old filter began with
    /// "visible and at least 400x300", which quietly excluded the one case a
    /// click needs to fix — a minimized window, whose rect is the icon's
    /// off-screen placeholder rather than a size.
    const RANK_VISIBLE: u8 = 0;
    const RANK_MINIMIZED: u8 = 1;
    const RANK_HIDDEN: u8 = 2;

    /// Whether the window is an Electron browser window rather than a helper
    /// the same process happens to own.
    ///
    /// Only consulted for minimized and hidden candidates. The DSH process also
    /// owns a hidden `ConsoleWindowClass` window for the shells it spawns, and a
    /// click must never show that one. Every Electron `BrowserWindow` uses
    /// Chromium's fixed window class, hidden or not.
    fn is_browser_window(window: Handle) -> bool {
        let mut buffer = [0u16; 64];
        let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length <= 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&buffer[..length as usize]);
        class.starts_with("Chrome_WidgetWin")
    }

    /// A window that could be the main window of `process_name`, and its rank.
    ///
    /// Three filters, each excluding a real window this process actually owns:
    ///
    /// - **No owner.** DSH's policy-login window is a `BrowserWindow` created
    ///   with a `parent`, so it carries an owner; the main window is created
    ///   without one. This is the filter that matters, because the login window
    ///   is 720x760 and would otherwise pass every other test.
    /// - **Not a tool window.** The modal overlay sets `skipTaskbar`, which is
    ///   `WS_EX_TOOLWINDOW`, and a tool window is never the application.
    /// - **At least 400x300, unless minimized.** The floor excludes the small
    ///   windows Electron uses for utilities; a minimized window is exempt
    ///   because its rect is the taskbar icon's off-screen placeholder.
    ///
    /// Hidden windows are candidates too: a window closed to the tray keeps its
    /// real placement (and its size passes the floor), but it is ranked last so
    /// a visible window is always preferred over a hidden helper.
    fn candidate(window: Handle, process_name: &str) -> Option<(u8, i64)> {
        unsafe {
            if !GetWindow(window, GW_OWNER).is_null() {
                return None;
            }
            if GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW != 0 {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if pid == 0 {
                return None;
            }
            let belongs = match process_image(pid) {
                Some(path) => path
                    .to_string_lossy()
                    .rsplit(['\\', '/'])
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case(process_name)),
                None => false,
            };
            if !belongs {
                return None;
            }
            // Checked before the rect: a minimized window reports the icon's
            // placeholder (-32000,-32000 160x28), which says nothing about
            // whether this is the main window.
            if IsIconic(window) != 0 {
                return is_browser_window(window).then_some((RANK_MINIMIZED, 0));
            }
            let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(window, &mut rect) == 0 {
                return None;
            }
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width < MIN_WIDTH || height < MIN_HEIGHT {
                return None;
            }
            let area = i64::from(width) * i64::from(height);
            if IsWindowVisible(window) == 0 {
                return is_browser_window(window).then_some((RANK_HIDDEN, area));
            }
            Some((RANK_VISIBLE, area))
        }
    }

    /// The value threaded through the enumeration callback.
    struct Search<'a> {
        process_name: &'a str,
        found: Handle,
        found_rank: u8,
        found_area: i64,
    }

    extern "system" fn visit(window: Handle, param: isize) -> i32 {
        let search = unsafe { &mut *(param as *mut Search<'_>) };
        if let Some((rank, area)) = candidate(window, search.process_name) {
            let better = rank < search.found_rank
                || (rank == search.found_rank && area > search.found_area);
            if better {
                search.found = window;
                search.found_rank = rank;
                search.found_area = area;
            }
        }
        // Keep enumerating: several windows can pass the filters, and the one
        // worth raising is the best-ranked (then the largest) rather than the
        // topmost, which during a modal is not the main window.
        1
    }

    /// How long to let the shell settle before the second attempt.
    ///
    /// A raise is refused when the pet is not the foreground process at the
    /// instant it asks, and the click that triggers it is often still being
    /// routed when the command runs. Waiting briefly is what turns that race
    /// into a success rather than a line of text in the roster.
    const SETTLE: Duration = Duration::from_millis(60);

    /// Raise the application's main window without changing its geometry.
    ///
    /// `SetForegroundWindow` only succeeds for a process the shell already
    /// considers foreground-eligible, which a window the user just clicked
    /// qualifies as — this is called from the pet, in response to a click on it.
    /// It can still be refused, which is why the outcome is returned rather than
    /// assumed: the session switches either way, and the pet says so.
    ///
    /// **Placement is only touched when the window has none** — a minimized
    /// window is restored (to the state it was minimized from), a tray-hidden
    /// one is shown in place, and a visible window is raised by
    /// `SetForegroundWindow` alone. Calling `ShowWindow(SW_RESTORE)`
    /// unconditionally was the bug that shrank a maximized or fullscreen window
    /// on every click: `SW_RESTORE` *un-maximizes*. DSH's own second-launch
    /// path has the same rule (`restore()` only when minimized).
    ///
    /// Three things make a refusal rarer, in the order they are tried:
    ///
    /// - **The window is already in front.** That is success, not failure, and
    ///   the shell may answer either way for it, so it is asked first.
    /// - **A second attempt after the click has settled.** The pet's own window
    ///   becomes foreground as the click is processed; asking again once that
    ///   has happened is what the user's gesture actually earns.
    /// - **Attaching to the foreground thread.** Sharing its input queue is the
    ///   documented way for a process that is not foreground to be allowed to
    ///   set the foreground window, and it is the case that made the message
    ///   appear even though the user had just clicked the pet.
    ///
    /// The placement the window had *before* the attempt is part of every
    /// reason string, because "was maximized and still is" cannot be read from
    /// a log otherwise.
    pub fn focus_application(process_name: &str) -> FocusOutcome {
        let mut search = Search {
            process_name,
            found: core::ptr::null_mut(),
            found_rank: u8::MAX,
            found_area: 0,
        };
        unsafe {
            EnumWindows(visit, &mut search as *mut Search<'_> as isize);
            if search.found.is_null() {
                return FocusOutcome::new(FocusStatus::NotFound, "no eligible window");
            }
            let target = search.found;
            let state = window_state(target);
            if GetForegroundWindow() == target {
                return FocusOutcome::new(
                    FocusStatus::AlreadyFront,
                    &format!("already foreground (window {state})"),
                );
            }
            if IsIconic(target) != 0 {
                ShowWindow(target, SW_RESTORE);
            } else if IsWindowVisible(target) == 0 {
                // Showing keeps the placement a hidden window already has, so a
                // window closed to the tray comes back at the size it left.
                ShowWindow(target, SW_SHOW);
            }
            if SetForegroundWindow(target) != 0 {
                return FocusOutcome::new(
                    FocusStatus::Raised,
                    &format!("raised on the first attempt (window {state})"),
                );
            }
            std::thread::sleep(SETTLE);
            if SetForegroundWindow(target) != 0 {
                return FocusOutcome::new(
                    FocusStatus::Raised,
                    &format!("raised after the click settled (window {state})"),
                );
            }
            if raise_through_foreground_thread(target) {
                return FocusOutcome::new(
                    FocusStatus::Raised,
                    &format!("raised with the foreground thread (window {state})"),
                );
            }
            // Worth recording: a refusal happens because of *who owns the
            // foreground*, and which window that was is the whole diagnosis.
            FocusOutcome::new(
                FocusStatus::Refused,
                &format!("the shell refused every attempt (window {state})"),
            )
            .with_foreground(describe_foreground())
        }
    }

    /// How the window is placed right now, for the log line.
    ///
    /// Minimized is decided first: a minimized window still reports itself
    /// visible, and it is the minimized state that decides whether restoring is
    /// allowed at all.
    unsafe fn window_state(window: Handle) -> &'static str {
        if IsIconic(window) != 0 {
            "minimized"
        } else if IsWindowVisible(window) == 0 {
            "hidden"
        } else if IsZoomed(window) != 0 {
            "maximized"
        } else {
            "normal"
        }
    }

    /// The process name owning the foreground window, for the log line.
    ///
    /// `(none)` means no window held the foreground at all, which is what the
    /// desktop shows mid-transition; a name means some other application did.
    unsafe fn describe_foreground() -> String {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return "(none)".to_string();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(foreground, &mut pid);
        if pid == 0 {
            return "(none)".to_string();
        }
        match process_image(pid) {
            Some(path) => path
                .to_string_lossy()
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or("(unknown)")
                .to_string(),
            None => format!("pid {pid}"),
        }
    }

    /// Ask again with the foreground thread's input queue attached.
    ///
    /// A process the shell does not consider foreground is not allowed to set
    /// the foreground window. Attaching to the thread that *is* foreground
    /// shares that right for the duration of the call — and the attachment is
    /// dropped again immediately, so nothing about the pet's own input changes.
    unsafe fn raise_through_foreground_thread(target: Handle) -> bool {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return false;
        }
        let mut pid = 0u32;
        let foreground_thread = GetWindowThreadProcessId(foreground, &mut pid);
        let own_thread = GetCurrentThreadId();
        if foreground_thread == 0 || foreground_thread == own_thread {
            return false;
        }
        AttachThreadInput(foreground_thread, own_thread, 1);
        let raised = SetForegroundWindow(target) != 0;
        AttachThreadInput(foreground_thread, own_thread, 0);
        raised
    }
}

#[cfg(not(windows))]
mod platform {
    /// Only the Windows shell is implemented; elsewhere a click just opens DSH.
    pub fn focus_application(_process_name: &str) -> FocusOutcome {
        FocusOutcome::new(FocusStatus::Refused, "only implemented on windows")
    }
}

/// How a request to bring the DSH window forward ended.
///
/// Three of these are successes the reader should not hear about; only
/// [`FocusStatus::Refused`] is worth a line in the roster.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusStatus {
    /// The window was already in front, so there was nothing to do.
    AlreadyFront,
    /// The window was brought forward.
    Raised,
    /// No window of the DSH process passed the filters.
    NotFound,
    /// A window was found and the shell would not let it come forward.
    Refused,
}

/// What happened, and why — the reason is logged rather than shown.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusOutcome {
    pub status: FocusStatus,
    pub reason: String,
    /// The process that held the foreground when a raise was refused, if any.
    ///
    /// Only present on [`FocusStatus::Refused`], and only because that is the
    /// one answer that cannot be explained without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
}

impl FocusOutcome {
    fn new(status: FocusStatus, reason: &str) -> Self {
        Self { status, reason: reason.to_string(), foreground: None }
    }

    /// Record who owned the foreground, for a refusal.
    fn with_foreground(mut self, foreground: String) -> Self {
        self.foreground = Some(foreground);
        self
    }

    /// Whether the window is now in front, however it got there.
    pub fn is_front(&self) -> bool {
        matches!(self.status, FocusStatus::AlreadyFront | FocusStatus::Raised)
    }
}

/// Where the Host half is listening, as passed on the command line.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Endpoint {
    pub url: String,
    pub token: Option<String>,
}

/// The pet's interactive area inside the window, in logical pixels.
///
/// Everything outside it — the transparent margin the sprite does not fill —
/// stays click-through, so the window never blocks the desktop underneath.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A remembered window position, in physical pixels.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

/// Window mechanics state. The frontend owns what is drawn; this owns where.
#[derive(Default)]
pub struct PetState {
    endpoint: Endpoint,
    hit: Mutex<Option<HitRect>>,
    click_through: Mutex<bool>,
}

/// This app's private state directory, matching the Host half's layout.
fn state_dir() -> PathBuf {
    let dsh_home = std::env::var("DSH_HOME").ok();
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    let base = match dsh_home {
        Some(explicit) => PathBuf::from(explicit),
        None => PathBuf::from(home).join(".dsh"),
    };
    base.join("desktop-pet-codex")
}

/// Read the endpoint the Host advertised, for a pet started on its own.
fn discover_endpoint() -> Endpoint {
    let path = state_dir().join("endpoint.json");
    let Ok(text) = fs::read_to_string(path) else {
        return Endpoint::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Endpoint::default();
    };
    Endpoint {
        url: value
            .get("url")
            .and_then(|url| url.as_str())
            .unwrap_or_default()
            .to_string(),
        token: value
            .get("token")
            .and_then(|token| token.as_str())
            .map(str::to_string),
    }
}

/// Prefer the command line — it is exact — and fall back to discovery.
fn resolve_endpoint() -> Endpoint {
    let mut url: Option<String> = None;
    let mut token: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => url = args.next(),
            "--token" => token = args.next(),
            _ => {}
        }
    }
    match url {
        Some(url) if !url.is_empty() => Endpoint { url, token },
        _ => discover_endpoint(),
    }
}

fn load_position() -> Option<SavedPosition> {
    let text = fs::read_to_string(state_dir().join("window.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn store_position(position: SavedPosition) {
    let dir = state_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(&position) {
        let _ = fs::write(dir.join("window.json"), text);
    }
}

/// The gap between the roster's bottom edge and the pet window's top edge,
/// in logical pixels.
const ROSTER_GAP: f64 = 8.0;

/// Whether two physical coordinates are the same place.
///
/// The pair is kept together by moving one window in response to the other's
/// `Moved` event, so the two directions must agree exactly or they would chase
/// each other forever. Integer division in the two centring calculations can
/// differ by one pixel, and this tolerance is what makes that harmless.
fn same_place(left: (i32, i32), right: (i32, i32)) -> bool {
    (left.0 - right.0).abs() <= 1 && (left.1 - right.1).abs() <= 1
}

/// Where the roster belongs, given where the pet is and how tall the roster is.
fn roster_slot(pet_at: (i32, i32), pet_size: (i32, i32), roster_size: (i32, i32), scale: f64) -> (i32, i32) {
    let x = pet_at.0 + (pet_size.0 - roster_size.0) / 2;
    let y = pet_at.1 - roster_size.1 - (ROSTER_GAP * scale).round() as i32;
    (x, y)
}

/// Hang the roster off the pet's top edge.
///
/// This is the one place the pair's geometry is decided. The pet owns *where*
/// the pair is and the roster owns *how tall* it is, so folding the list moves
/// the roster's top edge down and leaves the pet exactly where the user put it.
fn anchor_roster(app: &AppHandle) {
    let (Some(pet), Some(roster)) = (app.get_webview_window("pet"), app.get_webview_window("roster"))
    else {
        return;
    };
    let (Ok(pet_at), Ok(pet_size), Ok(roster_size)) =
        (pet.outer_position(), pet.outer_size(), roster.outer_size())
    else {
        return;
    };
    let scale = pet.scale_factor().unwrap_or(1.0);
    let (x, y) = roster_slot(
        (pet_at.x, pet_at.y),
        (pet_size.width as i32, pet_size.height as i32),
        (roster_size.width as i32, roster_size.height as i32),
        scale,
    );
    if roster
        .outer_position()
        .is_ok_and(|current| same_place((current.x, current.y), (x, y)))
    {
        return;
    }
    let _ = roster.set_position(PhysicalPosition::new(x, y));
}

/// Move the pet so the roster stays anchored to it.
///
/// Dragging the list is therefore dragging the pet: the pair is rigid, and the
/// roster is never independently placeable.
fn follow_roster(app: &AppHandle) {
    let (Some(pet), Some(roster)) = (app.get_webview_window("pet"), app.get_webview_window("roster"))
    else {
        return;
    };
    let (Ok(pet_at), Ok(pet_size), Ok(roster_at), Ok(roster_size)) = (
        pet.outer_position(),
        pet.outer_size(),
        roster.outer_position(),
        roster.outer_size(),
    ) else {
        return;
    };
    let scale = pet.scale_factor().unwrap_or(1.0);
    // The inverse of `roster_slot`.
    let x = roster_at.x + (roster_size.width as i32 - pet_size.width as i32) / 2;
    let y = roster_at.y + roster_size.height as i32 + (ROSTER_GAP * scale).round() as i32;
    if same_place((pet_at.x, pet_at.y), (x, y)) {
        return;
    }
    let _ = pet.set_position(PhysicalPosition::new(x, y));
}

/// Keep the pair together when either window is moved or resized.
///
/// Both branches are no-ops once the other window already sits where the
/// geometry says it should, which is what stops the two `Moved` events from
/// chasing each other around the screen.
fn on_window_moved(app: &AppHandle, label: &str) {
    match label {
        "pet" => anchor_roster(app),
        "roster" => follow_roster(app),
        _ => {}
    }
}


///
/// Sample the pointer and flip click-through so only the pet itself is solid.
///
/// The window cannot learn about the pointer while it is click-through, so the
/// decision is made from the global cursor position instead of from events.
fn spawn_cursor_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CURSOR_POLL);
        let Some(window) = app.get_webview_window("pet") else {
            continue;
        };
        let state = app.state::<PetState>();
        // The guard is released at the end of the match, so the second lock
        // below cannot deadlock against this one.
        let rect = match state.hit.lock() {
            Ok(hit) => *hit,
            Err(_) => continue,
        };
        let Some(rect) = rect else {
            continue;
        };
        let (Ok(cursor), Ok(origin)) = (window.cursor_position(), window.outer_position()) else {
            continue;
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let left = origin.x as f64 + rect.x * scale;
        let top = origin.y as f64 + rect.y * scale;
        let hovered = cursor.x >= left
            && cursor.x <= left + rect.width * scale
            && cursor.y >= top
            && cursor.y <= top + rect.height * scale;
        let desired = !hovered;
        let Ok(mut current) = state.click_through.lock() else {
            continue;
        };
        if *current != desired {
            let _ = window.set_ignore_cursor_events(desired);
            *current = desired;
        }
    });
}

/// The endpoint this window should read, or an empty url when none is known.
#[tauri::command]
fn pet_endpoint(state: tauri::State<'_, PetState>) -> Endpoint {
    state.endpoint.clone()
}

/// Declare the interactive area; `None` keeps the whole window click-through.
#[tauri::command]
fn pet_set_hit_rect(state: tauri::State<'_, PetState>, rect: Option<HitRect>) {
    if let Ok(mut hit) = state.hit.lock() {
        *hit = rect;
    }
}

/// Force click-through on or off, bypassing the hover heuristic.
#[tauri::command]
fn pet_set_click_through(
    window: WebviewWindow,
    state: tauri::State<'_, PetState>,
    enabled: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())?;
    if let Ok(mut current) = state.click_through.lock() {
        *current = enabled;
    }
    Ok(())
}

/// Begin a native window drag, so the pet follows the pointer without JS math.
///
/// The roster calls this too: the pair is rigid, so dragging the list drags the
/// pet and the list follows through `follow_roster`.
#[tauri::command]
fn pet_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

/// Resize the frame, keeping the top-left corner where it is.
///
/// The frontend measures the card after every render and asks for exactly that
/// size, so `petScale` and the list toggle change the frame rather than leaving
/// a transparent area that would still swallow clicks.
#[tauri::command]
fn pet_set_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let size = LogicalSize::new(width.max(48.0), height.max(48.0));
    window.set_size(size).map_err(|error| error.to_string())
}

/// Resize the roster and re-hang it in the same breath.
///
/// A plain resize keeps the top-left corner, which would grow the list down over
/// the pet for a frame before the `Resized` hook moved it back. Folding is the
/// common case, so it is worth doing in one step.
#[tauri::command]
fn roster_set_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("roster")
        .ok_or_else(|| "the roster window is not configured".to_string())?;
    window
        .set_size(LogicalSize::new(width.max(48.0), height.max(48.0)))
        .map_err(|error| error.to_string())?;
    anchor_roster(&app);
    Ok(())
}

/// Keep both frames above other windows, or let them fall behind together.
#[tauri::command]
fn pet_set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    for label in ["pet", "roster"] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .set_always_on_top(enabled)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Show or hide the pair without ending the process.
///
/// Hiding must not tear anything down: both pages keep their event streams and
/// their last snapshots, so showing them again is instant and needs no
/// reconnect. The roster is re-hung before it appears, so it never flashes in
/// the wrong place.
#[tauri::command]
fn pet_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        anchor_roster(&app);
    }
    for label in ["pet", "roster"] {
        if let Some(window) = app.get_webview_window(label) {
            let result = if visible { window.show() } else { window.hide() };
            result.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Show or hide the roster on its own.
///
/// `pet_set_visible` is a command for the pair, but `showSessionList: false`
/// means "just the pet" — which is now literally the roster window not being
/// there. Only the roster page knows the combination of that setting with the
/// pair's own visibility, so it is the page that decides this.
#[tauri::command]
fn roster_set_shown(app: AppHandle, shown: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("roster")
        .ok_or_else(|| "the roster window is not configured".to_string())?;
    if shown {
        // Re-hang before appearing so it never flashes in the wrong place.
        anchor_roster(&app);
        window.show().map_err(|error| error.to_string())
    } else {
        window.hide().map_err(|error| error.to_string())
    }
}

/// Remember where the pair was left.
///
/// Only the pet is stored: the roster's place is derived from it, so saving the
/// roster too would just be a second copy of the same fact.
#[tauri::command]
fn pet_save_position(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "the pet window is not configured".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    store_position(SavedPosition {
        x: position.x,
        y: position.y,
    });
    Ok(())
}

/// End the pet process.
///
/// No longer reachable from the interface: closing the pair *is* hiding it, and
/// the process is meant to outlive the interface. It stays as the escape hatch
/// for a stuck window (`Stop-Process -Name dsh-desktop-pet` is the same thing),
/// and the Host's own teardown ends the child directly when the row is disabled.
#[tauri::command]
fn pet_quit(app: AppHandle) {
    app.exit(0);
}

/// Show the settings window and bring it to the front.
///
/// It is created hidden at startup rather than on demand, so opening it is a
/// show rather than a window construction: the page has already loaded and
/// already knows the settings in force.
#[tauri::command]
fn pet_open_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "the settings window is not configured".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Hide the settings window, keeping it loaded for next time.
#[tauri::command]
fn pet_close_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "the settings window is not configured".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

/// Bring the DSH desktop window to the front.
///
/// The Host half cannot do this: it is a separate Node process, and the window
/// belongs to the Electron shell. The pet can, because it is an ordinary
/// Windows application, so raising another application's window is exactly the
/// kind of thing it is allowed to do.
///
/// The window is identified by its **owning process**, not its title: the title
/// is `<session title> — DeepSeek Harness` and changes with whatever is open,
/// while the executable name does not.
///
/// The raise is not allowed to *change* the window along the way. Restoring is
/// only correct for a window that is actually put away: `SW_RESTORE` on a
/// maximized window un-maximizes it, which is how a click on the pet used to
/// hand back a DSH window that had been full-screen a moment earlier. So the
/// platform layer restores only a minimized window, shows only a hidden one, and
/// otherwise asks for nothing but the foreground.
///
/// The outcome is returned rather than a bare boolean because "already in front"
/// and "raised" are both successes the reader should not hear about, while a
/// refusal is worth saying. Every attempt is also appended to
/// `%LOCALAPPDATA%\ai.deepseek.dsh.desktop-pet-codex\focus.log`, because a
/// refusal that happens once a day cannot be diagnosed from a line of interface
/// text.
#[tauri::command]
fn pet_focus_app(app: AppHandle) -> FocusOutcome {
    let outcome = platform::focus_application(APP_PROCESS_NAME);
    record_focus(&app, &outcome);
    outcome
}

/// Append one focus attempt to the pet's log.
///
/// Best effort by design: a pet that cannot write its log still has to raise
/// windows, so every failure here is ignored rather than surfaced.
fn record_focus(app: &AppHandle, outcome: &FocusOutcome) {
    let Ok(directory) = app.path().app_local_data_dir() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let line = format!(
        "{} {:?} {}{}\n",
        timestamp(),
        outcome.status,
        outcome.reason,
        match &outcome.foreground {
            Some(name) => format!(" (foreground: {name})"),
            None => String::new(),
        }
    );
    let path = directory.join("focus.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

/// The wall clock, as `HH:MM:SS.mmm` since the process started.
///
/// Deliberately not a date: the log is read next to the session that produced
/// it, and a monotonic stamp is enough to correlate the two.
fn timestamp() -> String {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    let start = START.get_or_init(Instant::now);
    let elapsed = start.elapsed();
    format!(
        "+{}.{:03}s",
        elapsed.as_secs(),
        elapsed.subsec_millis()
    )
}

/// Keep WebView2's timers running in a window it thinks is in the background.
///
/// Chromium clamps timers to roughly one second in a backgrounded window, and
/// this window is `focus: false` and always-on-top by design — so the pose
/// player's 170 ms blink would be stretched into a stare and its 300 ms typing
/// alternation into a slow shuffle.
///
/// The flags have to arrive through WebView2's environment variable. The same
/// list in `tauri.conf.json`'s `additionalBrowserArgs` makes webview creation
/// fail with `ERROR_INVALID_STATE`, and with `panic = "abort"` that is an
/// immediate process death rather than a recoverable error.
///
/// Existing arguments are kept, so a debugging launch can still add its own
/// (`.ref/cdp.mjs` needs `--remote-debugging-port`).
#[cfg(windows)]
fn unthrottle_background_timers() {
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    const FLAGS: [&str; 3] = [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    ];

    let current = std::env::var(KEY).unwrap_or_default();
    let mut arguments = current.clone();
    for flag in FLAGS {
        if arguments.contains(flag) {
            continue;
        }
        if !arguments.is_empty() {
            arguments.push(' ');
        }
        arguments.push_str(flag);
    }
    if arguments != current {
        std::env::set_var(KEY, arguments);
    }
}

#[cfg(not(windows))]
fn unthrottle_background_timers() {}

/// Build and run the window.
pub fn run() {
    // Before the builder: WebView2 reads this when its environment is created.
    unthrottle_background_timers();

    tauri::Builder::default()
        .manage(PetState {
            endpoint: resolve_endpoint(),
            ..PetState::default()
        })
        .invoke_handler(tauri::generate_handler![
            pet_endpoint,
            pet_set_hit_rect,
            pet_set_click_through,
            pet_start_drag,
            pet_set_size,
            roster_set_size,
            roster_set_shown,
            pet_set_always_on_top,
            pet_set_visible,
            pet_save_position,
            pet_quit,
            pet_open_settings,
            pet_close_settings,
            pet_focus_app,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("pet") {
                if let Some(position) = load_position() {
                    let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
                }
            }
            // The pair's geometry is decided here, not in the pages: both windows
            // report their moves and whichever one the user dragged drives it.
            for label in ["pet", "roster"] {
                let Some(window) = app.get_webview_window(label) else {
                    continue;
                };
                let handle = app.handle().clone();
                let roster = label == "roster";
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Moved(_) => on_window_moved(&handle, label),
                    // Folding changes the roster's height and its bottom edge is
                    // the anchor, so a resize has to re-hang it.
                    tauri::WindowEvent::Resized(_) if roster => anchor_roster(&handle),
                    _ => {}
                });
            }
            anchor_roster(app.handle());
            // The settings window is closed by hiding it, so the next open is
            // instant and the page keeps the settings it already fetched.
            if let Some(settings) = app.get_webview_window("settings") {
                let handle = settings.clone();
                settings.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.hide();
                    }
                });
            }
            spawn_cursor_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop pet: the window failed to start");
}
