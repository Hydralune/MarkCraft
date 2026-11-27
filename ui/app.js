"use strict";
const $ = (id) => document.getElementById(id),
  node = (tag, txt) => {
    const el = document.createElement(tag);
    if (txt !== undefined) el.textContent = txt;
    return el;
  };
const post = (action, fields = {}) =>
  window.ipc.postMessage(
    JSON.stringify({ action, epoch: doc.epoch, ...fields }),
  );
const doc = {
  epoch: 0,
  draft: false,
  paused: false,
  lastAutomatic: false,
  text: "",
  saved: "",
  title: "未命名.md",
  path: "",
  root: "",
  recent: [],
  blocks: [],
  rev: 0,
  dirty: false,
  source: false,
};
const prefs = {
  name: "",
  themes: [],
  side: "",
  focus: false,
  typewriter: false,
  zoom: 1,
};
let writer,
  timer,
  toastTimer,
  menuKey = "",
  exporting = false,
  exportRev = 0,
  autosaveTimer,
  formatJob = null,
  treeCache = new Map();
function notice(s) {
  if (!s) return;
  $("notice").textContent = s;
  $("notice").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("notice").hidden = true), 4200);
}
const autoEnabled = () => localStorage.autoSave !== "no";
const req = (action, arg = "", rev = 0) =>
  post(action, {
    text: doc.text,
    arg,
    rev,
    automatic: autoEnabled() && !doc.paused,
  });
