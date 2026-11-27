#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod assets;

mod chat;
mod disk_watch;
mod extras;
mod file_window;
mod links;
mod markdown;
mod project_search;
mod saving;
mod storage;
mod word_export;
use saving::{Next, Pending, Save};

use rfd::{FileDialog, MessageDialog, MessageLevel};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    cell::RefCell,
    fs, io,
    path::{Path, PathBuf},
    rc::Rc,
};
use storage::{Document, Recent};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::{EventLoopBuilderExtWindows, WindowBuilderExtWindows},
    window::{Icon, Theme, Window, WindowBuilder},
};
use wry::{
    DragDropEvent, NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
};

#[derive(Debug)]
enum Input {
    Message(String),
    Drop(PathBuf),
    GoToLine(u32),
    Reply(serde_json::Value),
    Exported(Result<(String, String), String>),
}

#[derive(Deserialize)]
struct Request {
    action: String,

    #[serde(default)]
    recipient: chat::Recipient,
    #[serde(default, rename = "chatTitle")]
    chat_title: Option<String>,

    #[serde(default, rename = "forkId")]
    fork_id: Option<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    arg: String,
    #[serde(default)]
    rev: u64,
    #[serde(default)]
    epoch: u64,
    #[serde(default)]
    automatic: bool,
}
fn send(web: &WebView, payload: impl Serialize) {
    if let Ok(data) = serde_json::to_string(&payload) {
        let _ = web.evaluate_script(&format!("window.craftReceive({data})"));
    }
}
fn dialog(win: &Window) -> FileDialog {
    FileDialog::new()
        .set_parent(win)
        .add_filter("Markdown 文稿", &["md", "markdown", "mdown", "mkd", "txt"])
        .add_filter("所有文件", &["*"])
}
fn image_dialog(win: &Window) -> FileDialog {
    FileDialog::new()
        .set_parent(win)
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp"])
}
#[derive(Default)]
struct App {

