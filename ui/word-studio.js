const wordStudio = (() => {
  const fonts = ["宋体", "微软雅黑", "黑体", "等线", "楷体", "仿宋"];
  const inks = [
    ["#182b38", "墨青"], ["#181818", "墨黑"], ["#285987", "深蓝"],
    ["#326453", "松绿"], ["#824a39", "陶褐"], ["#624d78", "灰紫"],
  ];
  const fills = [
    ["#e7eff3", "雾蓝"], ["#efefed", "浅灰"], ["#deebf5", "天青"],
    ["#e3efe8", "鼠尾草"], ["#f3e8e2", "杏色"], ["#ece7f1", "淡紫"],
    ["#ffffff", "白色"],
  ];
  const paragraphAlignments = [["left", "左对齐"], ["both", "两端对齐"]];
  const headingAlignments = [["left", "左对齐"], ["center", "居中"]];
  const defaults = {
    headingAlign: "left", headingBefore: 12, headingAfter: 5,
    bodyAlign: "left", firstIndent: 0, headerFill: "#e7eff3", cellPadding: 3.25,
  };
  const presets = {
    standard: {
      name: "通用文稿",
      bodyFont: "宋体",
      headingFont: "微软雅黑",
      bodySize: 11,
      headings: [21, 16, 13, 11.5, 11, 11],
      leading: 1.32,
      after: 5,
      color: "#182b38",
    },
    academic: {
      name: "学术论文",
      bodyFont: "宋体",
      headingFont: "黑体",
      bodySize: 12,
      headings: [18, 15, 14, 12, 12, 12],
      leading: 1.5,
      after: 6,
      color: "#181818",
      bodyAlign: "both", firstIndent: 2, headerFill: "#efefed",
    },
    report: {
      name: "工作报告",
      bodyFont: "等线",
      headingFont: "微软雅黑",
      bodySize: 11.5,
      headings: [26, 19, 15, 13, 12, 11],
      leading: 1.4,
      after: 8,
      color: "#285987",
      headingBefore: 16, headingAfter: 7, headerFill: "#deebf5", cellPadding: 4,
    },
    minutes: {
      name: "会议纪要", bodyFont: "等线", headingFont: "黑体", bodySize: 11,
      headings: [19, 15, 13, 12, 11, 11], leading: 1.25, after: 3,
      color: "#326453", headerFill: "#e3efe8", headingBefore: 9, cellPadding: 2,
    },
    proposal: {
      name: "项目方案", bodyFont: "微软雅黑", headingFont: "微软雅黑", bodySize: 11,
      headings: [24, 18, 14, 12, 11, 11], leading: 1.45, after: 6,
      color: "#624d78", headerFill: "#ece7f1", headingBefore: 16, headingAfter: 8,
    },
    essay: {
      name: "人文随笔", bodyFont: "楷体", headingFont: "宋体", bodySize: 13,
      headings: [23, 17, 15, 13, 13, 13], leading: 1.65, after: 6,
      color: "#824a39", headerFill: "#f3e8e2", firstIndent: 2, headingAlign: "center",
    },
    manual: {
      name: "技术手册", bodyFont: "等线", headingFont: "黑体", bodySize: 10.5,
      headings: [20, 15, 12.5, 11, 10.5, 10.5], leading: 1.24, after: 4,
      color: "#285987", headerFill: "#deebf5", headingBefore: 10, cellPadding: 2.5,
    },
    personal: {
      name: "个人模板",
      bodyFont: null,
      headingFont: null,
      bodySize: null,
      headings: Array(6).fill(null),
      leading: null,
      after: null,
      color: null,
    },
  };
  let serial = 0,
    session;
  const make = (tag, cls, text) => {
    const el = node(tag, text);
    if (cls) el.className = cls;
    return el;
  };
  function choose(s, key, overrides = {}) {
    s.key = key;
    const { name, ...base } = presets[key];
    s.style = structuredClone({
      ...(key === "personal" ? {} : defaults),
      ...base,
      ...overrides,
      personal: key === "personal",
    });
    for (const [id, card] of s.cards)
      card.setAttribute("aria-pressed", String(id === key));
    controls(s);
    queue(s);
  }
  function sampleCard(s, key) {
    const p = presets[key],
      b = make("button", "word-card");
    b.type = "button";
    b.dataset.preset = key;
    b.setAttribute("aria-label", p.name);
    const sample = make("div", "word-sample");
    sample.setAttribute("aria-hidden", "true");
    if (key === "personal") {
      sample.classList.add("personal");
      sample.append(toolIcon("paper"));
    } else {
      sample.style.setProperty("--sample-ink", p.color);
      sample.style.setProperty("--sample-fill", p.headerFill || defaults.headerFill);
      sample.style.setProperty("--sample-leading", (p.leading * 2.3) + "px");
      const title = node("strong", {
        standard: "观测手记", academic: "研究方法", report: "季度简报",
        minutes: "会议记录", proposal: "实施计划", essay: "山间来信", manual: "安装指南",
      }[key]);
      title.style.fontFamily = p.headingFont;
      title.style.fontSize = (p.headings[0] * 0.39) + "px";
      title.style.textAlign = p.headingAlign || defaults.headingAlign;
      const lines = make("span", "sample-lines");
      const table = make("span", "sample-grid");
      sample.append(title, lines, table);
    }
    const info = make("span", "word-card-info");
    info.append(make("strong", "word-card-name", p.name), make("small", "word-card-meta",
      key === "personal" ? "word-reference.docx" : p.bodyFont + " · " + p.bodySize + " 磅"));
    b.append(sample, info, toolIcon("check", "word-card-check"));
    b.onclick = () => choose(s, key);
    s.cards.set(key, b);
    s.templates.append(b);
  }
  function controls(s) {
    const panel = s.controls;
    const expanded = new Set(Array.from(panel.querySelectorAll(".word-group[open]"), g => g.dataset.group));
    const first = !panel.childElementCount;
    panel.replaceChildren();
    function group(title) {
      const box = make("details", "word-group");
      box.dataset.group = title;
      box.open = first || expanded.has(title);
      const summary = node("summary", title);
      summary.append(toolIcon("chevron"));
      box.append(summary);
      panel.append(box);
      return box;
    }
    const head = group("标题"), body = group("正文"), table = group("表格");
    function field(box, label, key, opts = {}) {
      const row = make("label", "word-field");
      const value = opts.i == null ? s.style[key] : s.style[key][opts.i];
      const input = node(opts.options ? "select" : "input");
      input.setAttribute("aria-label", label);
      if (opts.options) {
        const choices = [...opts.options];
        if (s.key === "personal") choices.unshift("");
        for (const opt of choices) {
          const [value, caption] = Array.isArray(opt) ? opt : [opt, opt];
          const option = node("option", caption || "沿用模板");
          option.value = value;
          input.append(option);
        }
      } else {
        input.type = "number";
        input.min = opts.min;
        input.max = opts.max;
        input.step = opts.step;
        input.required = s.key !== "personal";
        input.placeholder = "沿用";
      }
      input.value = value ?? "";
      input.dataset.styleKey = key;
      input.oninput = () => {
        const next =
          input.value === ""
            ? null
            : opts.options
              ? input.value
              : input.valueAsNumber;
        if (input.validity.valid) {
          if (opts.i == null) s.style[key] = next;
          else s.style[key][opts.i] = next;
        }
        queue(s);
      };
      const control = make("span", "word-value");
      control.append(input);
      if (opts.unit) control.append(make("small", "word-unit", opts.unit));
      row.append(node("span", label), control);
      box.append(row);
    }
    field(head, "标题字体", "headingFont", { options: fonts });
    field(head, "标题颜色", "color", { options: inks });
    field(head, "标题对齐", "headingAlign", { options: headingAlignments });
    const more = node("details");
    more.append(node("summary", "四至六级标题"));
    [
      "一级标题",
      "二级标题",
      "三级标题",
      "四级标题",
      "五级标题",
      "六级标题",
    ].forEach((label, i) => {
      field(i < 3 ? head : more, label, "headings", {
        i,
        min: 8,
        max: 72,
        step: 0.5,
        unit: "磅",
      });
    });
    head.append(more);
    field(head, "标题段前", "headingBefore", { min: 0, max: 72, step: 0.5, unit: "磅" });
    field(head, "标题段后", "headingAfter", { min: 0, max: 36, step: 0.5, unit: "磅" });
    field(body, "正文字体", "bodyFont", { options: fonts });
    field(body, "正文字号", "bodySize", {
      min: 8,
      max: 36,
      step: 0.5,
      unit: "磅",
    });
    field(body, "正文对齐", "bodyAlign", { options: paragraphAlignments });
    field(body, "首行缩进", "firstIndent", { min: 0, max: 4, step: 0.5, unit: "字" });
    field(body, "行距", "leading", { min: 1, max: 3, step: 0.01, unit: "倍" });
    field(body, "段后间距", "after", {
      min: 0,
      max: 36,
      step: 0.5,
      unit: "磅",
    });
    field(table, "表头底色", "headerFill", { options: fills });
    field(table, "上下内边距", "cellPadding", { min: 0, max: 12, step: 0.25, unit: "磅" });
  }
  function fit(s) {
    const w = s.image.hidden ? 794 : s.image.naturalWidth || 794;
    const h = s.image.hidden ? 1123 : s.image.naturalHeight || 1123;
    if (!s.stage.clientWidth || !s.stage.clientHeight) return;
    const widthScale = s.stage.clientWidth / w;
    const scale = s.wide
      ? widthScale
      : Math.min(widthScale, s.stage.clientHeight / h);
    s.sheet.style.width = s.wide ? "100%" : Math.round(w * scale) + "px";
    s.sheet.style.height = Math.round(h * scale) + "px";
    s.paper.style.transform = "scale(" + scale + ")";
  }
  function rough(s) {
    const a = s.style,
      f = presets.standard,
      vars = s.paper.style;
    for (const [k, v] of Object.entries({
      "--wp-body": (a.bodySize ?? f.bodySize) + "pt",
      "--wp-font": a.bodyFont || f.bodyFont,
      "--wp-heading": a.headingFont || f.headingFont,
      "--wp-color": a.color || f.color,
      "--wp-line": a.leading ?? f.leading,
      "--wp-after": (a.after ?? f.after) + "pt",
      "--wp-head-before": (a.headingBefore ?? defaults.headingBefore) + "pt",
      "--wp-head-after": (a.headingAfter ?? defaults.headingAfter) + "pt",
      "--wp-head-align": a.headingAlign || defaults.headingAlign,
      "--wp-align": a.bodyAlign === "both" ? "justify" : "left",
      "--wp-indent": (a.firstIndent ?? defaults.firstIndent) + "em",
      "--wp-header-fill": a.headerFill || defaults.headerFill,
      "--wp-cell-pad": (a.cellPadding ?? defaults.cellPadding) + "pt",
    }))
      vars.setProperty(k, v);
    a.headings.forEach((v, i) =>
      vars.setProperty("--wp-h" + (i + 1), (v ?? f.headings[i]) + "pt"),
    );
    fit(s);
  }
  function queue(s) {
    clearTimeout(s.timer);
    s.rev = ++serial;
    s.save.disabled = true;
    s.ready = false;
    rough(s);
    if (s.controls.querySelector(":invalid")) {
      s.status.textContent = "请检查字号或间距的取值";
      return;
    }
    s.status.textContent = "正在生成 Word 首页…";
    s.timer = setTimeout(() => {
      if (session === s)
        post("wordLayout", { rev: s.rev, arg: JSON.stringify(s.style) });
    }, 230);
  }
  function pane(s, key) {
    s.grid.dataset.pane = key;
    for (const b of s.tabs.children)
      b.setAttribute("aria-pressed", String(b.dataset.pane === key));
    fit(s);
  }
  function close() {
    const s = session;
    if (!s) return;
    session = null;
    clearTimeout(s.timer);
    s.observer.disconnect();
    post("wordClose", { rev: s.id });
  }
  function open(snapshot = null) {
    close();
    const s = { snapshot, id: ++serial, cards: new Map(), rev: 0, ready: false, wide: false };
    session = s;
    modal(
      "导出 Word",
      (host, actions) => {
        s.tabs = make("div", "word-tabs");
        for (const [k, title] of [
          ["templates", "模板"],
          ["preview", "首页预览"],
          ["controls", "细调"],
        ]) {
          const b = node("button", title);
          b.type = "button";
          b.dataset.pane = k;
          b.onclick = () => pane(s, k);
          s.tabs.append(b);
        }
        s.grid = make("div", "word-grid");
        const left = make("section", "word-templates"),
          center = make("section", "word-preview"),
          right = make("section", "word-controls");
        left.append(make("h3", "word-label", "排版模板"));
        s.templates = make("div", "word-cards");
        left.append(s.templates);
        const bar = make("div", "word-preview-bar");
        const zoom = make("button", "word-zoom", "页宽");
        zoom.type = "button";
        zoom.title = "按页宽查看首页";
        zoom.onclick = () => {
          s.wide = !s.wide;
          zoom.textContent = s.wide ? "整页" : "页宽";
          zoom.title = s.wide ? "查看完整首页" : "按页宽查看首页";
          s.stage.classList.toggle("wide", s.wide);
          s.stage.scrollTop = 0;
          fit(s);
        };
        bar.append(
          make("h3", "word-label", "首页预览"),
          make("span", "word-filename", snapshot?.title || doc.title),
          zoom,
        );
        s.stage = make("div", "word-stage");
        s.sheet = make("div", "word-sheet");
        s.paper = make("article", "word-paper");
        s.content = make("div", "word-page-content");
        s.paper.append(s.content, make("span", "word-page-number", "1"));
        s.paper.inert = true;
        s.image = node("img");
        s.image.className = "word-page-image";
        s.image.alt = "当前文稿的 Word 第一页";
        s.image.hidden = true;
        s.sheet.append(s.paper, s.image);
        s.stage.append(s.sheet);
        center.append(bar, s.stage);
        const rightBar = make("div", "word-controls-bar"),
          reset = make("button", "word-reset", "重置");
        reset.type = "button";
        reset.title = "恢复当前模板的参数";
        reset.onclick = () => {
          if (s.key) choose(s, s.key);
        };
        rightBar.append(make("h3", "word-label", "样式细调"), reset);
        s.controls = make("div", "word-fields");
        right.append(rightBar, s.controls);
        s.grid.append(left, center, right);
        host.append(s.tabs, s.grid);
        s.status = make("span", "word-progress", "正在读取当前文稿…");
        s.status.setAttribute("role", "status");
        actions.append(s.status);
        modButton(actions, "取消", () => $("pop").close());
        s.save = modButton(
          actions,
          "导出 Word…",
          () => {
            if (s.ready) {
              s.save.disabled = true;
              post("wordSave", { rev: s.rev, chatTitle: s.snapshot?.title });
            }
          },
          true,
        );
        s.save.disabled = true;
        s.observer = new ResizeObserver(() => fit(s));
        s.observer.observe(s.stage);
        pane(s, "preview");
      },
      "paper",
      "word",
    );
    if (snapshot) post("wordBegin", {rev: s.id, text: snapshot.sections.join("\n"), chatTitle: snapshot.title});
    else req("wordBegin", "", s.id);
  }
  function receive(msg) {
    const s = session;
    if (
      !s ||
      msg.studio !== s.id ||
      !$("pop").open ||
      $("pop").dataset.kind !== "word"
    )
      return;
    if (msg.kind === "wordSource") {
      for (const k of Object.keys(presets))
        if (k !== "personal" || msg.personal) sampleCard(s, k);
      const frag = document.createDocumentFragment();
      for (const b of s.snapshot ? s.snapshot.sections.slice(0,48).map(html => ({html})) : msg.blocks) {
        const t = document.createElement("template");
        t.innerHTML = b.html;
        for (const el of t.content.querySelectorAll("[id]"))
          el.removeAttribute("id");
        frag.append(t.content);
      }
      s.content.replaceChildren(frag);
      choose(s, msg.personal ? "personal" : "standard");
    } else if (msg.kind === "wordPage" && msg.rev === s.rev) {
      if (msg.error) {
        s.status.textContent = msg.error;
        return;
      }
      const ready = (exact) => {
        if (session !== s || s.rev !== msg.rev) return;
        s.image.hidden = !exact;
        s.paper.hidden = exact;
        const ratio = exact ? s.image.naturalWidth / s.image.naturalHeight : 794 / 1123;
        s.grid.style.setProperty("--word-page-ratio", String(ratio));
        fit(s);
        s.status.textContent = exact
          ? "Word 实际排版 · 第 1 页"
          : "近似预览 · 当前无法调用 Word 排版";
        s.ready = true;
        s.save.disabled = false;
      };
      if (msg.image) {
        s.image.onload = () => ready(true);
        s.image.onerror = () => ready(false);
        s.image.src = msg.image;
      } else ready(false);
    } else if (msg.kind === "wordSaved") {
      if (msg.cancelled || msg.error) {
        s.save.disabled = false;
        if (msg.error) s.status.textContent = msg.error;
        return;
      }
      $("pop").close();
      close();
      if (msg.warnings) showWordWarnings(msg);
      else notice(msg.message);
    }
  }
  $("pop").addEventListener("close", () => {
    if (!$("pop").open || $("pop").dataset.kind !== "word") close();
  });
  return { open, receive, close };
})();
