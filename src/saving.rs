use crate::{App, Document, Recent, dialog, send, storage};
use serde_json::json;
use std::{
    io,
    path::{Path, PathBuf},
};
use tao::window::Window;
use wry::WebView;

pub enum Next {
    Stay,
    Close,
    New,
    Guide,
    Open(PathBuf),
    Linked(PathBuf, u64),
    Import(String),
}
pub enum Save {
    Automatic,
    Manual,
    As,
    Overwrite {
        path: PathBuf,
        observed: Option<[u8; 32]>,
    },
}
pub enum Question {
    Leave,
    Conflict {
        path: PathBuf,
        observed: Option<[u8; 32]>,
    },
    Failed(Save),
}
pub struct Pending {
    id: u64,
    next: Next,
    question: Question,
}

impl App {
    pub fn is_draft(&self) -> bool {
        self.doc.path.as_deref().and_then(Path::parent) == Some(self.data.join("草稿").as_path())
    }

    fn advance(&mut self, next: Next, win: &Window, web: &WebView) -> io::Result<bool> {
        match next {
            Next::Stay => {}
            Next::Close => return Ok(true),
            Next::Open(path) => self.open(path, win, web)?,
            Next::Linked(path, line) => {
                self.open(path, win, web)?;
                if line > 0 {
                    send(web, json!({"kind":"goToLine","line":line}));
                }
            }
            Next::Import(input) => {
                self.doc = Document::default();
                self.guide = false;
                self.document(win, web);
                send(web, json!({"kind":"imported","text":input}));
            }
            Next::New | Next::Guide => {
                self.doc = Document::default();
                self.guide = matches!(next, Next::Guide);
                if self.guide {
                    self.doc.original = include_str!("../ui/guide.md").into();
                }
                self.document(win, web);
            }
        }
        Ok(false)
    }

    pub(crate) fn ask(&mut self, next: Next, question: Question, detail: String, web: &WebView) {
        self.question_id += 1;
        let (kind, title) = match &question {
            Question::Leave => ("leave", "保存这次修改？"),
            Question::Conflict { .. } => ("conflict", "文件在其他地方被修改了"),
            Question::Failed(_) => ("failed", "暂时无法保存"),
        };
        send(
            web,
            json!({"kind":"saveQuestion","id":self.question_id,"question":kind,"title":title,"file":self.title(),"detail":detail}),
        );
        self.pending = Some(Pending {
            id: self.question_id,
            next,
            question,
        });
    }

    pub fn leave(
        &mut self,
        next: Next,
        text: &str,
        auto: bool,
        win: &Window,
        web: &WebView,
    ) -> io::Result<bool> {
        if text == self.doc.original {
            if let Some(path) = &self.doc.path
                && !path.try_exists()?
            {
                self.ask(
                    next,
                    Question::Conflict {
                        path: path.clone(),
                        observed: None,
                    },
                    "文件已移走或删除。你可以将窗口里的内容存进草稿箱或另存一份。".into(),
                    web,
                );
                return Ok(false);
            }
            return self.advance(next, win, web);
        }
        if auto {
            return self.persist(Save::Automatic, next, text, win, web);
        }
        self.ask(
            next,
            Question::Leave,
            if self.doc.path.is_some() {
                "放弃修改会丢弃上次保存之后的编辑。"
            } else {
                "放弃修改会丢弃这份尚未保存的内容。"
            }
            .into(),
            web,
        );
        Ok(false)
    }

    pub fn answer(
        &mut self,
        id: u64,
        choice: &str,
        text: &str,
        win: &Window,
        web: &WebView,
    ) -> io::Result<bool> {
        if self.pending.as_ref().is_none_or(|p| p.id != id) {
            return Ok(false);
        }
        let Pending { next, question, .. } = self.pending.take().unwrap();
        match (question, choice) {
            (Question::Leave, "discard") => self.advance(next, win, web),
            (Question::Leave, "save") => self.persist(Save::Manual, next, text, win, web),
            (Question::Failed(mode), "retry") => self.persist(mode, next, text, win, web),
            (Question::Conflict { .. } | Question::Failed(_), "copy") => {
                self.persist(Save::As, next, text, win, web)
            }
            (Question::Conflict { path, .. }, "both") => {
                let draft = storage::create_draft(&self.data, text)?;
                if path.exists() {
                    self.open(path, win, web)?;
                } else {
                    self.doc = draft;
                    self.document(win, web);
                }
                send(
                    web,
                    json!({"kind":"notice","message":"窗口中的版本已保存在草稿箱。"}),
                );
                self.advance(next, win, web)
            }
            (Question::Conflict { path, observed }, "overwrite") => {
                self.persist(Save::Overwrite { path, observed }, next, text, win, web)
            }
            _ => Ok(false),
        }
    }

