use crate::extras;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs, io,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    personal: bool,
    body_font: Option<String>,
    heading_font: Option<String>,
    body_size: Option<f64>,
    headings: [Option<f64>; 6],
    color: Option<String>,
    leading: Option<f64>,
    after: Option<f64>,
    heading_before: Option<f64>,
    heading_after: Option<f64>,
    heading_align: Option<String>,
    body_align: Option<String>,
    first_indent: Option<f64>,
    header_fill: Option<String>,
    cell_padding: Option<f64>,
}

impl Layout {
    fn parse(arg: &str) -> io::Result<Self> {
        let s: Self = serde_json::from_str(arg).map_err(io::Error::other)?;
        let within = |v: Option<f64>, low, high| v.is_none_or(|x| (low..=high).contains(&x));
        if !within(s.body_size, 8., 36.)
            || !within(s.leading, 1., 3.)
            || !within(s.after, 0., 36.)
            || !within(s.heading_before, 0., 72.)
            || !within(s.heading_after, 0., 36.)
            || !within(s.first_indent, 0., 4.)
            || !within(s.cell_padding, 0., 12.)
            || s.heading_align.as_deref().is_some_and(|a| !matches!(a, "left" | "center"))
            || s.body_align.as_deref().is_some_and(|a| !matches!(a, "left" | "both"))
            || s.headings.iter().any(|&v| !within(v, 8., 72.))
            || [&s.body_font, &s.heading_font]
                .into_iter()
                .flatten()
                .any(|f| f.len() > 100 || f.contains(char::is_control))
            || [&s.color, &s.header_fill].into_iter().flatten().any(|c| {
                c.len() != 7
                    || !c.starts_with('#')
                    || !c.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            })
        {
            return Err(io::Error::other("排版参数超出可用范围"));
        }
        Ok(s)
    }
}

struct Job {
    revision: u64,
    layout: Layout,
}
struct Ready {
    revision: u64,
    warnings: String,
}
pub struct Studio {
    pub id: u64,
    dir: Arc<tempfile::TempDir>,
    current: Arc<AtomicU64>,
    ready: Arc<Mutex<Option<Ready>>>,
    tx: mpsc::Sender<Job>,
}

fn powershell(script: &str, document: &Path) -> Command {
    let shell =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut cmd = Command::new(shell);
    cmd.creation_flags(0x08000000)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("MARKCRAFT_WORD_DOC", document)
        .stdin(Stdio::null());
    cmd
}

fn layout_doc(base: &Path, target: &Path, spec: &Layout) -> io::Result<()> {
    fs::copy(base, target)?;
    let settings = target.with_extension("json");
    fs::write(&settings, serde_json::to_vec(spec)?)?;
    let output = powershell(include_str!("../export/word-style.ps1"), target)
        .env("MARKCRAFT_WORD_SETTINGS", settings)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "写入 Word 样式失败。{}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

fn first_page(doc: &Path) -> Option<String> {
    let image = doc.with_extension("png");
    let _ = fs::remove_file(&image);
    let mut child = powershell(include_str!("../export/word-page.ps1"), doc)
        .env("MARKCRAFT_WORD_PNG", &image)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return status
                .success()
                .then(|| fs::read(image).ok())
                .flatten()
                .map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
        }
        if start.elapsed() > Duration::from_secs(35) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(70));
    }
}

