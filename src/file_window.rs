use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs, os::windows::ffi::OsStrExt, path::Path, ptr};
use tao::{platform::windows::WindowExtWindows, window::Window};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetPropW, IsIconic, MSG, PostMessageW, RegisterWindowMessageW, RemovePropW,
    SW_RESTORE, SetForegroundWindow, SetPropW, ShowWindow,
};

fn key(data: &Path, file: &Path) -> Option<Vec<u16>> {
    let absolute = fs::canonicalize(file).ok()?;
    let id = format!("{}\n{}", data.display(), absolute.display()).to_lowercase();
    let name = format!("MarkCraft.Document.{:x}", Sha256::digest(id.as_bytes()));
    Some(OsStr::new(&name).encode_wide().chain(Some(0)).collect())
}
fn navigation_message() -> u32 {
    static MESSAGE: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MESSAGE.get_or_init(|| {
        let name: Vec<_> = "MarkCraft.GoToLine.v1"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe { RegisterWindowMessageW(name.as_ptr()) }
    })
}
pub fn requested_line(raw: *const std::ffi::c_void) -> Option<u32> {
    // Tao supplies a valid Win32 MSG for the lifetime of its hook.
    let msg = unsafe { &*raw.cast::<MSG>() };
    (msg.message != 0 && msg.message == navigation_message())
        .then(|| u32::try_from(msg.wParam).ok())
        .flatten()
        .filter(|n| *n > 0)
}
pub fn activate(data: &Path, file: &Path) -> bool {
    activate_at(data, file, 0)
}
pub fn activate_at(data: &Path, file: &Path, line: u64) -> bool {
    let Some(name) = key(data, file) else {
        return false;
    };
    unsafe {
        let mut hwnd = ptr::null_mut();
        loop {
            hwnd = FindWindowExW(ptr::null_mut(), hwnd, ptr::null(), ptr::null());
            if hwnd.is_null() {
                return false;
            }
            if !GetPropW(hwnd, name.as_ptr()).is_null() {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                SetForegroundWindow(hwnd);
                if line > 0 && navigation_message() != 0 {
                    PostMessageW(
                        hwnd,
                        navigation_message(),
                        line.min(u32::MAX as u64) as usize,
                        0,
                    );
                }
                return true;
            }
        }
    }
}
pub fn register(win: &Window, data: &Path, file: Option<&Path>, old: &mut Option<Vec<u16>>) {
    let next = file.and_then(|f| key(data, f));
    if next == *old {
        return;
    }
    let hwnd = win.hwnd() as _;
    unsafe {
        if let Some(name) = old.take() {
            RemovePropW(hwnd, name.as_ptr());
        }
        if let Some(name) = next {
            if SetPropW(hwnd, name.as_ptr(), 1usize as _) != 0 {
                *old = Some(name);
            }
        }
    }
}
