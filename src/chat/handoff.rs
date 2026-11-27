use super::{Active, Entry, Roots, Source, antigravity, claude, codex, messages::Message};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::Path,
    time::Duration,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Recipient {
    #[default]
    DeepSeek,
    Claude,
    Codex,
    Antigravity,
    AntigravityDesktop,
}

pub(super) struct Snapshot<'a> {
    pub entry: &'a Entry,
    pub messages: Vec<&'a Message>,
    custom_title: Option<&'a str>,
}

impl Snapshot<'_> {
    pub fn title(&self) -> String {
        if let Some(title) = self.custom_title {
            return title.to_owned();
        }
        let brand = match self.entry.source {
            Source::Codex => "Codex",
            Source::Claude => "Claude Code",
            Source::Antigravity => "Antigravity",
            Source::DeepSeek => "DeepSeek Harness",
        };
        format!("{brand} · {}", self.entry.title)
    }
}

pub(super) fn uuid(input: &[u8]) -> String {
    let h = format!("{:x}", Sha256::digest(input));
    format!(
        "{}-{}-4{}-a{}-{}",
        &h[..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

pub(super) fn parsed_time(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok().or_else(|| {
        let n = value.parse::<i64>().ok()?;
        let factor = if value.len() <= 10 {
            1_000_000_000
        } else {
            1_000_000
        };
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(n) * factor).ok()
    })
}

pub(super) fn write_once(
    dst: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<bool> {
    if dst.is_file() {
        return Ok(true);
    }
    let parent = dst
        .parent()
        .ok_or_else(|| io::Error::other("会话目录无效。"))?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    write(temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    match temp.persist_noclobber(dst) {
        Ok(_) => Ok(false),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => Ok(true),
        Err(e) => Err(e.error),
    }
}

#[derive(Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

fn call(root: &Path, mut request: Value, timeout: Duration) -> io::Result<Value> {
    let bytes = fs::read(root.join("markcraft/bridge-v1.json"))?;
    let endpoint: Endpoint = serde_json::from_slice(&bytes)?;
    if endpoint.token.len() != 64 || !endpoint.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::other("Harness 接续插件的连接信息无效。"));
    }
    request["token"] = Value::String(endpoint.token);
    let mut data = serde_json::to_vec(&request)?;
    data.push(b'\n');
    if data.len() > LIMIT {
        return Err(io::Error::other("对话超过本次原文接续的 16 MiB 上限。"));
    }
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port);
    let mut stream = TcpStream::connect_timeout(&addr.into(), Duration::from_millis(300))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(&data)?;
    let mut result = String::new();
    BufReader::new(stream)
        .take(1024 * 1024)
        .read_line(&mut result)?;
    let reply: Value = serde_json::from_str(&result)?;
    if let Some(error) = reply["error"].as_str() {
        return Err(io::Error::other(error.to_owned()));
    }
    Ok(reply)
}

pub(super) fn targets(root: &Path) -> Value {
    call(
        root,
        json!({"action":"targets"}),
        Duration::from_millis(750),
    )
    .ok()
    .filter(|r| r["targets"].is_array())
    .unwrap_or(Value::Null)
}

#[cfg(test)]
pub(super) fn copy(
    entry: &Entry,
    workspace: &str,
    roots: &Roots,
    recipient: Recipient,
) -> io::Result<Value> {
    transfer(entry, workspace, roots, recipient, None, None)
}

pub(super) fn transfer(
    entry: &Entry,
    workspace: &str,
    roots: &Roots,
    recipient: Recipient,
    name: Option<&str>,
    fork: Option<&str>,
) -> io::Result<Value> {
    if workspace.is_empty() {
        return Err(io::Error::other("请选择目标工作区。"));
    }
    let mut file = File::open(&entry.path)?;
    let size = file.metadata()?.len();
    let mut snapshot = Active::default();
    snapshot.read(&mut file, entry, size)?;
    let messages = snapshot.transcript.messages();
    if messages.is_empty() {
        return Err(io::Error::other("没有可接续的用户或助手原话。"));
    }
    let name = name.map(str::trim).filter(|s| !s.is_empty());
    if name.is_some_and(|s| s.chars().count() > 120 || s.chars().any(char::is_control)) {
        return Err(io::Error::other("对话名称应为 1 至 120 个字符的单行文字。"));
    }
    if fork.is_some_and(|s| {
        s.len() != 36
            || !s.bytes().enumerate().all(|(i, b)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
    }) {
        return Err(io::Error::other("新会话标识无效。"));
    }
    let mut history = Snapshot {
        entry,
        messages,
        custom_title: None,
    };
    let default = history.title();
    let name = name.filter(|s| *s != default);
    let mut branch;
    if name.is_some() || fork.is_some() {
        branch = entry.clone();
        branch.id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&entry.id, name, fork))?)
        );
        history.entry = &branch;
        history.custom_title = name;
    }
    let suggested;
    let directory =
        if workspace == "@source" {
            Some(entry.project.as_str())
        } else if workspace == "@auto" {
            suggested = snapshot.activity.suggest(&entry.project);
            Some(suggested["path"].as_str().ok_or_else(|| {
                io::Error::other("未能识别现有工作区，可使用「接续…」指定文件夹。")
            })?)
        } else {
            workspace.strip_prefix("@folder:")
        };
    if let Some(path) = directory
        && (!Path::new(path).is_absolute() || !Path::new(path).is_dir())
    {
        return Err(io::Error::other(
            "原工作目录在本机不可用，请选择现有文件夹。",
        ));
    }
    match recipient {
        Recipient::Claude => claude::copy(&history, &native_directory(directory)?, &roots.claude),
        Recipient::Codex => codex::copy(&history, &native_directory(directory)?, &roots.codex),
        Recipient::Antigravity | Recipient::AntigravityDesktop => antigravity::copy(
            &history,
            &native_directory(directory)?,
            &roots.gemini,
            matches!(recipient, Recipient::AntigravityDesktop),
        ),
        Recipient::DeepSeek => copy_to_harness(&history, directory, workspace, &roots.dsh),
    }
}

fn native_directory(path: Option<&str>) -> io::Result<String> {
    let path = path.ok_or_else(|| io::Error::other("请选择接续的本机项目目录。"))?;
    let absolute = Path::new(path).canonicalize()?;
    let raw = absolute.to_string_lossy();
    Ok(raw
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!(r"\\{p}"))
        .unwrap_or_else(|| raw.trim_start_matches(r"\\?\").to_owned()))
}

fn copy_to_harness(
    history: &Snapshot<'_>,
    directory: Option<&str>,
    workspace: &str,
    home: &Path,
) -> io::Result<Value> {
    let entry = history.entry;
    let mut request = json!({
        "action":"import", "source":entry.source,
        "sourceId":entry.id, "title":entry.title, "messages":history.messages
    });
    if let Some(name) = history.custom_title {
        request["displayTitle"] = json!(name);
    }
    if let Some(path) = directory {
        request["workspacePath"] = json!(path);
    } else {
        request["workspaceId"] = json!(workspace);
    }
    call(home, request, Duration::from_secs(30))
}
