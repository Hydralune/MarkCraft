use super::handoff::{Snapshot, parsed_time, uuid};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn executable(name: &str, standard: Option<PathBuf>) -> Option<PathBuf> {
    standard
        .into_iter()
        .chain(
            env::split_paths(&env::var_os("PATH").unwrap_or_default())
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name)),
        )
        .find(|p| p.is_file())
}

pub(super) fn agy_path() -> Option<PathBuf> {
    executable(
        "agy.exe",
        env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("agy/bin/agy.exe")),
    )
}
pub(super) fn node_path() -> Option<PathBuf> {
    executable(
        "node.exe",
        env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("nodejs/node.exe")),
    )
}

pub(super) fn copy(
    history: &Snapshot<'_>,
    cwd: &str,
    gemini: &Path,
    desktop: bool,
) -> io::Result<Value> {
    let agy = agy_path().ok_or_else(|| io::Error::other("请先安装 Antigravity CLI（agy）。"))?;
    let node = node_path()
        .ok_or_else(|| io::Error::other("Antigravity 接续需要 Node.js 22.13 或更高版本。"))?;
    let key = uuid(&serde_json::to_vec(&(
        if desktop {
            "antigravity-desktop-v1"
        } else {
            "antigravity-cli-v2"
        },
        &history.entry.id,
        cwd,
        &history.messages,
    ))?);
    let messages: Vec<_> = history
        .messages
        .iter()
        .map(|m| {
            let at = parsed_time(&m.time)
                .filter(|t| t.unix_timestamp() >= 0)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH);
            json!({"text":m.text,"role":m.role,"time":at.format(&Rfc3339).unwrap()})
        })
        .collect();
    let payload = serde_json::to_vec(
        &json!({"workspace":cwd,"messages":messages,"desktop":desktop,"title":history.title()}),
    )?;
    if payload.len() > 16 * 1024 * 1024 {
        return Err(io::Error::other(
            "对话超过 Antigravity 原文接续的 16 MiB 上限。",
        ));
    }
    let cache = gemini.join("markcraft-handoff");
    fs::create_dir_all(&cache)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(cache.join(format!("{key}.lock")))?;
    lock.try_lock().map_err(|e| match e {
        fs::TryLockError::WouldBlock => {
            io::Error::other("另一个窗口正在接续这个快照，请稍后重试。")
        }
        fs::TryLockError::Error(err) => err,
    })?;
    let tmp = tempfile::tempdir()?;
    let script = tmp.path().join("import.mjs");
    fs::write(
        &script,
        include_bytes!("../../integrations/antigravity-handoff/import.mjs"),
    )?;
    let mut child = Command::new(node)
        .arg(&script)
        .arg(agy)
        .arg(std::path::absolute(gemini)?)
        .arg(key)
        .current_dir(tmp.path())
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let sent = child.stdin.take().unwrap().write_all(&payload);
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        if error.contains("node:sqlite") {
            return Err(io::Error::other(
                "Antigravity 接续需要支持 node:sqlite 的 Node.js 22.13 或更高版本。",
            ));
        }
        return Err(io::Error::other(
            error.trim().chars().take(400).collect::<String>(),
        ));
    }
    sent?;
    Ok(serde_json::from_slice(&output.stdout)?)
}