impl Studio {
    pub fn new(
        id: u64,
        epoch: u64,
        text: String,
        input: extras::ConversionInput,
        send: impl Fn(Value) + Send + 'static,
    ) -> io::Result<Self> {
        let dir = Arc::new(tempfile::tempdir()?);
        let current = Arc::new(AtomicU64::new(0));
        let ready = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel::<Job>();
        let result = Self {
            id,
            tx,
            dir: dir.clone(),
            current: current.clone(),
            ready: ready.clone(),
        };
        thread::spawn(move || {
            // Reuse the converted manuscript and its downloaded images for successive edits.
            let mut bases = std::collections::HashMap::new();
            while let Ok(first) = rx.recv() {
                let job = rx.try_iter().last().unwrap_or(first);
                let rev = job.revision;
                let fresh = || current.load(Ordering::Acquire) == rev;
                if !fresh() {
                    continue;
                }
                let prepared = (|| -> io::Result<String> {
                    let personal = job.layout.personal;
                    let base = dir.path().join(if personal {
                        "personal.docx"
                    } else {
                        "standard.docx"
                    });
                    if let std::collections::hash_map::Entry::Vacant(e) = bases.entry(personal) {
                        let reference = if personal {
                            Some(
                                extras::personal_word_template()
                                    .ok_or_else(|| io::Error::other("个人模板文件已移走"))?,
                            )
                        } else {
                            None
                        };
                        let warnings = extras::convert(&text, &input, "docx", &base, reference.as_deref())
                            .map_err(|err| if err.kind()==io::ErrorKind::NotFound {io::Error::other("未找到 Pandoc。请安装 Pandoc，或将其放入程序旁的 tools/pandoc 文件夹。")} else {err})?;
                        e.insert(warnings);
                    }
                    if fresh() {
                        layout_doc(&base, &dir.path().join("layout.docx"), &job.layout)?;
                    }
                    Ok(bases[&personal].clone())
                })();
                if !fresh() {
                    continue;
                }
                match prepared {
                    Ok(warnings) => {
                        let image = first_page(&dir.path().join("layout.docx"));
                        if fresh() {
                            *ready.lock().unwrap() = Some(Ready {
                                revision: rev,
                                warnings,
                            });
                            send(
                                json!({"kind":"wordPage","epoch":epoch,"studio":id,"rev":rev,"image":image}),
                            );
                        }
                    }
                    Err(err) => send(
                        json!({"kind":"wordPage","epoch":epoch,"studio":id,"rev":rev,"error":err.to_string()}),
                    ),
                }
            }
        });
        Ok(result)
    }
    pub fn layout(&self, revision: u64, arg: &str) -> io::Result<()> {
        let layout = Layout::parse(arg)?;
        self.current.store(revision, Ordering::Release);
        self.tx
            .send(Job { revision, layout })
            .map_err(io::Error::other)
    }
    pub fn save(&self, revision: u64, dest: &Path) -> io::Result<String> {
        let ready = self.ready.lock().unwrap();
        let saved = ready
            .as_ref()
            .filter(|r| r.revision == revision && revision == self.current.load(Ordering::Acquire))
            .ok_or_else(|| io::Error::other("请等待当前排版完成预览"))?;
        let mut output = tempfile::NamedTempFile::new_in(
            dest.parent().ok_or_else(|| io::Error::other("目录无效"))?,
        )?;
        io::copy(
            &mut fs::File::open(self.dir.path().join("layout.docx"))?,
            output.as_file_mut(),
        )?;
        output.persist(dest).map_err(|e| e.error)?;
        Ok(saved.warnings.clone())
    }
}
impl Drop for Studio {
    fn drop(&mut self) {
        self.current.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_layout_can_inherit_or_override_individual_styles() {
        let mut layout = json!({"personal":true,"headings":[null,24,null,null,null,null]});
        assert_eq!(
            Layout::parse(&layout.to_string()).unwrap().headings[1],
            Some(24.)
        );
        layout["headings"][0] = json!(200);
        assert!(Layout::parse(&layout.to_string()).is_err());
    }

    #[test]
    fn save_requires_the_latest_preview_and_copies_its_bytes() {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let studio = Studio {
            id: 1,
            dir: dir.clone(),
            current: Arc::new(AtomicU64::new(3)),
            ready: Arc::new(Mutex::new(Some(Ready {
                revision: 2,
                warnings: String::new(),
            }))),
            tx: mpsc::channel().0,
        };
        let dest = dir.path().join("export.docx");
        fs::write(&dest, b"previous").unwrap();
        fs::write(dir.path().join("layout.docx"), b"rendered").unwrap();
        assert!(studio.save(2, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"previous");
        studio.ready.lock().unwrap().as_mut().unwrap().revision = 3;
        studio.save(3, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"rendered");
    }
}
