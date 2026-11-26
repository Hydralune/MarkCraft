use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct Document {
    pub path: Option<PathBuf>,
    pub original: String,
    digest: Option<[u8; 32]>,
    bom: bool,
    crlf: bool,
}

fn image_uri(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('%', "%25")
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('&', "%26")
}

pub fn image_asset(document: Option<&Path>, suffix: &str, bytes: &[u8]) -> io::Result<String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let Some(doc) = document else {
        return Ok(format!(
            "data:image/{suffix};base64,{}",
            STANDARD.encode(bytes)
        ));
    };
    let stem = doc.file_stem().unwrap_or_default().to_string_lossy();
    let folder = PathBuf::from(format!("{stem}.assets"));
    let dir = doc.with_file_name(&folder);
    fs::create_dir_all(&dir)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let name = format!("{}.{}", &hash[..24], suffix);
    let target = dir.join(&name);
    if !target.exists() {
        atomic_write(&target, bytes)?;
    }
    Ok(image_uri(&folder.join(name)))
}

pub fn replacement_image(document: Option<&Path>, file: &Path) -> io::Result<String> {
    let ext = file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let suffix = match ext.as_str() {
        "jpg" | "jpeg" => "jpeg",
        "png" | "gif" | "webp" => &ext,
        _ => return Err(io::Error::other("请选择 PNG、JPEG、GIF 或 WebP 图片。")),
    };
    if file.metadata()?.len() > 32 * 1024 * 1024 {
        return Err(io::Error::other("图片超过 32 MB。"));
    }
    if let Some(folder) = document.and_then(Path::parent) {
        for (levels, ancestor) in folder.ancestors().enumerate() {
            if !ancestor.has_root() {
                break;
            }
            if let Ok(tail) = file.strip_prefix(ancestor) {
                return Ok(format!("{}{}", "../".repeat(levels), image_uri(tail)));
            }
        }
    }
    image_asset(document, suffix, &fs::read(file)?)
}
impl Document {
    pub fn read(path: PathBuf) -> io::Result<Self> {
        let bytes = fs::read(&path)?;
        let digest = Sha256::digest(&bytes).into();
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let text = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes }).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "请使用 UTF-8 编码的 Markdown 文件。",
            )
        })?;
        if text.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "该文件包含二进制数据。",
            ));
        }
        let crlf = text.contains("\r\n");
        Ok(Self {
            path: Some(path),
            original: text.replace("\r\n", "\n"),
            digest: Some(digest),
            bom,
            crlf,
        })
    }
    pub fn digest(&self) -> Option<[u8; 32]> {
        self.digest
    }
    pub fn differs_from(&self, observed: Option<[u8; 32]>) -> bool {
        self.digest != observed
    }
    pub fn save(&mut self, path: PathBuf, text: &str) -> io::Result<()> {
        self.write_with(path, text, |p, b| atomic_write(p, b))
    }
    pub fn save_checked(
        &mut self,
        path: PathBuf,
        text: &str,
        expected: Option<[u8; 32]>,
    ) -> io::Result<Option<PathBuf>> {
        self.write_with(path, text, |p, b| replace_checked(p, b, expected))
    }
    fn write_with<T>(
        &mut self,
        path: PathBuf,
        text: &str,
        write: impl FnOnce(&Path, &[u8]) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut bytes = Vec::new();
        if self.bom {
            bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        if self.crlf {
            bytes.extend_from_slice(text.replace('\n', "\r\n").as_bytes());
        } else {
            bytes.extend_from_slice(text.as_bytes());
        }
        let result = write(&path, &bytes)?;
        self.digest = Some(Sha256::digest(&bytes).into());
        self.original = text.to_owned();
        self.path = Some(path);
        Ok(result)
    }
}
pub fn save_lock(data: &Path) -> io::Result<fs::File> {
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("save.lock"))?;
    lock.lock()?;
    Ok(lock)
}

