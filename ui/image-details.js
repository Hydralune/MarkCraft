import { parser } from "@lezer/markdown";
import { Annotation } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";

export const imageChange = Annotation.define();
let openPanel;
let nextPicker = 0;

export function imageFilePicked(msg) {
  openPanel?.picked(msg);
}

function parts(text) {
  let image = parser.parse(text).resolveInner(1, 1);
  while (image && image.name !== "Image") image = image.parent;
  if (!image || image.from !== 0 || image.to !== text.length) return null;
  const [open, end, destination] = image.getChildren("LinkMark");
  if (!open || !end) return null;
  return {
    altFrom: open.to,
    altTo: end.from,
    destination,
    url: image.getChild("URL"),
    label: image.getChild("LinkLabel"),
  };
}

function editSource(raw, parsed, oldAlt, alt, oldPath, path, title) {
  if (/^<img\b/i.test(raw)) {
    const template = document.createElement("template");
    template.innerHTML = raw;
    const img = template.content.firstElementChild;
    if (img?.localName === "img") {
      if (oldPath !== path) img.setAttribute("src", path);
      if (oldAlt !== alt) img.setAttribute("alt", alt);
      return img.outerHTML;
    }
  }
  const literal = alt.replace(/[\\\[\]*_`~!&<>]/g, "\\$&");
  let dest = path.replace(/\\/g, "\\\\");
  if (/[\s()<>]/.test(path) || (parsed?.url && raw[parsed.url.from] === "<"))
    dest = "<" + dest.replace(/[<>]/g, "\\$&") + ">";
  if (!parsed || (!parsed.destination && oldPath !== path)) {
    // Replacing one reference must not retarget the other uses of its definition.
    const caption =
      parsed && oldAlt === alt
        ? raw.slice(parsed.altFrom, parsed.altTo)
        : literal;
    const tooltip = title ? ' "' + title.replace(/[\\"]/g, "\\$&") + '"' : "";
    return "![" + caption + "](" + dest + tooltip + ")";
  }
  let next = raw;
  if (parsed.destination && oldPath !== path) {
    const from = parsed.url?.from ?? parsed.destination.to;
    const to = parsed.url?.to ?? from;
    next = raw.slice(0, from) + dest + raw.slice(to);
  }
  if (oldAlt !== alt) {
    // In a shortcut or collapsed reference the old caption is also the lookup key.
    if (
      !parsed.destination &&
      (!parsed.label || parsed.label.to - parsed.label.from === 2)
    )
      next =
        raw.slice(0, parsed.altTo + 1) +
        "[" +
        raw.slice(parsed.altFrom, parsed.altTo) +
        "]";
    next = next.slice(0, parsed.altFrom) + literal + next.slice(parsed.altTo);
  }
  return next;
}

export function collectedImageSource(raw, item, newPath) {
  const template = document.createElement("template");
  template.innerHTML = item.html;
  const img = template.content.querySelector("img");
  return editSource(raw, parts(raw), img?.alt || "", img?.alt || "", item.path, newPath, img?.title || "");
}
export function dismissImageDetails(anchor) {
  if (openPanel?.anchor === anchor) openPanel.close();
}

export function showImageDetails(view, anchor, length, path) {
  if (openPanel?.anchor === anchor) {
    openPanel.close();
    return;
  }
  openPanel?.close();
  const img = anchor.querySelector("img");
  if (!img) return;
  const pos = view.posAtDOM(anchor);
  const raw = view.state.sliceDoc(pos, pos + length),
    parsed = parts(raw);
  const panel = document.createElement("section");
  panel.className = "image-details";
  panel.popover = "manual";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "图片信息");
  const title = document.createElement("h2");
  title.textContent = "图片信息";
  title.tabIndex = -1;
  panel.append(title);
  function field(label, value, readonly, multiline = false) {
    const row = document.createElement("label"),
      caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement(multiline ? "textarea" : "input");
    if (multiline) input.rows = 2;
    input.readOnly = readonly;
    input.spellcheck = false;
    input.value = value;
    row.append(caption, input);
    panel.append(row);
    return input;
  }
  const alt = field("图片说明", img.alt, false, true);
  const location = document.createElement("div");
  location.className = "image-location";
  const caption = document.createElement("label");
  caption.textContent = "图片路径";
  const controls = document.createElement("div");
  controls.className = "image-path-controls";
  const choose = document.createElement("button"),
    manual = document.createElement("button");
  choose.type = manual.type = "button";
  choose.className = "image-file";
  choose.title = "选择其他图片文件";
  const filename = document.createElement("span");
  filename.textContent = path.startsWith("data:image/")
    ? "已嵌入的图片"
    : path || "选择图片";
  const action = document.createElement("span");
  action.textContent = "更换…";
  choose.append(filename, action);
  manual.textContent = "输入路径";
  const target = document.createElement("input");
  target.className = "image-path";
  target.id = "image-manual-path";
  choose.id = "image-choose-file";
  caption.htmlFor = choose.id;
  target.spellcheck = false;
  target.placeholder = "相对路径或图片网址";
  target.value = path;
  target.hidden = true;
  controls.append(choose, target, manual);
  location.append(caption, controls);
  panel.append(location);
  if (img.title) field("标题", img.title, true);
  const actions = document.createElement("div");
  actions.className = "image-actions";
  const cancel = document.createElement("button"),
    save = document.createElement("button");
  cancel.type = save.type = "button";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-image";
  remove.textContent = "删除图片";
  remove.title = "从文稿移除这张图片（Ctrl+Z 可撤销）";
  cancel.textContent = "关闭";
  save.textContent = "应用";
  save.className = "primary";
  save.disabled = true;
  actions.append(remove, cancel, save);
  panel.append(actions);
  document.body.append(panel);
  const listeners = new AbortController(),
    opts = { signal: listeners.signal };
  function close() {
    listeners.abort();
    anchor.classList.remove("image-current");
    anchor.setAttribute("aria-expanded", "false");
    panel.remove();
    if (openPanel?.anchor === anchor) openPanel = null;
  }
  function finish() {
    close();
    view.focus();
  }
  function position() {
    if (!anchor.isConnected) {
      close();
      return;
    }
    const r = img.getBoundingClientRect(),
      p = panel.getBoundingClientRect(),
      gap = 8;
    const y =
      r.bottom + gap + p.height <= innerHeight
        ? r.bottom + gap
        : r.top - gap - p.height;
    panel.style.left =
      Math.max(gap, Math.min(r.left, innerWidth - p.width - gap)) + "px";
    panel.style.top =
      Math.max(gap, Math.min(y, innerHeight - p.height - gap)) + "px";
  }
  function commit(deleting = false) {
    if (!anchor.isConnected) {
      close();
      return;
    }
    const start = view.posAtDOM(anchor),
      end = start + length;
    if (view.state.sliceDoc(start, end) !== raw) {
      finish();
      return;
    }
    if (deleting) {
      let from = start,
        to = end;
      let node = syntaxTree(view.state).resolveInner(start + 1, 1);
      while (node && node.name !== "Image") node = node.parent;
      const link = node?.parent;
      if (
        link?.name === "Link" &&
        link.from === start - 1 &&
        link.getChildren("LinkMark")[1]?.from === end
      ) {
        from = link.from;
        to = link.to;
      }
      close();
      view.dispatch({
        changes: { from, to, insert: "" },
        selection: { anchor: from },
        annotations: isolateHistory.of("full"),
        userEvent: "delete.image",
      });
      view.focus();
      return;
    }
    if (alt.value === img.alt && target.value === path) {
      finish();
      return;
    }
    const next = editSource(
      raw,
      parsed,
      img.alt,
      alt.value,
      path,
      target.value,
      img.title,
    );
    const preview = img.cloneNode(false);
    preview.alt = alt.value;
    // Retain the image's dimensions until the renderer resolves the new path.
    const updated = {
      kind: "image",
      from: start,
      to: start + next.length,
      html: preview.outerHTML,
      path: target.value,
    };
    close();
    view.dispatch({
      changes: { from: start, to: end, insert: next },
      selection: { anchor: start + next.length },
      annotations: [imageChange.of(updated), isolateHistory.of("full")],
      userEvent: "input.image",
    });
    view.focus();
  }
  panel.oninput = () => {
    save.disabled = alt.value === img.alt && target.value === path;
    position();
  };
  let picker = 0;
  function chooseFile() {
    if (picker) return;
    picker = ++nextPicker;
    window.pickReplacementImage(picker);
  }
  function picked(msg) {
    if (msg.rev !== picker || !picker) return;
    picker = 0;
    if (msg.path != null) {
      target.value = msg.path;
      commit();
    } else {
      (choose.hidden ? manual : choose).focus({ preventScroll: true });
    }
  }
  choose.onclick = chooseFile;
  manual.onclick = () => {
    if (!target.hidden) {
      chooseFile();
      return;
    }
    choose.hidden = true;
    target.hidden = false;
    caption.htmlFor = target.id;
    manual.textContent = "选择文件…";
    target.focus();
    target.select();
    position();
  };
  remove.onclick = () => commit(true);
  cancel.onclick = finish;
  save.onclick = () => commit();
  panel.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
    }
    if (e.key === "Enter" && (e.target === target || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!picker && !anchor.contains(e.target) && !panel.contains(e.target))
        close();
    },
    { ...opts, capture: true },
  );
  document.addEventListener(
    "focusin",
    (e) => {
      if (!picker && !anchor.contains(e.target) && !panel.contains(e.target))
        close();
    },
    opts,
  );
  document.addEventListener(
    "scroll",
    (e) => {
      if (!panel.contains(e.target)) position();
    },
    { ...opts, capture: true },
  );
  window.addEventListener("resize", position, opts);
  openPanel = { anchor, close, picked };
  anchor.classList.add("image-current");
  anchor.setAttribute("aria-expanded", "true");
  panel.showPopover();
  position();
  title.focus({ preventScroll: true });
}
