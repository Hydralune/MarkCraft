mod antigravity;
mod claude;
mod codex;
mod deepseek;
mod handoff;
pub use handoff::Recipient;
mod launch;
mod messages;
mod metadata;
mod setup;
mod workspace;
pub(crate) use setup::desktop_exe;
#[cfg(test)]
mod tests;

use messages::Transcript;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::mpsc,
    time::UNIX_EPOCH,
};

#[derive(Copy, Clone, PartialEq, Eq, Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Codex,
    Claude,
    Antigravity,
    DeepSeek,
}

#[derive(Clone, Serialize)]
struct Entry {
    id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver: Option<&'static str>,
    source: Source,
    project: String,
    title: String,
    modified: u64,
    size: u64,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Default)]
struct Library {
    aliases: HashMap<String, String>,
    entries: HashMap<PathBuf, Entry>,
    active: Option<Active>,
    deepseek_indexes: HashMap<PathBuf, deepseek::Index>,
    generation: u64,
}

struct Roots {
    codex: PathBuf,
    claude: PathBuf,
    gemini: PathBuf,
    dsh: PathBuf,
}
impl Roots {
    fn local() -> Self {
        let home = env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
            .unwrap_or_default();
        Self {
            codex: env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
            claude: env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude")),
            gemini: env::var_os("MARKCRAFT_GEMINI_DIR")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".gemini")),
            dsh: env::var_os("DSH_HOME")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".dsh")),
        }
    }
}

fn stamp(info: &fs::Metadata) -> u64 {
    info.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_micros() as u64)
}
fn files(dir: &Path) -> impl Iterator<Item = fs::DirEntry> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
}
fn codex_files(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    for e in files(dir) {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if depth > 0
                && e.file_name()
                    .to_string_lossy()
                    .bytes()
                    .all(|c| c.is_ascii_digit())
            {
                codex_files(&p, depth - 1, found);
            }
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            found.push(p);
        }
    }
}
fn short_title(text: &str) -> String {
    let mut previous_space = true;
    text.chars()
        .filter_map(|c| {
            let space = c.is_whitespace();
            let keep = !space || !previous_space;
            previous_space = space;
            keep.then_some(if space { ' ' } else { c })
        })
        .take(76)
        .collect::<String>()
        .trim_end()
        .to_owned()
}
fn literal_label(value: &str) -> String {
    let mut label = String::new();
    for c in value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
    {
        if r"\`*_{}[]<>#!|~$^".contains(c) {
            label.push('\\');
        }
        label.push(c);
    }
    label
}
fn uuid_suffix(path: &Path) -> String {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let start = stem.len().saturating_sub(36);
    stem.get(start..).unwrap_or(&stem).to_owned()
}

// Both clients append titles after their chat events. Only inspect the tail
// when the file changes, including native renames after an import.
fn recent_title(path: &Path, source: Source) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(size.saturating_sub(128 * 1024)))
        .ok()?;
    let mut bytes = Vec::new();
    f.take(128 * 1024).read_to_end(&mut bytes).ok()?;
    let mut generated = None;
    for line in bytes.rsplit(|&c| c == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let (value, automatic) = match (source, v["type"].as_str()) {
            (Source::Claude, Some("custom-title")) => (v["customTitle"].as_str(), false),
            (Source::Claude, Some("ai-title")) if generated.is_none() => {
                (v["aiTitle"].as_str(), true)
            }
            (Source::Codex, Some("event_msg")) if v["payload"]["type"] == "thread_name_updated" => {
                (v["payload"]["thread_name"].as_str(), false)
            }
            _ => continue,
        };
        if let Some(title) = value.filter(|s| !s.trim().is_empty()) {
            if automatic {
                generated = Some(title.to_owned());
            } else {
                return Some(title.to_owned());
            }
        }
    }
    generated
}

