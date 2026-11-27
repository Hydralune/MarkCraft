use super::{Roots, Source, handoff::Recipient};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) const SOURCES: [Source; 4] = [
    Source::Codex,
    Source::Claude,
    Source::Antigravity,
    Source::DeepSeek,
];
pub(super) const PACKAGE: &str = "markcraft-handoff-0.3.0.tgz";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Access {
    pub source: Source,
    pub enabled: bool,
    #[serde(default)]
    pub folder: Option<PathBuf>,
}

#[derive(Default, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Config {
    pub sources: Vec<Access>,
}

impl Config {
    pub fn read(data: &Path) -> io::Result<Self> {
        match fs::read(data.join("chat-sources.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }
    pub fn allows(&self, source: Source) -> bool {
        self.sources.iter().any(|a| a.source == source && a.enabled)
    }
    pub fn roots(&self) -> Roots {
        let mut roots = Roots::local();
        for a in &self.sources {
            if let Some(path) = &a.folder {
                *roots.path_mut(a.source) = path.clone();
            }
        }
        roots
    }
    pub fn save(data: &Path, request: &str) -> io::Result<Self> {
        #[derive(Deserialize)]
        struct Change {
            previous: Config,
            next: Config,
        }
        let Change { previous, mut next } = serde_json::from_str(request)?;
        if next.sources.len() != SOURCES.len()
            || SOURCES
                .iter()
                .any(|s| next.sources.iter().filter(|a| a.source == *s).count() != 1)
        {
            return Err(io::Error::other("来源列表不完整，请重新打开配置。"));
        }
        let defaults = Roots::local();
        for a in &mut next.sources {
            if a.enabled && a.folder.is_none() {
                a.folder = Some(defaults.path(a.source).to_path_buf());
            }
            if let Some(p) = &a.folder
                && (!p.is_absolute() || (a.enabled && p != defaults.path(a.source) && !p.is_dir()))
            {
                return Err(io::Error::other(
                    "自选记录目录不存在，请重新选择目录或恢复默认。",
                ));
            }
        }
        fs::create_dir_all(data)?;
        let lock = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(data.join("chat-sources.lock"))?;
        lock.lock()?;
        if Self::read(data)? != previous {
            return Err(io::Error::other("其他窗口已更改授权，请重新打开配置。"));
        }
        let mut file = tempfile::NamedTempFile::new_in(data)?;
        file.write_all(&serde_json::to_vec_pretty(&next)?)?;
        file.as_file().sync_all()?;
        file.persist(data.join("chat-sources.json"))?;
        Ok(next)
    }

    pub fn describe(&self) -> Value {
        let defaults = Roots::local();
        let roots = self.roots();
        let rows: Vec<_> = SOURCES.iter().map(|&source| {
            let root = roots.path(source);
            let markers: &[&str] = match source {
                Source::Codex => &["sessions", "archived_sessions"],
                Source::Claude => &["projects"],
                Source::Antigravity => &["antigravity", "antigravity-cli"],
                Source::DeepSeek => &["sessions", "profiles"],
            };
            let inaccessible = fs::metadata(root).is_err_and(|e| e.kind()==io::ErrorKind::PermissionDenied);
            let var=match source { Source::Codex=>"CODEX_HOME",Source::Claude=>"CLAUDE_CONFIG_DIR",Source::Antigravity=>"MARKCRAFT_GEMINI_DIR",Source::DeepSeek=>"DSH_HOME" };
            let short=if env::var_os(var).filter(|v|!v.is_empty()).is_some(){format!("%{var}%")}
                else{format!("%USERPROFILE%\\{}",defaults.path(source).file_name().unwrap_or_default().to_string_lossy())};
            json!({"source":source,"root":root,"defaultRoot":defaults.path(source),"defaultLabel":short,
                "found": markers.iter().any(|marker| root.join(marker).is_dir()),
                "client": match source {
                    Source::Codex => on_path(&["codex.exe","codex.cmd"]) || env::var_os("LOCALAPPDATA").is_some_and(|p|PathBuf::from(p).join("Packages/OpenAI.Codex_2p2nqsd0c76g0").is_dir()),
                    Source::Claude => on_path(&["claude.exe","claude.cmd"]) || env::home_dir().is_some_and(|d| d.join(".local/bin/claude.exe").is_file()),
                    Source::Antigravity => super::antigravity::agy_path().is_some() || desktop_exe().is_some(),
                    Source::DeepSeek => on_path(&["dsh.cmd","dsh.exe"]) || root.join("profiles/desktop").is_dir() || ["APPDATA","ProgramData"].iter().filter_map(env::var_os).any(|p|PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk").is_file()),
                }, "inaccessible":inaccessible})
        }).collect();
        let dsh = &roots.dsh;
        let plugin_version = if self.allows(Source::DeepSeek) {
            fs::read(dsh.join("profiles/desktop/node_modules/markcraft-handoff/package.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|v| v["version"].as_str().map(str::to_owned))
        } else {
            None
        };
        let bridge = if self.allows(Source::DeepSeek) {
            super::handoff::targets(dsh)
        } else {
            Value::Null
        };
        json!({"config":self,"sources":rows, "agy":super::antigravity::agy_path().is_some(),
            "node":super::antigravity::node_path().is_some(), "pluginVersion":plugin_version,
            "bridge":bridge["namedHarness"]==true,"package":package().is_ok_and(|p|p.is_file())})
    }
}

impl Roots {
    fn path_mut(&mut self, s: Source) -> &mut PathBuf {
        match s {
            Source::Codex => &mut self.codex,
            Source::Claude => &mut self.claude,
            Source::Antigravity => &mut self.gemini,
            Source::DeepSeek => &mut self.dsh,
        }
    }
    pub(super) fn path(&self, s: Source) -> &Path {
        match s {
            Source::Codex => &self.codex,
            Source::Claude => &self.claude,
            Source::Antigravity => &self.gemini,
            Source::DeepSeek => &self.dsh,
        }
    }
}

fn on_path(names: &[&str]) -> bool {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|p| p.is_absolute())
        .any(|p| names.iter().any(|n| p.join(n).is_file()))
}

pub(crate) fn desktop_exe() -> Option<PathBuf> {
    ["LOCALAPPDATA", "ProgramFiles"]
        .iter()
        .filter_map(env::var_os)
        .map(PathBuf::from)
        .flat_map(|p| {
            [
                p.join("Programs/antigravity/Antigravity.exe"),
                p.join("Antigravity/Antigravity.exe"),
            ]
        })
        .find(|p| p.is_file())
}

pub(crate) fn package() -> io::Result<PathBuf> {
    Ok(env::current_exe()?.with_file_name(PACKAGE))
}

impl Recipient {
    pub(super) fn source(self) -> Source {
        match self {
            Self::Codex => Source::Codex,
            Self::Claude => Source::Claude,
            Self::Antigravity | Self::AntigravityDesktop => Source::Antigravity,
            Self::DeepSeek => Source::DeepSeek,
        }
    }
}

pub(super) fn install_plugin(roots: &Roots, executable: &str) -> io::Result<()> {
    if !roots.dsh.join("profiles/desktop").is_dir() {
        return Err(io::Error::other(
            "请先启动一次 DeepSeek Harness 桌面端，再核对所选记录目录。",
        ));
    }
    let package = package()?;
    if !package.is_file() {
        return Err(io::Error::other(
            "发行包中的插件缺失，请完整解压 Windows 便携包。",
        ));
    }
    let temp = tempfile::tempdir()?;
    let script = temp.path().join("install-harness-plugin.ps1");
    fs::write(
        &script,
        include_bytes!("../../integrations/deepseek-handoff/install-harness-plugin.ps1"),
    )?;
    let shell = PathBuf::from(
        env::var_os("SystemRoot").ok_or_else(|| io::Error::other("找不到 Windows PowerShell。"))?,
    )
    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut cmd = Command::new(shell);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(script)
    .arg("-Package")
    .arg(package)
    .env("DSH_HOME", &roots.dsh)
    .creation_flags(0x08000000);
    if !executable.is_empty() {
        cmd.arg("-HarnessExecutable").arg(executable);
    }
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    if detail.contains("Open DeepSeek Harness, or select")
        || detail.contains("Select DeepSeek Harness.exe")
    {
        return Err(io::Error::other(
            "未能定位 Harness 的插件管理器。请点「选择 Harness 程序安装…」，选择官方桌面端的 DeepSeek Harness.exe。",
        ));
    }
    Err(io::Error::other(
        detail
            .lines()
            .filter(|s| !s.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(350)
            .collect::<String>(),
    ))
}
