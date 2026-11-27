const choices = {
  fontSize: [
    ["theme", "跟随主题"],
    ["15", "15 px"],
    ["16", "16 px"],
    ["17", "17 px"],
    ["18", "18 px"],
    ["20", "20 px"],
    ["22", "22 px"],
  ],
  measure: [
    ["theme", "跟随主题"],
    ["720", "紧凑 · 720 px"],
    ["860", "适中 · 860 px"],
    ["1024", "宽松 · 1024 px"],
  ],
  imageMode: [
    ["copy", "复制到文稿的 .assets"],
    ["link", "引用原图路径"],
  ],
  paper: [
    ["A4", "A4"],
    ["A5", "A5"],
    ["Letter", "Letter"],
  ],
  margin: [
    ["theme", "跟随主题"],
    ["12", "紧凑 · 12 mm"],
    ["20", "标准 · 20 mm"],
    ["26", "宽松 · 26 mm"],
  ],
};
function setting(name) {
  const value = localStorage.getItem("mc." + name);
  if (choices[name])
    return choices[name].some(([v]) => v === value)
      ? value
      : choices[name][0][0];
  return value === null ? name === "follow" : value === "yes";
}
function applySettings() {
  const desk = $("desk");
  for (const [key, css] of [
    ["fontSize", "--size"],
    ["measure", "--measure"],
  ]) {
    const value = setting(key);
    if (value === "theme") desk.style.removeProperty(css);
    else desk.style.setProperty(css, value + "px");
  }
  const margin = setting("margin"),
    paper = setting("paper"),
    pages = setting("pageNumbers");
  const edges =
    margin === "theme"
      ? prefs.name === "澄明浅色.css"
        ? "16mm 8.5mm"
        : "18mm 19mm"
      : margin + "mm";
  $("printSettings").textContent =
    "@media print { #printRoot {page: mcprint} @page mcprint {size:" +
    paper +
    ";margin:" +
    edges +
    ";@bottom-center {content:" +
    (pages ? 'counter(page) " / " counter(pages)' : "none") +
    ";font:9pt sans-serif;color:#515461}}}";
  writer?.view?.requestMeasure();
}
window.addEventListener("storage", (e) => {
  if (e.key?.startsWith("mc.")) applySettings();
});
function openSettings() {
  modal(
    "设置",
    (body) => {
      const tabs = node("nav"),
        panel = node("div");
      tabs.className = "settings-nav";
      tabs.setAttribute("aria-label", "设置分类");
      panel.className = "settings-content";
      body.append(tabs, panel);
      const sections = [
        [
          "写作",
          [
            ["自动保存", "autosave", "停笔后保存文稿，未命名内容进入草稿箱。"],
            ["正文主题", "theme"],
            ["正文字号", "fontSize"],
            ["正文宽度", "measure"],
          ],
        ],
        [
          "导航与图片",
          [
            ["大纲跟随滚动", "follow", "浏览长文时标出当前可见章节。"],
            ["插入本地图片时", "imageMode", "粘贴的图片仍存入文稿的资源目录。"],
          ],
        ],
        [
          "PDF 导出",
          [
            ["纸张", "paper"],
            ["页边距", "margin"],
            ["显示页码", "pageNumbers", "在每页底部显示当前页与总页数。"],
          ],
        ],
      ];
      sections.push(["对话", []]);
      const show = (tab, rows) => {
        for (const b of tabs.children)
          b.setAttribute("aria-pressed", String(b === tab));
        panel.replaceChildren(node("h3", tab.textContent));
        if(tab.textContent==="对话"){
          panel.append(node("p","管理本机对话的读取权限、记录目录和接续插件。"));
          modButton(panel,"管理对话来源",()=>window.chatExplorer.openSetup());return;
        }
        for (const [label, key, note] of rows) {
          const row = node("label");
          row.className = "setting-row";
          const caption = node("span");
          caption.append(node("strong", label));
          if (note) caption.append(node("small", note));
          let control;
          if (key === "theme" || choices[key]) {
            control = node("select");
            const options =
              key === "theme"
                ? prefs.themes.map((n) => [n, n.replace(/\.css$/i, "")])
                : choices[key];
            for (const [value, text] of options)
              control.add(new Option(text, value));
            control.value = key === "theme" ? prefs.name : setting(key);
          } else {
            control = node("input");
            control.type = "checkbox";
            control.checked = key === "autosave" ? autoEnabled() : setting(key);
          }
          control.dataset.setting = key;
          control.setAttribute("aria-label", label);
          control.onchange = () => {
            if (key === "autosave") {
              localStorage.autoSave = control.checked ? "yes" : "no";
              doc.paused = false;
              status();
              scheduleAutosave();
            } else if (key === "theme") post("theme", { arg: control.value });
            else {
              localStorage.setItem(
                "mc." + key,
                control.type === "checkbox"
                  ? control.checked
                    ? "yes"
                    : "no"
                  : control.value,
              );
              applySettings();
              if (key === "follow" && control.checked) followOutline();
            }
          };
          row.append(caption, control);
          panel.append(row);
        }
      };
      for (const [label, rows] of sections) {
        const b = node("button", label);
        b.type = "button";
        b.onclick = () => show(b, rows);
        tabs.append(b);
      }
      tabs.firstChild.click();
    },
    "settings",
    "settings",
  );
}
let projectTicket = 0,
  projectReply = null,
  pendingLocation = null;
