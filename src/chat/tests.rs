use super::*;
use std::io::Write;

#[test]
fn workspace_follows_successful_edits_and_commands_not_mentioned_paths() {
    let sandbox = tempfile::tempdir().unwrap();
    let fallback = sandbox.path();
    let repo = fallback.join("changed-project");
    let other = fallback.join("other-project");
    let src = repo.join("src");
    for dir in [repo.join(".git"), other.join(".git"), src.clone()] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(src.join("package.json"), "{}").unwrap();
    let mut activity = workspace::Activity::default();
    let event = |item: Value| json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-a","item":item}});
    let command = |path: &Path| {
        json!({"type":"CommandExecution","status":"completed","exit_code":0,
        "cwd":url::Url::from_directory_path(path).unwrap().as_str(),"aggregated_output":other})
    };
    activity.observe(&json!({"type":"turn_context","payload":{"cwd":repo,"turn_id":"turn-a"}}));
    activity.observe(&event(json!({"type":"FileChange","status":"failed","changes":{other.join("file").to_string_lossy():{}}})));
    activity.observe(&event(command(&src)));
    assert_eq!(
        activity.suggest(fallback.to_str().unwrap())["inferred"],
        false
    );
    activity.observe(&event(
        json!({"type":"FileChange","status":"completed","changes":{"src/file.rs":{}}}),
    ));
    let found = activity.suggest(fallback.to_str().unwrap());
    assert_eq!(found["path"], json!(repo));
    assert_eq!(found["edits"], 1);
    assert_eq!(found["commands"], 1);
    activity.observe(&event(command(&other)));
    activity.observe(&event(json!({"type":"FileChange","status":"completed","changes":{other.join("file.rs").to_string_lossy():{}}})));
    assert_eq!(
        activity.suggest(fallback.to_str().unwrap())["path"],
        json!(fallback)
    );

    let mut large = command(&repo);
    large["aggregated_output"] = json!("x".repeat(100_000));
    let mut commands_only = workspace::Activity::default();
    let large_log = serde_json::to_vec(&event(large)).unwrap();
    commands_only.observe_large_command(&large_log);
    commands_only.observe_large_command(&large_log);
    assert_eq!(
        commands_only.suggest(fallback.to_str().unwrap())["commands"],
        2
    );
}

#[test]
fn claude_handoff_reuses_snapshot_and_preserves_native_followup() {
    let sandbox = tempfile::tempdir().unwrap();
    let roots = Roots {
        codex: sandbox.path().join("codex"),
        claude: sandbox.path().join("claude"),
        gemini: sandbox.path().join("gemini"),
        dsh: sandbox.path().join("dsh"),
    };
    let dir = roots.codex.join("sessions");
    let project = sandbox.path().join("实际_项目");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir(&project).unwrap();
    let a = json!({"type":"event_msg","timestamp":"2026-11-27T00:00:00Z","payload":{"type":"user_message","message":"保留原话"}});
    let b = json!({"type":"event_msg","timestamp":"2026-11-27T00:00:01Z","payload":{"type":"agent_message","message":"明白"}});
    fs::write(dir.join("rollout-test.jsonl"), format!("{a}\n{b}\n")).unwrap();
    let mut lib = Library::default();
    let source = lib.scan(&roots).pop().unwrap();
    let target = format!("@folder:{}", project.display());
    let first = handoff::copy(&source, &target, &roots, Recipient::Claude).unwrap();
    let copy = lib
        .scan(&roots)
        .into_iter()
        .find(|e| e.source == Source::Claude)
        .unwrap();
    let saved = fs::read_to_string(&copy.path).unwrap();
    let rows: Vec<Value> = saved
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(rows[1]["parentUuid"], rows[0]["uuid"]);
    assert_eq!(rows[1]["timestamp"], "2026-11-27T00:00:01Z");
    let continuation = json!({"type":"user","message":{"content":"继续"}});
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(&copy.path)
            .unwrap(),
        "{continuation}"
    )
    .unwrap();
    let repeated = handoff::copy(&source, &target, &roots, Recipient::Claude).unwrap();
    assert_eq!(first["id"], repeated["id"]);
    assert_eq!(repeated["existing"], true);
    assert_eq!(lib.page(&copy.id, "{}").unwrap()["rows"][2]["text"], "继续");
    let renamed = "方案 · 分支";
    let fork_id = "00000000-0000-4000-a000-000000000001";
    let fork = |nonce| {
        handoff::transfer(
            &copy,
            "@source",
            &roots,
            Recipient::Claude,
            Some(renamed),
            Some(nonce),
        )
        .unwrap()
    };
    let forked = fork(fork_id);
    assert_ne!(forked["id"], first["id"]);
    assert_eq!(forked["count"], 3);
    assert_eq!(fork(fork_id)["id"], forked["id"]);
    assert_ne!(
        fork("00000000-0000-4000-a000-000000000002")["id"],
        forked["id"]
    );
    assert!(lib.scan(&roots).iter().any(|e| e.title == renamed));
    let names = sandbox.path().join("names");
    rename_entry(&names, &mut lib, &source.id, "资料库名称").unwrap();
    assert_eq!(
        fs::read_to_string(names.join(&source.id)).unwrap(),
        "资料库名称"
    );
    assert!(
        lib.page(&source.id, r#"{"format":"markdown"}"#).unwrap()["markdown"]
            .as_str()
            .unwrap()
            .starts_with("# 资料库名称")
    );
}

