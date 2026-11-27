use super::{Entry, Recipient, Roots, Source, antigravity, codex};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    env, io,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};

impl Entry {
    pub(super) fn native_id(&self) -> Option<&str> {
        match self.source {
            Source::Codex => self.thread_id.as_deref(),
            Source::Claude => self.path.file_stem()?.to_str(),
            Source::Antigravity => self.path.ancestors().nth(3)?.file_name()?.to_str(),
            Source::DeepSeek => self.path.parent()?.file_name()?.to_str(),
        }
    }
}

pub(super) fn valid_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub(super) fn open(entry: &Entry, roots: &Roots) -> io::Result<()> {
    let id = entry
        .native_id()
        .ok_or_else(|| io::Error::other("这条记录缺少原生会话 ID。"))?;
    let dest = match entry.source {
        Source::Codex => {
            if !valid_uuid(id) {
                return Err(io::Error::other("无效的 Codex 会话 ID。"));
            }
            codex::repair_import(&entry.path, id, &roots.codex)?;
            Recipient::Codex
        }
        Source::Claude => Recipient::Claude,
        Source::DeepSeek => Recipient::DeepSeek,
        Source::Antigravity if entry.receiver == Some("antigravitydesktop") => {
            Recipient::AntigravityDesktop
        }
        Source::Antigravity => Recipient::Antigravity,
    };
    open_session(dest, id, &entry.project, &entry.title, roots)
}

pub(super) fn open_session(
    dest: Recipient,
    id: &str,
    project: &str,
    title: &str,
    roots: &Roots,
) -> io::Result<()> {
    let uuid = if dest == Recipient::DeepSeek {
        id.strip_prefix("session-").unwrap_or(id)
    } else {
        id
    };
    if !valid_uuid(uuid) {
        return Err(io::Error::other("这条记录缺少有效的原生会话 ID。"));
    }
    if dest == Recipient::Codex
        && roots.codex.canonicalize()? == Roots::local().codex.canonicalize().unwrap_or_default()
    {
        return open::that(format!("codex://threads/{id}"));
    }
    let cwd = Path::new(project);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(io::Error::other(format!(
            "原工作目录不可用（{}）。可用「接续到…」在现有目录创建副本。",
            project
        )));
    }
    let shell = PathBuf::from(
        env::var_os("SystemRoot").ok_or_else(|| io::Error::other("找不到 Windows PowerShell。"))?,
    )
    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut launch = serde_json::json!({"agent":dest.source(),"title":title,"dir":cwd,"id":id});
    launch["root"] = serde_json::json!(roots.path(dest.source()));
    if dest.source() == Source::Antigravity {
        launch["agy"] = serde_json::json!(
            antigravity::agy_path()
                .ok_or_else(|| io::Error::other("请安装 Antigravity CLI（agy）后重试。"))?
        );
        launch["store"] = serde_json::json!(if dest == Recipient::AntigravityDesktop {
            "antigravity"
        } else {
            "antigravity-cli"
        });
    }
    // Pass untrusted paths and titles as JSON data, never as PowerShell syntax.
    let data = STANDARD.encode(serde_json::to_vec(&launch)?);
    let script = format!(
        "$launch = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{data}')))\n{}",
        include_str!("open-session.ps1")
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let args = format!(
        "-NoLogo -NoProfile -EncodedCommand {}",
        STANDARD.encode(utf16)
    );
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    // Have Windows open an interactive console. Inheriting this GUI process's
    // standard handles would make Claude enter non-interactive mode.
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            wide(shell.as_os_str()).as_ptr(),
            wide(args.as_ref()).as_ptr(),
            wide(cwd.as_os_str()).as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    } as isize;
    if result <= 32 {
        return Err(io::Error::other(format!(
            "Windows 无法打开智能体窗口（{result}）。"
        )));
    }
    Ok(())
}
