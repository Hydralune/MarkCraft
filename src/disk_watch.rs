use crate::{
    App, Document, markdown,
    saving::{Next, Question},
    send,
};
use serde_json::json;
use std::{
    fs, io,
    time::{Duration, Instant, SystemTime},
};
use tao::window::Window;
use wry::WebView;

#[derive(Default)]
pub struct Watch {
    // A changed timestamp must settle before reading an in-place rewrite.
    seen: Option<(Option<(SystemTime, u64)>, Instant)>,
    checked: bool,
    unavailable: bool,
    serial: u64,
    candidate: Option<Document>,
}
impl Watch {
    pub fn reset(&mut self) {
        let serial = self.serial.wrapping_add(1);
        *self = Self {
            serial,
            ..Default::default()
        };
    }
}
impl App {
    pub fn check_disk(&mut self, rev: u64, force: bool, web: &WebView) {
        let Some(path) = self.doc.path.as_ref() else {
            return;
        };
        let stamp = fs::metadata(path)
            .ok()
            .and_then(|m| Some((m.modified().ok()?, m.len())));
        let watch = &mut self.watch;
        if watch.seen.as_ref().is_none_or(|(s, _)| s != &stamp) {
            watch.seen = Some((stamp, Instant::now()));
            watch.checked = false;
            return;
        }
        if watch.seen.as_ref().unwrap().1.elapsed() < Duration::from_millis(250)
            || (watch.checked && !force)
        {
            return;
        }
        watch.checked = true;
        let incoming = match Document::read(path.clone()) {
            Ok(incoming) => incoming,
            Err(e) => {
                watch.candidate = None;
                if !watch.unavailable {
                    watch.unavailable = true;
                    let reason = if e.kind() == io::ErrorKind::NotFound {
                        "文件已移走或删除。"
                    } else {
                        "暂时无法读取磁盘版本。"
                    };
                    send(
                        web,
                        json!({"kind":"diskUnavailable","epoch":self.epoch,"message":reason}),
                    );
                }
                return;
            }
        };
        if watch.unavailable {
            watch.unavailable = false;
            send(web, json!({"kind":"diskAvailable","epoch":self.epoch}));
        }
        if incoming.original == self.doc.original {
            self.doc = incoming;
            watch.candidate = None;
            return;
        }
        if !self.doc.differs_from(incoming.digest()) {
            watch.candidate = None;
            return;
        }
        watch.serial += 1;
        send(
            web,
            json!({"kind":"diskUpdate","epoch":self.epoch,"rev":rev,"token":watch.serial,
            "text":incoming.original,"blocks":markdown::blocks(&incoming.original)}),
        );
        watch.candidate = Some(incoming);
    }

    pub fn respond_disk(&mut self, token: u64, accept: bool, win: &Window, web: &WebView) {
        if token != self.watch.serial {
            return;
        }
        let Some(incoming) = self.watch.candidate.take() else {
            return;
        };
        if accept {
            self.doc = incoming;
            self.dirty = false;
            self.titlebar(win);
        } else if let Some(path) = incoming.path.clone() {
            self.ask(Next::Stay,Question::Conflict{path,observed:incoming.digest()},
                "窗口和磁盘都有修改，自动保存已暂停。保留两版会将窗口内容存入草稿箱，再打开磁盘版本。".into(),web);
        }
    }
}