#[test]
fn four_sources_preserve_visible_roles_and_text_across_three_receivers() {
    use std::net::TcpListener;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let roots = Roots {
        codex: root.join("codex"),
        claude: root.join("claude"),
        gemini: root.join("gemini"),
        dsh: root.join("dsh"),
    };
    let project = root.join("共享 项目");
    fs::create_dir(&project).unwrap();
    let workspace = format!("@folder:{}", project.display());
    let expected = [
        ("user", "请比较路线 A 和 B"),
        ("assistant", "一度选择 A"),
        ("assistant", "最后选 B。\n\n`git status`"),
        ("user", "继续"),
    ];
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    fs::create_dir_all(roots.dsh.join("markcraft")).unwrap();
    fs::write(
        roots.dsh.join("markcraft/bridge-v1.json"),
        json!({"port":listener.local_addr().unwrap().port(),"token":"a".repeat(64)}).to_string(),
    )
    .unwrap();
    // The plugin's native persistence is tested separately in handoff.test.mjs.
    let bridge = std::thread::spawn(move || {
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&socket).read_line(&mut line).unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            let actual: Vec<_> = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| (m["role"].as_str().unwrap(), m["text"].as_str().unwrap()))
                .collect();
            assert_eq!(actual, expected);
            writeln!(
                socket,
                "{}",
                json!({"id":"test-native","count":4,"workspace":req["workspacePath"]})
            )
            .unwrap();
        }
    });
    for source in [
        Source::Codex,
        Source::Claude,
        Source::DeepSeek,
        Source::Antigravity,
    ] {
        let name = serde_json::to_value(source)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let fixture = root.join(&name).join("incoming/session.v4.jsonl");
        fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        let mut rows = String::new();
        for (i, (role, text)) in expected.iter().enumerate() {
            let ts = format!("2026-11-27T02:00:0{i}Z");
            let user = *role == "user";
            let v = match source {
                Source::Claude => {
                    json!({"type":role,"timestamp":ts,"message":{"role":role,"content":[{"type":"text","text":text}]}})
                }
                Source::Codex => {
                    json!({"type":"event_msg","timestamp":ts,"payload":{"type":if user{"user_message"}else{"agent_message"},"message":text}})
                }
                Source::Antigravity => {
                    json!({"type":if user{"USER_INPUT"}else{"PLANNER_RESPONSE"},"created_at":ts,"content":text})
                }
                Source::DeepSeek if user => {
                    json!({"type":"user/message","time":1795744800000i64+i as i64*1000,"data":{"source":{"kind":"user"},"role":role,"content":[{"type":"text","text":text}]}})
                }
                Source::DeepSeek => {
                    json!({"type":"assistant/message","time":1795744800000i64+i as i64*1000,"data":{"message":{"role":role,"content":[{"type":"text","text":text}]}}})
                }
            };
            rows.push_str(&v.to_string());
            rows.push('\n');
        }
        fs::write(&fixture, rows).unwrap();
        let entry = Entry {
            id: name.clone(),
            source,
            thread_id: None,
            receiver: None,
            title: "原题".into(),
            project: project.display().to_string(),
            path: fixture.clone(),
            modified: 0,
            size: 0,
        };
        for dest in [Recipient::DeepSeek, Recipient::Codex, Recipient::Claude] {
            let receipt = handoff::copy(&entry, &workspace, &roots, dest).unwrap();
            assert_eq!(receipt["count"], 4);
            if matches!(dest, Recipient::DeepSeek) {
                continue;
            }
            let id = receipt["id"].as_str().unwrap();
            let mut lib = Library::default();
            let copy = lib
                .scan(&roots)
                .into_iter()
                .find(|e| e.path.file_stem().unwrap().to_string_lossy().ends_with(id))
                .unwrap();
            let page = lib.page(&copy.id, "{}").unwrap();
            let actual: Vec<_> = page["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| (m["role"].as_str().unwrap(), m["text"].as_str().unwrap()))
                .collect();
            assert_eq!(actual, expected);
            assert!(copy.title.ends_with(" · 原题"));
            assert_eq!(
                handoff::copy(&entry, &workspace, &roots, dest).unwrap()["existing"],
                true
            );
        }
    }
    bridge.join().unwrap();
}