fn inspect(path: &Path, source: Source) -> (String, String, String) {
    let mut id = uuid_suffix(path);
    let mut project = String::new();
    let mut title = String::new();
    let Ok(file) = File::open(path) else {
        return (id, project, title);
    };
    let mut preview = Transcript::default();
    for line in BufReader::new(file.take(2 * 1024 * 1024))
        .split(b'\n')
        .take(70)
        .flatten()
    {
        let Ok(v) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if source == Source::Codex && v["type"] == "session_meta" {
            let p = &v["payload"];
            if let Some(value) = p["id"].as_str() {
                id = value.to_owned();
            }
            if let Some(value) = p["cwd"].as_str() {
                project = value.to_owned();
            }
        } else if source == Source::Claude && project.is_empty() {
            if let Some(value) = v["cwd"].as_str() {
                project = value.to_owned();
            }
        }
        preview.accept(source, &v);
        if let Some(m) = preview.messages().iter().find(|m| m.role == "user") {
            title = short_title(&m.text);
            break;
        }
    }
    (id, project, title)
}

impl Library {
    #[cfg(test)]
    fn scan(&mut self, roots: &Roots) -> Vec<Entry> {
        self.scan_allowed(roots, &setup::SOURCES)
    }
    fn scan_allowed(&mut self, roots: &Roots, allowed: &[Source]) -> Vec<Entry> {
        let mut seen = HashSet::new();
        let mut titles = HashMap::new();
        if allowed.contains(&Source::Codex)
            && let Ok(f) = File::open(roots.codex.join("session_index.jsonl"))
        {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && let (Some(id), Some(title)) = (v["id"].as_str(), v["thread_name"].as_str())
                {
                    titles.insert(id.to_owned(), title.to_owned());
                }
            }
        }
        let mut register =
            |p: PathBuf, source: Source, fallback: String, known: Option<&(String, String)>| {
                let Ok(info) = fs::symlink_metadata(&p) else {
                    return;
                };
                if !info.is_file() || info.file_type().is_symlink() {
                    return;
                }
                seen.insert(p.clone());
                let old = self.entries.get(&p);
                let changed =
                    old.is_none_or(|e| e.modified != stamp(&info) || e.size != info.len());
                if old.is_some_and(|e| {
                    (e.modified == stamp(&info) && e.size == info.len())
                        || (e.size > 0 && !e.title.starts_with("对话 ·"))
                }) {
                    let e = self.entries.get_mut(&p).unwrap();
                    e.modified = stamp(&info);
                    e.size = info.len();
                } else {
                    let (session, mut project, mut title) = inspect(&p, source);
                    if source == Source::Codex
                        && let Some(name) = titles.get(&session)
                    {
                        title = name.clone();
                    }
                    if project.is_empty() {
                        project = fallback;
                    }
                    if title.is_empty() {
                        title = format!("对话 · {}", session.chars().take(8).collect::<String>());
                    }
                    let id = format!("{:x}", Sha256::digest(p.to_string_lossy().as_bytes()));
                    self.entries.insert(
                        p.clone(),
                        Entry {
                            id,
                            thread_id: (source == Source::Codex).then_some(session),
                            receiver: (source == Source::Antigravity).then(|| {
                                if p.starts_with(roots.gemini.join("antigravity-cli")) {
                                    "antigravity"
                                } else {
                                    "antigravitydesktop"
                                }
                            }),
                            source,
                            project,
                            title,
                            path: p.clone(),
                            modified: stamp(&info),
                            size: info.len(),
                        },
                    );
                }
                let e = self.entries.get_mut(&p).unwrap();
                if changed
                    && matches!(source, Source::Claude | Source::Codex)
                    && let Some(title) = recent_title(&p, source)
                {
                    e.title = title;
                }
                if source == Source::Codex
                    && let Some(title) = titles.get(&uuid_suffix(&p)).filter(|x| !x.is_empty())
                {
                    e.title = title.clone();
                }
                if let Some((title, project)) = known {
                    if !title.is_empty() {
                        e.title = title.clone();
                    }
                    if !project.is_empty() {
                        e.project = project.clone();
                    }
                }
            };
        if allowed.contains(&Source::Codex) {
            let mut paths = Vec::new();
            codex_files(&roots.codex.join("sessions"), 3, &mut paths);
            codex_files(&roots.codex.join("archived_sessions"), 3, &mut paths);
            for p in paths {
                register(p, Source::Codex, "未指定项目".into(), None);
            }
        }
        if allowed.contains(&Source::Claude) {
            for project in files(&roots.claude.join("projects"))
                .filter(|e| e.file_type().is_ok_and(|f| f.is_dir()))
            {
                for file in files(&project.path()) {
                    let p = file.path();
                    if p.extension().is_some_and(|s| s == "jsonl")
                        && !file.file_name().to_string_lossy().starts_with("agent-")
                    {
                        register(
                            p,
                            Source::Claude,
                            project.file_name().to_string_lossy().into(),
                            None,
                        );
                    }
                }
            }
        }
        if allowed.contains(&Source::Antigravity) {
            for variant in ["antigravity", "antigravity-cli"] {
                let base = roots.gemini.join(variant);
                let meta = metadata::antigravity(&base.join("conversation_summaries.db"));
                for session in
                    files(&base.join("brain")).filter(|e| e.file_type().is_ok_and(|f| f.is_dir()))
                {
                    let logs = session.path().join(".system_generated/logs");
                    if let Some(path) = ["transcript_full.jsonl", "transcript.jsonl"]
                        .iter()
                        .map(|n| logs.join(n))
                        .find(|p| p.is_file())
                    {
                        register(
                            path,
                            Source::Antigravity,
                            "未指定项目".into(),
                            meta.get(session.file_name().to_string_lossy().as_ref()),
                        );
                    }
                }
            }
        }
        if allowed.contains(&Source::DeepSeek) {
            self.scan_deepseek(&roots.dsh, &mut seen);
        }
        self.entries.retain(|p, _| seen.contains(p));
        let mut list: Vec<_> = self.entries.values().cloned().collect();
        for entry in &mut list {
            if let Some(title) = self.aliases.get(&entry.id) {
                entry.title.clone_from(title);
            }
        }
        list.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        list
    }

    fn page(&mut self, id: &str, query: &str) -> io::Result<Value> {
        let entry = self
            .entries
            .values()
            .find(|e| e.id == id)
            .ok_or_else(|| io::Error::other("这段对话已移走或删除。"))?;
        let mut f = File::open(&entry.path)?;
        let info = f.metadata()?;
        let mut rebuild = true;
        if let Some(a) = &self.active
            && a.id == id
            && info.len() >= a.size
        {
            rebuild = if info.len() == a.size {
                stamp(&info) != a.modified
            } else {
                !tail_matches(&mut f, a.size, &a.tail)?
            };
        }
        if rebuild {
            self.generation += 1;
            self.active = Some(Active {
                id: id.to_owned(),
                ..Default::default()
            });
        }
        let active = self.active.as_mut().unwrap();
        if rebuild || active.size != info.len() {
            if let Err(error) = active.read(&mut f, entry, info.len()) {
                self.active = None;
                return Err(error);
            }
            active.modified = stamp(&info);
        }
        let opts: Value = serde_json::from_str(query).unwrap_or(Value::Null);
        if opts["format"] == "workspace" {
            return Ok(json!({"workspace":active.activity.suggest(&entry.project)}));
        }
        let messages = active.transcript.messages();
        let total = messages.len();
        if opts["format"] == "outline" {
            // Completed messages are immutable until the file is rewritten. Codex
            // can still replace display events in its current, uncommitted turn.
            active.outline.truncate(active.indexed);
            for m in &messages[active.indexed..] {
                active.outline.push(OutlineMessage {
                    role: m.role,
                    lead: short_title(
                        m.text
                            .lines()
                            .find(|line| !line.trim().is_empty())
                            .unwrap_or(""),
                    ),
                    headings: crate::markdown::transcript_outline(&m.text),
                });
            }
            active.indexed = active.transcript.committed_len();
            return Ok(json!({"outline":active.outline,"generation":self.generation}));
        }
        if opts["format"] == "markdown" {
            let provider = match entry.source {
                Source::Codex => "Codex",
                Source::Claude => "Claude Code",
                Source::Antigravity => "Antigravity",
                Source::DeepSeek => "DeepSeek Harness",
            };
            let project = entry
                .project
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("");
            let title = literal_label(self.aliases.get(id).unwrap_or(&entry.title));
            let mut markdown = format!("# {title}\n\n{provider}");
            if !project.is_empty() {
                markdown.push_str(&format!(" · {}", literal_label(project)));
            }
            markdown.push('\n');
            let mut sections = vec![crate::markdown::transcript_html(&markdown)];
            let mut turn = 0;
            for m in messages {
                let label = if m.role == "user" {
                    turn += 1;
                    format!("第 {turn} 轮提问")
                } else {
                    format!("{provider} 回复")
                };
                let heading = format!("\n## {label}\n\n");
                markdown.push_str(&heading);
                markdown.push_str(&m.text);
                markdown.push('\n');
                // Parse each message separately so incomplete markup cannot swallow the next reply.
                sections.push(
                    crate::markdown::transcript_html(&heading)
                        + &crate::markdown::transcript_html(&m.text),
                );
            }
            return Ok(
                json!({"markdown":markdown,"sections":sections,"total":total,"generation":self.generation}),
            );
        }
        let end = opts["before"]
            .as_u64()
            .filter(|_| opts["generation"].as_u64() == Some(self.generation))
            .map_or(total, |v| (v as usize).min(total));
        let mut start = end.saturating_sub(40);
        if opts["generation"].as_u64() == Some(self.generation)
            && let Some(from) = opts["since"].as_u64()
        {
            start = (from as usize).saturating_sub(1).min(end);
            if entry.source == Source::Codex {
                start = start.min(
                    active
                        .transcript
                        .committed_len()
                        .max(end.saturating_sub(40)),
                );
            }
        }
        let (start, end) = if let Some(target) = opts["around"].as_u64() {
            let end = (target as usize).saturating_add(32).max(40).min(total);
            (end.saturating_sub(40), end)
        } else if opts["generation"].as_u64() == Some(self.generation)
            && let Some(after) = opts["after"].as_u64()
        {
            let start = (after as usize).min(total);
            (start, start.saturating_add(40).min(total))
        } else {
            (start, end)
        };
        let rows: Vec<_> = messages[start..end]
            .iter()
            .map(|m| {
                json!({
                    "role":m.role,"time":m.time,"text":m.text,"html":crate::markdown::transcript_html(&m.text)
                })
            })
            .collect();
        Ok(json!({"rows":rows,"start":start,"total":total,"generation":self.generation}))
    }
}

