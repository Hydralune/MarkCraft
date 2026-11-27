use super::handoff::{Snapshot, parsed_time, uuid, write_once};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::Path,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

// Claude Code's project key uses UTF-16 code units, including for its long-path hash.
fn project_key(cwd: &str) -> String {
    let mut hash = 0i32;
    let mut key = String::new();
    for unit in cwd.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
        key.push(if unit < 128 && (unit as u8).is_ascii_alphanumeric() {
            unit as u8 as char
        } else {
            '-'
        });
    }
    if key.len() > 200 {
        key.truncate(200);
        let mut n = hash.unsigned_abs();
        let mut digits = Vec::new();
        loop {
            digits.push(char::from_digit(n % 36, 36).unwrap());
            n /= 36;
            if n == 0 {
                break;
            }
        }
        key.push('-');
        key.extend(digits.into_iter().rev());
    }
    key
}

pub(super) fn copy(history: &Snapshot<'_>, cwd: &str, home: &Path) -> io::Result<Value> {
    // Preserve the snapshot identity used by earlier MarkCraft versions.
    let id = uuid(&serde_json::to_vec(&(
        1,
        &history.entry.id,
        cwd,
        &history.messages,
    ))?);
    let dst = home
        .join("projects")
        .join(project_key(cwd))
        .join(format!("{id}.jsonl"));
    let title = history.title();
    let existing = write_once(&dst, |file| {
        let now = OffsetDateTime::now_utc();
        let mut parent: Option<String> = None;
        for (i, m) in history.messages.iter().enumerate() {
            let item = uuid(format!("{id}/{i}").as_bytes());
            let message = if m.role == "user" {
                json!({"role":"user","content":m.text})
            } else {
                json!({"id":format!("msg_{item}"),"type":"message","role":"assistant","model":"markcraft-import",
                    "content":[{"type":"text","text":m.text}],"stop_reason":"end_turn","stop_sequence":null,
                    "usage":{"input_tokens":0,"output_tokens":0}})
            };
            let row = json!({"type":m.role,"uuid":item,"parentUuid":parent,"sessionId":id,"cwd":cwd,
                "isSidechain":false,"timestamp":parsed_time(&m.time).unwrap_or(now).format(&Rfc3339).unwrap(),"message":message});
            serde_json::to_writer(&mut *file, &row)?;
            file.write_all(b"\n")?;
            parent = Some(item);
        }
        serde_json::to_writer(
            &mut *file,
            &json!({"type":"custom-title","customTitle":title,"sessionId":id}),
        )?;
        file.write_all(b"\n")?;
        Ok(())
    })?;
    Ok(
        json!({"id":id,"title":title,"workspace":cwd,"count":history.messages.len(),"existing":existing,"recipient":"claude"}),
    )
}