#[test]
fn codex_prefers_display_events_per_role_and_turn() {
    let mut transcript = Transcript::default();
    let mut accept = |event| transcript.accept(Source::Codex, &event);
    accept(
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"之前的原话"}]}}),
    );
    accept(json!({"type":"event_msg","payload":{"type":"task_started"}}));
    accept(
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>example"}]}}),
    );
    accept(json!({"type":"event_msg","payload":{"type":"user_message","message":"新的问题"}}));
    accept(
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"新的问题"}]}}}),
    );
    accept(
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"答案\n\n*格式*"}}),
    );
    assert_eq!(
        transcript
            .messages()
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["之前的原话", "新的问题", "答案\n\n*格式*"]
    );
}

#[test]
fn antigravity_extracts_only_original_turns() {
    let mut transcript = Transcript::default();
    transcript.accept(Source::Antigravity,&json!({"type":"USER_INPUT","content":"<USER_REQUEST>\n原话\n</USER_REQUEST>\n<ADDITIONAL_METADATA>context</ADDITIONAL_METADATA>"}));
    transcript.accept(
        Source::Antigravity,
        &json!({"type":"TOOL_RESULT","content":"tool data"}),
    );
    transcript.accept(
        Source::Antigravity,
        &json!({"type":"PLANNER_RESPONSE","content":"**答复**","thinking":"private"}),
    );
    assert_eq!(
        transcript
            .messages()
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["原话", "**答复**"]
    );
}

#[test]
fn active_claude_log_reads_append_and_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let roots = Roots {
        codex: dir.path().join("codex"),
        claude: dir.path().join("claude"),
        gemini: dir.path().join("gemini"),
        dsh: dir.path().join(".dsh"),
    };
    let project = roots.claude.join("projects/demo");
    fs::create_dir_all(&project).unwrap();
    let p = project.join("test.jsonl");
    let user = json!({"type":"user","cwd":"D:/example","message":{"content":"first"}});
    let reply = json!({"type":"assistant","message":{"content":[{"type":"text","text":"second"},{"type":"tool_use","name":"tool"}]}});
    let summary =
        json!({"type":"user","isCompactSummary":true,"message":{"content":"内部压缩记录"}});
    fs::write(&p, format!("{user}\n{summary}\n")).unwrap();
    let mut lib = Library::default();
    let e = lib.scan(&roots).pop().unwrap();
    assert_eq!(e.project, "D:/example");
    let initial = lib.page(&e.id, "{}").unwrap();
    assert_eq!(initial["total"], 1);
    let bytes = reply.to_string();
    let mut file = fs::OpenOptions::new().append(true).open(&p).unwrap();
    file.write_all(&bytes.as_bytes()[..12]).unwrap();
    assert_eq!(lib.page(&e.id, "{}").unwrap()["total"], 1);
    file.write_all(&bytes.as_bytes()[12..]).unwrap();
    file.write_all(b"\n").unwrap();
    let complete = lib.page(&e.id, r#"{"format":"markdown"}"#).unwrap();
    assert_eq!(complete["total"], 2);
    assert_eq!(initial["generation"], complete["generation"]);
    assert!(
        complete["markdown"]
            .as_str()
            .unwrap()
            .ends_with("## Claude Code 回复\n\nsecond\n")
    );
    drop(file);
    fs::write(&p, format!("{reply}\n")).unwrap();
    let replaced = lib.page(&e.id, "{}").unwrap();
    assert_ne!(complete["generation"], replaced["generation"]);
    assert_eq!(replaced["total"], 1);
    assert_eq!(replaced["rows"][0]["text"], "second");
}

