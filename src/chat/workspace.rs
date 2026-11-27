use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
};

// Keep evidence from recent working turns. Message text, shell strings and tool
// output are deliberately excluded: they commonly mention unrelated projects.
#[derive(Default)]
pub(super) struct Activity {
    cwd: PathBuf,
    turn_id: String,
    turns: VecDeque<Turn>,
}

#[derive(Default)]
struct Turn {
    id: String,
    dirs: HashMap<PathBuf, Counts>,
}

#[derive(Clone, Copy, Default)]
struct Counts {
    edits: u32,
    commands: u32,
}

fn local_path(value: &str) -> Option<PathBuf> {
    let path = if value.starts_with("file:") {
        let url = url::Url::parse(value).ok()?;
        if url.host_str().is_some() {
            return None;
        }
        url.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };
    if value.is_empty() || path.to_string_lossy().starts_with(r"\\") {
        return None;
    }
    Some(path)
}

impl Activity {
    // Deserialize only metadata when the command output itself is large.
    pub fn observe_large_command(&mut self, line: &[u8]) {
        #[derive(serde::Deserialize)]
        struct Event {
            #[serde(rename = "type")]
            kind: String,
            payload: Payload,
        }
        #[derive(serde::Deserialize)]
        struct Payload {
            #[serde(rename = "type")]
            kind: String,
            turn_id: Option<String>,
            item: Command,
        }
        #[derive(serde::Deserialize)]
        struct Command {
            #[serde(rename = "type")]
            kind: String,
            status: String,
            exit_code: Option<i32>,
            cwd: String,
        }
        let Ok(event) = serde_json::from_slice::<Event>(line) else {
            return;
        };
        let p = event.payload;
        let item = p.item;
        if event.kind == "event_msg"
            && p.kind == "item_completed"
            && item.kind == "CommandExecution"
            && item.status == "completed"
            && item.exit_code.unwrap_or(0) == 0
            && let Some(path) = local_path(&item.cwd)
        {
            self.record(
                &p.turn_id.unwrap_or_else(|| self.turn_id.clone()),
                path,
                false,
            );
        }
    }

    pub fn observe(&mut self, v: &Value) {
        let p = &v["payload"];
        if v["type"] == "turn_context" || v["type"] == "session_meta" {
            self.cwd = p["cwd"].as_str().and_then(local_path).unwrap_or_default();
            if let Some(id) = p["turn_id"].as_str() {
                self.turn_id = id.to_owned();
            }
            return;
        }
        if v["type"] != "event_msg" {
            return;
        }
        let item = &p["item"];
        let turn = p["turn_id"].as_str().unwrap_or(&self.turn_id).to_owned();
        if p["type"] == "patch_apply_end" && p["success"] == true {
            self.changes(&turn, &p["changes"]);
        } else if p["type"] == "exec_command_end" && p["exit_code"] == 0 {
            self.command(&turn, &p["cwd"]);
        } else if p["type"] == "item_completed" && item["status"] == "completed" {
            match item["type"].as_str() {
                Some("FileChange") => self.changes(&turn, &item["changes"]),
                Some("CommandExecution")
                    if item["exit_code"].is_null() || item["exit_code"] == 0 =>
                {
                    self.command(&turn, &item["cwd"])
                }
                _ => {}
            }
        }
    }

    fn command(&mut self, turn: &str, cwd: &Value) {
        if let Some(path) = cwd.as_str().and_then(local_path) {
            self.record(turn, path, false);
        }
    }

    fn changes(&mut self, turn: &str, changes: &Value) {
        let Some(changes) = changes.as_object() else {
            return;
        };
        for (key, change) in changes {
            let dest = change["move_path"].as_str().unwrap_or(key);
            let Some(file) = local_path(dest) else {
                continue;
            };
            let file = if file.is_absolute() {
                file
            } else {
                self.cwd.join(file)
            };
            if let Some(dir) = file.parent() {
                self.record(turn, dir.to_owned(), true);
            }
        }
    }

    fn record(&mut self, id: &str, dir: PathBuf, edit: bool) {
        if !dir.is_absolute() || dir.parent().is_none() {
            return;
        }
        if self.turns.back().is_none_or(|t| t.id != id) {
            if self.turns.len() == 12 {
                self.turns.pop_front();
            }
            self.turns.push_back(Turn {
                id: id.to_string(),
                ..Turn::default()
            });
        }
        let dirs = &mut self.turns.back_mut().unwrap().dirs;
        if dirs.len() >= 256 && !dirs.contains_key(&dir) {
            return;
        }
        let counts = dirs.entry(dir).or_default();
        if edit {
            counts.edits += 1;
        } else {
            counts.commands += 1;
        }
    }

    pub fn suggest(&self, declared: &str) -> Value {
        let mut cache = HashMap::new();
        let mut ranks: HashMap<PathBuf, (u32, Counts)> = HashMap::new();
        for (age, turn) in self.turns.iter().rev().enumerate() {
            let mut in_turn = HashMap::<PathBuf, Counts>::new();
            for (dir, counts) in &turn.dirs {
                let root = cache.entry(dir).or_insert_with(|| project_root(dir));
                if let Some(root) = root {
                    let total = in_turn.entry(root.clone()).or_default();
                    total.edits += counts.edits;
                    total.commands += counts.commands;
                }
            }
            for (root, counts) in in_turn {
                let (score, total) = ranks.entry(root).or_default();
                let weight = match age {
                    0..=1 => 6,
                    2..=4 => 3,
                    _ => 1,
                };
                *score += weight * (counts.edits.min(6) * 4 + counts.commands.min(8));
                total.edits += counts.edits;
                total.commands += counts.commands;
            }
        }
        let mut ranked: Vec<_> = ranks.into_iter().collect();
        ranked.sort_by_key(|(_, (score, _))| std::cmp::Reverse(*score));
        if let Some((path, (score, counts))) = ranked.first()
            && (counts.edits > 0 || counts.commands >= 2)
            && ranked
                .get(1)
                .is_none_or(|(_, (next, _))| score * 2 > next * 3)
        {
            return json!({"path":path,"inferred":true,"edits":counts.edits,"commands":counts.commands});
        }
        let original = local_path(declared).filter(|p| p.is_absolute() && p.is_dir());
        json!({"path":original,"inferred":false})
    }
}

fn project_root(dir: &Path) -> Option<PathBuf> {
    let mut manifest = None;
    for parent in dir.ancestors().take_while(|p| p.parent().is_some()) {
        if parent.join(".git").exists() {
            return Some(parent.to_owned());
        }
        if manifest.is_none()
            && [
                "Cargo.toml",
                "package.json",
                "pyproject.toml",
                "go.mod",
                "CMakeLists.txt",
            ]
            .iter()
            .any(|name| parent.join(name).is_file())
        {
            manifest = Some(parent.to_owned());
        }
    }
    manifest
}
