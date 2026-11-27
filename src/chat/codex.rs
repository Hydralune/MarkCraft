use super::handoff::{Snapshot, parsed_time, uuid, write_once};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

fn read_config(path: &Path) -> io::Result<toml::Table> {
    match fs::read_to_string(path) {
        Ok(s) => s
            .trim_start_matches('\u{feff}')
            .parse()
            .map_err(|_| io::Error::other(format!("无法解析 Codex 配置 {}", path.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Default::default()),
        Err(e) => Err(e),
    }
}

fn settings(home: &Path) -> io::Result<(String, PathBuf)> {
    let config = read_config(&home.join("config.toml"))?;
    let mut profile = toml::Table::new();
    if let Some(name) = config.get("profile").and_then(toml::Value::as_str) {
        if Path::new(name).file_name().and_then(|n| n.to_str()) != Some(name) {
            return Err(io::Error::other("Codex 配置中的 profile 名称无效。"));
        }
        if let Some(inline) = config
            .get("profiles")
            .and_then(|v| v.get(name))
            .and_then(toml::Value::as_table)
        {
            profile.clone_from(inline);
        }
        profile.extend(read_config(&home.join(format!("{name}.config.toml")))?);
    }
    let setting = |key: &str| {
        profile
            .get(key)
            .or_else(|| config.get(key))
            .and_then(toml::Value::as_str)
    };
    let provider = setting("model_provider").unwrap_or("openai").trim();
    if provider.is_empty() {
        return Err(io::Error::other("Codex 配置中的 model_provider 为空。"));
    }
    let state = std::env::var_os("CODEX_SQLITE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| setting("sqlite_home").map(PathBuf::from))
        .unwrap_or_else(|| home.to_owned());
    Ok((
        provider.to_owned(),
        if state.is_absolute() {
            state
        } else {
            home.join(state)
        },
    ))
}

fn imported_header(input: &mut impl BufRead, id: &str) -> io::Result<Option<Value>> {
    let mut line = Vec::new();
    input.read_until(b'\n', &mut line)?;
    Ok(serde_json::from_slice::<Value>(&line).ok().filter(|v| {
        v["type"] == "session_meta"
            && v["payload"]["id"] == id
            && v["payload"]["originator"] == "markcraft"
    }))
}

// Repair only MarkCraft imports. Hold a handle denying writers while copying the
// untouched suffix, so a native follow-up cannot race the atomic replacement.
pub(super) fn repair_import(path: &Path, id: &str, home: &Path) -> io::Result<()> {
    let Some(header) = imported_header(&mut BufReader::new(File::open(path)?), id)? else {
        return Ok(());
    };
    let (configured, state) = settings(home)?;
    let provider = |v: &Value| {
        v["payload"]["model_provider"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    };
    let actual = if let Some(value) = provider(&header) {
        value
    } else {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE)
            .open(path)
            .map_err(|e| {
                io::Error::other(format!(
                    "无法独占旧会话以补全提供商，请关闭该对话后重试。{e}"
                ))
            })?;
        let mut input = BufReader::new(file);
        let mut header = imported_header(&mut input, id)?
            .ok_or_else(|| io::Error::other("会话已更换，请刷新资料库。"))?;
        if let Some(value) = provider(&header) {
            value
        } else {
            header["payload"]["model_provider"] = json!(configured);
            let mut stage = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
            serde_json::to_writer(&mut stage, &header)?;
            stage.write_all(b"\n")?;
            io::copy(&mut input, &mut stage)?;
            stage
                .as_file()
                .set_modified(input.get_ref().metadata()?.modified()?)?;
            stage.as_file().sync_all()?;
            let stage = stage.into_temp_path();
            let wide = |p: &Path| {
                p.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            // MoveFileEx cannot replace an open destination. ReplaceFileW can
            // replace it while our handle keeps competing appenders out.
            let ok = unsafe {
                windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
                    wide(path).as_ptr(),
                    wide(&stage).as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            configured
        }
    };
    // A desktop client may already have indexed the old header. Reconcile an
    // empty cache entry on retry even if the rollout repair finished earlier.
    super::metadata::fill_codex_provider(&state.join("state_5.sqlite"), id, &actual)
}

fn record(file: &mut File, timestamp: &str, kind: &str, payload: Value) -> io::Result<()> {
    serde_json::to_writer(
        &mut *file,
        &json!({"timestamp":timestamp,"type":kind,"payload":payload}),
    )?;
    file.write_all(b"\n")
}

fn index_title(home: &Path, id: &str, title: &str) -> io::Result<()> {
    let path = home.join("session_index.jsonl");
    match File::open(&path) {
        Ok(file) => {
            for line in BufReader::new(file).lines() {
                let line = line?;
                if line.contains(id)
                    && serde_json::from_str::<Value>(&line)
                        .is_ok_and(|row| row["id"] == id && row["thread_name"].is_string())
                {
                    return Ok(());
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut row = serde_json::to_vec(&json!({"id":id,"thread_name":title,
        "updated_at":OffsetDateTime::now_utc().format(&Rfc3339).unwrap()}))?;
    row.push(b'\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(&row)
}

pub(super) fn copy(history: &Snapshot<'_>, cwd: &str, home: &Path) -> io::Result<Value> {
    let id = uuid(&serde_json::to_vec(&(
        "codex-v1",
        &history.entry.id,
        cwd,
        &history.messages,
    ))?);
    let start = history
        .messages
        .iter()
        .find_map(|m| parsed_time(&m.time))
        .or_else(|| {
            history
                .entry
                .path
                .metadata()
                .ok()?
                .created()
                .ok()
                .map(OffsetDateTime::from)
        })
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .to_offset(UtcOffset::UTC);
    let (year, month, day) = start.to_calendar_date();
    let date = format!("{year:04}-{:02}-{day:02}", month as u8);
    let (h, m, s) = start.to_hms();
    let name = format!("rollout-{date}T{h:02}-{m:02}-{s:02}-{id}.jsonl");
    if home.join("archived_sessions").join(&name).is_file() {
        return Err(io::Error::other(
            "该接续副本已在 Codex 归档，可在 Codex 的已归档对话中恢复。",
        ));
    }
    let dst = home
        .join("sessions")
        .join(format!("{year:04}"))
        .join(format!("{:02}", month as u8))
        .join(format!("{day:02}"))
        .join(&name);
    let title = history.title();
    let existing = write_once(&dst, |file| {
        let stamp = start.format(&Rfc3339).unwrap();
        record(
            file,
            &stamp,
            "session_meta",
            json!({"id":id,"timestamp":stamp,"cwd":cwd,
            "originator":"markcraft","cli_version":env!("CARGO_PKG_VERSION"),"source":"cli","model_provider":settings(home)?.0}),
        )?;
        let mut turn = String::new();
        for (i, msg) in history.messages.iter().enumerate() {
            let is_user = msg.role == "user";
            let ts = parsed_time(&msg.time)
                .unwrap_or(start)
                .format(&Rfc3339)
                .unwrap();
            if is_user || i == 0 {
                turn = uuid(format!("{id}/turn/{i}").as_bytes());
                record(
                    file,
                    &ts,
                    "event_msg",
                    json!({"type":"task_started","turn_id":turn}),
                )?;
            }
            // Model input and visible conversation are distinct records in Codex.
            record(
                file,
                &ts,
                "response_item",
                json!({"type":"message","role":msg.role,
                "content":[{"type":if is_user {"input_text"} else {"output_text"},"text":msg.text}]}),
            )?;
            let event = if is_user {
                json!({"type":"user_message","message":msg.text,"images":[],"local_images":[],"text_elements":[]})
            } else {
                json!({"type":"agent_message","message":msg.text})
            };
            record(file, &ts, "event_msg", event)?;
            if history
                .messages
                .get(i + 1)
                .is_none_or(|next| next.role == "user")
            {
                record(
                    file,
                    &ts,
                    "event_msg",
                    json!({"type":"task_complete","turn_id":turn,
                    "last_agent_message":(!is_user).then_some(&msg.text)}),
                )?;
            }
        }
        record(
            file,
            &stamp,
            "event_msg",
            json!({"type":"thread_name_updated","thread_id":id,"thread_name":title}),
        )?;
        Ok(())
    })?;
    if existing {
        repair_import(&dst, &id, home)?;
    }
    index_title(home, &id, &title)?;
    Ok(
        json!({"id":id,"title":title,"workspace":cwd,"count":history.messages.len(),"existing":existing,"recipient":"codex"}),
    )
}
