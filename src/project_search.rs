use crate::extras::markdown_path;
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
#[derive(Serialize)]
pub struct Hit {
    path: PathBuf,
    line: usize,
    preview: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_documents_and_lines_and_skips_generated_folders() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path();
        for name in ["子目录", "node_modules"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        let document = root.join("子目录/提纲.MD");
        fs::write(&document, "第一行\n测站 Needle。\n").unwrap();
        fs::write(root.join("node_modules/提纲.md"), "needle").unwrap();
        let serial = AtomicU64::new(1);
        let (names, _) = search(root, "提纲", false, &serial, 1);
        assert_eq!(names.len(), 1);
        let (hits, _) = search(root, "NEEDLE", true, &serial, 1);
        assert_eq!(hits.len(), 1);
        assert_eq!((&hits[0].path, hits[0].line), (&document, 2));
        assert!(hits[0].preview.contains("测站"));
        assert!(search(root, "needle", true, &serial, 0).0.is_empty());
    }
}
pub fn search(
    root: &Path,
    query: &str,
    content: bool,
    serial: &AtomicU64,
    id: u64,
) -> (Vec<Hit>, bool) {
    let mut result = Vec::new();
    let mut dirs = vec![root.to_owned()];
    let needle = query.to_lowercase();
    if content && needle.trim().is_empty() {
        return (result, false);
    }
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if serial.load(Ordering::Relaxed) != id {
                return (Vec::new(), false);
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
            if meta.is_dir() {
                if !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "node_modules" | "target" | ".svn")
                ) {
                    dirs.push(path);
                }
                continue;
            }
            if !markdown_path(&path) || !meta.is_file() {
                continue;
            }
            if !content {
                if path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_lowercase()
                    .contains(&needle)
                {
                    result.push(Hit {
                        path,
                        line: 0,
                        preview: String::new(),
                    });
                }
            } else if let Ok(file) = fs::File::open(&path) {
                for (i, line) in BufReader::new(file).lines().enumerate() {
                    if serial.load(Ordering::Relaxed) != id {
                        return (Vec::new(), false);
                    }
                    let Ok(line) = line else { break };
                    let lower = line.to_lowercase();
                    if let Some(at) = lower.find(&needle) {
                        let skip = lower[..at].chars().count().saturating_sub(28);
                        result.push(Hit {
                            path: path.clone(),
                            line: i + 1,
                            preview: line.chars().skip(skip).take(130).collect(),
                        });
                        if result.len() == 150 {
                            return (result, true);
                        }
                    }
                }
            }
            if result.len() == 150 {
                return (result, true);
            }
        }
    }
    (result, false)
}
