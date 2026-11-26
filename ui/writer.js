import { installEditorContext } from "./editor-context.js";
import { installParagraphTools } from "./paragraph-tools.js";
import { paragraphs, setParagraphs, folds, foldDecorations, toggleFold, clearFolds } from "./paragraph-document.js";
import { fitEditorWidth } from "./fit-width.js";
import {
  flowQuoteParagraph,
  decorateInlineTag,
  editableBlocks,
  inlineObjects,
  resetImageSizes,
  showInlineObjects,
  listItem,
  showList,
} from "./live-prose.js";
import {
  mathBlocks,
  decorateBlock,
  insertWritingBlock,
  finishBlock,
  activeBlock,
} from "./markdown-blocks.js";
import {
  beginCell,
  resumeCell,
  cellCommand,
  destroyActiveTable,
  leaveCell,
  tableInput,
  tableHistory,
  installTableEdges,
  acknowledgeTable,
  updateActiveTable,
  refreshCellObjects,
  cellAnchor,
  tablePositions,
} from "./table-editor.js";
import { findPanel, openFind, visibleMatch } from "./find-panel.js";
import { inlineWebLinks, linkMark } from "./web-links.js";
export { linkifyText } from "./web-links.js";
export { cellCommand };
export { imageFilePicked, collectedImageSource } from "./image-details.js";
import {
  EditorState,
  EditorSelection,
  Transaction,
  StateEffect,
  StateField,
  Prec,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  BlockWrapper,
  keymap,
  placeholder,
  highlightActiveLine,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  indentMore,
  indentLess,
  insertNewlineAndIndent,
  selectAll,
} from "@codemirror/commands";
import {
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { pointerSelection, selectionAppearance } from "./pointer-selection.js";
import { GFM, Superscript, Subscript } from "@lezer/markdown";
import { syntaxTree, bracketMatching } from "@codemirror/language";

const setBlocks = StateEffect.define(),
  setSource = StateEffect.define();
const inlineField = inlineObjects(setBlocks);
const rawField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const ef of tr.effects) if (ef.is(setSource)) value = ef.value;
    return value;
  },
});
const blockField = StateField.define({
  create: () => [],
  update(value, tr) {
    for (const ef of tr.effects) if (ef.is(setBlocks)) return ef.value;
    if (!tr.docChanged) return value;
const tableStart = tr.effects.find(e => e.is(tableInput))?.value;
    return value
      .filter(
        (b) =>
          b.start === tableStart || !tr.changes.touchesRange(b.start, b.end),
      )
      .map((b) => ({
        ...b,
        start: tr.changes.mapPos(b.start, b.start === tableStart ? -1 : 1),
        end: tr.changes.mapPos(b.end, b.start === tableStart ? 1 : -1),
      }));
  },
});
const intersects = (selection, a, b) =>
  selection.ranges.some((r) =>
    r.empty ? r.head >= a && r.head <= b : r.from < b && r.to > a,
  );
const activeNode = (s, a, b) =>
  s.selection.ranges.some((r) => r.empty && r.head >= a && r.head <= b);