pub fn disk_digest(path: &Path) -> io::Result<Option<[u8; 32]>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(Sha256::digest(bytes).into())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn create_draft(data: &Path, text: &str) -> io::Result<Document> {
    let dir = data.join("草稿");
    fs::create_dir_all(&dir)?;
    let title: String = text
        .lines()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .chars()
        .filter(|c| !c.is_control() && !r#"<>:"/\|?*"#.contains(*c))
        .take(32)
        .collect();
    let title = title.trim_end_matches([' ', '.']);
    let stem = if title.is_empty() {
        "草稿".to_owned()
    } else {
        format!("草稿 · {title}")
    };
    let mut temp = tempfile::NamedTempFile::new_in(&dir)?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    for number in 1u64.. {
        let name = if number == 1 {
            format!("{stem}.md")
        } else {
            format!("{stem} ({number}).md")
        };
        let path = dir.join(name);
        match temp.persist_noclobber(&path) {
            Ok(_) => {
                return Ok(Document {
                    path: Some(path),
                    original: text.to_owned(),
                    digest: Some(Sha256::digest(text.as_bytes()).into()),
                    ..Document::default()
                });
            }
            Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => temp = e.file,
            Err(e) => return Err(e.error),
        }
    }
    unreachable!()
}

pub fn draft_files(data: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(data.join("草稿")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut drafts = Vec::new();
    for entry in entries {
        let e = entry?;
        if e.file_type()?.is_file() && e.path().extension().is_some_and(|ext| ext == "md") {
            drafts.push((e.metadata()?.modified()?, e.path()));
        }
    }
    drafts.sort_unstable_by(|a, b| b.cmp(a));
    Ok(drafts.into_iter().map(|(_, p)| p).collect())
}

// Keep the exact version displaced by the rename until its bytes have been
// checked. A different process need not participate in MarkCraft's save lock.
fn replace_checked(
    path: &Path,
    bytes: &[u8],
    expected: Option<[u8; 32]>,
) -> io::Result<Option<PathBuf>> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, ReplaceFileW,
    };
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("目标路径无效"))?;
    let mut next = tempfile::NamedTempFile::new_in(dir)?;
    next.write_all(bytes)?;
    next.as_file().sync_all()?;
    let Some(expected) = expected else {
        next.persist_noclobber(path).map_err(|e| e.error)?;
        return Ok(None);
    };
    let prefix = format!(
        "{}.磁盘版本-",
        path.file_stem().unwrap_or_default().to_string_lossy()
    );
    let reserved = tempfile::Builder::new()
        .prefix(&prefix)
        .suffix(".md")
        .tempfile_in(dir)?;
    let backup = reserved.path().to_owned();
    reserved.close()?;
    let temp = next.into_temp_path();
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let success = unsafe {
        ReplaceFileW(
            wide(path).as_ptr(),
            wide(&temp).as_ptr(),
            wide(&backup).as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        let error = io::Error::last_os_error();
        if backup.is_file() {
            return Err(io::Error::other(format!(
                "{error}。原磁盘版本位于 {}",
                backup.display()
            )));
        }
        return Err(error);
    }
    let matches = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
        .open(&backup)
        .and_then(|mut file| {
            let mut hash = Sha256::new();
            io::copy(&mut file, &mut hash)?;
            Ok(<[u8; 32]>::from(hash.finalize()) == expected)
        })
        .unwrap_or(false);
    if matches && fs::remove_file(&backup).is_ok() {
        Ok(None)
    } else {
        Ok(Some(backup))
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("路径缺少父目录"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
#[derive(Default, Deserialize, Serialize)]
pub struct Recent {
    pub paths: Vec<PathBuf>,
}
impl Recent {
    pub fn load(data: &Path) -> Self {
        fs::read(data.join("recent.json"))
            .ok()
            .and_then(|x| serde_json::from_slice(&x).ok())
            .unwrap_or_default()
    }
    pub fn touch(data: &Path, path: &Path) {
        let mut recent = Self::load(data);
        recent.paths.retain(|p| p != path);
        recent.paths.insert(0, path.to_path_buf());
        recent.paths.truncate(12);
        if let Ok(bytes) = serde_json::to_vec(&recent) {
            let _ = atomic_write(&data.join("recent.json"), &bytes);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_the_displaced_bytes_if_the_disk_changes_during_save() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("稿.md");
        fs::write(&path, "原版").unwrap();
        let mut doc = Document::read(path.clone()).unwrap();
        let expected = doc.digest();
        fs::write(&path, "外部写入").unwrap();
        let backup = doc
            .save_checked(path.clone(), "本地编辑", expected)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), "外部写入");
        assert_eq!(fs::read_to_string(&path).unwrap(), "本地编辑");
        assert!(
            doc.save_checked(path, "再次编辑", doc.digest())
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn drafts_with_identical_titles_remain_separate() {
        let tmp = tempfile::tempdir().unwrap();
        let first = create_draft(tmp.path(), "# 同/名\n甲").unwrap();
        let second = create_draft(tmp.path(), "# 同/名\n乙").unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(draft_files(tmp.path()).unwrap().len(), 2);
        assert_eq!(
            fs::read_to_string(first.path.unwrap()).unwrap(),
            "# 同/名\n甲"
        );
    }

    #[test]
    fn saves_unicode_crlf_bom_and_detects_other_writers() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("中文.md");
        fs::write(&p, b"\xef\xbb\xbfline\r\n").unwrap();
        let mut d = Document::read(p.clone()).unwrap();
        d.save(p.clone(), "中文\n").unwrap();
        assert_eq!(fs::read(&p).unwrap(), "\u{feff}中文\r\n".as_bytes());
        assert!(!d.differs_from(disk_digest(&p).unwrap()));
        fs::write(&p, "external").unwrap();
        assert!(d.differs_from(disk_digest(&p).unwrap()));
    }
}
