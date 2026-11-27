// Windows Antigravity CLI 1.5.x. Only agy creates and indexes sessions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [agy, gemini, key] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const { workspace, messages, title } = request;
const variant = request.desktop ? "antigravity" : "antigravity-cli";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// A separate process for each call releases the session before SQLite is opened.
async function session(root, id, verify = false) {
  const proc = spawn(agy, ["acp", "--stdio", "--disable-telemetry", "--gemini-dir", gemini,
    "--app-data-dir", path.relative(gemini, path.join(root, variant))], { cwd: workspace, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: proc.stdout });
  let index = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Antigravity CLI 恢复会话超时。")), 45000);
    let result, error;
    function finish(failure, value) {
      if (finished) return;
      finished = true;
      error = failure;
      result = value;
      clearTimeout(timer);
      proc.kill();
    }
    function send(seq, method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: seq, method, params }) + "\n");
    }
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.stdin.on("error", e => finish(e));
    proc.on("close", () => {
      clearTimeout(timer);
      lines.close();
      if (!finished || error) reject(error || new Error("Antigravity CLI 提前退出。"));
      else resolve(result);
    });
    lines.on("line", line => {
      if (finished) return;
      try {
        const msg = JSON.parse(line);
        if (msg.error && /authenticat|unauthorized|log in/i.test(msg.error.message||"")) throw new Error("Antigravity 需要有效的 CLI 登录。请在终端运行 agy acp --login，完成登录后重试接续。");
        if (msg.error) throw new Error("Antigravity CLI "+(id?"恢复":"创建")+"会话失败（" + msg.error.code + "）。"+String(msg.error.message||"").slice(0,240));
        if (msg.id === 1) {
          if (!/^1\.5\.\d+(?:$|[-+])/.test(msg.result?.agentInfo?.version || ""))
            throw new Error("当前接续适配支持 Antigravity CLI 1.5.x，本机版本暂未验证。");
          send(2, id ? "session/load" : "session/new", { cwd: workspace, mcpServers: [],
            ...(id ? { sessionId: id } : {}) });
        } else if (msg.method === "session/update" && verify) {
          const update = msg.params.update;
          const role = { user_message_chunk: "user", agent_message_chunk: "assistant" }[update.sessionUpdate];
          if (role) {
            const expected = messages[index++];
            const actual = update.content?.text;
            // ACP adds a visual paragraph break between consecutive assistant steps.
            const separated = role === "assistant" && messages[index - 2]?.role === role
              && actual === "\n\n" + expected?.text;
            if (role !== expected?.role || (!separated && actual !== expected.text))
              throw new Error("Antigravity 读回的原话或角色与来源不一致。");
          }
        } else if (msg.id === 2) {
          if (verify && index !== messages.length) throw new Error("Antigravity 读回的消息数不一致。");
          const actual = msg.result?.sessionId;
          if (!uuid.test(actual) || (id && actual !== id)) throw new Error("Antigravity 会话 ID 无效。");
          finish(null, actual);
        }
      } catch (e) { finish(e); }
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: "MarkCraft", version: "0.4" } });
  });
}

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}
function integer(field, value) { return Buffer.concat([varint(field * 8), varint(value)]); }
function bytes(field, value) {
  const data = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}
// Prefer a dedicated single-folder project when a directory also belongs to a multi-root project.
function desktopProject() {
  const dir = path.join(gemini, "config", "projects");
  const folder = path.resolve(workspace).toLowerCase();
  const matches = [];
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const resources = p.projectResources?.resources || [];
      if (!p.sidecar && !p.isWorkspaceOnly && p.id && resources.some(r => r.folderUri &&
        path.resolve(fileURLToPath(r.folderUri)).toLowerCase() === folder)) matches.push({p, count:resources.length});
    } catch { /* Other projects can contain non-file resources. */ }
  }
  if (matches.length) return { project:matches.sort((a,b)=>a.count-b.count)[0].p, create:false };
  const hex = createHash("sha256").update("markcraft-desktop-project/" + folder).digest("hex");
  const id = [hex.slice(0,8),hex.slice(8,12),"4"+hex.slice(13,16),"a"+hex.slice(17,20),hex.slice(20,32)].join("-");
  return { create:true, project:{ id, name:path.basename(workspace) || workspace,
    projectResources:{resources:[{folderUri:pathToFileURL(workspace).href}]}, settings:{}, isWorkspaceOnly:false } };
}
function writeSteps(filename, project) {
  const db = new DatabaseSync(filename);
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM steps").get().n, 0);
    const trajectory = db.prepare("SELECT trajectory_id FROM trajectory_meta").get().trajectory_id;
    db.exec("BEGIN IMMEDIATE");
    if (project) {
      const meta = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'").get();
      // Project ID is field 18 of the native trajectory metadata. The workspace URI is retained from session/new.
      db.prepare("UPDATE trajectory_metadata_blob SET data=? WHERE id='main'")
        .run(Buffer.concat([meta.data, bytes(18, project.id)]));
    }
    const insert = db.prepare("INSERT INTO steps(idx,step_type,status,metadata,step_payload) VALUES(?,?,3,?,?)");
    for (const [index, { role, text, time }] of messages.entries()) {
      const user = role === "user";
      const timestamp = new Date(time).getTime();
      const seconds = Math.floor(timestamp / 1000);
      const stamp = Buffer.concat([integer(1, seconds), integer(2, (timestamp % 1000) * 1000000)]);
      const meta = Buffer.concat([bytes(1, stamp), integer(3, user ? 4 : 2), bytes(12, trajectory)]);
      // UserInput.query/raw_input items and PlannerResponse.response/modified_response.
      const body = user ? [bytes(2, text), bytes(3, bytes(1, text))] : [bytes(1, text), bytes(8, text)];
      const type = user ? 14 : 15;
      const step = Buffer.concat([integer(1, type), integer(4, 3), bytes(5, meta),
        bytes(user ? 19 : 20, Buffer.concat(body))]);
      insert.run(index, type, meta, step);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}

function catalog(root, id) {
  const file = path.join(root, variant, "conversation_summaries.db");
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT step_count,workspace_uris,project_id,title FROM conversation_summaries WHERE conversation_id=? AND app_data_dir=?")
      .get(id, variant);
  } finally { db.close(); }
}
function checkWorkspace(row, fresh = false) {
  const directories = JSON.parse(row?.workspace_uris || "[]");
  if (row?.step_count < messages.length || (fresh && directories.length !== 1)
    || !directories.some(uri => path.resolve(fileURLToPath(uri)).toLowerCase() === path.resolve(workspace).toLowerCase()))
    throw new Error("Antigravity 的会话目录或记录数未通过核对。");
}
function publish(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); return true; }
  catch (e) { if (e.code === "EEXIST") return false; throw e; }
}

