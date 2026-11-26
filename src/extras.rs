use crate::storage::atomic_write;
use rfd::FileDialog;
use serde_json::{Value, json};
use std::{
    fs, io,
    io::Write,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tao::window::Window;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6},
    PrintToPdfCompletedHandler,
};
use windows::core::{HSTRING, Interface};
use wry::{WebView, WebViewExtWindows};

const DEFAULT_THEME: &str = "澄明浅色.css";

pub fn theme_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("MarkCraft")
        .join("themes")
}
pub fn seed_themes() -> io::Result<()> {
    let root = theme_dir();
    fs::create_dir_all(&root)?;
    for (name, text) in [
        (DEFAULT_THEME, include_str!("../themes/lucid-paper.css")),
        ("素笺.css", include_str!("../themes/paper.css")),
        ("Claudette.css", include_str!("../themes/claudette.css")),
        (
            "Claudette Dark.css",
            include_str!("../themes/claudette-dark.css"),
        ),
        (
            "Claudette-LICENSE.txt",
            include_str!("../themes/Claudette-LICENSE.txt"),
        ),
    ] {
        let path = root.join(name);
        if !path.exists() {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(mut file) => file.write_all(text.as_bytes())?,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}
pub fn themes(data: &Path, chosen: Option<&str>) -> io::Result<Value> {
    let root = theme_dir();
    let mut names: Vec<String> = fs::read_dir(&root)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_ascii_lowercase().ends_with(".css"))
        .collect();
    names.sort_by(|a, b| (a != DEFAULT_THEME, a).cmp(&(b != DEFAULT_THEME, b)));
    let saved = fs::read_to_string(data.join("document-theme")).unwrap_or_default();
    let name = chosen.unwrap_or(saved.trim());
    let name = if names.iter().any(|n| n == name) {
        name
    } else {
        DEFAULT_THEME
    };
    let css = fs::read_to_string(root.join(name))?;
    if chosen.is_some() {
        atomic_write(&data.join("document-theme"), name.as_bytes())?;
    }
    Ok(json!({"kind":"themes","names":names,"current":name,"css":css}))
}
pub fn markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt"
    )
}
pub fn in_folder(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let path = path.canonicalize()?;
    if !path.starts_with(root.canonicalize()?) {
        return Err(io::Error::other("路径在打开的文件夹之外。"));
    }
    Ok(path)
}
pub fn children(root: &Path, path: &Path) -> io::Result<Value> {
    let _ = in_folder(root, path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)?.flatten() {
        let p = entry.path();
        let ft = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || ft.is_symlink() || (!ft.is_dir() && !markdown_path(&p)) {
            continue;
        }
        entries.push((
            !ft.is_dir(),
            name.to_lowercase(),
            json!({"path":p,"name":name,"dir":ft.is_dir()}),
        ));
    }
    entries.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(
        json!({"kind":"children","root":root,"parent":path,"entries":entries.into_iter().map(|x|x.2).collect::<Vec<_>>()}),
    )
}
pub fn output(win: &Window, document: Option<&Path>, ext: &str) -> Option<PathBuf> {
    let stem = document
        .and_then(Path::file_stem)
        .and_then(|x| x.to_str())
        .unwrap_or("未命名");
    let mut dlg = FileDialog::new()
        .set_parent(win)
        .set_title(format!("导出为 {}", ext.to_uppercase()))
        .add_filter(ext.to_uppercase(), &[ext])
        .set_file_name(format!("{stem}.{ext}"));
    if let Some(dir) = document.and_then(Path::parent) {
        dlg = dlg.set_directory(dir);
    }
    dlg.save_file().map(|mut p| {
        if p.extension().is_none() {
            p.set_extension(ext);
        }
        p
    })
}
pub fn pdf(
    web: &WebView,
    dest: PathBuf,
    paper: &str,
    done: impl FnOnce(Result<String, String>) + 'static,
) -> io::Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::other("目标路径无效"))?;
    let tmp = tempfile::Builder::new()
        .suffix(".pdf")
        .tempfile_in(parent)?
        .into_temp_path();
    let path = HSTRING::from(tmp.as_os_str());
    let native = || -> windows::core::Result<()> {
        unsafe {
            let core: ICoreWebView2_7 = web.controller().CoreWebView2()?.cast()?;
            let environment: ICoreWebView2Environment6 = web.environment().cast()?;
            let settings = environment.CreatePrintSettings()?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            settings.SetShouldPrintBackgrounds(true)?;
            let (w, h) = match paper {
                "A5" => (148., 210.),
                "Letter" => (215.9, 279.4),
                _ => (210., 297.),
            };
            settings.SetPageHeight(h / 25.4)?;
            settings.SetPageWidth(w / 25.4)?;
            let cb = PrintToPdfCompletedHandler::create(Box::new(move |status, ok| {
                let result = (|| -> Result<String, String> {
                    status.map_err(|e| e.to_string())?;
                    if !ok || tmp.metadata().map_err(|e| e.to_string())?.len() == 0 {
                        return Err("PDF 生成失败。".into());
                    }
                    tmp.persist(&dest).map_err(|e| e.to_string())?;
                    Ok(dest.display().to_string())
                })();
                done(result);
                Ok(())
            }));
            core.PrintToPdf(&path, &settings, &cb)
        }
    };
    native().map_err(io::Error::other)
}
fn pandoc_path() -> PathBuf {
    let bundled = std::env::current_exe()
        .unwrap_or_default()
        .with_file_name("tools")
        .join("pandoc")
        .join("pandoc.exe");
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("pandoc.exe")
    }
}
pub fn personal_word_template() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|dir| {
            PathBuf::from(dir)
                .join("MarkCraft")
                .join("word-reference.docx")
        })
        .filter(|path| path.is_file())
}

