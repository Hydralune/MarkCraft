use crate::{markdown, storage};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use std::{fs, io, os::windows::process::CommandExt, path::Path, process::Command};
fn remote(url: &str) -> io::Result<Vec<u8>> {
    let dest = tempfile::NamedTempFile::new()?.into_temp_path();
    let curl = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| io::Error::other("找不到 Windows 下载工具"))?
        .join("System32/curl.exe");
    let result = Command::new(curl)
        .args([
            "-q",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--globoff",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-time",
            "25",
            "--max-filesize",
            "50331648",
            "--output",
        ])
        .arg(&dest)
        .arg("--")
        .arg(url)
        .creation_flags(0x08000000)
        .output()?;
    if !result.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&result.stderr).trim().to_owned(),
        ));
    }
    fs::read(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collecting_identical_local_and_embedded_images_reuses_one_asset() {
        let folder = tempfile::tempdir().unwrap();
        let doc = folder.path().join("观测.md");
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        fs::write(folder.path().join("原图.png"), bytes).unwrap();
        let name = collect_one(&doc, "原图.png").unwrap();
        let embedded = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        assert_eq!(collect_one(&doc, &embedded).unwrap(), name);
        assert_eq!(collect_one(&doc, &name).unwrap(), name);
        assert_eq!(fs::read(folder.path().join(name)).unwrap(), bytes);
        assert!(collect_one(&doc, "missing.png").is_err());
    }
}
fn suffix(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|v| v == b"avif" || v == b"avis")
    {
        Some("avif")
    } else if std::str::from_utf8(bytes).ok().is_some_and(|s| {
        s.trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with('<')
            && s.contains("<svg")
    }) {
        Some("svg")
    } else {
        None
    }
}
pub fn collect_one(document: &Path, source: &str) -> io::Result<String> {
    let bytes = if source.starts_with("https://") {
        remote(source)?
    } else if source.starts_with("data:image/") {
        let (_, s) = source
            .split_once(";base64,")
            .ok_or_else(|| io::Error::other("不支持的内嵌图片"))?;
        if s.len() > 68 * 1024 * 1024 {
            return Err(io::Error::other("图片过大"));
        }
        STANDARD.decode(s).map_err(io::Error::other)?
    } else {
        markdown::local_image(document.parent(), &URL_SAFE_NO_PAD.encode(source))
            .ok_or_else(|| io::Error::other("找不到文件或无法读取"))?
            .1
    };
    let ext = suffix(&bytes).ok_or_else(|| io::Error::other("内容不是受支持的图片"))?;
    storage::image_asset(Some(document), ext, &bytes)
}