async function run() {
  assert(uuid.test(key) && path.isAbsolute(gemini) && path.isAbsolute(workspace));
  assert(messages.length && messages.every(m => ["user", "assistant"].includes(m.role)
    && typeof m.text === "string" && Date.parse(m.time) >= 0));
  const cache = path.join(gemini, "markcraft-handoff");
  fs.mkdirSync(cache, { recursive: true });
  const receipt = path.join(cache, key);
  const target = request.desktop ? desktopProject() : null;
  if (!fs.existsSync(receipt)) {
    const tmp = fs.mkdtempSync(path.join(cache, ".stage-"));
    try {
      const id = await session(tmp);
      const filename = path.join(tmp, variant, "conversations", id + ".db");
      writeSteps(filename, target?.project);
      const annotation = path.join(tmp, variant, "annotations", id + ".pbtxt");
      if (title) {
        fs.mkdirSync(path.dirname(annotation), {recursive:true});
        fs.writeFileSync(annotation, "title: " + JSON.stringify(title) + "\n");
      }
      await session(tmp, id, true);
      const checked = catalog(tmp, id);
      checkWorkspace(checked, true);
      if (target && checked.project_id !== target.project.id) throw new Error("桌面项目登记未通过核对。");
      if (title && checked.title !== title) throw new Error("接续标题未通过核对。");
      const db = new DatabaseSync(filename);
      try { const wal = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); assert.equal(wal.busy, 0); }
      finally { db.close(); }
      const ready = path.join(tmp, "ready");
      fs.mkdirSync(ready);
      fs.renameSync(filename, path.join(ready, "seed.db"));
      fs.writeFileSync(path.join(ready, "id"), id);
      if (title) fs.copyFileSync(annotation, path.join(ready,"annotation"));
      if (target) fs.writeFileSync(path.join(ready,"project-id"), target.project.id);
      if (target?.create) fs.writeFileSync(path.join(ready,"project.json"), JSON.stringify(target.project,null,2));
      const mirror = messages.map((m, index) => JSON.stringify({ step_index: index,
        type: m.role === "user" ? "USER_INPUT" : "PLANNER_RESPONSE", created_at: m.time, content: m.text }));
      fs.writeFileSync(path.join(ready, "transcript"), mirror.join("\n") + "\n");
      // Concurrent imports converge on one complete native snapshot.
      try { fs.renameSync(ready, receipt); } catch (e) { if (!fs.existsSync(path.join(receipt, "id"))) throw e; }
    } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  const id = fs.readFileSync(path.join(receipt, "id"), "utf8");
  assert(uuid.test(id));
  const dst = path.join(gemini, variant, "conversations", id + ".db");
  const seed = path.join(receipt, "seed.db");
  const transcript = path.join(receipt, "transcript");
  const annotation = path.join(receipt, "annotation");
  const projectFile = path.join(receipt, "project.json");
  let projectId;
  if (target) {
    const saved = path.join(receipt, "project-id");
    // Older receipts stored the native project ID only in the project or catalog.
    projectId = fs.existsSync(saved) ? fs.readFileSync(saved, "utf8")
      : catalog(gemini, id)?.project_id || target.project.id;
    assert(uuid.test(projectId));
    const registered = path.join(gemini, "config", "projects", projectId + ".json");
    if (!fs.existsSync(registered) && !fs.existsSync(dst) && fs.existsSync(projectFile)) publish(projectFile, registered);
    if (!fs.existsSync(registered)) throw new Error("目标桌面项目已移除，请在接续窗口选择工作区并指定新的副本名称。");
  }
  if (fs.existsSync(annotation)) publish(annotation, path.join(gemini,variant,"annotations",id+".pbtxt"));
  let existing = fs.existsSync(dst);
  if (!existing) {
    if (!fs.existsSync(seed)) throw new Error("接续副本已从 Antigravity 移除。");
    existing = !publish(seed, dst);
  }
  if (fs.existsSync(transcript)) publish(transcript, path.join(gemini, variant, "brain", id,
    ".system_generated", "logs", "transcript_full.jsonl"));
  if (!catalog(gemini, id)) await session(gemini, id);
  const registered = catalog(gemini, id);
  checkWorkspace(registered);
  if (projectId && registered?.project_id !== projectId) throw new Error("桌面会话已移动，请在目标项目中核对。");
  for (const file of [seed, transcript, annotation, projectFile]) fs.rmSync(file, { force: true });
  process.stdout.write(JSON.stringify({ id, existing, workspace, title, count: messages.length,
    recipient: request.desktop ? "antigravitydesktop" : "antigravity" }));
}
run().catch(e => { console.error(e.message); process.exitCode = 1; });
