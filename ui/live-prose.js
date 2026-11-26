import { Decoration, WidgetType } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { StateField } from "@codemirror/state";
import {
  showImageDetails,
  dismissImageDetails,
  imageChange,
} from "./image-details.js";

// Keep table and diagram widgets local to the corresponding source lines in a mixed list or quotation.
export function editableBlocks(state, blocks) {
  return blocks.flatMap((block) => {
    if (
      !/^<(?:ol|ul|blockquote)\b/.test(block.html) ||
      !/<table\b|language-mermaid/.test(block.html)
    )
      return [block];
    const t = document.createElement("template");
    t.innerHTML = block.html;
    const widgets = Array.from(
      t.content.querySelectorAll("table,pre:has(code.language-mermaid)"),
    );
    const segments = [],
      nodes = [];
    const tree = ensureSyntaxTree(state, block.end, 60) || syntaxTree(state);
    tree.iterate({
      from: block.start,
      to: block.end,
      enter(n) {
        if (
          n.name === "Table" ||
          (n.name === "FencedCode" &&
            state
              .sliceDoc(n.from, state.doc.lineAt(n.from).to)
              .includes("mermaid"))
        ) {
          nodes.push(n.node);
          return false;
        }
      },
    });
    if (!nodes.length || nodes.length !== widgets.length) return [block];
    function segment(start, end, html) {
      if (end <= start) return;
      const inlines = (block.inlines || [])
        .filter(
          (i) => block.start + i.from >= start && block.start + i.to <= end,
        )
        .map((i) => ({
          ...i,
          from: block.start + i.from - start,
          to: block.start + i.to - start,
        }));
      segments.push({ start, end, html, inlines, tasks: [] });
    }
    let cursor = block.start;
    nodes.forEach((n, i) => {
      const start = state.doc.lineAt(n.from).from;
      segment(cursor, start - 1, "");
      segment(
        start,
        n.to,
        '<div class="nested-content">' + widgets[i].outerHTML + "</div>",
      );
      cursor = n.to + 1;
    });
    segment(cursor, block.end, "");
    return segments;
  });
}
export function inlineObjects(setBlocks) {
  return StateField.define({
    create: () => [],
    update(old, tr) {
      for (const e of tr.effects)
        if (e.is(setBlocks))
          return e.value.flatMap((b) =>
            (b.inlines || []).map((i) => ({
              ...i,
              from: b.start + i.from,
              to: b.start + i.to,
            })),
          );
      if (!tr.docChanged) return old;
      const mapped = old
        .filter(
          (i) =>
            i.kind === "math" || !tr.changes.touchesRange(i.from + 1, i.to - 1),
        )
        .map((i) => ({
          ...i,
          from: tr.changes.mapPos(i.from, 1),
          to: tr.changes.mapPos(i.to, -1),
        }))
        .filter(
          (i) =>
            i.from < i.to &&
            (i.kind !== "math" ||
              (tr.newDoc.sliceString(i.from, i.from + 1) === "$" &&
                tr.newDoc.sliceString(i.to - 1, i.to) === "$")),
        );
      const updated = tr.annotation(imageChange);
      if (updated) {
        mapped.push(updated);
        mapped.sort((a, b) => a.from - b.from);
      }
      return mapped;
    },
  });
}
// Remember only intrinsic dimensions so a remounted image can reserve its space.
const imageSizes = new Map();
export function resetImageSizes() { imageSizes.clear(); }
function prepareEditorImage(img) {
  img.decoding = "async";
  const key = img.getAttribute("src");
  if (!key || key.length > 4096 || key.startsWith("data:")) return;
  if (img.hasAttribute("width") && img.hasAttribute("height")) {
    img.loading = "lazy";
    return;
  }
  if (img.hasAttribute("width") || img.hasAttribute("height")) return;
  const size = imageSizes.get(key);
  if (size) {
    img.width = size[0];
    img.height = size[1];
    img.loading = "lazy";
  }
  const remember = () => {
    if (!img.naturalWidth || !img.isConnected) return;
    if (size) { img.removeAttribute("width"); img.removeAttribute("height"); }
    imageSizes.delete(key);
    imageSizes.set(key, [img.naturalWidth, img.naturalHeight]);
    if (imageSizes.size > 128) imageSizes.delete(imageSizes.keys().next().value);
  };
  if (img.complete) queueMicrotask(remember);
  else img.addEventListener("load", remember, {once:true});
}
class InlineObject extends WidgetType {
  constructor(html, imageLength = 0, path = "") {
    super();
    this.html = html;
    this.imageLength = imageLength;
    this.path = path;
  }
  eq(w) {
    return (
      w.html === this.html &&
      w.imageLength === this.imageLength &&
      w.path === this.path
    );
  }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "inline-object";
    span.innerHTML = this.html;
    if (this.imageLength) {
      span.classList.add("inline-image");
      span.imagePath = this.path;
      const img = span.querySelector("img");
      if (img) {
        prepareEditorImage(img);
        const showError = () => {
          if (!span.querySelector(".image-error")) {
            const message = document.createElement("span");
            message.className = "image-error";
            message.textContent = this.path.startsWith("https://")
              ? "图片未加载 · 点击更换"
              : "图片无法读取 · 点击更换";
            span.append(message);
            span.title = this.path.startsWith("data:") ? "嵌入的图片" : this.path;
          }
        };
        img.addEventListener("error", showError, { once: true });
        if (img.complete && !img.naturalWidth) showError();
      }
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      span.setAttribute(
        "aria-label",
        "查看图片信息：" + (span.querySelector("img")?.alt || "图片"),
      );
      span.setAttribute("aria-haspopup", "dialog");
      span.setAttribute("aria-expanded", "false");
      span.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          span.click();
        }
      };
    }
    span.onmousedown = (e) => { if (e.button === 0) e.preventDefault(); };
    span.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.imageLength) {
        const link = span.closest("[data-link]");
        if (link && (e.ctrlKey || e.metaKey))
          window.openDocLink(link.dataset.link);
        else showImageDetails(view, span, this.imageLength, this.path);
        return;
      }
      const a = e.target.closest("a");
      if (a && (a.closest(".footnote-reference") || e.ctrlKey || e.metaKey)) {
        window.openDocLink(a.getAttribute("href"));
        return;
      }
      const pos = view.posAtDOM(span);
      view.dispatch({ selection: { anchor: pos + 1 } });
      view.focus();
    };
    return span;
  }
  ignoreEvent() {
    return true;
  }
  destroy(span) {
    if (this.imageLength) dismissImageDetails(span);
  }
}
export function showInlineObjects(state, objects, covered, ranges) {
  let block = 0;
  for (const i of objects) {
    while (block < covered.length && covered[block].end <= i.from) block++;
    if (covered[block]?.start <= i.from && covered[block].end >= i.to) continue;
    if (i.kind === "link" && i.path) {
      ranges.push(Decoration.mark({class:"md-link",attributes:{"data-resolved-link":i.path,"data-link":i.path,title:"单击打开链接 · Alt + 单击编辑"}}).range(i.from,i.to));
      continue;
    }
    if (
      !i.html ||
      (i.kind !== "note" &&
        i.kind !== "image" &&
        state.selection.ranges.some(
          (r) => r.empty && r.head > i.from && r.head < i.to,
        ))
    )
      continue;
    ranges.push(
      Decoration.replace({
        widget: new InlineObject(
          i.html,
          i.kind === "image" ? i.to - i.from : 0,
          i.path,
        ),
      }).range(i.from, i.to),
    );
  }
}
class InlineBreak extends WidgetType {
  toDOM() {
    return document.createElement("br");
  }
  ignoreEvent() {
    return false;
  }
}
const inlineBreak = Decoration.replace({ widget: new InlineBreak() });
export function decorateInlineTag(state, from, to, stacks, ranges, mask) {
  const raw = state.sliceDoc(from, to);
  if (/^<br\s*\/?>$/i.test(raw)) {
    mask(from, to, inlineBreak);
    return;
  }
  const tag = /^<(\/?)(mark|u|sub|sup)>$/i.exec(raw);
  if (!tag) return;
  const name = tag[2].toLowerCase();
  let stack = stacks.get(name);
  if (!tag[1]) {
    if (!stack) stacks.set(name, (stack = []));
    stack.push({ from, to });
  } else if (stack?.length) {
    const open = stack.pop();
    if (open.to < from)
      ranges.push(
        Decoration.mark({ class: "live-" + name }).range(open.to, from),
      );
    mask(open.from, open.to);
    mask(from, to);
  }
}
class ListMarker extends WidgetType {
  constructor(label, checked) {
    super();
    this.label = label;
    this.checked = checked;
  }
  eq(w) {
    return this.label === w.label && this.checked === w.checked;
  }
  updateDOM(el) {
    const input = el.querySelector("input");
    if (!input || this.checked == null) return false;
    input.checked = this.checked;
    return true;
  }
  toDOM(view) {
    const el = document.createElement("span");
    el.className = "live-list-marker";
    el.setAttribute("aria-hidden", "true");
    if (this.checked == null) {
      el.textContent = this.label;
      return el;
    }
    el.removeAttribute("aria-hidden");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.setAttribute("aria-label", "切换任务完成状态");
    el.append(input);
    input.onmousedown = (e) => { if (e.button === 0) e.preventDefault(); };
    input.onclick = (e) => {
      e.stopPropagation();
      const row = view.state.doc.lineAt(view.posAtDOM(el));
      const m = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([ xX])\]/.exec(row.text);
      if (!m) return;
      const pos = row.from + m[1].length;
      view.dispatch({
        changes: { from: pos, to: pos + 1, insert: m[2] === " " ? "x" : " " },
        userEvent: "input.task",
      });
    };
    return el;
  }
  ignoreEvent() {
    return this.checked != null;
  }
}
export function listItem(state, node, layout, counters) {
  const marker = node.getChild("ListMark");
  if (!marker) return;
  const doc = state.doc,
    first = doc.lineAt(marker.from),
    last = doc.lineAt(node.to);
  const after = first.text.slice(marker.to - first.from);
  const whitespace = after.match(/^[ \t]*/)[0].length;
  const indent = marker.to - first.from + whitespace;
  const list = node.parent;
  let depth = 1;
  for (let p = list.parent; p; p = p.parent) if (p.name === "ListItem") depth++;
  let label = depth === 1 ? "•" : depth % 2 === 0 ? "◦" : "▪";
  if (list.name === "OrderedList") {
    const start =
      counters.get(list.from) ??
      parseInt(state.sliceDoc(marker.from, marker.to), 10);
    counters.set(list.from, start + 1);
    label = String(start) + ".";
  }
  const task = after.slice(whitespace).match(/^\[([ xX])\](?:[ \t]+|$)/);
  for (let i = first.number; i <= last.number; i++)
    layout.set(i, {
      depth,
      indent,
      head: i === first.number,
      label,
      checked: task ? task[1] !== " " : null,
      full: indent + (task?.[0].length || 0),
    });
}
export function showList(state, layout, attrs, line, ranges, covered) {
  let block = 0;
  for (const [n, l] of layout) {
    const row = state.doc.line(n);
    while (block < covered.length && covered[block].end <= row.from) block++;
    if (covered[block]?.start <= row.from && row.to <= covered[block].end)
      continue;
    line(row.from, "live-list-row" + (l.head ? " live-list-head" : ""));
    attrs.set(row.from, { style: "--list-depth:" + l.depth });
    if (l.head) {
      ranges.push(
        Decoration.replace({
          widget: new ListMarker(l.label, l.checked),
        }).range(row.from, row.from + l.full),
      );
    } else {
      const len = Math.min(l.indent, row.text.match(/^[ \t]*/)[0].length);
      if (len)
        ranges.push(Decoration.replace({}).range(row.from, row.from + len));
    }
  }
}

class SoftBreak extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const space = document.createElement("span");
    space.textContent = " ";
    return space;
  }
  ignoreEvent() {
    return false;
  }
}
const joinedLine = Decoration.replace({ widget: new SoftBreak() });
// CommonMark soft breaks in the same quoted paragraph flow as spaces. Its hard breaks and blank
// lines keep their source boundaries, so both Markdown forms round-trip without rewriting the file.
export function flowQuoteParagraph(state, from, to, joined, ranges) {
  const start = state.doc.lineAt(from).number,
    end = state.doc.lineAt(to).number;
  for (let i = start + 1; i <= end; i++) {
    const prev = state.doc.line(i - 1),
      next = state.doc.line(i);
    if (
      / {2,}$/.test(prev.text) ||
      (prev.text.match(/\\+$/)?.[0].length || 0) % 2 === 1
    )
      continue;
    const prefix =
      next.text.match(/^(?:[ \t]*>[ \t]?)+[ \t]*/)?.[0].length || 0;
    joined.add(next.from);
    ranges.push(joinedLine.range(prev.to, next.from + prefix));
  }
}
