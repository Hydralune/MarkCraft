use super::Source;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub(super) struct Message {
    pub role: &'static str,
    pub time: String,
    pub text: String,
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn content(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.to_owned();
    }
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| match s(part, "type") {
            "text" | "Text" | "input_text" | "output_text" => {
                part["text"].as_str().map(str::to_owned)
            }
            "image" | "image_url" | "input_image" | "localImage" | "local_image" => {
                Some("〔图片附件〕".to_owned())
            }
            "file" => Some("〔文件附件〕".to_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn role(v: &str) -> Option<&'static str> {
    match v {
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}

fn injected(t: &str) -> bool {
    [
        "<environment_context>",
        "<permissions instructions>",
        "<user_instructions>",
        "<skill>",
        "# AGENTS.md instructions for ",
        "<turn_aborted>",
        "<local-command-caveat>",
        "<system-reminder>",
    ]
    .iter()
    .any(|prefix| t.trim_start().starts_with(prefix))
}

#[derive(Default)]
pub(super) struct Transcript {
    done: Vec<Message>,
    // Different Codex versions may record the same turn in up to three event formats.
    turn: Vec<(usize, Message)>,
}

impl Transcript {
    fn current(&self) -> impl Iterator<Item = &Message> {
        let mut rank = [0usize; 2];
        for (r, m) in &self.turn {
            let i = usize::from(m.role == "assistant");
            rank[i] = rank[i].max(*r);
        }
        self.turn
            .iter()
            .filter_map(move |(r, m)| (*r == rank[usize::from(m.role == "assistant")]).then_some(m))
    }
    pub fn messages(&self) -> Vec<&Message> {
        self.done.iter().chain(self.current()).collect()
    }
    pub fn committed_len(&self) -> usize {
        self.done.len()
    }

    fn finish_turn(&mut self) {
        let current: Vec<_> = self.current().cloned().collect();
        self.done.extend(current);
        self.turn.clear();
    }

    pub fn accept(&mut self, source: Source, v: &Value) {
        let entry = match source {
            Source::Codex => {
                let p = &v["payload"];
                let t = (s(v, "type"), s(p, "type"));
                if t == ("event_msg", "task_started") {
                    self.finish_turn();
                    return;
                }
                let item = &p["item"];
                let (rank, who, body) = match t {
                    ("event_msg", "item_completed") => match s(item, "type") {
                        "UserMessage" => (3, "user", content(&item["content"])),
                        "AgentMessage" => (3, "assistant", content(&item["content"])),
                        _ => return,
                    },
                    ("event_msg", "user_message") => (2, "user", s(p, "message").to_owned()),
                    ("event_msg", "agent_message") => (2, "assistant", s(p, "message").to_owned()),
                    ("response_item", "message") => {
                        let Some(who) = role(s(p, "role")) else {
                            return;
                        };
                        (1, who, content(&p["content"]))
                    }
                    _ => return,
                };
                if rank == 1 && who == "user" && injected(&body) {
                    return;
                }
                (rank, who, s(v, "timestamp"), body)
            }
            Source::Claude => {
                if v["isMeta"] == true || v["isSidechain"] == true || v["isCompactSummary"] == true
                {
                    return;
                }
                let Some(who) = role(s(v, "type")) else {
                    return;
                };
                let body = content(&v["message"]["content"]);
                if who == "user" && injected(&body) {
                    return;
                }
                (0, who, s(v, "timestamp"), body)
            }
            Source::Antigravity => {
                let raw = s(v, "content");
                match s(v, "type") {
                    "USER_INPUT" => {
                        let body = raw
                            .strip_prefix("<USER_REQUEST>")
                            .and_then(|v| v.split_once("</USER_REQUEST>"))
                            .map(|(request, _)| request.trim_matches('\n'))
                            .unwrap_or(raw);
                        (0, "user", s(v, "created_at"), body.to_owned())
                    }
                    "PLANNER_RESPONSE" => (0, "assistant", s(v, "created_at"), raw.to_owned()),
                    _ => return,
                }
            }
            Source::DeepSeek => {
                let d = &v["data"];
                let (who, parts) = match s(v, "type") {
                    "user/message" if d["source"]["kind"] == "user" && d["role"] == "user" => {
                        ("user", &d["content"])
                    }
                    "assistant/message" if d["message"]["role"] == "assistant" => {
                        ("assistant", &d["message"]["content"])
                    }
                    _ => return,
                };
                let text = content(parts);
                if !text.trim().is_empty() {
                    self.done.push(Message {
                        role: who,
                        time: v["time"]
                            .as_i64()
                            .map(|n| n.to_string())
                            .unwrap_or_default(),
                        text,
                    });
                }
                return;
            }
        };
        let (rank, who, time, text) = entry;
        if text.trim().is_empty() {
            return;
        }
        let m = Message {
            role: who,
            time: time.to_owned(),
            text,
        };
        if source == Source::Codex {
            self.turn.push((rank, m));
        } else {
            self.done.push(m);
        }
    }
}