function stopProjectSearch() {
  if (!projectReply) return;
  projectReply = null;
  projectTicket++;
  post("cancelSearch");
}
$("pop").addEventListener("close", () => {
  if (!$("pop").open || $("pop").dataset.kind !== "project")
    stopProjectSearch();
});
function projectPanel(content) {
  modal(
    content ? "文件夹内查找" : "快速打开",
    (body) => {
      const input = node("input");
      input.type = "search";
      input.placeholder = content
        ? "在当前文件夹中搜索正文"
        : "输入文件名或部分路径";
      input.setAttribute("aria-label", input.placeholder);
      const results = node("div");
      results.className = "project-results";
      const state = node("small");
      state.className = "project-state";
      body.append(input, state, results);
      let delay;
      const draw = (hits, limited) => {
        results.replaceChildren();
        const seen = new Set();
        const recent = content
          ? []
          : doc.recent
              .filter((p) =>
                p.toLowerCase().includes(input.value.toLowerCase()),
              )
              .map((path) => ({ path, recent: true }));
        for (const hit of [...hits, ...recent]) {
          const k = hit.path + ":" + (hit.line || 0);
          if (seen.has(k)) continue;
          seen.add(k);
          const btn = node("button");
          btn.type = "button";
          btn.title = hit.path;
          const name = hit.path.split(/[\\/]/).pop();
          btn.append(
            node(
              "strong",
              name + (hit.line ? " · 第 " + hit.line + " 行" : ""),
            ),
            node("small", hit.preview || hit.path),
          );
          results.append(btn);
          btn.onclick = () => {
            $("pop").close();
            if (doc.path?.toLowerCase() === hit.path.toLowerCase()) {
              if (hit.line) goLine(hit.line);
              return;
            }
            pendingLocation = hit.line
              ? { path: hit.path, line: hit.line }
              : null;
            req(
              hit.recent ? "recent" : "workspaceFile",
              hit.path,
              hit.line || 0,
            );
          };
        }
        state.textContent = limited
          ? "已显示前 150 项，请缩小范围"
          : !results.children.length
            ? content && !input.value
              ? "输入关键词查找匹配段落"
              : "没有匹配结果"
            : "";
      };
      input.oninput = () => {
        clearTimeout(delay);
        const id = ++projectTicket;
        projectReply = null;
        draw([], false);
        if (!doc.root) {
          if (content) state.textContent = "请先打开文稿或文件夹";
          return;
        }
        if (content && !input.value.trim()) {
          post("cancelSearch");
          return;
        }
        state.textContent = "正在搜索…";
        projectReply = (msg) => {
          if (
            msg.rev === id &&
            $("pop").open &&
            $("pop").dataset.kind === "project"
          )
            draw(msg.hits, msg.limited);
        };
        delay = setTimeout(() => {
          if (id === projectTicket)
            post(content ? "projectText" : "projectNames", {
              arg: input.value,
              rev: id,
            });
        }, 100);
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          dismissModal();
        } else if (e.key === "Enter") {
          e.preventDefault();
          results.querySelector("button")?.click();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          results.querySelector("button")?.focus();
        }
      };
      results.onkeydown = (event) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const current = document.activeElement;
        if (event.key === "ArrowUp")
          (current.previousElementSibling || input).focus();
        else current.nextElementSibling?.focus();
      };
      input.oninput();
      input.autofocus = true;
    },
    "search",
    "project",
  );
}
function goLine(n) {
  const v = writer.view;
  writer.select(v.state.doc.line(Math.min(n, v.state.doc.lines)).from);
}
let collectRevision = null;
function collectImages() {
  if (!doc.path || doc.draft) {
    notice("请先将文稿另存为 Markdown 文件。");
    return;
  }
  if (collectRevision !== null) {
    notice("正在收集本文图片…");
    return;
  }
  collectRevision = doc.rev;
  post("collectImages", { rev: doc.rev, text: doc.text });
  notice("正在收集本文图片…");
}
function finishImages(msg) {
  if (collectRevision !== msg.rev) return;
  collectRevision = null;
  if (doc.rev !== msg.rev || doc.path !== msg.document || questionId !== null) {
    notice("文稿已变动，图片引用未更新；可重新收集。");
    return;
  }
  const changes = [];
  for (const b of msg.blocks)
    for (const i of b.inlines || []) {
      if (
        i.kind !== "image" ||
        !Object.hasOwn(msg.resolved, i.path) ||
        msg.resolved[i.path] === i.path
      )
        continue;
      const from = b.start + i.from,
        to = b.start + i.to;
      changes.push({
        from,
        to,
        insert: MarkWriter.collectedImageSource(
          doc.text.slice(from, to),
          i,
          msg.resolved[i.path],
        ),
      });
    }
  if (changes.length)
    writer.view.dispatch({ changes, userEvent: "input.collectImages" });
  const summary =
    "已收集 " +
    Object.keys(msg.resolved).length +
    " 张图片，更新 " +
    changes.length +
    " 处引用";
  if (!msg.failed.length) {
    notice(summary);
    return;
  }
  modal(
    "图片收集结果",
    (body, actions) => {
      body.append(
        node(
          "p",
          summary + "。以下 " + msg.failed.length + " 张图片保留原引用。",
        ),
      );
      for (const entry of msg.failed) {
        const row = node("p");
        row.className = "asset-failure";
        row.append(node("strong", entry.path), node("small", entry.reason));
        body.append(row);
      }
      modButton(actions, "完成", () => $("pop").close(), true);
    },
    "paper",
    "collection",
  );
}
