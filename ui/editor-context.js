import { EditorView } from "@codemirror/view";
import { undoDepth, redoDepth } from "@codemirror/commands";
import { cellContext, leaveCell, tablePositions } from "./table-editor.js";
import { codeBodyAt } from "./code-language.js";

export function installEditorContext(
  view,
  blocks,
  act,
  closeOtherMenus,
  notify,
) {
  const menu = document.createElement("div");
  menu.className = "command-menu editor-context";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "编辑操作");
  menu.hidden = true;
  document.body.append(menu);
  let editor, root, current, x, y, openedState;
  function close(focus = false) {
    if (menu.hidden) return;
    if (focus && editor.dom.isConnected) editor.focus();
    menu.hidden = true;
    menu.replaceChildren();
    root = current = openedState = null;
  }
  function show(rows, keyboard = false) {
    current = rows;
    menu.replaceChildren();
    for (const entry of rows) {
      if (!entry) {
        menu.append(document.createElement("hr"));
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.disabled = !!entry.disabled;
      b.setAttribute(
        "role",
        entry.checked == null ? "menuitem" : "menuitemradio",
      );
      if (entry.checked != null)
        b.setAttribute("aria-checked", String(entry.checked));
      const text = document.createElement("span");
      text.textContent = entry.title;
      b.append(text);
      if (entry.children || entry.hint) {
        const hint = document.createElement("kbd");
        hint.textContent = entry.children ? "›" : entry.hint;
        b.append(hint);
      }
      if (entry.children) b.setAttribute("aria-haspopup", "menu");
      b.onclick = () => {
        if (entry.children) {
          show(entry.children, true);
          return;
        }
        if (entry.back) {
          show(root, true);
          return;
        }
        const valid = openedState === view.state.doc && editor.dom.isConnected;
        close(true);
        if (valid) entry.run();
      };
      menu.append(b);
    }
    menu.hidden = false;
    menu.scrollTop = 0;
    menu.style.left =
      Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top =
      Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + "px";
    if (keyboard)
      menu.querySelector("button:enabled")?.focus({ preventScroll: true });
  }
  function open(target, px, py, keyboard) {
    close();
    closeOtherMenus();
    let td = target.closest("td,th"),
      img = target.closest(".inline-image") || target.closest("img");
    const link = target.closest("[data-link],a[href]");
    const href =
      link?.closest("[data-resolved-link]")?.dataset.resolvedLink ||
      link?.dataset.link ||
      link?.getAttribute("href");
    const coords = { x: px, y: py };
    let pos = view.posAtCoords(coords, false);
    const selected = view.state.selection.main;
    let cell;
    if (td) {
      const el = td.closest(".rendered");
      const block =
        el &&
        view.state.field(blocks).find((b) => b.start === view.posAtDOM(el));
      const bounds = tablePositions(view, block, td);
      const selectedCell =
        !selected.empty &&
        bounds?.from != null &&
        selected.from <= bounds.from &&
        selected.to >= bounds.to;
      if (!selectedCell && block) {
        const imageIndex = img
          ? [...td.querySelectorAll("img")].indexOf(
              img.closest("img") || img.querySelector("img"),
            )
          : -1;
        cell = cellContext(
          view,
          block,
          td,
          keyboard ? null : { clientX: px, clientY: py },
        );
        if (cell && imageIndex >= 0)
          img = cell.editor.dom.querySelectorAll(".inline-image")[imageIndex];
      }
      if (selectedCell) pos = selected.from;
    }
    editor = cell?.editor || view;
    if (!cell) leaveCell();
    if (cell) pos = editor.posAtCoords(coords, false);
    if (!keyboard && pos != null) {
      const r = editor.state.selection.main;
      if (r.empty || pos < r.from || pos > r.to)
        editor.dispatch({ selection: { anchor: pos } });
    }
    editor.focus();
    const sel = editor.state.selection.main;
    const cmd = (title, id, hint) => ({ title, hint, run: () => act(id) });
    const action = (title, run) => ({ title, run });
    const group = (title, children) => ({
      title,
      children: [{ title: "‹  " + title, back: true }, null, ...children],
    });
    const copy = (value) =>
      navigator.clipboard
        .writeText(value)
        .catch(() => notify("未能写入剪贴板"));
    const rows = [];
    if (img?.matches(".inline-image")) {
      rows.push(
        action("图片信息与更换…", () => img.click()),
        action("复制图片路径", () => copy(img.imagePath)),
        null,
      );
    }
    if (href)
      rows.push(
        action("打开链接", () => window.openDocLink(href)),
        action("复制链接地址", () => copy(href)),
        null,
      );
    if (cell) {
      const op = (title, id, disabled = false) => ({
        title,
        disabled,
        run: () => cell.run(id),
      });
      rows.push(
        group(
          "列对齐",
          [
            ["左对齐", "left"],
            ["居中对齐", "center"],
            ["右对齐", "right"],
          ].map(([title, id]) => ({
            ...op(title, id),
            checked: id === cell.align,
          })),
        ),
        group("行和列", [
          op("在上方插入行", "rowAbove", !cell.row),
          op("在下方插入行", "row"),
          op("在左侧插入列", "columnLeft"),
          op("在右侧插入列", "column"),
          null,
          op("删除当前行", "deleteRow", !cell.row),
          op("删除当前列", "deleteCol", cell.columns === 1),
        ]),
        action("复制表格 Markdown", () => copy(cell.markdown())),
        null,
      );
    }
    const code = !cell && codeBodyAt(view, pos ?? sel.head);
    if (code) {
      const picker = [
        ...view.contentDOM.querySelectorAll(".code-toolbar"),
      ].find((t) => view.posAtDOM(t) === code.node.from);
      rows.push(
        action("复制代码", () => copy(view.state.sliceDoc(code.from, code.to))),
      );
      if (picker)
        rows.push(
          action("选择代码语言…", () =>
            picker.querySelector(".block-language")?.click(),
          ),
        );
      rows.push(null);
    }
    rows.push(
      { ...cmd("剪切", "cut", "Ctrl + X"), disabled: sel.empty },
      { ...cmd("复制", "copy", "Ctrl + C"), disabled: sel.empty },
      cmd("粘贴", "paste", "Ctrl + V"),
      cmd(cell ? "全选单元格文字" : "全选", "all", "Ctrl + A"),
      null,
    );
    if (!code) {
      rows.push(
        group("文本格式", [
          cmd("加粗", "bold", "Ctrl + B"),
          cmd("斜体", "italic", "Ctrl + I"),
          cmd("下划线", "underline", "Ctrl + U"),
          cmd("删除线", "strike"),
          cmd("行内代码", "code"),
          cmd("链接", "link", "Ctrl + K"),
        ]),
      );
      if (!cell)
        rows.push(
          group("段落与插入", [
            cmd("正文", "paragraph"),
            cmd("一级标题", "h1"),
            cmd("二级标题", "h2"),
            cmd("引用", "quote"),
            cmd("任务列表", "task"),
            null,
            cmd("表格", "table"),
            cmd("代码块", "fence"),
            cmd("公式块", "equation"),
            cmd("本地图片…", "imagePick"),
          ]),
        );
      rows.push(null);
    }
    rows.push(
      { ...cmd("撤销", "undo", "Ctrl + Z"), disabled: !undoDepth(view.state) },
      { ...cmd("重做", "redo", "Ctrl + Y"), disabled: !redoDepth(view.state) },
    );
    openedState = view.state.doc;
    x = px;
    y = py;
    root = rows;
    show(root, keyboard);
  }
  const inEditor = (node) =>
    view.contentDOM.contains(node) &&
    !node.closest(
      "input,textarea,button,select,.table-tools,.code-toolbar,[popover]",
    );
  view.dom.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 2 && inEditor(e.target)) e.preventDefault();
    },
    true,
  );
  view.dom.addEventListener("contextmenu", (e) => {
    if (!inEditor(e.target)) return;
    e.preventDefault();
    open(e.target, e.clientX, e.clientY, false);
  });
  view.dom.addEventListener(
    "keydown",
    (e) => {
      if (
        !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) ||
        !inEditor(e.target)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      const focused = EditorView.findFromDOM(e.target) || view;
      const p = focused.coordsAtPos(focused.state.selection.main.head);
      if (!p) return;
      const target = document.elementFromPoint(
        p.left + 1,
        (p.top + p.bottom) / 2,
      );
      open(
        target && inEditor(target) ? target : e.target,
        p.left,
        p.bottom,
        true,
      );
    },
    true,
  );
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener(
    "keydown",
    (e) => {
      if (menu.hidden) return;
      const keys = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowDown",
        "ArrowUp",
        "Enter",
        "Home",
        "End",
        "Escape",
        "Tab",
      ];
      if (!keys.includes(e.key)) {
        close(true);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const buttons = [...menu.querySelectorAll("button:enabled")],
        i = buttons.indexOf(document.activeElement);
      if (e.key === "Escape" || e.key === "Tab") return close(true);
      if (e.key === "ArrowLeft") {
        if (current !== root) show(root, true);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (
          i >= 0 &&
          (e.key === "Enter" || buttons[i].hasAttribute("aria-haspopup"))
        )
          buttons[i].click();
        return;
      }
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (Math.max(e.key === "ArrowUp" ? 0 : -1, i) +
                (e.key === "ArrowUp" ? -1 : 1) +
                buttons.length) %
              buttons.length;
      buttons[next]?.focus({ preventScroll: true });
      buttons[next]?.scrollIntoView({ block: "nearest" });
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!menu.contains(e.target)) close();
    },
    true,
  );
  view.scrollDOM.addEventListener("scroll", () => close());
  window.addEventListener("resize", () => close());
  window.addEventListener("blur", () => close());
  return close;
}