    chats: Option<std::sync::mpsc::Sender<chat::Job>>,
    doc: Document,
    watch: disk_watch::Watch,
    data: PathBuf,
    folder: Rc<RefCell<Option<PathBuf>>>,
    first_file: Option<PathBuf>,
    window_key: Option<Vec<u16>>,
    pending_drop: Option<PathBuf>,
    guide: bool,
    dirty: bool,
    ready: bool,
    pending: Option<Pending>,
    question_id: u64,
    epoch: u64,
    workspace: Option<PathBuf>,
    folder_back: Vec<PathBuf>,
    folder_forward: Vec<PathBuf>,
    proxy: Option<tao::event_loop::EventLoopProxy<Input>>,
    exporting: bool,
    word_studio: Option<word_export::Studio>,
    search_serial: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
impl App {
    fn browse_root(&self) -> Option<&Path> {
        self.workspace.as_deref().or_else(|| self.doc.path.as_deref().and_then(Path::parent))
    }
    fn history_target(history: &mut Vec<PathBuf>) -> Option<PathBuf> {
        while let Some(path) = history.last() {
            match fs::metadata(path) {
                Ok(info) if !info.is_dir() => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                _ => return Some(path.clone()),
            }
            history.pop();
        }
        None
    }
    fn show_folder(&mut self, path: PathBuf, action: &str, web: &WebView) -> io::Result<()> {
        let mut listing = extras::children(&path, &path)?;
        if let Some(previous) = self.browse_root().filter(|p| *p != path).map(Path::to_path_buf) {
            match action {
                "folderBack" => {
                    self.folder_back.pop();
                    self.folder_forward.push(previous);
                }
                "folderForward" => {
                    self.folder_forward.pop();
                    self.folder_back.push(previous);
                }
                _ => {
                    self.folder_back.push(previous);
                    self.folder_forward.clear();
                }
            }
        }
        self.workspace = Some(path);
        listing["reveal"] = json!(action == "folder");
        self.send_tree(listing, web);
        Ok(())
    }
    fn send_tree(&self, mut listing: Value, web: &WebView) {
        listing["back"] = json!(self.folder_back.last());
        listing["forward"] = json!(self.folder_forward.last());
        listing["up"] = json!(self.browse_root().and_then(Path::parent));
        listing["epoch"] = json!(self.epoch);
        send(web, listing);
    }
    fn title(&self) -> String {
        self.doc
            .path
            .as_deref()
            .and_then(Path::file_name)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| {
                if self.guide {
                    "使用指南.md"
                } else {
                    "未命名.md"
                }
                .to_owned()
            })
    }
    fn titlebar(&self, win: &Window) {
        win.set_title(&format!(
            "{}{} — MarkCraft",
            if self.dirty { "● " } else { "" },
            self.title(),
        ));
    }
    fn document(&mut self, win: &Window, web: &WebView) {
        self.word_studio = None;
        file_window::register(
            win,
            &self.data,
            self.doc.path.as_deref(),
            &mut self.window_key,
        );
        self.search_serial
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.watch = Default::default();
        self.epoch += 1;
        *self.folder.borrow_mut() = self
            .doc
            .path
            .as_deref()
            .and_then(Path::parent)
            .map(Path::to_path_buf);
        self.dirty = false;
        self.titlebar(win);
        send(
            web,
            json!({"kind":"document","epoch":self.epoch,"draft":self.is_draft(), "title":self.title(), "path":self.doc.path, "text":self.doc.original,
                         "blocks":markdown::blocks(&self.doc.original),"guide":self.guide,"recent":Recent::load(&self.data).paths,"root":self.browse_root()}),
        );
    }
    fn open(&mut self, path: PathBuf, win: &Window, web: &WebView) -> io::Result<()> {
        let loaded = Document::read(path.clone())?;
        self.open_loaded(loaded, path, win, web);
        Ok(())
    }
    fn open_loaded(&mut self, loaded: Document, path: PathBuf, win: &Window, web: &WebView) {
        self.doc = loaded;
        self.guide = false;
        Recent::touch(&self.data, &path);
        self.document(win, web);
    }
    fn handle(&mut self, request: Request, win: &Window, web: &WebView) -> io::Result<bool> {
        let Request {
            action,

            recipient,
            chat_title,

            fork_id,
            text,
            arg,
            rev,
            epoch,
            automatic,
        } = request;
        if action != "ready" && epoch != self.epoch {
            return Ok(false);
        }
        if self.pending.is_some()
            && !matches!(
                action.as_str(),
                "answer" | "render" | "dirty" | "windowTheme" | "chatIndex" | "chatRead"
            )
        {
            return Ok(false);
        }
        if self.exporting
            && matches!(
                action.as_str(),
                "close"
                    | "new"
                    | "open"
                    | "recent"
                    | "link"
                    | "drop"
                    | "guide"
                    | "workspaceFile"
                    | "draftOpen"
                    | "import"
            )
        {
            send(web, json!({"kind":"notice","message":"正在导出，请稍候。"}));
            return Ok(false);
        }
        match action.as_str() {

            "chatPluginPackage" => {
                let package = std::env::current_exe()?.with_file_name("markcraft-handoff-0.3.0.tgz");
                if package.is_file() {
                    std::process::Command::new("explorer.exe").arg(format!("/select,{}", package.display())).spawn()?;
                } else {
                    send(web, json!({"kind":"notice","message":"请把发行包中的 markcraft-handoff-0.3.0.tgz 放在程序旁。"}));
                }
            }

            "chatOpenCodex" => {
                let valid=arg.len()==36 && arg.bytes().enumerate().all(|(i,b)|if matches!(i,8|13|18|23){b==b'-'}else{b.is_ascii_hexdigit()});
                if valid { open::that(format!("codex://threads/{arg}"))?; }
            }

            "chatOpenAntigravity" => {
                let exe = chat::desktop_exe();
                if let Some(exe) = exe { std::process::Command::new(exe).spawn()?; }
                else { send(web, json!({"kind":"notice","message":"请从开始菜单打开已安装的 Antigravity 桌面端。"})); }
            }

            "chatFolder" => {
                let folder = FileDialog::new().set_parent(win).set_title("选择智能体的记录根目录").pick_folder();
                send(web,json!({"kind":"chatFolder","id":arg,"rev":rev,"epoch":epoch,"folder":folder}));
            }
            "chatSetup" | "chatConfigure" | "chatInstallPlugin" | "chatIndex" | "chatRead" | "chatHandoff" | "chatRename" => {
                let text = if action == "chatInstallPlugin" && text == "@pick" {
                    let Some(exe)=FileDialog::new().set_parent(win).add_filter("DeepSeek Harness", &["exe"]).pick_file() else {
                        send(web,json!({"kind":action,"cancelled":true,"epoch":epoch,"rev":rev}));return Ok(false);
                    };exe.to_string_lossy().into_owned()
                } else if action == "chatHandoff" && text == "@pick" {
                    let Some(path) = FileDialog::new().set_parent(win).set_title("选择接续任务的工作目录").pick_folder() else {
                        send(web, json!({"kind":"chatHandoff", "rev":rev, "epoch":epoch, "cancelled":true}));
                        return Ok(false);
                    };
                    format!("@folder:{}", path.display())
                } else {
                    text
                };
                if let Some(proxy) = self.proxy.clone() {
                    let worker = self.chats.get_or_insert_with(|| chat::worker(proxy, self.data.clone()));
                    let _ = worker.send(chat::Job { action, recipient, id: arg, query: text, name:chat_title, fork:fork_id, rev, epoch });
                }
            }
            "ready" => {
                self.ready = true;
                send(web, extras::themes(&self.data, None)?);
                if let Some(path) = self.first_file.take() {
                    if let Err(e) = self.open(path, win, web) {
                        self.document(win, web);
                        return Err(e);
                    }
                } else {
                    self.document(win, web);
                }
            }
            "render" => send(
                web,
                json!({"kind":"render","rev":rev,"blocks":markdown::blocks(&text)}),
            ),
            "checkDisk" => self.check_disk(rev, arg == "force", web),
            "acceptDisk" | "conflictDisk" => {
                self.respond_disk(rev, action == "acceptDisk", win, web)
            }
            "dirty" => {
                self.dirty = arg == "yes";
                self.titlebar(win);
            }
            "save" | "saveAs" | "autosave" => {
                let mode = match action.as_str() {
                    "saveAs" => Save::As,
                    "autosave" => Save::Automatic,
                    _ => Save::Manual,
                };
                if action == "autosave" && (!automatic || self.doc.original == text) {
                    return Ok(false);
                }
                return self.persist(mode, Next::Stay, &text, win, web);
            }
            "answer" => return self.answer(rev, &arg, &text, win, web),
            "drafts" => send(
                web,
                json!({"kind":"draftList","paths":storage::draft_files(&self.data)?}),
            ),
            "draftOpen" => {
                let path = storage::draft_files(&self.data)?
                    .into_iter()
                    .find(|p| p == Path::new(&arg));
                if let Some(p) = path {
                    return self.leave(Next::Open(p), &text, automatic, win, web);
                }
            }
            "open" | "recent" | "drop" | "workspaceFile" => {
                let chosen = match action.as_str() {
                    "open" => dialog(win).pick_file(),
                    "recent" => Recent::load(&self.data)
                        .paths
                        .into_iter()
                        .find(|p| p == Path::new(&arg)),
                    "workspaceFile" => {
                        if let Some(root) = self.browse_root() {
                            extras::in_folder(root, Path::new(&arg))?;
                            Some(PathBuf::from(&arg))
                        } else {
                            None
                        }
                    }
                    _ => self.pending_drop.take(),
                };
                if let Some(path) = chosen {
                    if file_window::activate_at(&self.data, &path, rev) {
                        send(web, json!({"kind":"activatedFile"}));
                        return Ok(false);
                    }
                    let next = if action == "workspaceFile" { Next::TreeFile(path) } else { Next::Open(path) };
                    return self.leave(next, &text, automatic, win, web);
                }
            }
            "close" | "new" | "guide" => {
                let next = match action.as_str() {
                    "close" => Next::Close,
                    "guide" => Next::Guide,
                    _ => Next::New,
                };
                return self.leave(next, &text, automatic, win, web);
            }
            "link" => match links::resolve(&arg, self.doc.path.as_deref())? {
                links::Target::Web(url) => open::that_detached(url.as_str())?,
                links::Target::Asset(path) => open::that_detached(path)?,
                links::Target::Document(path, fragment) => {
                    let line = if fragment.is_empty() {
                        0
                    } else {
                        markdown::heading_line(&Document::read(path.clone())?.original, &fragment)
                            .unwrap_or(0)
                    };
                    if !file_window::activate_at(&self.data, &path, line) {
                        return self.leave(Next::Linked(path, line), &text, automatic, win, web);
                    }
                }
            },
            "theme" => send(web, extras::themes(&self.data, Some(&arg))?),
            "themes" => send(web, extras::themes(&self.data, None)?),
            "windowTheme" => win.set_theme(Some(if arg == "dark" {
                Theme::Dark
            } else {
                Theme::Light
            })),
            "themeFolder" => {
                open::that_detached(extras::theme_dir())?;
            }
            "newWindow" => {
                std::process::Command::new(std::env::current_exe()?).spawn()?;
            }
            "fullscreen" => {
                use tao::window::Fullscreen;
                win.set_fullscreen(if win.fullscreen().is_some() {
                    None
                } else {
                    Some(Fullscreen::Borderless(None))
                });
            }
            "folder" => {
                let mut picker = FileDialog::new().set_parent(win);
                if let Some(root) = self.browse_root() {
                    picker = picker.set_directory(root);
                }
                if let Some(folder) = picker.pick_folder() {
                    self.show_folder(folder, &action, web)?;
                }
            }
            "folderUp" | "folderBack" | "folderForward" | "folderEnter" => {
                let target = match action.as_str() {
                    "folderBack" => Self::history_target(&mut self.folder_back),
                    "folderForward" => Self::history_target(&mut self.folder_forward),
                    "folderUp" => self.browse_root().and_then(Path::parent).map(Path::to_path_buf),
                    _ => {
                        let Some(root) = self.browse_root() else { return Ok(false) };
                        extras::in_folder(root, Path::new(&arg))?;
                        Some(PathBuf::from(arg))
                    }
                };
                if let Some(path) = target {
                    self.show_folder(path, &action, web)?;
                } else if let Some(root) = self.browse_root() {
                    self.send_tree(extras::children(root, root)?, web);
                }
            }
            "cancelSearch" => {
                self.search_serial
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            "projectNames" | "projectText" => {
                use std::sync::atomic::Ordering;
                let serial = self.search_serial.clone();
                let ticket = serial.fetch_add(1, Ordering::Relaxed) + 1;
                let root = self.browse_root().map(Path::to_path_buf);
                let proxy = self.proxy.as_ref().unwrap().clone();
                std::thread::spawn(move || {
                    let (hits, limited) = root
                        .as_deref()
                        .map(|p| {
                            project_search::search(
                                p,
                                &arg,
                                action == "projectText",
                                &serial,
                                ticket,
                            )
                        })
                        .unwrap_or_default();
                    if serial.load(Ordering::Relaxed) == ticket {
                        let _=proxy.send_event(Input::Reply(json!({"kind":"projectHits","rev":rev,"epoch":epoch,"hits":hits,"limited":limited})));
                    }
                });
            }
            "children" => {
                if let Some(root) = self.browse_root() {
                    let folder = if arg.is_empty() {
                        root
                    } else {
                        Path::new(&arg)
                    };
                    self.send_tree(extras::children(root, folder)?, web);
                }
            }
            "collectImages" => {
                let path = self
                    .doc
                    .path
                    .clone()
                    .filter(|_| !self.is_draft())
                    .ok_or_else(|| io::Error::other("请先将文稿保存到文件夹。"))?;
                let proxy = self.proxy.as_ref().unwrap().clone();
                std::thread::spawn(move || {
                    let blocks = markdown::blocks(&text);
                    let paths = markdown::image_paths(&blocks);
                    let mut resolved = std::collections::BTreeMap::new();
                    let mut failed = Vec::new();
                    for (i, source) in paths.iter().enumerate() {
                        let _=proxy.send_event(Input::Reply(json!({"kind":"assetProgress","epoch":epoch,"rev":rev,"index":i+1,"count":paths.len()})));
                        match assets::collect_one(&path,source){
                            Ok(new_path)=>{resolved.insert(source,new_path);}
                            Err(e)=>failed.push(json!({"path":if source.starts_with("data:"){"内嵌图片"}else{source},"reason":e.to_string()})),
                        }
                    }
                    let _=proxy.send_event(Input::Reply(json!({"kind":"assetResults","epoch":epoch,"rev":rev,"document":path,"resolved":resolved,"failed":failed,"blocks":blocks})));
                });
            }
            "replaceImageFile" => {
                let document = self.doc.path.as_deref().filter(|_| !self.is_draft());
                let mut picker = image_dialog(win).set_title("更换图片");
                if let Some(folder) = document.and_then(Path::parent) {
                    picker = picker.set_directory(folder);
                }
                let result = picker
                    .pick_file()
                    .map(|file| storage::replacement_image(document, &file))
                    .transpose();
                let reply = match result {
                    Ok(path) => {
                        json!({"kind":"imageFilePicked","epoch":epoch,"rev":rev,"path":path})
                    }
                    Err(e) => {
                        json!({"kind":"imageFilePicked","epoch":epoch,"rev":rev,"error":e.to_string()})
                    }
                };
                send(web, reply);
            }
            "imagePick" | "pasteImage" => {
                use base64::{Engine, engine::general_purpose::STANDARD};
                let (suffix, bytes) = if action == "imagePick" {
                    let Some(p) = image_dialog(win).pick_file() else {
                        return Ok(false);
                    };
                    if arg == "link" {
                        let path = storage::replacement_image(
                            self.doc.path.as_deref().filter(|_| !self.is_draft()),
                            &p,
                        )?;
                        send(
                            web,
                            json!({"kind":"insert","text":format!("![图片](<{path}>)")}),
                        );
                        return Ok(false);
                    }
                    if p.metadata()?.len() > 32 * 1024 * 1024 {
                        return Err(io::Error::other("图片超过 32 MB。"));
                    }
                    (
                        p.extension()
                            .and_then(|x| x.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase(),
                        fs::read(p)?,
                    )
                } else {
                    if arg.len() > 45 * 1024 * 1024 {
                        return Err(io::Error::other("图片超过 32 MB。"));
                    }
                    let (mime, data) = arg
                        .split_once(',')
                        .ok_or_else(|| io::Error::other("无效的图片数据"))?;
                    let ext = match mime {
                        "data:image/png;base64" => "png",
                        "data:image/jpeg;base64" => "jpg",
                        "data:image/gif;base64" => "gif",
                        "data:image/webp;base64" => "webp",
                        _ => return Err(io::Error::other("图片格式不支持")),
                    };
                    (
                        ext.to_owned(),
                        STANDARD.decode(data).map_err(io::Error::other)?,
                    )
                };
                let suffix = match suffix.as_str() {
                    "jpg" | "jpeg" => "jpeg",
                    "png" => "png",
                    "webp" => "webp",
                    "gif" => "gif",
                    _ => return Err(io::Error::other("图片格式不支持")),
                };
                let document = self.doc.path.as_deref().filter(|_| !self.is_draft());
                let path = storage::image_asset(document, suffix, &bytes)?;
                let src = if document.is_some() {
                    format!("<{path}>")
                } else {
                    path
                };
                send(
                    web,
                    json!({"kind":"insert","text":format!("![图片]({src})")}),
                );
            }
            "import" => {
                if let Some(path) = FileDialog::new()
                    .set_parent(win)
                    .add_filter(
                        "可导入的文档",
                        &["docx", "odt", "epub", "html", "htm", "rst", "tex"],
                    )
                    .pick_file()
                {
                    let input = extras::import(&path)?;
                    return self.leave(Next::Import(input), &text, automatic, win, web);
                }
            }
            "wordBegin" => {
                let proxy = self.proxy.as_ref().unwrap().clone();
                let blocks = if chat_title.is_some() { Vec::new() } else { markdown::blocks(&text) }
                    .into_iter()
                    .take(48)
                    .collect::<Vec<_>>();
                let studio = word_export::Studio::new(
                    rev,
                    epoch,
                    text,
                    if let Some(title) = chat_title { extras::ConversionInput::TranscriptHtml(title) } else {
                        extras::ConversionInput::Markdown(self.doc.path.as_deref().and_then(Path::parent).map(Path::to_owned))
                    },
                    move |msg| {
                        let _ = proxy.send_event(Input::Reply(msg));
                    },
                );
                match studio {
                    Ok(studio) => self.word_studio = Some(studio),
                    Err(e) => {
                        send(
                            web,
                            json!({"kind":"wordPage","studio":rev,"rev":0,"error":format!("无法准备导出预览。{e}")}),
                        );
                        return Ok(false);
                    }
                }
                send(
                    web,
                    json!({"kind":"wordSource","studio":rev,"blocks":blocks,"personal":extras::personal_word_template().is_some()}),
                );
            }
            "wordLayout" => {
                if let Some(studio) = &self.word_studio {
                    if let Err(err) = studio.layout(rev, &arg) {
                        send(
                            web,
                            json!({"kind":"wordPage","studio":studio.id,"rev":rev,"error":err.to_string()}),
                        );
                    }
                }
            }
            "wordClose" => {
                if self.word_studio.as_ref().is_some_and(|s| s.id == rev) {
                    self.word_studio = None;
                }
            }
            "wordSave" => {
                if let Some(studio) = &self.word_studio {
                    let Some(path) = extras::output(win, self.doc.path.as_deref(), "docx", chat_title.as_deref()) else {
                        send(
                            web,
                            json!({"kind":"wordSaved","studio":studio.id,"cancelled":true}),
                        );
                        return Ok(false);
                    };
                    let result = if path
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
                    {
                        studio.save(rev, &path)
                    } else {
                        Err(io::Error::other("请使用 .docx 文件扩展名。"))
                    };
                    let msg = match result {
                        Ok(warnings) => {
                            json!({"kind":"wordSaved","studio":studio.id,"message":format!("已导出 {}",path.display()),"warnings":warnings})
                        }
                        Err(err) => {
                            json!({"kind":"wordSaved","studio":studio.id,"error":err.to_string()})
                        }
                    };
                    send(web, msg);
                }
            }
            "exportMarkdown" | "exportPdf" | "exportHtml" | "epub" | "odt" | "rtf" | "latex" => {
                if self.exporting {
                    return Ok(false);
                }
                let ext = match action.as_str() {
                    "exportPdf" => "pdf",
                    "exportHtml" => "html",
                    "exportMarkdown" => "md",
                    "latex" => "tex",
                    other => other,
                };
                let Some(path) = extras::output(win, self.doc.path.as_deref(), ext, chat_title.as_deref()) else {
                    send(web, json!({"kind":"exportDone","message":""}));
                    return Ok(false);
                };
                if path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_none_or(|e| !e.eq_ignore_ascii_case(ext))
                {
                    return Err(io::Error::other(format!("请使用 .{ext} 文件扩展名。")));
                }
                let proxy = self.proxy.as_ref().unwrap().clone();
                if action == "exportPdf" {
                    extras::pdf(web, path, &arg, move |result| {
                        let _ = proxy
                            .send_event(Input::Exported(result.map(|path| (path, String::new()))));
                    })?;
                    self.exporting = true;
                } else if action == "exportHtml" || action == "exportMarkdown" {
                    let content = if action == "exportMarkdown" { &text } else { &arg };
                    storage::atomic_write(&path, content.as_bytes())?;
                    send(
                        web,
                        json!({"kind":"exportDone","message":format!("已导出 {}",path.display())}),
                    );
                } else {
                    self.exporting = true;
                    let dir = self
                        .doc
                        .path
                        .as_deref()
                        .and_then(Path::parent)
                        .map(Path::to_path_buf);
                    std::thread::spawn(move || {
                        let input = if let Some(title) = chat_title { extras::ConversionInput::TranscriptHtml(title) } else { extras::ConversionInput::Markdown(dir) };
                        let result = extras::convert(&text, &input, &action, &path, None)
                            .map(|warnings| (path.display().to_string(), warnings))
                            .map_err(|e| e.to_string());
                        let _ = proxy.send_event(Input::Exported(result));
                    });
                }
            }
            _ => {}
        }
        Ok(false)
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let channel = Rc::new(RefCell::new(None::<tao::event_loop::EventLoopProxy<Input>>));
    let receiver = channel.clone();
    let mut builder = EventLoopBuilder::<Input>::with_user_event();
    builder.with_msg_hook(move |msg| {
        if let Some(line) = file_window::requested_line(msg)
            && let Some(proxy) = receiver.borrow().as_ref()
        {
            let _ = proxy.send_event(Input::GoToLine(line));
            return true;
        }
        false
    });
    let event_loop = builder.build();
    *channel.borrow_mut() = Some(event_loop.create_proxy());
    let data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("MarkCraft");
    fs::create_dir_all(&data)?;
    extras::seed_themes()?;
    let first_file = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .map(|p| std::path::absolute(&p).unwrap_or(p));
    let startup_lock = if let Some(file) = first_file.as_deref() {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(data.join("open.lock"))?;
        lock.lock()?;
        if file_window::activate(&data, file) {
            return Ok(());
        }
        Some(lock)
    } else {
        None
    };
    let mut app = App {
        proxy: Some(event_loop.create_proxy()),
        data: data.clone(),
        first_file,
        ..Default::default()
    };
    let icon = Icon::from_rgba(include_bytes!("../ui/icon.rgba").to_vec(), 64, 64).ok();
    let win = WindowBuilder::new()
        .with_title("MarkCraft")
        .with_window_icon(icon.clone())
        .with_taskbar_icon(icon)
        .with_inner_size(LogicalSize::new(1080., 780.))
        .with_min_inner_size(LogicalSize::new(480., 340.))
        .build(&event_loop)?;
    file_window::register(&win, &data, app.first_file.as_deref(), &mut app.window_key);
    drop(startup_lock);
    let ipc = event_loop.create_proxy();
    let drag = event_loop.create_proxy();
    let root = app.folder.clone();
    let mut context = WebContext::new(Some(data.join("WebView2")));
    let html = include_str!("../ui/index.html")
        .replace("/* APP_STYLE */", include_str!("../ui/style.css"))
        .replace("/* ENHANCE_SCRIPT */", include_str!("../ui/enhance.js"))
        .replace("/* APP_SCRIPT */", include_str!("../ui/app.js"))
        .replace("/* PREFERENCES */", include_str!("../ui/preferences.js"))
        .replace("/* WORD_STUDIO */", include_str!("../ui/word-studio.js"))
        .replace("/* WORD_STYLE */", include_str!("../ui/word-studio.css"));

    let html = html
        .replace("/* CHAT_EXPLORER */", include_str!("../ui/chat.js"))
        .replace("/* CHAT_STYLE */", include_str!("../ui/chat.css"));
    let web = WebViewBuilder::new_with_web_context(&mut context)
        .with_url("craftui://localhost/index.html")
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(true)
        .with_navigation_handler(|url| url == "http://craftui.localhost/index.html")
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_custom_protocol("craftui".into(), move |_, req| {
            if req.uri().path() == "/index.html" {
                return wry::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .header("Cache-Control", "no-store")
                    .body(Cow::Owned(html.as_bytes().to_vec()))
                    .unwrap();
            }
            let asset: Option<&'static [u8]> = match req.uri().path() {
                "/writer.js" => Some(include_bytes!("../vendor/writer.bundle.js")),
                "/highlight.js" => Some(include_bytes!("../vendor/highlight.min.js")),
                "/mermaid.js" => Some(include_bytes!("../vendor/mermaid.min.js")),

                "/brands/codex.png" => Some(include_bytes!("../ui/brands/codex.png")),

                "/brands/antigravity.png" => Some(include_bytes!("../ui/brands/antigravity.png")),

                "/brands/claude.png" => Some(include_bytes!("../ui/brands/claude.png")),

                "/brands/deepseek.png" => Some(include_bytes!("../ui/brands/deepseek.png")),
                _ => None,
            };
            wry::http::Response::builder()
                .status(if asset.is_some() { 200 } else { 404 })
                .header("Content-Type", if req.uri().path().ends_with(".png") { "image/png" } else { "application/javascript; charset=utf-8" })
                .header("Access-Control-Allow-Origin", "*")
                .body(Cow::Borrowed(asset.unwrap_or_default()))
                .unwrap()
        })
        .with_custom_protocol("craftimg".into(), move |_, req| {
            let key = req.uri().path().trim_start_matches('/');
            let image = markdown::local_image(root.borrow().as_deref(), key);
            let (status, mime, bytes) =
                image.map_or((404, "text/plain", Vec::new()), |(m, b)| (200, m, b));
            wry::http::Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "http://craftui.localhost")
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                )
                .body(Cow::Owned(bytes))
                .unwrap()
        })
        .with_ipc_handler(move |r| {
            let _ = ipc.send_event(Input::Message(r.into_body()));
        })
        .with_drag_drop_handler(move |ev| {
            if let DragDropEvent::Drop { paths, .. } = ev {
                if let Some(path) = paths.into_iter().next() {
                    let _ = drag.send_event(Input::Drop(path));
                }
            }
            true
        })
        .build(&win)?;
    event_loop.run(move |event, _, control| {
        *control = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if app.ready {
                    let _ = web.evaluate_script("window.craftRequest('close')");
                } else {
                    *control = ControlFlow::Exit;
                }
            }
            Event::UserEvent(Input::GoToLine(line)) => {
                send(&web, json!({"kind":"goToLine","line":line}))
            }
            Event::UserEvent(Input::Reply(msg)) => {
                if msg["epoch"] == app.epoch {
                    send(&web, msg);
                }
            }
            Event::UserEvent(Input::Exported(result)) => {
                app.exporting = false;
                match result {
                    Ok((path, warnings)) => send(
                        &web,
                        json!({"kind":"exportDone","message":format!("已导出 {path}"),"warnings":warnings}),
                    ),
                    Err(e) => send(&web, json!({"kind":"error","message":e})),
                }
            }
            Event::UserEvent(Input::Drop(path)) => {
                app.pending_drop = Some(path);
                let _ = web.evaluate_script("window.craftRequest('drop')");
            }
            Event::UserEvent(Input::Message(msg)) => {
                if let Ok(request) = serde_json::from_str(&msg) {
                    match app.handle(request, &win, &web) {
                        Ok(true) => *control = ControlFlow::Exit,
                        Err(e) => send(&web, json!({"kind":"error","message":e.to_string()})),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    })
}
fn main() {
    if let Err(e) = run() {
        MessageDialog::new()
            .set_title("MarkCraft 启动失败")
            .set_level(MessageLevel::Error)
            .set_description(format!(
                "无法创建编辑窗口。请检查 Microsoft Edge WebView2 Runtime。\n{e}"
            ))
            .show();
    }
}