window.craftRequest = req;
function diagramPalette(printing = false) {
  if (prefs.name === "澄明浅色.css") return "lucid";
  return !printing && prefs.name.toLowerCase().includes("dark")
    ? "dark"
    : "light";
}
window.typesetBlocks = (root) => typeset(root, diagramPalette());
window.openDocLink = (href) => {
  if (href?.startsWith("#")) {
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const b = doc.blocks.find(
      (b) => b.id === id || b.footnote === id || b.references?.includes(id),
    );
    if (b) {
      const reference = b.inlines?.find((i) => i.referenceId === id);
      writer.select(b.start + (reference?.from || 0));
    }
    return;
  }
  if (href) req("link", href);
};
function countWords(text) {
  return (
    text.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-zÀ-ʯА-я0-9]+(?:['’-][A-Za-zÀ-ʯА-я0-9]+)*/gu,
    ) || []
  ).length;
}
let wordTotal = 0, parsedRevision = -1;
function updateWords(update, text) {
  const oldDoc = update.startState.doc, newDoc = update.state.doc;
  let edit, count = 0;
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => { count++; edit = {fromA, toA, fromB, toB}; });
  if (count !== 1) { wordTotal = countWords(text); return null; }
  const {fromA,toA,fromB,toB} = edit;
  const oldStart = oldDoc.lineAt(fromA), oldEnd = oldDoc.lineAt(toA);
  const newStart = newDoc.lineAt(fromB), newEnd = newDoc.lineAt(toB);
  wordTotal += countWords(newDoc.sliceString(newStart.from, newEnd.to)) - countWords(oldDoc.sliceString(oldStart.from, oldEnd.to));
  return oldStart.number === oldEnd.number && newStart.number === newEnd.number ? edit : null;
}
function updatePlainParagraph(edit, previous, text) {
  if (!edit || parsedRevision !== doc.rev) return false;
  const {fromA,toA,fromB,toB} = edit;
  const idx = doc.blocks.findIndex(b => b.start < fromA && toA <= b.end);
  if (idx < 0) return false;
  const block = doc.blocks[idx], shift = toB - fromB - (toA - fromA);
  const oldText = previous.slice(block.start, block.end), newText = text.slice(block.start, block.end + shift);
  // Anything that could change Markdown structure goes through the Rust parser.
  const plain = /^[\p{L}\p{M}\p{N} ，、。？！；：（）《》]+$/u;
  if (!plain.test(oldText) || !plain.test(newText) || oldText.trim() !== oldText || newText.trim() !== newText || block.html.trim() !== "<p>" + oldText + "</p>") return false;
  doc.blocks = doc.blocks.map((b,i) => i < idx ? b : i === idx
    ? {...b, end:b.end+shift, html:"<p>"+newText+"</p>\n"} : {...b, start:b.start+shift, end:b.end+shift});
  return true;
}
function status() {
  const dirty = doc.text !== doc.saved;
  if (dirty !== doc.dirty) {
    doc.dirty = dirty;
    post("dirty", { arg: dirty ? "yes" : "no" });
  }
  $("status").textContent = dirty
    ? doc.paused
      ? "等待手动保存"
      : autoEnabled()
        ? "待自动保存"
        : "未保存"
    : diskUnavailable ? "磁盘文件不可用"
    : doc.draft
      ? "草稿已保存"
      : doc.lastAutomatic
        ? "已自动保存"
        : doc.path
          ? "已保存"
          : "未命名";
  const toggle = $("sourceToggle"),
    action = doc.source ? "退出源码模式" : "打开源码模式";
  toggle.setAttribute("aria-pressed", String(doc.source));
  toggle.setAttribute("aria-label", action);
  toggle.title = action + " (Ctrl + /)";
  toggle.querySelector("span").textContent = doc.source ? "退出源码" : "源码";
  $("status").title = doc.path;
  const state = dirty ? "dirty" : doc.path ? "saved" : "untitled";
  $("status").parentElement.dataset.state = state;
  $("stateIcon").setAttribute(
    "href",
    dirty ? "#i-draft" : doc.path ? "#i-check" : "#i-paper",
  );
  $("count").textContent = wordTotal.toLocaleString() + " 字";
}
function change(text, update) {
  if (applyingDisk) return;
  const edit = updateWords(update, text);
  const local = updatePlainParagraph(edit, doc.text, text);
  doc.text = text;
  status();
  doc.rev++;
  clearTimeout(timer);
  const rev = doc.rev;
  if (local) {
    parsedRevision = rev;
    queueMicrotask(() => {
      if (rev !== doc.rev) return;
      writer.setBlocks(doc.blocks);
      if (prefs.side === "outline") outline();
    });
  } else timer = setTimeout(() => post("render", { rev, text }), 90);
  scheduleAutosave();
}
let dirtySince = 0;
function flushAutosave() {
  clearTimeout(autosaveTimer);
  dirtySince = 0;
  if (autoEnabled() && !doc.paused && doc.dirty && questionId === null)
    req("autosave");
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!autoEnabled() || doc.paused || !doc.dirty || questionId !== null) {
    dirtySince = 0;
    return;
  }
  const now = Date.now();
  if (!dirtySince) dirtySince = now;
  autosaveTimer = setTimeout(
    flushAutosave,
    Math.max(0, Math.min(650, dirtySince + 4000 - now)),
  );
}
window.addEventListener("blur", flushAutosave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushAutosave();
});
window.addEventListener("storage", (e) => {
  if (e.key === "autoSave") {
    doc.paused = false;
    status();
    scheduleAutosave();
  }
});
let applyingDisk = false, diskUnavailable = false, forceDiskCheck = true, lastDiskCheck = 0;
let selectingPointer = false, composingText = false;
$("write").addEventListener("compositionstart", () => composingText = true, true);
$("write").addEventListener("compositionend", () => composingText = false, true);
$("write").addEventListener("pointerdown", () => selectingPointer = true, true);
window.addEventListener("pointerup", () => selectingPointer = false, true);
window.addEventListener("pointercancel", () => selectingPointer = false, true);
window.addEventListener("blur", () => selectingPointer = false);
function checkDisk(force = false) {
  if (!doc.path || document.hidden || composingText || selectingPointer || $("pop").open || exporting ||
      doc.paused && doc.dirty || writer?.view?.composing || document.querySelector(".editing-cell .cm-composing,.image-details:popover-open")) return;
  const now = Date.now();
  force ||= forceDiskCheck || now - lastDiskCheck > 15000;
  if (force) { lastDiskCheck = now; forceDiskCheck = false; }
  post("checkDisk", {rev:doc.rev, arg:force ? "force" : ""});
}
setInterval(checkDisk, 900);
window.addEventListener("focus", () => checkDisk(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDisk(true); });
function diskUpdate(msg) {
  if (composingText || selectingPointer || doc.rev !== msg.rev || $("pop").open || writer.view.composing || document.querySelector(".image-details:popover-open")) {
    forceDiskCheck = true;
    return;
  }
  if (doc.text !== doc.saved && doc.text !== msg.text) {
    if (!doc.paused) {
      doc.paused = true;
      clearTimeout(autosaveTimer);
      status();
      post("conflictDisk", {rev:msg.token});
    }
    return;
  }
  clearTimeout(timer);
  clearTimeout(autosaveTimer);
  dirtySince = 0;
  applyingDisk = true;
  try {
    writer.reload(msg.text, msg.blocks);
    doc.text = doc.saved = msg.text;
    doc.blocks = msg.blocks;
    parsedRevision = ++doc.rev;
    wordTotal = countWords(doc.text);
    doc.lastAutomatic = doc.paused = false;
    post("acceptDisk", {rev:msg.token});
    status(); outline();
    notice("已同步磁盘上的修改");
  } finally { applyingDisk = false; }
}
function markOutlinePosition(pos) {
  const list = $("outline");
  const heading = doc.blocks.findLast((b) => b.heading && b.start <= pos);
  let next = heading ? list.querySelector(`button[data-pos="${heading.start}"]`) : null;
  if (heading && !next && !$("outlineFilter").value) next = [...list.querySelectorAll("[data-pos]")].findLast(b => +b.dataset.pos < heading.start);
  const previous = list.querySelector('[aria-current="location"]');
  if (previous === next) return;
  previous?.removeAttribute("aria-current");
  next?.setAttribute("aria-current", "location");
  if (next && document.activeElement !== $("outlineFilter")) {
    const box = list.getBoundingClientRect(), row = next.getBoundingClientRect();
    if (row.top < box.top) list.scrollTop += row.top - box.top;
    else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom;
  }
}
function cursor(pos) {
  if (prefs.side === "outline") markOutlinePosition(pos);
  if (prefs.typewriter && !selectingPointer && writer?.view?.hasFocus && writer.selection().empty)
    requestAnimationFrame(() => {
      const v = writer.view,
        coords = v.coordsAtPos(v.state.selection.main.head);
      if (coords && !selectingPointer && v.state.selection.main.empty) {
        const r = v.scrollDOM.getBoundingClientRect();
        v.scrollDOM.scrollTop += coords.top - r.top - r.height * 0.46;
      }
    });
}
function setTheme(msg) {
  prefs.name = msg.current;
  document.body.classList.toggle("lucid", msg.current === "澄明浅色.css");
  prefs.themes = msg.names;
  const css = msg.css.replace(/:root\b/g, ":scope");
  $("documentTheme").textContent = "@scope (.docTheme) {\n" + css + "\n}";
  const night = /dark|night|深色|夜/i.test(prefs.name);
  document.body.classList.toggle("night", night);
  applySettings();
  post("windowTheme", { arg: night ? "dark" : "light" });
  if (writer?.view) {
    writer.view.requestMeasure();
  }
}
function setDoc(msg) {
  if (window.chatExplorer?.isReading) sidebar("files");
  if ($("pop").open && $("pop").dataset.kind === "word") $("pop").close();
  dirtySince = 0;
  collectRevision = null;
  diskUnavailable = false;
  forceDiskCheck = true;
  foldedHeadings.clear();
  $("outlineFilter").value = "";
  clearTimeout(timer);
  clearTimeout(autosaveTimer);
  doc.rev++;
  Object.assign(doc, {
    epoch: msg.epoch,
    draft: !!msg.draft,
    paused: false,
    lastAutomatic: false,
    text: msg.text,
    saved: msg.text,
    title: msg.title,
    path: msg.path || "",
    recent: msg.recent || [],
    blocks: msg.blocks,
    dirty: false,
    source: false,
  });
  parsedRevision = doc.rev;
  wordTotal = countWords(doc.text);
  document.body.classList.remove("source");
  setTreeRoot(msg.root);
  drawTree();
  writer.reset(doc.text, doc.blocks);
  status();
  outline();
  bindOutlineScroll();
  if (pendingLocation?.path.toLowerCase() === doc.path.toLowerCase()) goLine(pendingLocation.line);
  pendingLocation = null;
  if (prefs.side === "files" && doc.root) post("children");
}
const foldedHeadings = new Set();
let outlineHost, outlineFrame = 0;
function followOutline() {
  if (!setting("follow") || prefs.side !== "outline") return;
  const v = writer.view;
  const y = v.scrollDOM.getBoundingClientRect().top + 32 - v.documentTop;
  const pos = v.lineBlockAtHeight(Math.max(0, y)).from;
  markOutlinePosition(pos);
}
function bindOutlineScroll() {
  const host = writer.view.scrollDOM;
  if (outlineHost === host) return;
  outlineHost = host;
  host.addEventListener("scroll", () => {
    if (outlineFrame) return;
    outlineFrame = requestAnimationFrame(() => { outlineFrame = 0; followOutline(); });
  }, { passive: true });
}
$("outlineFilter").addEventListener("input", outline);
function outline() {
  if (prefs.side === "chatOutline") {
    window.chatExplorer.drawOutline();
    return;
  }
  renderOutlineList(doc.blocks.filter(b => b.heading), foldedHeadings,
    b => writer.select(b.start, b.start, "start"), "文稿中的标题会显示在这里");
  if (prefs.side === "outline") {
    if (setting("follow")) followOutline(); else markOutlinePosition(writer.selection().head);
  }
}
function renderOutlineList(headings, folded, choose, empty) {
  const dest = $("outline");
  const query = $("outlineFilter").value.trim().toLocaleLowerCase();
  const keep = new Set(), parents = [];
  const items = headings.map(b => {
    while (parents.length && parents.at(-1).level >= b.level) parents.pop();
    const ancestors = parents.slice();
    parents.push(b);
    if (query && b.heading.toLocaleLowerCase().includes(query)) {
      for (const h of parents) keep.add(h.id);
    }
    return {b, ancestors};
  });
  const fragment = document.createDocumentFragment();
  items.forEach(({b, ancestors}, index) => {
    if (query ? !keep.has(b.id) : ancestors.some(h => folded.has(h.id))) return;
    const row = node("div"); row.className = "outline-row";
    row.style.paddingInlineStart = Math.min(5, ancestors.length) * 12 + "px";
    if (headings[index+1]?.level > b.level) {
      const fold = node("button", "›"), open = !!query || !folded.has(b.id);
      fold.type = "button"; fold.className = "outline-fold";
      fold.setAttribute("aria-expanded", String(open));
      fold.setAttribute("aria-label", (open ? "折叠 " : "展开 ") + b.heading);
      fold.disabled = !!query;
      fold.onclick = () => {
        if (open) folded.add(b.id); else folded.delete(b.id);
        outline();
        dest.querySelector(`[data-pos="${b.start}"]`)?.previousElementSibling?.focus({preventScroll:true});
      };
      row.append(fold);
    } else row.append(Object.assign(node("span"), {className:"outline-spacer"}));
    const el = node("button"); el.append(node("span", b.heading));
    el.title = b.heading; el.dataset.pos = b.start; el.dataset.depth = ancestors.length;
    el.onclick = () => choose(b);
    row.append(el); fragment.append(row);
  });
  if (!fragment.childNodes.length) {
    const note = node("p", query ? "没有匹配的标题" : empty);
    note.className = "small"; fragment.append(note);
  }
  dest.replaceChildren(fragment);
}
function showSidebar(which) {
  const old = prefs.side;
  prefs.side = which;
  window.chatExplorer?.switchSide(which, old);
  const outlineVisible = which === "outline" || which === "chatOutline";
  $("sidebarButton").setAttribute("aria-expanded", String(!!which));
  $("side").hidden = !which;
  $("outlineFilter").hidden = !outlineVisible;
  $("files").hidden = which !== "files";
  $("outline").hidden = !outlineVisible;
  $("filesTab").classList.toggle("current", which === "files");
  $("outlineTab").classList.toggle("current", outlineVisible);
  $("filesTab").setAttribute("aria-pressed", String(which === "files"));
  $("outlineTab").setAttribute("aria-pressed", String(outlineVisible));
}
function sidebar(which) {
  showSidebar(which);
  if (which === "files" && doc.root) post("children");
  if (which === "outline" || which === "chatOutline") outline();
  writer.view.requestMeasure();
}
function toolIcon(name, extraClass = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", ("ui-icon " + extraClass).trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
function setTreeRoot(path) {
  path = path || "";
  if (doc.root === path) return;
  doc.root = path;
  treeCache.clear();
  $("tree").scrollTop = 0;
  for (const id of ["folderBack", "folderForward", "folderUp"]) $(id).disabled = true;
}
function drawTree() {
  const dest = $("tree");
  const previous = dest.contains(document.activeElement) ? document.activeElement : null;
  let refocus;
  const location = $("folderLocation");
  location.textContent = doc.root.split(/[\\/]/).filter(Boolean).pop() || "";
  if (/^[A-Za-z]:$/.test(location.textContent)) location.textContent = doc.root;
  location.title = doc.root;
  dest.replaceChildren();
  function branch(path, depth) {
    for (const e of treeCache.get(path) || []) {
      const row = node("div");
      row.className = "tree-row";
      row.style.paddingInlineStart = depth * 12 + "px";
      const el = node("button");
      if (e.dir) {
        const toggle = node("button");
        const open = treeCache.has(e.path);
        toggle.className = "tree-toggle";
        toggle.dataset.path = e.path;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", (open ? "收起 " : "展开 ") + e.name);
        toggle.title = toggle.getAttribute("aria-label");
        toggle.append(toolIcon("chevron", "tree-chevron"));
        toggle.onclick = () => {
          if (treeCache.delete(e.path)) drawTree();
          else post("children", { arg: e.path });
        };
        row.append(toggle);
        if (previous?.className === toggle.className && previous.dataset.path === e.path) refocus = toggle;
      } else if (e.path.toLowerCase() === doc.path.toLowerCase()) el.setAttribute("aria-current", "page");
      el.className = "tree-entry";
      el.dataset.path = e.path;
      const label = node("span", e.name);
      label.className = "tree-name";
      el.append(toolIcon(e.dir ? "folder" : "paper"), label);
      el.title = e.dir ? "进入文件夹 · " + e.path : e.path;
      el.onclick = () => e.dir ? post("folderEnter", { arg: e.path }) : req("workspaceFile", e.path);
      if (previous?.className === el.className && previous.dataset.path === e.path) refocus = el;
      row.append(el);
      dest.append(row);
      if (e.dir && treeCache.has(e.path)) branch(e.path, depth + 1);
      if (e.dir && treeCache.get(e.path)?.length === 0) empty(depth + 1);
    }
  }
  function empty(depth) {
    const item = node("div", "没有子文件夹或文稿");
    item.className = "tree-empty";
    item.style.paddingInlineStart = (22 + depth * 12) + "px";
    dest.append(item);
  }
  if (doc.root) {
    branch(doc.root, 0);
    if (treeCache.get(doc.root)?.length === 0) empty(0);
  } else dest.append(Object.assign(node("div", "打开文件夹即可浏览文稿。"), {className: "tree-empty"}));
  refocus?.focus({preventScroll:true});
}
function closeMenu() {
  $("chatExport")?.setAttribute("aria-expanded","false");
  menuKey = "";
  $("menu").hidden = true;
  $("bar")
    .querySelectorAll("button")
    .forEach((b) => b.setAttribute("aria-expanded", "false"));
}
const sep = null,
  item = (title, cmd, key) => [title, cmd, key];
const fileItems = () => [
  item("新建", "new", "Ctrl N"),
  item("新窗口", "newWindow", "Ctrl Shift N"),
  item("打开…", "open", "Ctrl O"),
  item("打开文件夹…", "folder"),
  item("快速打开…", "quick", "Ctrl P"),
  sep,
  item("保存", "save", "Ctrl S"),
  item("另存为…", "saveAs", "Ctrl Shift S"),
  item("自动保存", "autoSave"),
  item("草稿箱…", "drafts"),
  sep,
  item("导出 PDF…", "exportPdf", "Ctrl Shift E"),
  item("导出 Word…", "docx"),
  item("更多导出格式", "exports", "›"),
  item("导入文档…", "import"),
  item("打印…", "print", "Ctrl Alt P"),
  sep,
  item("收集本文图片…", "collectImages"),
  item("设置…", "settings", "Ctrl ,"),
  sep,
  item("关闭窗口", "close", "Ctrl W"),
];
const menus = {
  文件: fileItems,
  编辑: () => [
    item("撤销", "undo", "Ctrl Z"),
    item("重做", "redo", "Ctrl Y"),
    sep,
    item("剪切", "cut", "Ctrl X"),
    item("复制", "copy", "Ctrl C"),
    item("粘贴", "paste", "Ctrl V"),
    item("全选", "all", "Ctrl A"),
    sep,
    item("查找和替换…", "find", "Ctrl F / H"),
    item("文件夹内查找…", "projectFind", "Ctrl Shift F"),
    item("跳至行…", "goto", "Ctrl Alt G"),
    item("文档统计", "stats"),
  ],
  段落: () => [
    item("段落操作…", "paragraphTools"),
    item("多选段落…", "paragraphSelect"),
    sep,
    item("正文", "paragraph", "Ctrl 0"),
    ...Array.from({ length: 6 }, (_, i) =>
      item(i + 1 + " 级标题", "h" + (i + 1), "Ctrl " + (i + 1)),
    ),
    sep,
    item("无序列表", "bullet"),
    item("有序列表", "number"),
    item("任务列表", "task"),
    item("引用", "quote"),
    sep,
    item("表格", "table"),
    item("代码块", "fence"),
    item("公式块", "equation"),
    item("流程图", "diagram"),
    item("分隔线", "rule"),
  ],
  格式: () => [
    item("加粗", "bold", "Ctrl B"),
    item("斜体", "italic", "Ctrl I"),
    item("下划线", "underline", "Ctrl U"),
    item("删除线", "strike"),
    item("高亮", "highlight"),
    item("上标", "sup"),
    item("下标", "sub"),
    sep,
    item("行内代码", "code"),
    item("行内公式", "math"),
    item("链接", "link", "Ctrl K"),
    item("插入本地图片…", "imagePick"),
    item("脚注", "footnote"),
  ],
  视图: () => [
    item("对话资料库", "chatLibrary"),
    item("文档大纲", "outline", "Ctrl Shift 1"),
    item("文件树", "files", "Ctrl Shift 3"),
    item("切换侧栏", "toggleSide", "Ctrl Shift L"),
    sep,
    item("专注模式", "focus", "F8"),
    item("打字机模式", "typewriter", "F9"),
    item("全屏", "fullscreen", "F11"),
    item("源码模式", "source", "Ctrl /"),
    sep,
    item("放大", "zoomIn", "Ctrl +"),
    item("缩小", "zoomOut", "Ctrl −"),
    item("实际大小", "zoomReset"),
    sep,
    item("使用指南", "guide"),
  ],
  主题: () => [
    ...prefs.themes.map((n) => item(n.replace(/\.css$/i, ""), "theme:" + n)),
    sep,
    item("打开主题文件夹", "themeFolder"),
    item("重新载入主题", "themes"),
  ],
  exports: () => [
    item("HTML 网页…", "exportHtml"),
    item("EPUB 电子书…", "epub"),
    item("OpenDocument 文档…", "odt"),
    item("RTF 富文本…", "rtf"),
    item("LaTeX 源文件…", "latex"),
  ],
};
function menu(key, anchor, focus = false) {
  const dest = $("menu");
  dest.replaceChildren();
  menuKey = key;
  for (const row of menus[key]()) {
    if (!row) {
      dest.append(node("hr"));
      continue;
    }
    const [title, cmd, hint] = row,
      el = node("button");
    el.type = "button";
    el.dataset.command = cmd;
    el.setAttribute("role", "menuitem");
    el.append(node("span", title));
    if (hint)
      el.append(node("kbd", hint.replace(/\b(Ctrl|Shift|Alt) /g, "$1 + ")));
    if (
      cmd === "theme:" + prefs.name ||
      (cmd === "autoSave" && autoEnabled()) ||
      (cmd === "source" && doc.source) ||
      prefs[cmd] === true ||
      cmd === prefs.side
    )
      el.setAttribute("aria-checked", "true");
    dest.append(el);
  }
  dest.hidden = false;
  const b = anchor || $("bar").firstElementChild,
    r = b.getBoundingClientRect();
  dest.style.left = Math.min(r.left, innerWidth - dest.offsetWidth - 5) + "px";
  dest.style.top = r.bottom + 3 + "px";
  $("bar")
    .querySelectorAll("button")
    .forEach((e) => e.setAttribute("aria-expanded", String(e === b)));
  if (focus) dest.querySelector("button")?.focus();
}
for (const name of ["文件", "编辑", "段落", "格式", "视图", "主题"]) {
  const b = node("button", name);
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.onclick = () => (menuKey === name ? closeMenu() : menu(name, b));
  b.onmouseenter = () => {
    if (menuKey) menu(name, b);
  };
  b.onkeydown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menu(name, b, true);
    }
  };
  $("bar").append(b);
}
let questionId = null;
function modal(title, build, icon = "paper", kind = "normal") {
  const d = $("pop");
  if (d.open) d.close();
  d.dataset.kind = kind;
  d.removeAttribute("aria-describedby");
  $("popTitle").textContent = title;
  $("popIcon").setAttribute("href", "#i-" + icon);
  $("popBody").replaceChildren();
  $("popActions").replaceChildren();
  build($("popBody"), $("popActions"));
  d.showModal();
}
function modButton(parent, text, fn, primary = false) {
  const b = node("button", text);
  b.type = "button";
  if (primary) b.className = "primary";
  b.onclick = fn;
  parent.append(b);
  return b;
}
function showWordWarnings(msg) {
  const dialog = $("pop");
  if (dialog.open) {
    dialog.addEventListener("close", () => queueMicrotask(() => showWordWarnings(msg)), { once: true });
    return;
  }
  modal("Word 导出提示", (body, actions) => {
    body.append(node("p", msg.message));
    if (/Could not fetch resource/i.test(msg.warnings)) {
      body.append(node("p", "部分图片未能嵌入。请检查下列路径或网址，修正后重新导出。"));
    }
    const detail = node("p", msg.warnings);
    detail.className = "question-detail export-detail";
    body.append(detail);
    modButton(actions, "知道了", () => dialog.close(), true);
  });
}
function answerQuestion(choice) {
  const id = questionId;
  if (id === null) return;
  questionId = null;
  $("pop").close();
  post("answer", { rev: id, arg: choice, text: doc.text });
  writer.focus();
}
function dismissModal() {
  if (questionId !== null) answerQuestion("cancel");
  else $("pop").close();
}
$("popClose").onclick = dismissModal;
$("pop").addEventListener("cancel", (event) => {
  if (questionId !== null) {
    event.preventDefault();
    answerQuestion("cancel");
  }
});
$("pop").addEventListener("close", () => {
  if (!$("pop").open && $("pop").dataset.kind === "goto") writer.focus();
});
function saveQuestion(msg) {
  clearTimeout(autosaveTimer);
  const leave = msg.question === "leave",
    conflict = msg.question === "conflict";
  if (!leave) {
    doc.paused = true;
    status();
  }
  questionId = msg.id;
  modal(
    msg.title,
    (body, actions) => {
      const file = node("div");
      file.className = "question-file";
      file.append(toolIcon("paper"), node("span", msg.file));
      const description = node("p", msg.detail);
      description.className = "question-detail";
      description.id = "questionDetail";
      body.append(file, description);
      const choice = (label, value, primary = false) =>
        modButton(actions, label, () => answerQuestion(value), primary);
      if (leave) choice("放弃修改", "discard").className = "discard";
      choice("取消", "cancel");
      if (conflict) {
        choice("覆盖磁盘版本", "overwrite").className = "caution";
        choice("另存一份…", "copy");
      }
      if (!leave && !conflict) choice("重试", "retry");
      const primary = leave
        ? choice("保存", "save", true)
        : conflict ? choice("保留两版", "both", true) : choice("另存一份…", "copy", true);
      primary.autofocus = true;
    },
    leave ? "save" : conflict ? "versions" : "alert",
    "question",
  );
  $("pop").setAttribute("aria-describedby", "questionDetail");
  $("popActions").querySelector(".primary").focus();
}
function quick(paths = doc.recent, drafts = false) {
  modal(
    drafts ? "草稿箱" : "快速打开",
    (body, actions) => {
      const q = node("input");
      q.placeholder = drafts ? "搜索草稿" : "搜索最近打开的文件";
      q.setAttribute("aria-label", q.placeholder);
      const list = node("div");
      list.className = "file-results";
      body.append(q, list);
      const fill = () => {
        list.replaceChildren();
        const files = paths.filter((p) =>
          p.toLowerCase().includes(q.value.toLowerCase()),
        );
        for (const path of files) {
          const el = node("button");
          el.className = "recentEntry";
          el.type = "button";
          el.title = path;
          const label = node("span", path.split(/[\\/]/).pop());
          el.append(toolIcon("paper"), label);
          el.onclick = () => {
            $("pop").close();
            req(drafts ? "draftOpen" : "recent", path);
          };
          list.append(el);
        }
        if (!files.length) {
          const p = node(
            "p",
            drafts && !paths.length
              ? "自动保存的未命名文稿会出现在这里。"
              : "没有匹配的文件",
          );
          p.className = "small";
          list.append(p);
        }
      };
      q.oninput = fill;
      q.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          list.querySelector("button")?.click();
        }
      };
      fill();
      if (drafts) modButton(actions, "关闭", () => $("pop").close());
      else
        modButton(actions, "浏览文件…", () => {
          $("pop").close();
          req("open");
        });
      q.autofocus = true;
    },
    drafts ? "folder" : "search",
  );
}
function jumpToLine() {
  const state = writer.view.state,
    docText = state.doc,
    line = docText.lineAt(state.selection.main.head).number;
  modal(
    "跳至行",
    (body, actions) => {
      const label = node("label", "行号或位置"),
        input = node("input"),
        preview = node("p");
      label.htmlFor = input.id = "jumpPosition";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = String(line);
      input.setAttribute("aria-describedby", "jumpPreview");
      input.placeholder = "行号、+5、50% 或 行:列";
      preview.id = "jumpPreview";
      preview.setAttribute("aria-live", "polite");
      body.append(label, input, preview);
      function target() {
        const m = /^([+-])?(\d*)(%)?(?::(\d+))?(%)?$/.exec(input.value.trim());
        if (!m || (!m[2] && !m[4]) || (m[3] && m[5]) || (m[1] && !m[2]))
          return null;
        const percent = !!(m[3] || m[5]),
          amount = m[2] ? Number(m[2]) : line,
          relative = m[1] || "",
          column = Number(m[4] || 0);
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(column))
          return null;
        const delta = percent
          ? Math.round((docText.lines * amount) / 100)
          : amount;
        const n = Math.max(
          1,
          Math.min(
            docText.lines,
            relative ? line + (relative === "-" ? -delta : delta) : delta,
          ),
        );
        const row = docText.line(n);
        return { n, pos: row.from + Math.min(column, row.length), row };
      }
      function go() {
        const t = target();
        if (t) {
          $("pop").close();
          writer.select(t.pos);
        }
      }
      modButton(actions, "取消", () => {
        $("pop").close();
        writer.focus();
      });
      const button = modButton(actions, "跳转", go, true);
      function refresh() {
        const t = target();
        button.disabled = !t;
        input.setAttribute("aria-invalid", String(!t));
        preview.textContent = t
          ? "第 " +
            t.n +
            " 行 / 共 " +
            docText.lines +
            " 行" +
            (t.row.text.trim()
              ? "　" + t.row.text.trim().slice(0, 50)
              : "　空行")
          : "输入行号、相对行数或百分比";
      }
      refresh();
      input.oninput = refresh;
      input.onkeydown = (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          go();
        }
      };
      input.autofocus = true;
    },
    "jump",
    "goto",
  );
  $("jumpPosition").focus();
  $("jumpPosition").select();
}
function stats() {
  modal(
    "文档统计",
    (body, actions) => {
      const selected = writer.selection();
      const grid = node("dl");
      grid.className = "stat-grid";
      for (const [name, n] of [
        ["字数", countWords(doc.text)],
        ["字符（含空格）", Array.from(doc.text).length],
        ["行数", writer.view.state.doc.lines],
        [
          "已选字符",
          Array.from(doc.text.slice(selected.from, selected.to)).length,
        ],
      ]) {
        const cell = node("div");
        cell.append(node("dt", name), node("dd", n.toLocaleString()));
        grid.append(cell);
      }
      body.append(grid);
      modButton(actions, "关闭", () => $("pop").close(), true);
    },
    "words",
  );
}
function setExport(b) {
  exporting = b;
  document.body.classList.toggle("exporting", b);
}
async function drawExport(msg, snapshot = null) {
  const save = (action, arg) => snapshot ? post(action, {arg, chatTitle: snapshot.title}) : req(action, arg);
  const target = $("printPage");
  target.replaceChildren();
  for (const b of msg.blocks) {
    const section = node("div");
    section.innerHTML = b.html;
    for (const a of section.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:|^mailto:/i.test(href))
        a.removeAttribute("href");
    }
    target.append(section);
  }
  // Diagram layout needs a measurable surface even before print media is activated.
  $("printRoot").classList.add("preparing");
  try {
    await typeset(target, diagramPalette(true), !snapshot);
    await document.fonts.ready;
    await Promise.all(
      [...target.querySelectorAll("img")].map(async (img) => {
        try {
          await Promise.race([
            img.decode(),
            new Promise((r) => setTimeout(r, 8000)),
          ]);
        } catch {}
      }),
    );
    if (formatJob === "print") {
      window.print();
      setExport(false);
      return;
    }
    if (formatJob === "exportHtml") {
      for (const img of target.querySelectorAll(
        "img[src^='http://craftimg.localhost/']",
      )) {
        const response = await fetch(img.src);
        if (!response.ok) continue;
        const blob = await response.blob();
        img.src = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
      }
      const single = document.implementation.createHTMLDocument(snapshot?.title || doc.title);
      single.documentElement.lang = "zh-CN";
      if (document.body.classList.contains("lucid")) single.body.classList.add("lucid");
      single.head.prepend(Object.assign(node("meta"), { charset: "utf-8" }));
      const style = node("style");
      style.textContent =
        $("appStyles").textContent +
        $("documentTheme").textContent +
        "html,body{display:block;height:auto}.docTheme{min-height:100vh}.prose{max-width:var(--measure);padding:42px 28px;margin:auto}@media print{body>main.docTheme{display:block!important}}";
      single.head.append(style);
      const main = node("main");
      main.className = "docTheme";
      const a = target.cloneNode(true);
      a.removeAttribute("id");
      a.classList.add("export-document");
      main.append(a);
      single.body.append(main);
      save("exportHtml", "<!doctype html>\n" + single.documentElement.outerHTML);
    } else save("exportPdf", setting("paper"));
  } catch (e) {
    setExport(false);
    notice("导出失败：" + e.message);
  } finally {
    $("printRoot").classList.remove("preparing");
  }
}
function exportDoc(format, snapshot = null) {
  if (exporting) {
    notice("正在导出，请稍候。");
    return;
  }
  if (format === "docx") {
    wordStudio.open(snapshot);
    return;
  }
  setExport(true);
  formatJob = format;
  if (["exportHtml", "exportPdf", "print"].includes(format)) {
    if (snapshot) void drawExport({blocks: snapshot.sections.map(html => ({html}))}, snapshot);
    else post("render", { rev: ++exportRev + 1e9, text: doc.text });
  } else if (snapshot) {
    post(format, {text: format === "exportMarkdown" ? snapshot.text : snapshot.sections.join("\n"), chatTitle: snapshot.title});
  } else req(format);
}
function act(cmd) {
  if (!cmd) return false;
  if (window.chatExplorer?.isReading && window.chatExplorer.command(cmd)) return true;
  if (window.chatExplorer?.isReading && !["outline","files","toggleSide","hideSide","close"].includes(cmd)) return false;
  if (MarkWriter.cellCommand(cmd)) {
    closeMenu();
    return true;
  }
  if (
    exporting &&
    [
      "open",
      "new",
      "recent",
      "quick",
      "folder",
      "import",
      "close",
      "guide",
    ].includes(cmd)
  ) {
    notice("正在导出，请稍候。");
    return true;
  }
  if (cmd === "exports") {
    menu("exports", $("bar").firstElementChild, true);
    return true;
  }
  closeMenu();
  if (cmd === "paragraphTools" || cmd === "paragraphSelect") {
    if (doc.source) notice("切换到正文后可使用段落操作");
    else writer.paragraphTools(cmd === "paragraphSelect");
    return true;
  }
  if (cmd.startsWith("theme:")) {
    post("theme", { arg: cmd.slice(6) });
    return true;
  }
  if (["undo", "redo", "all"].includes(cmd)) {
    writer[cmd]();
    return true;
  }
  if (
    [
      "exportPdf",
      "exportHtml",
      "print",
      "docx",
      "epub",
      "odt",
      "rtf",
      "latex",
    ].includes(cmd)
  ) {
    exportDoc(cmd);
    return true;
  }
  switch (cmd) {
    case "drafts":
      req("drafts");
      break;
    case "autoSave":
      localStorage.autoSave = autoEnabled() ? "no" : "yes";
      doc.paused = false;
      status();
      scheduleAutosave();
      notice(autoEnabled() ? "已开启自动保存" : "已关闭自动保存");
      break;
    case "cut":
    case "copy":
      writer.focus();
      document.execCommand(cmd);
      break;
    case "paste":
      writer.focus();
      navigator.clipboard
        .readText()
        .then((t) => {
          const r = writer.selection();
          writer.replace(r.from, r.to, t);
        })
        .catch(() => notice("按 Ctrl + V 粘贴"));
      break;
    case "find":
    case "replace":
      writer.search(cmd === "replace");
      break;
    case "settings":
      openSettings();
      break;
    case "projectFind":
      projectPanel(true);
      break;
    case "collectImages":
      collectImages();
      break;
    case "quick":
      projectPanel(false);
      break;
    case "goto":
      jumpToLine();
      break;
    case "stats":
      stats();
      break;
    case "source":
      doc.source = !doc.source;
      document.body.classList.toggle("source", doc.source);
      writer.raw(doc.source);
      status();
      break;
    case "chatLibrary":
      sidebar("chats"); break;
    case "outline":
      if (window.chatExplorer?.isReading) sidebar("chatOutline");
      else sidebar(prefs.side === "outline" ? "" : "outline");
      break;
    case "files":
      sidebar(prefs.side === cmd ? "" : cmd);
      break;
    case "hideSide":
      sidebar("");
      break;
    case "toggleSide":
      sidebar(prefs.side ? "" : window.chatExplorer?.restoreSide || "outline");
      break;
    case "focus":
    case "typewriter":
      prefs[cmd] = !prefs[cmd];
      document.body.classList.toggle(cmd, prefs[cmd]);
      writer.focus();
      cursor(writer.selection().head);
      break;
    case "zoomIn":
    case "zoomOut":
    case "zoomReset":
      prefs.zoom =
        cmd === "zoomReset"
          ? 1
          : Math.max(
              0.75,
              Math.min(2, prefs.zoom + (cmd === "zoomIn" ? 0.1 : -0.1)),
            );
      document.documentElement.style.setProperty("--scale", prefs.zoom);
      writer.view.requestMeasure();
      break;
    case "new":
    case "open":
    case "save":
    case "saveAs":
    case "close":
    case "guide":
    case "newWindow":
    case "themeFolder":
    case "themes":
    case "fullscreen":
    case "folder":
    case "import":
      req(cmd);
      break;
    case "folderBack":
    case "folderForward":
    case "folderUp":
      post(cmd);
      break;
    case "imagePick":
      req(cmd, setting("imageMode"));
      break;
    default:
      writer.format(cmd);
  }
  return true;
}
function prepareBlocks(blocks) {
  const counts = Array(6).fill(0),
    used = new Set(),
    numbers = new Map(),
    seenReferences = new Map(),
    toc = document.createElement("div");
  toc.className = "doc-toc";
  const footnote = (id) => {
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    return numbers.get(id);
  };
  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  for (const b of blocks) {
    const hasURLs = /(?:https?:\/\/|www\.)/i.test(b.html);
    if (
      !b.level &&
      !b.html.includes("footnote-") &&
      !hasURLs &&
      !b.inlines?.length
    )
      continue;
    const t = document.createElement("template");
    t.innerHTML = b.html;
    if (hasURLs) MarkWriter.linkifyText(t.content);
    const h = b.level ? t.content.querySelector("h" + b.level) : null;
    if (h) {
      const at = b.level - 1;
      counts[at]++;
      counts.fill(0, at + 1);
      b.number = counts.slice(0, at + 1).join(".");
      let base = slug(b.heading),
        id = base,
        n = 1;
      while (used.has(id)) id = base + "-" + n++;
      used.add(id);
      b.id = id;
      h.id = id;
      h.dataset.section = b.number;
      const a = node("a", b.heading);
      a.href = "#" + id;
      a.dataset.index = b.number;
      a.dataset.level = String(b.level);
      a.style.paddingInlineStart = at * 0.95 + "em";
      toc.append(a);
    }
    for (const a of t.content.querySelectorAll(".footnote-reference a")) {
      const id = a.getAttribute("href").slice(1),
        number = footnote(id);
      const repeat = (seenReferences.get(id) || 0) + 1;
      seenReferences.set(id, repeat);
      a.id = "markcraft-note-" + number + (repeat === 1 ? "" : "-" + repeat);
      (b.references ||= []).push(a.id);
      a.textContent = number;
    }
    for (const f of t.content.querySelectorAll(".footnote-definition")) {
      b.footnote = f.id;
      const number = footnote(f.id),
        label = f.querySelector(".footnote-definition-label");
      if (label) label.textContent = number;
      const back = node("a", "↩");
      back.href = "#markcraft-note-" + number;
      back.setAttribute("aria-label", "返回脚注引用");
      back.className = "footnote-return";
      (f.querySelector("p:last-of-type") || f).append(back);
    }
    if (b.inlines?.length) {
      const notes = Array.from(
          t.content.querySelectorAll(".footnote-reference"),
        ),
        images = Array.from(t.content.querySelectorAll("img"));
      for (const i of b.inlines) {
        if (i.kind === "note") {
          const note = notes.shift();
          i.html = note?.outerHTML || "";
          i.referenceId = note?.querySelector("a")?.id;
        }
        if (i.kind === "image") i.html = images.shift()?.outerHTML || "";
      }
    }
    b.html = t.innerHTML;
  }
  for (const b of blocks)
    if (/^<p>\[toc\]<\/p>\s*$/i.test(b.html)) b.html = toc.outerHTML;
}
window.pickReplacementImage = (id) => post("replaceImageFile", { rev: id });
window.craftReceive = (msg) => {
  if (window.chatExplorer?.receive(msg)) return;
  if (msg.blocks) prepareBlocks(msg.blocks);
  switch (msg.kind) {
    case "wordSource":
    case "wordPage":
    case "wordSaved":
      wordStudio.receive(msg);
      break;
    case "activatedFile":
      pendingLocation = null;
      break;
    case "goToLine":
      if (writer?.view && !$("pop").open) goLine(msg.line);
      break;
    case "projectHits":
      projectReply?.(msg);
      break;
    case "assetProgress":
      if (msg.rev === collectRevision) notice(`正在收集图片 ${msg.index} / ${msg.count}`);
      break;
    case "assetResults":
      finishImages(msg);
      break;
    case "imageFilePicked":
      if (msg.epoch === doc.epoch) {
        MarkWriter.imageFilePicked(msg);
        if (msg.error) notice(msg.error);
      }
      break;
    case "themes":
      setTheme(msg);
      break;
    case "document":
      setDoc(msg);
      break;
    case "imported":
      writer.replace(0, doc.text.length, msg.text, 0);
      break;
    case "insert": {
      const r = writer.selection();
      writer.replace(r.from, r.to, msg.text);
      break;
    }
    case "saveQuestion":
      saveQuestion(msg);
      break;
    case "draftList":
      quick(msg.paths, true);
      break;
    case "diskUpdate":
      if (msg.epoch === doc.epoch) diskUpdate(msg);
      break;
    case "diskUnavailable":
    case "diskAvailable":
      if (msg.epoch === doc.epoch) { diskUnavailable = msg.kind === "diskUnavailable"; status(); if (diskUnavailable) notice(msg.message + "窗口内容已保留，可另存一份。"); }
      break;
    case "saved":
      if (msg.epoch !== doc.epoch) break;
      diskUnavailable = false;
      doc.draft = !!msg.draft;
      doc.paused = false;
      doc.lastAutomatic = !!msg.automatic;
      doc.path = msg.path;
      doc.title = msg.title;
      doc.saved = msg.text;
      doc.recent = [
        msg.path,
        ...doc.recent.filter((p) => p !== msg.path),
      ].slice(0, 12);
      if (doc.root !== msg.root || !msg.automatic) {
        setTreeRoot(msg.root);
        drawTree();
        if (prefs.side === "files" && doc.root) post("children");
      }
      status();
      if (doc.dirty) {
        post("dirty", { arg: "yes" });
        scheduleAutosave();
      }
      if (!msg.automatic) notice("已保存 " + msg.title);
      break;
    case "render":
      if (msg.rev >= 1e9) {
        if (msg.rev === 1e9 + exportRev) void drawExport(msg);
        break;
      }
      if (msg.rev === doc.rev) {
        parsedRevision = doc.rev;
        doc.blocks = msg.blocks;
        writer.setBlocks(msg.blocks);
        outline();
      }
      break;
    case "children":
      if (msg.epoch !== doc.epoch) break;
      const enteredFromTree = msg.root !== doc.root && $("tree").contains(document.activeElement);
      setTreeRoot(msg.root);
      for (const [id, name, target] of [
        ["folderBack", "后退", msg.back], ["folderForward", "前进", msg.forward], ["folderUp", "上一级", msg.up],
      ]) {
        $(id).disabled = !target;
        $(id).title = target ? name + " · " + target : name;
      }
      treeCache.set(msg.parent, msg.entries);
      if (msg.reveal) showSidebar("files");
      drawTree();
      if (enteredFromTree) ($("tree").querySelector(".tree-entry") || $("folderBack")).focus({preventScroll:true});
      break;
    case "exportDone":
    case "error":
      setExport(false);
      if (msg.warnings) showWordWarnings(msg);
      else notice(msg.message);
      break;
    case "notice":
      notice(msg.message);
      break;
  }
};
document.addEventListener("pointerdown", (e) => {
  if (menuKey && !e.target.closest("#bar,#menu,#chatExport")) closeMenu();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-command]");
  if (b) {
    act(b.dataset.command);
  }
});
document.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || e.keyCode === 229 || $("pop").open) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.target.closest("#files")) {
      const id = {ArrowLeft:"folderBack", ArrowRight:"folderForward", ArrowUp:"folderUp"}[e.key];
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        if (!$(id).disabled) post(id);
        return;
      }
    }
    if (e.target.closest(".code-toolbar,.language-panel,.image-details")) return;
    if (menuKey && ["ArrowDown", "ArrowUp", "Escape"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Escape") {
        const trigger = menuKey === "chatExports" ? $("chatExport") : null;
        closeMenu();
        if (trigger) trigger.focus(); else writer.focus();
        return;
      }
      const bs = [...$("menu").querySelectorAll("button")],
        i = bs.indexOf(document.activeElement);
      bs[
        (i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length
      ]?.focus();
      return;
    }
    const key = e.key.toLowerCase(),
      ctrl = e.ctrlKey || e.metaKey;
    let cmd;
    if (ctrl) {
      const map = e.shiftKey
        ? { s: "saveAs", n: "newWindow", e: "exportPdf", l: "toggleSide", f: "projectFind" }
        : {
            ",": "settings",
            o: "open",
            n: "new",
            s: "save",
            p: e.altKey ? "print" : "quick",
            w: "close",
            "/": "source",
            k: "link",
            u: "underline",
            b: "bold",
            i: "italic",
            f: "find",
            h: "replace",
            "=": "zoomIn",
            "-": "zoomOut",
          };
      cmd = key === "g" && e.altKey && !e.shiftKey ? "goto" : map[key];
      if (e.shiftKey && e.code === "Digit1") cmd = "outline";
      if (e.shiftKey && e.code === "Digit3") cmd = "files";
      if (!e.shiftKey && /^[0-6]$/.test(key))
        cmd = key === "0" ? "paragraph" : "h" + key;
      if (key === "+") cmd = "zoomIn";
    } else cmd = { F8: "focus", F9: "typewriter", F11: "fullscreen" }[e.key];
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      act(cmd);
    }
  },
  true,
);
$("popForm").onsubmit = (e) => e.preventDefault();
document.addEventListener(
  "paste",
  (e) => {
    if (!e.target.closest("#write") || e.target.closest(".editing-cell"))
      return;
    const file = Array.from(e.clipboardData?.items || [])
      .find(
        (it) =>
          it.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(it.type),
      )
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const reader = new FileReader();
    reader.onload = () =>
      post("pasteImage", { arg: reader.result, text: doc.text });
    reader.readAsDataURL(file);
  },
  true,
);
/* PREFERENCES */
/* WORD_STUDIO */
/* CHAT_EXPLORER */
writer = MarkWriter.createWriter($("write"), change, cursor, act, closeMenu, notice);
post("ready");