#[derive(Serialize)]
struct OutlineMessage {
    role: &'static str,
    lead: String,
    headings: Vec<(u8, String)>,
}

#[derive(Default)]
struct Active {
    activity: workspace::Activity,
    outline: Vec<OutlineMessage>,
    indexed: usize,
    id: String,
    size: u64,
    modified: u64,
    offset: u64,
    tail: Vec<u8>,
    transcript: Transcript,
    deepseek: deepseek::LogReader,
}
fn tail_matches(f: &mut File, size: u64, tail: &[u8]) -> io::Result<bool> {
    f.seek(SeekFrom::Start(size - tail.len() as u64))?;
    let mut buf = vec![0; tail.len()];
    f.read_exact(&mut buf)?;
    Ok(buf == tail)
}
fn remember_tail(f: &mut File, size: u64, tail: &mut Vec<u8>) -> io::Result<()> {
    let k = size.min(512);
    f.seek(SeekFrom::Start(size - k))?;
    tail.resize(k as usize, 0);
    f.read_exact(tail)
}
impl Active {
    fn read(&mut self, f: &mut File, entry: &Entry, size: u64) -> io::Result<()> {
        if entry.source == Source::DeepSeek {
            self.deepseek.read(f, size, &entry.path, |v| {
                self.transcript.accept(entry.source, &v)
            })?;
        } else {
            self.read_jsonl(f, entry.source, size)?;
        }
        self.size = size;
        remember_tail(f, size, &mut self.tail)
    }
    fn read_jsonl(&mut self, f: &mut File, source: Source, size: u64) -> io::Result<()> {
        f.seek(SeekFrom::Start(self.offset))?;
        let mut r = BufReader::with_capacity(128 * 1024, (&mut *f).take(size - self.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = r.read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            let complete = line.ends_with(b"\n");
            // Tool outputs can contain megabytes of embedded images. Inspect their
            // event header before attempting a full JSON deserialization.
            let prefix = String::from_utf8_lossy(&line[..line.len().min(512)]);
            let large_tool_output = source == Source::Codex
                && line.len() > 65536
                && [
                    "\"function_call_output\"",
                    "\"custom_tool_call_output\"",
                    "\"McpToolCall\"",
                    "\"CommandExecution\"",
                    "\"token_usage_record\"",
                ]
                .iter()
                .any(|s| prefix.contains(s));
            let relevant = !large_tool_output;
            if relevant {
                match serde_json::from_slice::<Value>(&line) {
                    Ok(v) => {
                        if source == Source::Codex {
                            self.activity.observe(&v);
                        }
                        self.transcript.accept(source, &v);
                    }
                    Err(_) if !complete => break,
                    Err(_) => {}
                }
            } else if !complete {
                break;
            } else if prefix.contains("\"CommandExecution\"") {
                self.activity.observe_large_command(&line);
            }
            self.offset += n as u64;
        }
        Ok(())
    }
}

pub struct Job {
    pub action: String,
    pub recipient: Recipient,
    pub name: Option<String>,
    pub fork: Option<String>,
    pub id: String,
    pub query: String,
    pub epoch: u64,
    pub rev: u64,
}
fn rename_entry(root: &Path, lib: &mut Library, id: &str, title: &str) -> io::Result<()> {
    use std::io::Write;
    let title = title.trim();
    if !lib.entries.values().any(|entry| entry.id == id) {
        return Err(io::Error::other("这段对话已移走或删除。"));
    }
    if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
        return Err(io::Error::other("请输入 1 至 120 个字符的单行名称。"));
    }
    fs::create_dir_all(root)?;
    let mut tmp = tempfile::NamedTempFile::new_in(root)?;
    tmp.write_all(title.as_bytes())?;
    tmp.persist(root.join(id))?;
    lib.aliases.insert(id.to_owned(), title.to_owned());
    Ok(())
}
pub fn worker(
    proxy: tao::event_loop::EventLoopProxy<super::Input>,
    data: PathBuf,
) -> mpsc::Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::spawn(move || {
        let alias_dir = data.join("chat-names");
        let mut last = None;
        let mut last_transfer: Option<(Recipient, Value)> = None;
        let mut lib = Library::default();
        for j in rx {
            let response = (|| -> io::Result<Value> {
                let config = setup::Config::read(&data)?;
                if last.as_ref() != Some(&config) {
                    lib = Library::default();
                    last_transfer = None;
                    last = Some(config.clone());
                }
                let roots = config.roots();
                match j.action.as_str() {
                    "chatSetup" => Ok(config.describe()),
                    "chatConfigure" => Ok(setup::Config::save(&data, &j.query)?.describe()),
                    "chatInstallPlugin" => {
                        if !config.allows(Source::DeepSeek) {
                            return Err(io::Error::other("请先启用并保存 DeepSeek Harness 来源。"));
                        }
                        setup::install_plugin(&roots, &j.query)?;
                        Ok(config.describe())
                    }
                    "chatIndex" => {
                        let allowed: Vec<_> = setup::SOURCES
                            .into_iter()
                            .filter(|s| config.allows(*s))
                            .collect();
                        let available: Vec<_> = [
                            Recipient::DeepSeek,
                            Recipient::Claude,
                            Recipient::Codex,
                            Recipient::AntigravityDesktop,
                            Recipient::Antigravity,
                        ]
                        .into_iter()
                        .filter(|r| config.allows(r.source()))
                        .collect();
                        let bridge = if config.allows(Source::DeepSeek) {
                            handoff::targets(&roots.dsh)
                        } else {
                            Value::Null
                        };
                        let folders = if config.allows(Source::Antigravity) {
                            metadata::desktop_folders(&roots.gemini)
                        } else {
                            Vec::new()
                        };
                        let legacy = data.with_file_name("MarkCraft-AI").join("chat-names");
                        lib.aliases.clear();
                        if !allowed.is_empty() {
                            for dir in [&legacy, &alias_dir] {
                                for entry in files(dir) {
                                    let id = entry.file_name().to_string_lossy().into_owned();
                                    if id.len() == 64
                                        && id.bytes().all(|b| b.is_ascii_hexdigit())
                                        && let Ok(title) = fs::read_to_string(entry.path())
                                    {
                                        lib.aliases.insert(id, title);
                                    }
                                }
                            }
                        }
                        let entries = lib.scan_allowed(&roots, &allowed);
                        Ok(
                            json!({"entries":entries,"configured":!config.sources.is_empty(),"allowed":allowed,"recipients":available,"desktopFolders":folders,
                            "handoffTargets":bridge["targets"],"workspacePaths":bridge["workspacePaths"],"namedHarness":bridge["namedHarness"]}),
                        )
                    }
                    "chatRename" => {
                        rename_entry(&alias_dir, &mut lib, &j.id, &j.query)?;
                        Ok(json!({"title":j.query.trim()}))
                    }
                    "chatOpenNative" => {
                        if j.query == "received" {
                            let (_, receipt) = last_transfer
                                .as_ref()
                                .filter(|(dest, value)| {
                                    *dest == j.recipient
                                        && config.allows(dest.source())
                                        && value["id"] == j.id
                                })
                                .ok_or_else(|| {
                                    io::Error::other("接续结果已更新，请在资料库中右键打开。")
                                })?;
                            launch::open_session(
                                j.recipient,
                                &j.id,
                                receipt["workspace"].as_str().unwrap_or_default(),
                                receipt["title"].as_str().unwrap_or_default(),
                                &roots,
                            )?;
                        } else {
                            let entry = lib
                                .entries
                                .values()
                                .find(|e| e.id == j.id && config.allows(e.source))
                                .ok_or_else(|| {
                                    io::Error::other(
                                        "这段对话已移走或来源授权已更改，请刷新资料库。",
                                    )
                                })?;
                            launch::open(entry, &roots)?;
                        }
                        Ok(json!({}))
                    }
                    "chatHandoff" => {
                        if !config.allows(j.recipient.source()) {
                            return Err(io::Error::other("请先在对话来源中允许目标智能体。"));
                        }
                        let entry =
                            lib.entries.values().find(|e| e.id == j.id).ok_or_else(|| {
                                io::Error::other("原对话不可用，请刷新已授权来源。")
                            })?;
                        handoff::transfer(
                            entry,
                            &j.query,
                            &roots,
                            j.recipient,
                            j.name.as_deref(),
                            j.fork.as_deref(),
                        )
                    }
                    _ => lib.page(&j.id, &j.query),
                }
            })();
            let mut reply = response.unwrap_or_else(|e| json!({"error":e.to_string()}));
            if j.action == "chatHandoff"
                && let Some(id) = reply.get("id").cloned()
            {
                last_transfer = Some((j.recipient, reply.clone()));
                reply["nativeId"] = id;
            }
            reply["kind"] = json!(j.action);
            reply["id"] = json!(j.id);
            reply["epoch"] = json!(j.epoch);
            reply["rev"] = json!(j.rev);
            if proxy.send_event(super::Input::Reply(reply)).is_err() {
                break;
            }
        }
    });
    tx
}
