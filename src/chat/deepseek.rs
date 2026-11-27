use super::{Entry, Library, Source, files, remember_tail, short_title, stamp, tail_matches};
use ruzstd::decoding::{FrameDecoder, StreamingDecoder};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(super) struct LogReader {
    offset: u64,
    partial_line: Vec<u8>,
}

fn emit(line: &[u8], visit: &mut impl FnMut(Value)) {
    // Harness writes the event type first. Skip request payloads and tool output
    // without constructing a JSON tree. Accept reordered keys via the normal parser.
    if let Some(rest) = line.strip_prefix(b"{\"type\":\"")
        && let Some(kind) = rest.split(|&b| b == b'"').next()
        && !matches!(
            kind,
            b"session" | b"session/title" | b"user/message" | b"assistant/message"
        )
    {
        return;
    }
    if let Ok(v) = serde_json::from_slice::<Value>(line) {
        visit(v);
    }
}

impl LogReader {
    pub fn read(
        &mut self,
        f: &mut File,
        size: u64,
        path: &Path,
        mut visit: impl FnMut(Value),
    ) -> io::Result<()> {
        f.seek(SeekFrom::Start(self.offset))?;
        let mut input = BufReader::new(f).take(size - self.offset);
        let compressed = path.extension().is_some_and(|s| s == "zstd");
        let mut decoder = FrameDecoder::new();
        let mut bytes = Vec::new();
        while input.limit() > 0 {
            bytes.clear();
            let decoded = if compressed {
                StreamingDecoder::new_with_decoder(&mut input, &mut decoder)
                    .map_err(io::Error::other)
                    .and_then(|mut reader| reader.read_to_end(&mut bytes))
            } else {
                (&mut input).take(64 * 1024).read_to_end(&mut bytes)
            };
            if matches!(decoded, Ok(0)) && !compressed {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if let Err(error) = decoded {
                // Writers may leave a partial frame at EOF. Commit only complete
                // frames, so the next poll resumes at its original byte offset.
                if input.limit() == 0 {
                    break;
                }
                return Err(error);
            }
            let mut remaining = bytes.as_slice();
            while let Some(end) = remaining.iter().position(|b| *b == b'\n') {
                let line = &remaining[..end];
                if self.partial_line.is_empty() {
                    emit(line, &mut visit);
                } else {
                    self.partial_line.extend_from_slice(line);
                    emit(&self.partial_line, &mut visit);
                    self.partial_line.clear();
                }
                remaining = &remaining[end + 1..];
            }
            self.partial_line.extend_from_slice(remaining);
            self.offset = size - input.limit();
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Index {
    reader: LogReader,
    tail: Vec<u8>,
}

impl Library {
    pub(super) fn scan_deepseek(&mut self, root: &Path, seen: &mut HashSet<PathBuf>) {
        for project in
            files(&root.join("sessions")).filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        {
            for session in
                files(&project.path()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            {
                let name = session.file_name();
                let Some(dir_name) = name.to_str() else {
                    continue;
                };
                // The native importer uses bare UUIDs, while interactive sessions use a prefix.
                let key = dir_name.strip_prefix("session-").unwrap_or(dir_name);
                let folder = session.path();
                let path = ["session.v4.jsonl.zstd", "session.v4.jsonl"]
                    .into_iter()
                    .map(|name| folder.join(name))
                    .find(|p| p.is_file());
                let Some(path) = path else { continue };
                let Ok(info) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !info.is_file() {
                    continue;
                }
                seen.insert(path.clone());
                let entry = self.entries.entry(path.clone()).or_insert_with(|| Entry {
                    id: format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes())),
                    source: Source::DeepSeek,
                    thread_id: None,
                    receiver: None,
                    project: String::new(),
                    title: String::new(),
                    modified: 0,
                    size: 0,
                    path: path.clone(),
                });
                let modified = stamp(&info);
                if entry.modified == modified && entry.size == info.len() {
                    continue;
                }
                let baseline = format!("对话 · {}", key.chars().take(8).collect::<String>());
                let Ok(mut file) = File::open(&path) else {
                    continue;
                };
                let index = self.deepseek_indexes.entry(path).or_default();
                let appended = entry.size > 0
                    && info.len() > entry.size
                    && tail_matches(&mut file, entry.size, &index.tail).unwrap_or(false);
                if !appended {
                    *index = Index::default();
                    entry.title = baseline.clone();
                    entry.project = project.file_name().to_string_lossy().into_owned();
                }
                let result = index.reader.read(&mut file, info.len(), &entry.path, |v| {
                    match v["type"].as_str() {
                        Some("session") => {
                            if let Some(cwd) = v["cwd"].as_str().filter(|s| !s.is_empty()) {
                                entry.project = cwd.to_owned();
                            }
                        }
                        Some("session/title") => {
                            if let Some(title) =
                                v["data"]["title"].as_str().filter(|s| !s.trim().is_empty())
                            {
                                entry.title = title.to_owned();
                            }
                        }
                        Some("user/message")
                            if entry.title == baseline && v["data"]["source"]["kind"] == "user" =>
                        {
                            if let Some(text) = v["data"]["content"].as_array().and_then(|parts| {
                                parts
                                    .iter()
                                    .find(|p| p["type"] == "text")
                                    .and_then(|p| p["text"].as_str())
                            }) {
                                let title = short_title(text);
                                if !title.is_empty() {
                                    entry.title = title;
                                }
                            }
                        }
                        _ => {}
                    }
                });
                if result.is_ok() && remember_tail(&mut file, info.len(), &mut index.tail).is_ok() {
                    entry.size = info.len();
                    entry.modified = modified;
                }
            }
        }
        self.deepseek_indexes.retain(|path, _| seen.contains(path));
    }
}