class Rich extends WidgetType {
  constructor(html) {
    super();
    this.html = html;
  }
  eq(v) {
    return this.html === v.html;
  }
  toDOM(view) {
    const el = document.createElement("div");
    el.className = "rendered prose";
    el.innerHTML = this.html;
    acknowledgeTable(el, this.html);
    if (el.querySelector("table")) installTableEdges(el,view,() =>
      view.state.field(blockField).find(b => b.start === view.posAtDOM(el)));
    el.addEventListener("pointerdown", (e) => {
      if (
        e.target.closest(
          ".table-tools,.editing-cell .cm-editor,.footnote-reference,img",
        )
      )
        return;
      const cell = e.target.closest("td,th");
      if (
        cell &&
        e.button === 0 &&
        e.pointerType !== "touch" &&
        !e.shiftKey &&
        (!e.target.closest("a[href]") || e.altKey)
      ) {
        const pos = view.posAtDOM(el);
        const b = view.state.field(blockField).find((x) => x.start === pos);
        if (b) beginCell(view, el, b, cell, e);
        return;
      }
    });
    el.addEventListener("mousedown", (e) => {
      if (
        e.button === 0 &&
        !e.shiftKey &&
        !e.target.closest(".editing-cell .cm-editor,.table-tools")
      )
        e.preventDefault();
    });
    el.addEventListener("click", (e) => {
      if (e.target.closest(".table-tools,.editing-cell .cm-editor")) return;
      const anchor = e.target.closest("a");
      if (anchor) {
        e.preventDefault();
        if (
          e.ctrlKey ||
          e.metaKey ||
          anchor.closest(".doc-toc,.footnote-reference,.footnote-return")
        ) {
          window.openDocLink(anchor.getAttribute("href"));
          return;
        }
      }
      const pos = view.posAtDOM(el);
      const b = view.state
        .field(blockField)
        .find((x) => x.start === pos || (x.start <= pos && x.end >= pos));
      if (!b) return;
      const td = e.target.closest("td,th");
      if (td && beginCell(view, el, b, td, e.detail ? e : undefined)) return;
      const cb = e.target.closest("input[type=checkbox]");
      if (cb) {
        const i = [...el.querySelectorAll("input[type=checkbox]")].indexOf(cb);
        const p = b.start + b.tasks[i] + 1;
        view.dispatch({
          changes: {
            from: p,
            to: p + 1,
            insert:
              view.state.sliceDoc(p, p + 1).toLowerCase() === "x" ? " " : "x",
          },
        });
        return;
      }
      const raw = view.state.sliceDoc(b.start, b.end);
      const displayedMath = e.target.closest(
        ".display-equation,math[display=block]",
      );
      if (displayedMath && /^\s*\$\$[ \t]*\n/.test(raw)) {
        view.dispatch({
          selection: { anchor: b.start + raw.indexOf("\n") + 1 },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      let inside = 0;
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (
        range?.startContainer.nodeType === 3 &&
        el.contains(range.startContainer)
      ) {
        const code = range.startContainer.parentElement?.closest("pre code");
        if (code && el.contains(code)) {
          const upto = range.cloneRange();
          upto.selectNodeContents(code);
          upto.setEnd(range.startContainer, range.startOffset);
          const at = raw.indexOf(
            code.textContent.replace(/\n$/, ""),
            Math.max(0, raw.indexOf("\n") + 1),
          );
          if (at >= 0) {
            view.dispatch({
              selection: {
                anchor: Math.min(b.end, b.start + at + upto.toString().length),
              },
              scrollIntoView: true,
            });
            view.focus();
            return;
          }
        }
        const at = view.state
          .sliceDoc(b.start, b.end)
          .indexOf(range.startContainer.textContent);
        if (at >= 0) inside = at + range.startOffset;
      }
      view.dispatch({
        selection: { anchor: Math.min(b.end, b.start + inside) },
        scrollIntoView: true,
      });
      view.focus();
    });
    el.querySelectorAll("input[type=checkbox]").forEach((c) => {
      c.disabled = false;
    });
    queueMicrotask(async () => {
      if (el.isConnected) {
        await window.typesetBlocks(el);
        view.requestMeasure();
      }
    });
    return el;
  }
  updateDOM(el) {
    if (el._tableHTML !== this.html) {
      if (!updateActiveTable(el, this.html)) return false;
      acknowledgeTable(el, this.html);
    }
    return true;
  }
  destroy(el) {
    destroyActiveTable(el);
  }
  ignoreEvent() {
    return true;
  }
}
const marks = {
  Superscript: "live-sup",
  Subscript: "live-sub",
  StrongEmphasis: "md-strong",
  Emphasis: "md-em",
  InlineCode: "md-inlinecode",
  Strikethrough: "md-strike",
  Link: "md-link",
};
function decorations(s) {
  const raw = s.field(rawField);
  const ds = [],
    wraps = [],
    covered = [];
  const mark = (a, b, cls) => {
    if (b > a) ds.push(Decoration.mark({ class: cls }).range(a, b));
  };
  for (const block of raw ? [] : s.field(blockField)) {
    if (block.start >= block.end || block.end > s.doc.length) continue;
    const rich =
      /doc-toc|display-equation|<table[ >]|language-mermaid|footnote-definition|<hr(?: |>)/i.test(
        block.html,
      );
    if (!rich) continue;
    const table = block.html.includes("<table");
    if (
      !table &&
      s.selection.main.empty && intersects(s.selection, block.start, block.end) &&
      !(
        block.footnote &&
        s.selection.main.empty &&
        s.selection.main.head === block.start
      ) &&
      !(searchPanelOpen(s) && visibleMatch(s, block))
    )
      continue;
    covered.push(block);
    ds.push(
      Decoration.replace({
        widget: new Rich(block.html),
        table,
        block: true,
        inclusive: true,
      }).range(block.start, block.end),
    );
  }
  if (!raw) showInlineObjects(s, s.field(inlineField), covered, ds);
  const joinedQuotes = new Set(),
    listLayout = new Map(),
    attrs = new Map(),
    counters = new Map(),
    tags = new Map();
  let ci = 0;
  const lines = new Map();
  function line(pos, cls) {
    const l = s.doc.lineAt(pos).from;
    lines.set(l, (lines.get(l) || "") + " " + cls);
  }
  syntaxTree(s).iterate({
    enter(ref) {
      while (ci < covered.length && covered[ci].end <= ref.from) ci++;
      if (covered[ci]?.start <= ref.from && ref.to <= covered[ci].end)
        return false;
      const n = ref.name,
        a = ref.from,
        b = ref.to,
        parent = ref.node.parent;
      if (n === "Document") return;
      if (
        !raw &&
        (n === "Blockquote" || n === "FencedCode" || n === "CodeBlock")
      ) {
        const quote = n === "Blockquote";
        let listDepth = 0,
          quoteDepth = 0;
        for (let p = parent; p; p = p.parent) {
          if (p.name === "ListItem") listDepth++;
          if (p.name === "Blockquote") quoteDepth++;
        }
        const first = s.doc.lineAt(a).from;
        const wrapper = BlockWrapper.create({
          tagName: quote ? "blockquote" : "div",
          attributes: {
            class: quote ? "live-quote" : "live-code-block",
            style: "--block-inset:" + listDepth,
          },
          rank: quote ? Math.max(10, 90 - quoteDepth) : 1,
        });
        if (b > first) wraps.push(wrapper.range(first, b));
      }
      if (/^ATXHeading[1-6]$|^SetextHeading[12]$/.test(n))
        line(a, (raw ? "src-h" : "md-h") + n.slice(-1));
      if (["DisplayFormula", "FencedCode", "CodeBlock"].includes(n)) {
        decorateBlock(s, ref, {
          raw,
          blocks: s.field(blockField),
          line,
          mark,
          ranges: ds,
        });
        return false;
      }
      if (raw) {
        if (n === "ListItem" || n === "Blockquote") {
          for (let i = s.doc.lineAt(a).number; i <= s.doc.lineAt(b).number; i++)
            line(s.doc.line(i).from, "src-list");
        }
        const cls = {
          StrongEmphasis: "md-strong",
          Emphasis: "md-em",
          Strikethrough: "md-strike",
          InlineCode: "src-inline",
          URL: "md-link",
          Link: "md-link",
          LinkReference: "src-inline",
        }[n];
        if (cls) mark(a, b, cls);
        return;
      }
      if (n === "HardBreak") {
        const end = Math.min(b, s.doc.lineAt(a).to);
        if (end > a) ds.push(Decoration.replace({}).range(a, end));
        return false;
      }
      if (n === "Paragraph" && parent?.name === "Blockquote")
        flowQuoteParagraph(s, a, b, joinedQuotes, ds);
      if (n === "QuoteMark" && joinedQuotes.has(s.doc.lineAt(a).from))
        return false;
      if (n === "QuoteMark" && listLayout.get(s.doc.lineAt(a).number)?.head)
        return false;
      if (n === "QuoteMark") {
        line(a, "md-quote");
      }
      if (n === "ListItem") listItem(s, ref.node, listLayout, counters);
      if (n === "TaskMarker" || n === "ListMark") return false;
      if (n === "HTMLTag") {
        decorateInlineTag(
          s,
          a,
          b,
          tags,
          ds,
          (from, to, d = Decoration.replace({})) => ds.push(d.range(from, to)),
        );
      }
      if (marks[n]) mark(a, b, marks[n]);
      if (n === "Link" && parent) {
        const target = ref.node.getChild("URL");
        if (target)
          ds.push(
            Decoration.mark({
              attributes: { "data-link": s.sliceDoc(target.from, target.to), title: "单击打开链接 · Alt + 单击编辑" },
            }).range(a, b),
          );
      }
      if (!parent) return;
      const hide =
        n === "HeaderMark" || n === "QuoteMark"
          ? !s.selection.ranges.some((r) => r.empty && r.head > a && r.head < b)
          : n === "EmphasisMark" ||
              n === "CodeMark" ||
              n === "StrikethroughMark" ||
              n === "SuperscriptMark" ||
              n === "SubscriptMark" ||
              ((n === "LinkMark" || n === "URL" || n === "LinkTitle") &&
                parent.name === "Link")
            ? !s.selection.ranges.some(
                (r) => r.empty && r.head > a && r.head < b,
              )
            : false;
      if (hide && b > a) {
        let end = b;
        if (
          (n === "HeaderMark" || n === "QuoteMark") &&
          s.sliceDoc(b, b + 1) === " "
        )
          end++;
        ds.push(Decoration.replace({}).range(a, end));
        return false;
      }
      if (
        [
          "EmphasisMark",
          "CodeMark",
          "HeaderMark",
          "QuoteMark",
          "LinkMark",
          "StrikethroughMark",
        ].includes(n)
      )
        mark(a, b, "md-delimiter");
    },
  });
  if (!raw) showList(s, listLayout, attrs, line, ds, covered);
  let blockIndex = 0;
  for (let i = 1; i <= s.doc.lines; i++) {
    const line = s.doc.line(i);
    if (!raw && !line.length) lines.set(line.from, (lines.get(line.from) || "") + " md-blank-line");
    while (blockIndex < covered.length && covered[blockIndex].end <= line.from)
      blockIndex++;
    if (
      covered[blockIndex]?.start <= line.from ||
      !/(?:https?:\/\/|www\.)/i.test(line.text)
    )
      continue;
    for (const link of inlineWebLinks(s, line))
      ds.push(
        linkMark(link.href).range(line.from + link.from, line.from + link.to),
      );
  }
  const headingNums = new Map(
    s
      .field(blockField)
      .filter((b) => b.number)
      .map((b) => [b.start, b.number]),
  );
  const activeLine = s.doc.lineAt(s.selection.main.head).number;
  if (raw) {
    line(0, "src-numbered");
    line(s.doc.line(activeLine).from, "src-numbered");
    for (let i = 10; i <= s.doc.lines; i += 10)
      line(s.doc.line(i).from, "src-numbered");
  }
  for (const [a, cls] of lines) {
    const number = headingNums.get(a);
    ds.push(
      Decoration.line({
        class: cls.trim(),
        attributes: raw
          ? cls.includes("src-numbered")
            ? { "data-source-line": String(s.doc.lineAt(a).number) }
            : {}
          : number
            ? { "data-section": number }
            : attrs.get(a) || {},
      }).range(a),
    );
  }
  const {decorations, wrappers} = foldDecorations(s, Decoration.set(ds, true), BlockWrapper.set(wraps, true));
  return {
    decorations,
    wrappers,
    atomic: decorations.update({
      filter: (a, b, d) =>
        a < b && d.isReplace && (!d.spec.block || d.spec.table),
    }),
  };
}
const liveField = StateField.define({
  create: decorations,
  update(v, tr) {
    const rangeDrag = tr.isUserEvent("select.drag") ||
      (tr.selection && !tr.selection.main.empty && tr.isUserEvent("select.pointer"));
    if ((rangeDrag || (tr.selection && !tr.selection.main.empty)) && !tr.docChanged && !tr.effects.length && tr.state.field(folds) === tr.startState.field(folds)) return v;
    return tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      searchPanelOpen(tr.startState) !== searchPanelOpen(tr.state) ||
      tr.effects.some((e) => e.is(setBlocks) || e.is(setSource) || e.is(toggleFold) || e.is(clearFolds))
      ? decorations(tr.state)
      : v;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.blockWrappers.from(f, (v) => v.wrappers),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});
const phrases = {
  Find: "查找",
  Replace: "替换",
  next: "下一处",
  previous: "上一处",
  all: "全选",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "整词",
  replace: "替换",
  "replace all": "全部替换",
  "Go to line": "跳至行",
  go: "跳转",
  close: "关闭",
  "current match": "当前匹配",
  "replaced $ matches": "已替换 $ 处",
};
function pressEnter(view) {
  const s = view.state;
  if (s.field(rawField) || activeBlock(s)) return false;
  const r = s.selection.main,
    l = s.doc.lineAt(r.from);
  if (
    !l.text.trim() ||
    /^\s*(?:[-*+] |\d+[.)] |>|\||[\x60]{3}|~~~|\$\$)/.test(l.text)
  )
    return false;
  let node = syntaxTree(s).resolveInner(r.from, -1);
  while (node) {
    if (
      ["FencedCode", "CodeBlock", "Table", "ListItem", "Blockquote"].includes(
        node.name,
      )
    )
      return false;
    node = node.parent;
  }
  view.dispatch(s.replaceSelection("\n\n"), {
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}
export function createWriter(parent, onChange, onSelection, onShortcut, closeMenus, notify) {
  let view, closeContext, paragraphTools;
  const ext = [
    rawField,
    blockField,
    paragraphs,
    folds,
    inlineField,
    liveField,
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    fitEditorWidth,
    history(),
    tableHistory,
    selectionAppearance,
    pointerSelection(blockField, cellAnchor, tablePositions, leaveCell),
    dropCursor(),
    bracketMatching(),
    markdown({
      extensions: [GFM, Superscript, Subscript, mathBlocks],
      addKeymap: false,
    }),
    highlightActiveLine(),
    placeholder("开始写作…"),
    search({
      top: true,
      createPanel: (v) => findPanel(v, () => v.state.field(blockField)),
    }),
    EditorState.phrases.of(phrases),
    EditorView.contentAttributes.of({
      "aria-label": "Markdown 正文编辑区",
      spellcheck: "false",
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (v) => !v.state.field(rawField) && finishBlock(v),
        },
        {
          key: "Escape",
          run: (v) =>
            !v.state.field(rawField) &&
            !searchPanelOpen(v.state) &&
            finishBlock(v),
        },
        { key: "Enter", run: pressEnter },
        { key: "Shift-Enter", run: insertNewlineAndIndent },
        { key: "Mod-s", run: () => onShortcut("save") },
        { key: "Mod-Shift-s", run: () => onShortcut("saveAs") },
        { key: "Mod-b", run: () => onShortcut("bold") },
        { key: "Mod-i", run: () => onShortcut("italic") },
        { key: "Tab", run: indentMore },
        { key: "Shift-Tab", run: indentLess },
      ]),
    ),
    keymap.of([
      ...markdownKeymap,
      ...historyKeymap,
      ...searchKeymap.filter((k) => k.key !== "Mod-Alt-g"),
      ...defaultKeymap,
    ]),
    EditorView.domEventHandlers({
      click(e) {
        const a = e.target.closest("[data-link]");
        if (a) e.preventDefault();
        if (a && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          window.openDocLink(a.dataset.link);
          return true;
        }
        return false;
      },
    }),
    EditorView.updateListener.of((u) => {
      paragraphTools?.update(u);
      if (u.docChanged) {
        closeContext?.();
        onChange(u.state.doc.toString(), u);
      }
      if (u.selectionSet || u.docChanged)
        onSelection(u.state.selection.main.head);
    }),
  ];
  function reset(text, blocks) {
    paragraphTools?.reset();
    closeContext?.();
    leaveCell();
    resetImageSizes();
    const state = EditorState.create({
      doc: text,
      selection: { anchor: (/^#{1,6} +/.exec(text)?.[0] || "").length },
      extensions: ext,
    });
    if (view) {
      view.setState(state);
    } else {
      view = new EditorView({ state, parent });
      closeContext = installEditorContext(view, blockField, onShortcut, closeMenus, notify);
      paragraphTools = installParagraphTools(view, rawField, leaveCell, notify);
    }
    view.dispatch({
      effects: [setBlocks.of(editableBlocks(view.state, blocks)), setParagraphs.of(blocks)],
    });
    view.scrollDOM.scrollTop = 0;
    view.focus();
  }
  function select(a, b = a, align = "center") {
    view.dispatch({
      selection: { anchor: a, head: b },
      effects: EditorView.scrollIntoView(a, { y: align, yMargin: 8 }),
    });
    view.focus();
  }
  function replace(from, to, text, anchor = from + text.length, head = anchor) {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor, head },
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
  }
  function format(kind) {
    if (kind === "fence" || kind === "equation") {
      insertWritingBlock(view, kind);
      return;
    }
    const s = view.state,
      r = s.selection.main,
      l = s.doc.lineAt(r.from),
      t = s.sliceDoc(r.from, r.to);
    const pairs = {
      underline: ["<u>", "</u>"],
      highlight: ["<mark>", "</mark>"],
      sup: ["^", "^"],
      sub: ["~", "~"],
      bold: ["**", "**"],
      italic: ["*", "*"],
      strike: ["~~", "~~"],
      code: ["\x60", "\x60"],
      math: ["$", "$"],
      link: ["[", "](https://)"],
      image: ["![", "](<图片路径>)"],
      footnote: ["[^", "]"],
    };
    if (pairs[kind]) {
      const [a, b] = pairs[kind];
      if (
        [
          "bold",
          "italic",
          "strike",
          "code",
          "underline",
          "highlight",
          "sup",
          "sub",
        ].includes(kind) &&
        s.sliceDoc(Math.max(0, r.from - a.length), r.from) === a &&
        s.sliceDoc(r.to, r.to + b.length) === b
      ) {
        replace(
          r.from - a.length,
          r.to + b.length,
          t,
          r.from - a.length,
          r.to - a.length,
        );
        return;
      }
      replace(
        r.from,
        r.to,
        a + t + b,
        r.from + a.length,
        r.from + a.length + t.length,
      );
      return;
    }
    if (kind === "table" || kind === "rule" || kind === "diagram") {
      const template = {
        table: "| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |",
        rule: "---",
        diagram: "\x60\x60\x60mermaid\nflowchart LR\n  A --> B\n\x60\x60\x60",
      }[kind];
      let a = r.from > 0 ? "\n\n" : "";
      replace(r.from, r.to, a + template + "\n\n");
      return;
    }
    const prefix = /^h[1-6]$/.test(kind)
      ? "#".repeat(Number(kind[1])) + " "
      : {
          paragraph: "",
          bullet: "- ",
          number: "1. ",
          task: "- [ ] ",
          quote: "> ",
        }[kind];
    if (prefix !== undefined) {
      const end = s.doc.lineAt(r.to > r.from ? r.to - 1 : r.to);
      const lines = [];
      for (let i = l.number; i <= end.number; i++) {
        const line = s.doc.line(i);
        lines.push(
          (kind === "number" ? i - l.number + 1 + ". " : prefix) +
            line.text.replace(
              /^(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
              "",
            ),
        );
      }
      replace(l.from, end.to, lines.join("\n"));
      return;
    }
  }
  return {
    reset,
    get view() {
      return view;
    },
    setBlocks: (blocks) => {
      const editable = editableBlocks(view.state, blocks);
      view.dispatch({ effects: [setBlocks.of(editable), setParagraphs.of(blocks)] });
      refreshCellObjects(view, editable);
    },
    raw: (source) => {
      const r = view.state.selection.main;
      const table =
        !source &&
        r.empty &&
        view.state
          .field(blockField)
          .find(
            (b) =>
              b.start <= r.head && b.end >= r.head && b.html.includes("<table"),
          );
      if (table) {
        view.dispatch({
          effects: setSource.of(false),
          selection: { anchor: table.start },
        });
        const el = Array.from(
          view.contentDOM.querySelectorAll(".rendered"),
        ).find((e) => view.posAtDOM(e) === table.start);
        if (el && resumeCell(view, el, table, r.head)) return;
        view.dispatch({ selection: { anchor: r.head } });
      } else view.dispatch({ effects: [setSource.of(source), clearFolds.of(null)] });
      view.focus();
    },
    reload(text, blocks) {
      const before = view.state.doc.toString();
      if (before !== text) {
        let start=0, a=before.length, b=text.length;
        while(start<a && start<b && before[start]===text[start]) start++;
        while(a>start && b>start && before[a-1]===text[b-1]) {a--;b--;}
        // Keep positions outside the changed span attached to the same text.
        const map=p=>p<=start?p:p>=a?p+b-a:start+Math.min(p-start,b-start);
        const old=view.state.selection;
        const selection=EditorSelection.create(old.ranges.map(r=>EditorSelection.range(map(r.anchor),map(r.head))),old.mainIndex);
        const change=view.state.changes({from:start,to:a,insert:text.slice(start,b)});
        const snapshot=view.scrollSnapshot().map(change);
        leaveCell();
        view.dispatch({changes:change,selection,effects:snapshot,annotations:Transaction.addToHistory.of(false)});
      }
      view.dispatch({effects:[setBlocks.of(editableBlocks(view.state,blocks)),setParagraphs.of(blocks)]});
    },
    select,
    paragraphTools: (multiple) => paragraphTools.open(multiple),
    replace,
    format,
    undo: () => undo(view),
    redo: () => redo(view),
    search: (replace = false) => openFind(view, replace),
    all: () => selectAll(view),
    text: () => view.state.doc.toString(),
    selection: () => view.state.selection.main,
    focus: () => view.focus(),
  };
}
