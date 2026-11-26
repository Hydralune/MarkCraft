import { LanguagePicker } from "./code-language.js";
import { Decoration, WidgetType, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const delimiter = /^\$\$[ \t]*$/;
export const mathBlocks = {
  defineNodes: [{ name: "DisplayFormula", block: true }],
  parseBlock: [
    {
      name: "DisplayFormula",
      before: "FencedCode",
      parse(cx, line) {
        if (
          cx.parentType().name !== "Document" ||
          line.indent >= 4 ||
          !delimiter.test(line.text.slice(line.pos))
        )
          return false;
        const from = cx.lineStart + line.pos;
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (delimiter.test(line.text.trimStart())) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("DisplayFormula", from, end));
        return true;
      },
    },
  ],
};

const tokenCache = new Map();
function codeMarks(text, language) {
  const key = language + "\n" + text;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const marks = [];
  const html = window.highlightCode(text, language);
  if (html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT);
    let pos = 0;
    while (walk.nextNode()) {
      const n = walk.currentNode,
        end = pos + n.length;
      const span = n.parentElement?.closest("span[class]");
      if (span && pos < end)
        marks.push({ from: pos, to: end, cls: span.className });
      pos = end;
    }
  }
  if (tokenCache.size >= 48) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(key, marks);
  return marks;
}
function mathMarks(text, base, mark) {
  for (const m of text.matchAll(/\\(?:[a-zA-Z]+|.)|[{}_^&]|\d+(?:\.\d+)?/g)) {
    const cls =
      m[0][0] === "\\"
        ? "tex-command"
        : /^\d/.test(m[0])
          ? "hljs-number"
          : "tex-punctuation";
    mark(base + m.index, base + m.index + m[0].length, cls);
  }
}
class BlockLabel extends WidgetType {
  constructor(label) {
    super();
    this.label = label;
  }
  eq(other) {
    return this.label === other.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "writing-block-label";
    el.textContent = this.label;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}
class FormulaPreview extends WidgetType {
  constructor(html, status) {
    super();
    this.html = html;
    this.status = status;
  }
  eq(other) {
    return other.html === this.html && other.status === this.status;
  }
  toDOM(view) {
    const el = document.createElement("div");
    el.className = "formula-preview";
    this.paint(el, view);
    return el;
  }
  updateDOM(el, view) {
    this.paint(el, view);
    return true;
  }
  paint(el, view) {
    el.setAttribute("aria-label", "公式预览");
    // Retain the previous typeset result during the renderer's debounce.
    if (this.status === "pending" && el.querySelector("math")) return;
    if (this.html) el.innerHTML = this.html;
    else
      el.textContent =
        this.status === "empty"
          ? "输入 LaTeX 公式"
          : this.status === "invalid"
            ? "公式尚未完成，请检查命令和括号"
            : "正在排版…";
    el.dataset.state = this.status;
    view.requestMeasure({
      key: el,
      read() {
        if (!view.hasFocus || !view.state.selection.main.empty || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect(),
          port = view.scrollDOM.getBoundingClientRect(),
          caret = view.coordsAtPos(view.state.selection.main.head);
        if (!caret || caret.bottom < port.top || caret.top > port.bottom)
          return 0;
        return Math.max(
          0,
          Math.min(rect.bottom - port.bottom + 12, caret.top - port.top - 16),
        );
      },
      write(delta) {
        if (delta) view.scrollDOM.scrollTop += delta;
      },
    });
  }
  ignoreEvent() {
    return true;
  }
}
export function decorateBlock(state, ref, { raw, blocks, line, mark, ranges }) {
  const formula = ref.name === "DisplayFormula",
    fence = ref.name === "FencedCode";
  const first = state.doc.lineAt(ref.from),
    last = state.doc.lineAt(ref.to);
  const isClosed =
    last.number > first.number &&
    (formula
      ? delimiter.test(last.text.trimStart())
      : fence && ref.node.lastChild?.name === "CodeMark");
  if (
    !raw &&
    formula &&
    ref.node.parent?.name === "Document" &&
    state.selection.ranges.every((r) => r.to < first.from || r.from > first.to)
  ) {
    ranges.push(
      Decoration.replace({
        widget: new BlockLabel("LaTeX"),
      }).range(ref.from, first.to),
    );
  }
  const base = formula ? "formula" : "fence";
  for (let i = first.number; i <= last.number; i++) {
    const row = state.doc.line(i);
    line(
      row.from,
      "block-line " +
        base +
        "-line" +
        (i === first.number ? " block-start" : "") +
        (i === last.number ? " block-end" : ""),
    );
  }
  if (formula) {
    const from = Math.min(first.to + 1, ref.to),
      to = Math.max(from, isClosed ? last.from : ref.to);
    mathMarks(state.sliceDoc(from, to), from, mark);
    if (!raw && isClosed) {
      const current = blocks.find(
        (b) => b.start === ref.from && b.end === ref.to,
      );
      const html = current?.html.match(/<math\b[^]*?<\/math>/i)?.[0] || "";
      const status = html
        ? "ready"
        : !state.sliceDoc(from, to).trim()
          ? "empty"
          : current
            ? "invalid"
            : "pending";
      ranges.push(
        Decoration.widget({
          widget: new FormulaPreview(html, status),
          block: true,
          side: 1,
        }).range(last.to),
      );
    }
    return;
  }
  const info = ref.node.getChild("CodeInfo"),
    language = info ? state.sliceDoc(info.from, info.to).split(/\s+/)[0] : "";
  if (!raw && fence) {
    ranges.push(
      Decoration.replace({ widget: new LanguagePicker(language) }).range(
        ref.from,
        first.to,
      ),
    );
    if (isClosed) {
      const close = ref.node.lastChild;
      ranges.push(Decoration.replace({}).range(close.from, close.to));
    }
  }
  for (let child = ref.node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo" || child.name === "CodeMark") {
      mark(child.from, child.to, "block-marker");
      continue;
    }
    if (child.name !== "CodeText") continue;
    for (const span of codeMarks(
      state.sliceDoc(child.from, child.to),
      language,
    ))
      mark(child.from + span.from, child.from + span.to, span.cls);
  }
}

export function activeBlock(state) {
  let node = syntaxTree(state).resolveInner(state.selection.main.head, -1);
  while (node && !["FencedCode", "DisplayFormula"].includes(node.name))
    node = node.parent;
  return node;
}
export function insertWritingBlock(view, kind) {
  const { state } = view,
    sel = state.selection.main,
    body = state.sliceDoc(sel.from, sel.to);
  const left = state.sliceDoc(Math.max(0, sel.from - 2), sel.from);
  const right = state.sliceDoc(sel.to, Math.min(state.doc.length, sel.to + 2));
  const prefix =
    !left || left.endsWith("\n\n") ? "" : left.endsWith("\n") ? "\n" : "\n\n";
  const suffix = right.startsWith("\n\n")
    ? ""
    : right.startsWith("\n")
      ? "\n"
      : "\n\n";
  let fence = "$$";
  if (kind === "fence") {
    let size = 3;
    for (const m of body.matchAll(/^\s*(\x60{3,})/gm))
      size = Math.max(size, m[1].length + 1);
    fence = String.fromCharCode(96).repeat(size);
  }
  const start = sel.from + prefix.length + fence.length + 1;
  view.dispatch({
    changes: {
      from: sel.from,
      to: sel.to,
      insert: prefix + fence + "\n" + body + "\n" + fence + suffix,
    },
    selection: { anchor: start, head: start + body.length },
    effects: EditorView.scrollIntoView(start, { y: "center" }),
    userEvent: "input",
  });
  view.focus();
}
export function finishBlock(view) {
  const node = activeBlock(view.state);
  if (!node) return false;
  const { doc } = view.state,
    last = doc.lineAt(node.to),
    first = doc.lineAt(node.from);
  if (
    last.number === first.number ||
    !(node.name === "FencedCode"
      ? node.lastChild?.name === "CodeMark"
      : delimiter.test(last.text.trimStart()))
  )
    return false;
  if (last.number < doc.lines) {
    const pos = doc.line(last.number + 1).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos),
    });
  } else
    view.dispatch({
      changes: { from: last.to, insert: "\n\n" },
      selection: { anchor: last.to + 2 },
      scrollIntoView: true,
      userEvent: "input",
    });
  view.focus();
  return true;
}
