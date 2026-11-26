use crate::extras;
use std::{
    io,
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Debug, PartialEq)]
pub enum Target {
    Web(Url),
    Document(PathBuf, String),
    Asset(PathBuf),
}

pub fn resolve(text: &str, document: Option<&Path>) -> io::Result<Target> {
    let raw = text.trim();
    let raw = raw
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(raw);
    let drive = raw.as_bytes().get(1) == Some(&b':')
        && raw
            .as_bytes()
            .get(2)
            .is_some_and(|c| matches!(c, b'/' | b'\\'));
    if !drive && let Ok(url) = Url::parse(raw) {
        if matches!(url.scheme(), "https" | "http") && url.host().is_some() {
            return Ok(Target::Web(url));
        }
        if url.scheme() == "file" && url.host_str().is_none_or(|h| h == "localhost") {
            let path = url
                .to_file_path()
                .map_err(|_| io::Error::other("无效的本机文件路径。"))?;
            return classify(path, url.fragment().unwrap_or(""));
        }
        return Err(io::Error::other("此链接类型暂不支持。"));
    }
    if raw.starts_with("//") || raw.starts_with(r"\\") {
        return Err(io::Error::other("请选择本机文件链接。"));
    }
    let (name, fragment) = raw.split_once('#').unwrap_or((raw, ""));
    let name = percent_encoding::percent_decode_str(name)
        .decode_utf8()
        .map_err(io::Error::other)?;
    let path = Path::new(name.as_ref());
    let full = if path.is_absolute() {
        path.to_owned()
    } else {
        document
            .and_then(Path::parent)
            .ok_or_else(|| io::Error::other("请先保存文稿，再打开相对路径。"))?
            .join(path)
    };
    classify(full, fragment)
}
fn classify(path: PathBuf, fragment: &str) -> io::Result<Target> {
    if !path.is_file() {
        return Err(io::Error::other(format!(
            "找不到链接指向的文件：{}",
            path.display()
        )));
    }
    if extras::markdown_path(&path) {
        Ok(Target::Document(
            path,
            percent_encoding::percent_decode_str(fragment)
                .decode_utf8_lossy()
                .into_owned(),
        ))
    } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        matches!(
            e.to_ascii_lowercase().as_str(),
            "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "tif" | "tiff"
        )
    }) {
        Ok(Target::Asset(path))
    } else {
        Err(io::Error::other("此文件类型暂不支持从正文打开。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_relative_encoded_document_image_and_web_links() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().join("README.md");
        let other = t.path().join("分 镜.md");
        std::fs::write(&other, "").unwrap();
        assert_eq!(
            resolve("./%E5%88%86%20%E9%95%9C.md#小节", Some(&base)).unwrap(),
            Target::Document(other.clone(), "小节".into())
        );
        assert_eq!(
            resolve(Url::from_file_path(&other).unwrap().as_str(), None).unwrap(),
            Target::Document(other, String::new())
        );
        let img = t.path().join("封面.jpg");
        std::fs::write(&img, "").unwrap();
        assert_eq!(
            resolve("./封面.jpg", Some(&base)).unwrap(),
            Target::Asset(img)
        );
        assert!(matches!(
            resolve("http://127.0.0.1:8820/#roles", None),
            Ok(Target::Web(_))
        ));
        assert!(resolve("missing.md", Some(&base)).is_err());
        assert!(resolve("javascript:alert(1)", Some(&base)).is_err());
    }
}
