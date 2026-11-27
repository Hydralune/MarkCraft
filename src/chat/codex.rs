use super::handoff::{Snapshot, parsed_time, uuid, write_once};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::Path,
};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

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
            "originator":"markcraft","cli_version":env!("CARGO_PKG_VERSION"),"source":"cli"}),
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
    index_title(home, &id, &title)?;
    Ok(
        json!({"id":id,"title":title,"workspace":cwd,"count":history.messages.len(),"existing":existing,"recipient":"codex"}),
    )
}