    pub fn persist(
        &mut self,
        mode: Save,
        next: Next,
        text: &str,
        win: &Window,
        web: &WebView,
    ) -> io::Result<bool> {
        let automatic = matches!(mode, Save::Automatic);
        let draft = self.is_draft();
        let pick = matches!(mode, Save::As)
            || (matches!(mode, Save::Manual) && (self.doc.path.is_none() || draft));
        let chosen = if pick {
            let mut picker = dialog(win).set_file_name(self.title());
            if !draft && let Some(dir) = self.doc.path.as_deref().and_then(Path::parent) {
                picker = picker.set_directory(dir);
            }
            let Some(mut path) = picker.save_file() else {
                return Ok(false);
            };
            if path.extension().is_none() {
                path.set_extension("md");
            }
            if let Ok(target) = std::fs::canonicalize(&path)
                && self
                    .doc
                    .path
                    .as_ref()
                    .and_then(|p| std::fs::canonicalize(p).ok())
                    .as_ref()
                    != Some(&target)
                && crate::file_window::activate(&self.data, &target)
            {
                send(
                    web,
                    json!({"kind":"notice","message":"目标文件已在另一个窗口打开，请选择其他文件名。"}),
                );
                return Ok(false);
            }
            Some(path)
        } else if let Save::Overwrite { path, .. } = &mode {
            Some(path.clone())
        } else {
            self.doc.path.clone()
        };
        let previous = self.doc.path.clone();
        let mut displaced = None;
        let write = (|| -> io::Result<Option<Question>> {
            let _lock = storage::save_lock(&self.data)?;
            if let Some(path) = chosen {
                if self.doc.path.as_ref() == Some(&path) {
                    let mut observed = storage::disk_digest(&path)?;
                    let confirmed =
                        matches!(&mode,Save::Overwrite{observed:seen,..} if *seen==observed);
                    if self.doc.differs_from(observed) && !confirmed {
                        if let Ok(disk) = Document::read(path.clone()) {
                            if disk.original == text {
                                self.doc = disk;
                                return Ok(None);
                            }
                            if disk.original == self.doc.original {
                                observed = disk.digest();
                                self.doc = disk;
                            } else {
                                return Ok(Some(Question::Conflict {
                                    path,
                                    observed: disk.digest(),
                                }));
                            }
                        } else {
                            return Ok(Some(Question::Conflict { path, observed }));
                        }
                    }
                    displaced = self.doc.save_checked(path, text, observed)?;
                } else {
                    self.doc.save(path, text)?;
                }
            } else {
                self.doc = storage::create_draft(&self.data, text)?;
            }
            Ok(None)
        })();
        match write {
            Err(e) => {
                self.ask(next, Question::Failed(mode), e.to_string(), web);
                return Ok(false);
            }
            Ok(Some(question)) => {
                self.ask(
                    next,
                    question,
                    "自动保存已暂停。保留两版会将窗口内容存入草稿箱，再打开磁盘版本。".into(),
                    web,
                );
                return Ok(false);
            }
            Ok(None) => {}
        }
        self.watch.reset();
        self.guide = false;
        self.dirty = false;
        let path = self.doc.path.as_ref().expect("a saved document has a path");
        crate::file_window::register(win, &self.data, Some(path), &mut self.window_key);
        *self.folder.borrow_mut() = path.parent().map(Path::to_path_buf);
        if previous.as_ref() != Some(path) || !automatic {
            Recent::touch(&self.data, path);
        }
        self.titlebar(win);
        send(
            web,
            json!({"kind":"saved","title":self.title(),"path":path,"text":text,"draft":self.is_draft(),"automatic":automatic,"epoch":self.epoch}),
        );
        if let Some(path) = displaced {
            send(
                web,
                json!({"kind":"notice","message":format!("保存时磁盘发生变化，两版均已保留。磁盘副本：{}",path.display())}),
            );
        }
        self.advance(next, win, web)
    }
}