#[test]
fn transcript_formats_tables_and_displays_embeds_as_inert_text() {
    let html = crate::markdown::transcript_html(
        "|名称|值|\n|---|---|\n|甲|乙|\n\n![说明](https://example.org/image.png)\n\n<b>原话</b>",
    );
    assert!(html.contains("<table>") && html.contains("说明"));
    assert!(!html.contains("<img") && !html.contains("<b>原话</b>"));
}

#[test]
fn deepseek_reads_concatenated_frames_and_refreshes_title_and_transcript() {
    use ruzstd::encoding::{CompressionLevel, compress_to_vec};
    let dir = tempfile::tempdir().unwrap();
    let roots = Roots {
        codex: dir.path().join("codex"),
        claude: dir.path().join("claude"),
        gemini: dir.path().join("gemini"),
        dsh: dir.path().join(".dsh"),
    };
    let folder = roots.dsh.join("sessions/project/session-001");
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join("session.v4.jsonl.zstd");
    let frame = |s: &str| compress_to_vec(s.as_bytes(), CompressionLevel::Fastest);
    let header = json!({"type":"session","version":4,"cwd":"D:/项目"});
    let question = json!({"type":"user/message","time":1760000000000i64,"data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"我的问题"}]}});
    let synthetic = json!({"type":"user/message","data":{"role":"user","source":{"kind":"runtime-context"},"content":[{"type":"text","text":"后台提示"}]}});
    let response = json!({"type":"assistant/message","time":1760000001000i64,"data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"内部内容"},{"type":"text","text":"**原始回复**"},{"type":"tool-call","name":"example"}]}}});
    let title = json!({"type":"session/title","data":{"title":"正式标题"}});
    let mut log = frame(&format!("{header}\n{question}\n{synthetic}\n"));
    let split = response.to_string();
    log.extend(frame(&split[..7]));
    let last = frame(&format!("{}\n{title}\n", &split[7..]));
    log.extend_from_slice(&last[..2]);
    fs::write(&path, &log).unwrap();
    let mut lib = Library::default();
    let e = lib.scan(&roots).pop().unwrap();
    assert_eq!(e.title, "我的问题");
    assert_eq!(e.project, "D:/项目");
    let first = lib.page(&e.id, "{}").unwrap();
    assert_eq!(first["total"], 1);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&last[2..])
        .unwrap();
    let updated = lib.scan(&roots).pop().unwrap();
    assert_eq!(updated.title, "正式标题");
    let second = lib.page(&e.id, "{}").unwrap();
    assert_eq!(second["generation"], first["generation"]);
    assert_eq!(second["total"], 2);
    assert_eq!(second["rows"][1]["text"], "**原始回复**");
    assert_eq!(second["rows"][1]["time"], "1760000001000");
    let md = lib.page(&e.id, r#"{"format":"markdown"}"#).unwrap();
    let text = md["markdown"].as_str().unwrap();
    assert!(text.starts_with("# 正式标题\n\nDeepSeek Harness"));
    assert!(text.contains("## 第 1 轮提问\n\n我的问题"));
    assert!(text.ends_with("## DeepSeek Harness 回复\n\n**原始回复**\n"));
    assert!(
        md["sections"][2]
            .as_str()
            .unwrap()
            .contains("<strong>原始回复</strong>")
    );
    fs::write(&path, frame(&format!("{header}\n{title}\n"))).unwrap();
    lib.scan(&roots);
    assert_eq!(lib.page(&e.id, "{}").unwrap()["total"], 0);
    // Uncompressed v4 logs use the same events and role filtering.
    fs::remove_file(&path).unwrap();
    fs::write(
        folder.join("session.v4.jsonl"),
        format!("{header}\n{question}\n{synthetic}\n{response}\n"),
    )
    .unwrap();
    let plain = lib.scan(&roots);
    assert_eq!(plain.len(), 1);
    assert_eq!(
        lib.page(&plain[0].id, "{}").unwrap()["rows"],
        second["rows"]
    );
}

#[test]
fn archive_renders_document_blocks_without_loading_chat_attachments() {
    let sample = "## 读数\n\n| 站 | 值 |\n|---|---|\n| A | 12 |\n\n\
                  > **说明**\n\n~~~rust\nfn read() {}\n~~~\n\n$x^2$\n\n\
                  ![观测图](https://example.org/pixel.png)\n\n\
                  <img src=\"other.png\">\n\n[目录](file:///private)\n\n<script>hello()</script>";
    let html = crate::markdown::transcript_html(sample);
    for part in [
        "<table>",
        "<blockquote>",
        "<strong>说明</strong>",
        "language-rust",
        "<math",
        "观测图",
    ] {
        assert!(html.contains(part), "{part}");
    }
    for part in ["<img", "<script", "pixel.png", "file:///"] {
        assert!(!html.contains(part), "{part}");
    }
}

#[test]
#[ignore = "requires a local Antigravity CLI 1.5.x and Node.js with SQLite"]
fn antigravity_native_replay_preserves_roles_and_reuses_the_copy() {
    let dir = tempfile::tempdir().unwrap();
    let roots = Roots {
        codex: dir.path().join("codex"),
        claude: dir.path().join("claude"),
        gemini: dir.path().join("gemini"),
        dsh: dir.path().join("dsh"),
    };
    let cwd = dir.path().join("中文 workspace");
    fs::create_dir(&cwd).unwrap();
    let folder = roots.claude.join("projects/test");
    fs::create_dir_all(&folder).unwrap();
    let expected = [
        ("user", "上次约定？"),
        ("assistant", "第一条"),
        ("assistant", "第二条\n\n**蓝桥**"),
    ];
    let log = expected
        .iter()
        .map(|(role, text)| {
            json!({
                "type":role,"cwd":cwd,"timestamp":"2026-11-26T11:30:00Z","message":{"content":text}
            })
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(folder.join("input.jsonl"), log).unwrap();
    let mut lib = Library::default();
    let source = lib.scan(&roots).pop().unwrap();
    let first = handoff::copy(&source, "@source", &roots, Recipient::Antigravity).unwrap();
    let second = handoff::copy(&source, "@source", &roots, Recipient::Antigravity).unwrap();
    assert_eq!(first["id"], second["id"]);
    assert_eq!(first["existing"], false);
    assert_eq!(second["existing"], true);
    let native = lib
        .scan(&roots)
        .into_iter()
        .find(|e| e.source == Source::Antigravity)
        .unwrap();
    assert_eq!(Path::new(&native.project), cwd);
    let page = lib.page(&native.id, "{}").unwrap();
    for (row, (role, text)) in page["rows"].as_array().unwrap().iter().zip(expected) {
        assert_eq!(row["role"], role);
        assert_eq!(row["text"], text);
    }
    assert_eq!(page["total"], expected.len());
    let desktop = handoff::transfer(
        &source,
        "@source",
        &roots,
        Recipient::AntigravityDesktop,
        Some("桌面接续"),
        None,
    )
    .unwrap();
    assert_ne!(desktop["id"], first["id"]);
    let again = handoff::transfer(
        &source,
        "@source",
        &roots,
        Recipient::AntigravityDesktop,
        Some("桌面接续"),
        None,
    )
    .unwrap();
    assert_eq!(again["id"], desktop["id"]);
    assert_eq!(again["existing"], true);
    let entry = lib
        .scan(&roots)
        .into_iter()
        .find(|e| e.receiver == Some("antigravitydesktop"))
        .unwrap();
    assert_eq!(entry.title, "桌面接续");
    assert_eq!(Path::new(&entry.project), cwd);
    assert_eq!(
        metadata::desktop_folders(&roots.gemini),
        [cwd.display().to_string()]
    );
    assert_eq!(lib.page(&entry.id, "{}").unwrap()["rows"], page["rows"]);
}

#[test]
fn outline_indexes_unloaded_turns_and_matches_rendered_headings() {
    let dir = tempfile::tempdir().unwrap();
    let roots = Roots {
        codex: dir.path().join("codex"),
        claude: dir.path().join("claude"),
        gemini: dir.path().join("gemini"),
        dsh: dir.path().join("dsh"),
    };
    let folder = roots.claude.join("projects/demo");
    fs::create_dir_all(&folder).unwrap();
    let mut log = String::new();
    for i in 0..92 {
        let body =
            format!("问题 {i}\n\n标题 **A**\n---\n\n> ### A\n\n~~~md\n# 示例\n~~~\n\n$$\n# x\n$$");
        let msg = json!({"type":"user","cwd":"D:/QA","message":{"content":body}});
        log.push_str(&format!("{msg}\n"));
    }
    fs::write(folder.join("demo.jsonl"), log).unwrap();
    let mut lib = Library::default();
    let id = lib.scan(&roots).pop().unwrap().id;
    let page = lib.page(&id, "{}").unwrap();
    assert_eq!(page["start"], 52);
    let outline = lib.page(&id, r#"{"format":"outline"}"#).unwrap();
    assert_eq!(outline["outline"].as_array().unwrap().len(), 92);
    assert_eq!(
        outline["outline"][1]["headings"],
        json!([[2, "标题 A"], [3, "A"]])
    );
    assert_eq!(lib.page(&id, r#"{"around":0}"#).unwrap()["start"], 0);
    let next = lib
        .page(
            &id,
            &json!({"generation":page["generation"],"after":40}).to_string(),
        )
        .unwrap();
    assert_eq!(next["start"], 40);
    assert_eq!(next["rows"].as_array().unwrap().len(), 40);
}

#[test]
fn permission_scoped_discovery_persists_and_can_be_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("prefs");
    let source_dir = dir.path().join("custom");
    fs::create_dir_all(source_dir.join("projects/sample")).unwrap();
    fs::write(
        source_dir.join("projects/sample/a.jsonl"),
        r#"{"type":"user","message":{"content":"example"}}"#,
    )
    .unwrap();
    let initial = setup::Config::read(&data).unwrap();
    assert!(initial.sources.is_empty());
    let mut lib = Library::default();
    let mut sources: Vec<_> = setup::SOURCES
        .into_iter()
        .map(|s| setup::Access {
            source: s,
            enabled: s == Source::Claude,
            folder: (s == Source::Claude).then(|| source_dir.clone()),
        })
        .collect();
    let request = json!({"previous":initial,"next":{"sources":sources}}).to_string();
    let enabled = setup::Config::save(&data, &request).unwrap();
    let roots = enabled.roots();
    assert!(lib.scan_allowed(&roots, &[]).is_empty());
    let entry = lib.scan_allowed(&roots, &[Source::Claude]).pop().unwrap();
    assert!(setup::Config::read(&data).unwrap().allows(Source::Claude));
    assert!(setup::Config::save(&data, &request).is_err());
    sources.iter_mut().for_each(|a| a.enabled = false);
    let revoked = setup::Config::save(
        &data,
        &json!({"previous":enabled,"next":{"sources":sources}}).to_string(),
    )
    .unwrap();
    assert!(!revoked.allows(Source::Claude));
    assert!(lib.scan_allowed(&roots, &[]).is_empty());
    assert!(lib.page(&entry.id, "{}").is_err());
    assert!(source_dir.join("projects/sample/a.jsonl").is_file());
}