fn configure_word(cmd: &mut Command, personal: Option<&Path>) -> io::Result<tempfile::TempDir> {
    let assets = tempfile::tempdir()?;
    let filter = assets.path().join("word.lua");
    fs::write(&filter, include_bytes!("../export/word.lua"))?;
    let template = match personal {
        Some(path) => path.to_owned(),
        None => {
            let path = assets.path().join("reference.docx");
            fs::write(&path, include_bytes!("../export/markcraft-word.docx"))?;
            path
        }
    };
    cmd.arg("--reference-doc")
        .arg(template)
        .arg("--lua-filter")
        .arg(filter);
    Ok(assets)
}

pub fn convert(
    text: &str,
    folder: Option<&Path>,
    format: &str,
    dest: &Path,
    reference: Option<&Path>,
) -> io::Result<String> {
    let tmp = tempfile::Builder::new()
        .suffix(&format!(".{format}"))
        .tempfile_in(dest.parent().ok_or_else(|| io::Error::other("目录无效"))?)?
        .into_temp_path();
    let mut cmd = Command::new(pandoc_path());
    // Keep the embedded profile on disk until Pandoc finishes reading it.
    let _word_assets = (format == "docx")
        .then(|| configure_word(&mut cmd, reference))
        .transpose()?;
    if let Some(dir) = folder {
        cmd.current_dir(dir);
    }
    cmd.creation_flags(0x08000000)
        .args([
            "--from",
            "markdown+tex_math_dollars",
            "--to",
            format,
            "--standalone",
            "--output",
        ])
        .arg(&tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let bytes = text.as_bytes().to_owned();
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let out = child.wait_with_output()?;
    if !out.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    }
    writer
        .join()
        .map_err(|_| io::Error::other("传输文稿失败"))??;
    tmp.persist(dest).map_err(|e| e.error)?;
    Ok(if format == "docx" {
        String::from_utf8_lossy(&out.stderr).trim().to_owned()
    } else {
        String::new()
    })
}
pub fn import(path: &Path) -> io::Result<String> {
    let result = Command::new(pandoc_path())
        .creation_flags(0x08000000)
        .arg("--to=markdown")
        .arg("--wrap=none")
        .arg("--")
        .arg(path)
        .output()?;
    if !result.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&result.stderr).into_owned(),
        ));
    }
    String::from_utf8(result.stdout).map_err(io::Error::other)
}
