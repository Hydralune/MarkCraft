import {
  inlineObjects,
  showInlineObjects,
  decorateInlineTag,
} from "./live-prose.js";
import {
  EditorState,
  EditorSelection,
  StateField,
  StateEffect,
} from "@codemirror/state";
import { EditorView, Decoration, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM, Superscript, Subscript } from "@lezer/markdown";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import {
  invertedEffects,
  isolateHistory,
  defaultKeymap,
  undo,
  redo,
  selectAll,
} from "@codemirror/commands";
import { tableEdge, moveInParent, dragTable } from "./table-reorder.js";
import { selectionAppearance } from "./pointer-selection.js";
import { inlineWebLinks, linkMark } from "./web-links.js";

export const tableInput = StateEffect.define({
  map: (start, changes) => changes.mapPos(start, -1),
});
const tableMove = StateEffect.define();
export const tableHistory = invertedEffects.of(tr => tr.effects.flatMap(e => {
  if (e.is(tableInput)) return [e];
  if (!e.is(tableMove)) return [];
  const {axis,from,to} = e.value;
  return [tableMove.of({axis,from:to,to:from})];
}));
let active = null;

function cells(line) {
  const parts = [];
  let begin = 0,
    slashes = 0;
  for (let i = 0; i <= line.length; i++) {
    const c = line[i];
    if (i === line.length || (c === "|" && slashes % 2 === 0)) {
      const value = line.slice(begin, i);
      parts.push({ from: begin, to: i, value: value.trim() });
      begin = i + 1;
    }
    slashes = c === "\\" ? slashes + 1 : 0;
  }
  if (/^\s*\|/.test(line)) parts.shift();
  if (/\|\s*$/.test(line) && parts.at(-1)?.value === "") parts.pop();
  return parts;
}
function escapePipes(text) {
  return text.replace(/(\\*)\|/g, (m, s) => (s.length % 2 ? m : s + "\\|"));
}
function tableLayout(view, el, block, table) {
  const index = Array.from(el.querySelectorAll("table")).indexOf(table);
  if (el.firstElementChild === table)
    return {
      index,
      first: view.state.doc.lineAt(block.start).number,
      prefixes: Array(table.rows.length + 1).fill(""),
    };
  // In lists and quotes, the container marker is outside the Markdown table.
  // Keep each line's own prefix, including the bullet on an initial header.
  const tables = [];
  const tree =
    ensureSyntaxTree(view.state, block.end, 80) || syntaxTree(view.state);
  tree.iterate({
    from: block.start,
    to: block.end,
    enter(n) {
      if (n.name === "Table") {
        tables.push(n.node);
        return false;
      }
    },
  });
  const node = tables[index];
  if (!node) return null;
  const first = view.state.doc.lineAt(node.from).number,
    prefixes = [];
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (!["TableHeader", "TableDelimiter", "TableRow"].includes(n.name))
      continue;
    const line = view.state.doc.lineAt(n.from);
    if (line.number !== first + prefixes.length) return null;
    prefixes.push(view.state.sliceDoc(line.from, n.from));
  }
  return prefixes.length === table.rows.length + 1
    ? { index, first, prefixes }
    : null;
}
function locate(view, layout, row, col) {
  const index = row === 0 ? 0 : row + 1;
  const line = view.state.doc.line(layout.first + index),
    prefix = layout.prefixes[index];
  const body = line.text.slice(prefix.length),
    cs = cells(body);
  const part = cs[col];
  if (!part) return { line, cs, part };
  const raw = body.slice(part.from, part.to);
  const pad = raw.length - raw.trimStart().length;
  return {
    line,
    cs,
    part,
    from: line.from + prefix.length + part.from + pad,
    to: line.from + prefix.length + part.from + pad + part.value.length,
  };
}
function change(view, start, from, to, insert) {
  if (view.state.sliceDoc(from, to) === insert) return;
  view.dispatch({
    changes: { from, to, insert },
    effects: tableInput.of(start),
    userEvent: "input.type",
  });
}
const setCellObjects = StateEffect.define();
const objectField = inlineObjects(setCellObjects);
function objectsInCell(block, from, to) {
  return (block?.inlines || [])
    .map((i) => ({
      ...i,
      from: block.start + i.from - from,
      to: block.start + i.to - from,
    }))
    .filter((i) => i.from >= 0 && i.to <= to - from);
}
export function refreshCellObjects(view, blocks) {
  const s = active;
  if (!s || s.view !== view) return;
  const block = blocks.find((b) => b.start === s.block.start);
  if (!block) return;
  s.block = block;
  const { from, to } = locate(view, s.layout, s.row, s.col);
  if (
    from == null ||
    view.state.sliceDoc(from, to) !== s.inner.state.doc.toString()
  )
    return;
  const inlines = objectsInCell(block, from, to);
  if (inlines.length || s.inner.state.field(objectField).length)
    s.inner.dispatch({ effects: setCellObjects.of([{ start: 0, inlines }]) });
}
function inlineDecorations(state) {
  const ranges = [],
    atomic = [];
  showInlineObjects(state, state.field(objectField), [], ranges);
  const tags = new Map();
  function mask(a, b, decoration = Decoration.replace({})) {
    if (b <= a) return;
    const d = decoration.range(a, b);
    ranges.push(d);
    atomic.push(d);
  }
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name === "HTMLTag")
        decorateInlineTag(state, n.from, n.to, tags, ranges, mask);
      const cls = {
        Superscript: "live-sup",
        Subscript: "live-sub",
        StrongEmphasis: "md-strong",
        Emphasis: "md-em",
        Strikethrough: "md-strike",
        InlineCode: "md-inlinecode",
        Link: "md-link",
      }[n.name];
      if (cls) ranges.push(Decoration.mark({ class: cls }).range(n.from, n.to));
      if (n.name === "Escape") mask(n.from, n.from + 1);
      if (
        [
          "EmphasisMark",
          "CodeMark",
          "StrikethroughMark",
          "SuperscriptMark",
          "SubscriptMark",
        ].includes(n.name)
      )
        mask(n.from, n.to);
      if (
        n.node.parent?.name === "Link" &&
        ["LinkMark", "URL", "LinkTitle"].includes(n.name)
      )
        mask(n.from, n.to);
      if (n.name === "Link") {
        const dest = n.node.getChild("URL");
        if (dest)
          ranges.push(
            Decoration.mark({
              attributes: { "data-link": state.sliceDoc(dest.from, dest.to), title: "单击打开链接 · Alt + 单击编辑" },
            }).range(n.from, n.to),
          );
      }
    },
  });
  for (const l of inlineWebLinks(state, state.doc.line(1)))
    ranges.push(linkMark(l.href).range(l.from, l.to));
  return {
    all: Decoration.set(ranges, true),
    atomic: Decoration.set(atomic, true),
  };
}
const cellAppearance = StateField.define({
  create: inlineDecorations,
  update(value, tr) {
    return tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setCellObjects))
      ? inlineDecorations(tr.state)
      : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.all),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});
export function updateActiveTable(el, html) {
  const session = active?.el === el ? active : null;
  if (!session && el.reorderedIndex == null) {
    // An alignment-only render can also arrive just after the user leaves a cell.
    const alignment = / style="text-align: (?:left|center|right)"/g;
    if (!el._tableHTML?.includes("<table") ||
        el._tableHTML.replace(alignment, "") !== html.replace(alignment, "")) return false;
    const template = document.createElement("template");
    template.innerHTML = html;
    const dest = el.querySelectorAll("td,th");
    template.content.querySelectorAll("td,th").forEach((cell, i) => {
      dest[i].style.textAlign = cell.style.textAlign;
    });
    return true;
  }
  // A quick Tab can move focus to the next cell before the render reply arrives.
  const tmp = document.createElement("template");
  tmp.innerHTML = html;
  const index = session?.layout.index ?? el.reorderedIndex;
  const table = el.querySelectorAll("table")[index];
  const parsed = tmp.content.querySelectorAll("table")[index];
  if (!table || !parsed || parsed.rows.length !== table.rows.length) return false;
  for (const row of parsed.rows) {
    const current = table.rows[row.rowIndex];
    if (current.cells.length !== row.cells.length) return false;
    for (const td of row.cells) {
      const dest = current.cells[td.cellIndex];
      if (dest.style.textAlign !== td.style.textAlign)
        dest.style.textAlign = td.style.textAlign;
      if (dest !== session?.td && dest.innerHTML !== td.innerHTML)
        dest.innerHTML = td.innerHTML;
    }
  }
  if (session) session.latest = html;
  delete el.reorderedIndex;
  return true;
}
export function destroyActiveTable(el) {
  if (active?.el === el) endCell(false);
}
function freezeWidth(table) {
  if (table.querySelector(":scope > colgroup[data-sizing]")) return;
  const widths = Array.from(
    table.rows[0].cells,
    (td) => td.getBoundingClientRect().width,
  );
  const total = widths.reduce((a, b) => a + b, 0);
  if (!total) return;
  const group = document.createElement("colgroup");
  group.dataset.sizing = "";
  for (const width of widths) {
    const col = document.createElement("col");
    col.style.width = (100 * width) / total + "%";
    group.append(col);
  }
  table.prepend(group);
  table.style.tableLayout = "fixed";
}
function endCell(paint = true, nextTable = null) {
  const s = active;
  if (!s) return;
  active = null;
  s.drag?.abort();
  s.reorder?.abort();
  s.inner.destroy();
  s.tools.remove();
  s.el.classList.remove("editing-table");
  s.td.classList.remove("editing-cell");
  if (s.table !== nextTable) {
    s.table.querySelector("colgroup[data-sizing]")?.remove();
    s.table.style.tableLayout = "";
  }
  if (paint && s.td.isConnected) {
    const tmp = document.createElement("template");
    tmp.innerHTML = s.latest;
    const rendered =
      tmp.content.querySelectorAll("table")[s.layout.index]?.rows[s.row]?.cells[
        s.col
      ];
    if (rendered && s.confirmed === s.value)
      s.td.innerHTML = rendered.innerHTML;
    else if (s.value === s.original) s.td.innerHTML = s.originalHTML;
    else s.td.textContent = s.value;
  }
}
export function leaveCell() {
  endCell();
}
function columnAlignment(marker = "") {
  if (!marker.endsWith(":")) return "left";
  return marker.startsWith(":") ? "center" : "right";
}
function delimiter(s) {
  const line = s.view.state.doc.line(s.layout.first + 1);
  const prefix = s.layout.prefixes[1].length;
  return { line, prefix, parts: cells(line.text.slice(prefix)) };
}
function updateAlignment(s, changedColumn) {
  const { parts } = delimiter(s);
  for (const row of s.table.rows) {
    const cells = changedColumn == null ? row.cells : [row.cells[changedColumn]];
    for (const cell of cells) {
      const marker = parts[cell.cellIndex]?.value || "";
      const align = marker.includes(":") ? columnAlignment(marker) : "";
      if (cell.style.textAlign !== align) cell.style.textAlign = align;
    }
  }
  const current = columnAlignment(parts[s.col]?.value);
  for (const button of s.tools.querySelectorAll(".align-tool"))
    button.setAttribute("aria-pressed", String(button.dataset.op === current));
  s.inner.requestMeasure();
}
function alignColumn(s, side) {
  const { line, prefix, parts } = delimiter(s);
  const part = parts[s.col];
  if (!part || (part.value.includes(":") && columnAlignment(part.value) === side)) return;
  const from = line.from + prefix + part.from +
    line.text.slice(prefix + part.from, prefix + part.to).indexOf(part.value);
  const dashes = part.value.replace(/:/g, "");
  const insert = (side !== "right" ? ":" : "") + dashes + (side !== "left" ? ":" : "");
  s.view.dispatch({
    changes: { from, to: from + part.value.length, insert },
    effects: tableInput.of(s.block.start),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
  });
  updateAlignment(s, s.col);
}
function toolbar(s) {
  const bar = document.createElement("div");
  bar.className = "table-tools";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "表格操作");
  const add = (title, op, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.dataset.op = op;
    bar.append(b);
    return b;
  };
  const side = columnAlignment(delimiter(s).parts[s.col]?.value);
  for (const [op, title] of [
    ["left", "左对齐"],
    ["center", "居中对齐"],
    ["right", "右对齐"],
  ]) {
    const b = add(title, op, "");
    b.className = "align-tool " + op;
    b.setAttribute("aria-pressed", String(side === op));
    b.innerHTML = "<i></i><i></i><i></i>";
  }
  bar.append(
    Object.assign(document.createElement("span"), { className: "table-rule" }),
  );
  for (const [axis, label] of [["moveRow", "移行"], ["moveCol", "移列"]]) {
    const row = axis === "moveRow";
    const handle = add(row ? "拖到目标行，或用上下键移动" : "拖到目标列，或用左右键移动", axis, label);
    handle.className = "move-tool";
    handle.disabled = row ? s.row === 0 || s.table.rows.length < 3 : s.table.rows[0].cells.length < 2;
    handle.onkeydown = event => {
      const keys = row ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      structure(s, axis, (row ? s.row : s.col) + (event.key === keys[0] ? -1 : 1));
    };
    handle.onpointerdown = e => dragTable(s, axis, e, dest => structure(s,axis,dest));
  }
  add("下方插入行", "row", "＋行");
  add("右侧插入列", "column", "＋列");
  add("删除当前行", "deleteRow", "删行").disabled = s.row === 0;
  add("删除当前列", "deleteCol", "删列").disabled =
    s.table.rows[0].cells.length === 1;
  bar.addEventListener("mousedown", (e) => { if (e.button === 0) e.preventDefault(); });
  bar.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const op = e.target.closest("button")?.dataset.op;
    if (op) structure(s, op);
  });
  return bar;
}
function moveSessionCells(s, {axis,from,to}) {
  const {table,view,layout,row,col} = s;
  const previousPart = locate(view,layout,row,col).part?.from;
  if (axis === "moveRow") moveInParent(table.rows[from],table.rows[to]);
  else {
    const cols=table.querySelector("colgroup[data-sizing]")?.children;
    if (cols) moveInParent(cols[from],cols[to]);
    for (const tr of table.rows) moveInParent(tr.cells[from],tr.cells[to]);
  }
  s.row=s.td.parentElement.rowIndex;
  s.col=s.td.cellIndex;
  s.el.reorderedIndex=layout.index;
  s.confirmed=null;
  return () => {
    s.remap(previousPart,layout.prefixes[row ? row+1 : 0].length);
    s.inner.requestMeasure();
  };
}
function structure(s, op, destination) {
  if (["left", "center", "right"].includes(op)) {
    alignColumn(s, op);
    return;
  }
  const { view, row, col, table, layout } = s;
  const prefixes = layout.prefixes.slice();
  const top = view.state.doc.line(layout.first),
    last = view.state.doc.line(top.number + table.rows.length);
  const lines = view.state
      .sliceDoc(top.from, last.to)
      .split("\n")
      .map((line, i) => line.slice(prefixes[i].length)),
    rowIndex = row ? row + 1 : 0;
  const count = table.rows[0].cells.length;
  const write = (parts) => "| " + parts.join(" | ") + " |";
  if (op === "moveRow") {
    if (!row || !Number.isInteger(destination) || destination < 1 || destination >= table.rows.length || destination === row) return;
    lines.splice(destination + 1, 0, lines.splice(rowIndex, 1)[0]);
  } else if (op === "row" || op === "rowAbove") {
    if (!row && op === "rowAbove") return;
    const i = Math.max(2, rowIndex + (op === "row" ? 1 : 0));
    lines.splice(i, 0, write(Array(count).fill("")));
    prefixes.splice(i, 0, prefixes[i - 1]);
  } else if (op === "deleteRow" && row > 0) {
    lines.splice(rowIndex, 1);
    prefixes.splice(rowIndex, 1);
  } else if (["column", "columnLeft", "deleteCol", "moveCol"].includes(op)) {
    if (op === "deleteCol" && count === 1) return;
    if (op === "moveCol" && (!Number.isInteger(destination) || destination < 0 || destination >= count || destination === col)) return;
    for (let i = 0; i < lines.length; i++) {
      const original = cells(lines[i]);
      const parts = original.map(c => op === "moveCol" ? lines[i].slice(c.from,c.to) : c.value);
      while (parts.length < count) parts.push("");
      if (op === "column" || op === "columnLeft") parts.splice(col + (op === "column" ? 1 : 0), 0, i === 1 ? "---" : "");
      else if (op === "moveCol") parts.splice(destination, 0, parts.splice(col, 1)[0]);
      else parts.splice(col, 1);
      lines[i] = op === "moveCol" && original.length
        ? lines[i].slice(0,original[0].from) + parts.join("|") + lines[i].slice(original.at(-1).to)
        : write(parts);
    }
  } else return;
  const move = op === "moveRow" || op === "moveCol" ?
    {axis:op,from:op === "moveRow" ? row : col,to:destination} : null;
  const finish = move && moveSessionCells(s,move);
  if (!move) endCell();
  view.dispatch({
    changes: {
      from: top.from,
      to: last.to,
      insert: lines.map((line, i) => prefixes[i] + line).join("\n"),
    },
    effects: move ? [tableInput.of(s.block.start),tableMove.of(move)] : [],
    annotations: isolateHistory.of("full"),
    userEvent: "input",
  });
  if (finish) {finish(); s.inner.focus();}
  else view.focus();
}
function moveCell(s, step) {
  const count = s.table.rows[0].cells.length,
    index = s.row * count + s.col + step;
  const dest =
    index < 0
      ? null
      : s.table.rows[Math.floor(index / count)]?.cells[index % count];
  if (!dest) {
    endCell();
    s.view.focus();
    return true;
  }
  beginCell(s.view, s.el, s.block, dest, undefined, s.layout);
  return true;
}
// Read the text hit before replacing the cell. The inner editor can wrap
// differently for a frame, especially in a right-aligned or zoomed column.
function cellHit(td, event) {
  if (!event) return null;
  const range = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!range || !td.contains(range.startContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(td);
  before.setEnd(range.startContainer, range.startOffset);
  return {
    offset: before.toString().length,
    text: td.textContent,
    atStart:
      range.startContainer.nodeType === Node.TEXT_NODE &&
      range.startOffset === 0,
  };
}
function positionAtHit(inner, hit) {
  if (!hit || inner.contentDOM.textContent !== hit.text) return null;
  const walker = document.createTreeWalker(
    inner.contentDOM,
    NodeFilter.SHOW_TEXT,
  );
  let offset = hit.offset;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (offset < n.length || (offset === n.length && !hit.atStart))
      return inner.posAtDOM(n, offset);
    offset -= n.length;
  }
  return null;
}
export function tablePositions(view, block, td, layouts) {
  const el=td.closest(".rendered"), table=td.closest("table");
  if(!el || !block || !table)return null;
  const layout=active?.table===table ? active.layout : (layouts?.get(table) ?? tableLayout(view,el,block,table));
  if (layout) layouts?.set(table,layout);
  if(!layout)return null;
  return locate(view,layout,td.parentElement.rowIndex,td.cellIndex);
}
export function cellAnchor(view, td, x, y) {
  const s=active;
  if(s?.td!==td) return null;
  const bounds=locate(view,s.layout,s.row,s.col);
  const at=s.inner.posAtCoords({x,y},false) ?? s.inner.state.selection.main.anchor;
  return bounds.from==null ? bounds.line.to : bounds.from + escapePipes(s.inner.state.sliceDoc(0,at)).length;
}
export function beginCell(view, el, block, td, event, existingLayout) {
  if (active?.td === td) return true;
  const hit = cellHit(td, event);
  const clickedImage = event?.target.closest("img");
  const imageIndex = clickedImage
    ? Array.from(td.querySelectorAll("img")).indexOf(clickedImage)
    : -1;
  const row = td.parentElement.rowIndex,
    col = td.cellIndex,
    table = td.closest("table");
  const layout = existingLayout || (active?.table === table ? active.layout : tableLayout(view, el, block, table));
  if (!layout) return false;
  endCell(true, table);
  if (!view.state.selection.main.empty)
    view.dispatch({ selection: { anchor: block.start } });
  const bounds = locate(view, layout, row, col),
    start = block.start;
  // The delimiter sits above all body rows. Keep offsets relative to this row
  // so changing its colons never redirects the next keystroke into another cell.
  let begin = bounds.from == null ? null : bounds.from - bounds.line.from;
  let end = bounds.to == null ? null : bounds.to - bounds.line.from;
  const original = bounds.part?.value ?? "";
const initialObjects = objectsInCell(block, bounds.from, bounds.to);
  const mathIndex = event?.target?.closest("math")
    ? [...td.querySelectorAll("math")].indexOf(event.target.closest("math"))
    : -1;
  const clickedMath = initialObjects.filter((i) => i.kind === "math")[
    mathIndex
  ];
  const s = {
    view,
    el,
    block,
    layout,
    td,
    row,
    col,
    table,
    original,
    originalHTML: td.innerHTML,
    value: original,
    confirmed: null,
    latest: el._tableHTML,
  };
  freezeWidth(table);
  td.classList.add("editing-cell");
  el.classList.add("editing-table");
  td.replaceChildren();
  s.tools = toolbar(s);
  el.append(s.tools);
  if (el.firstElementChild !== table) {
    s.tools.style.bottom = "auto";
    s.tools.style.top =
      table.getBoundingClientRect().top - el.getBoundingClientRect().top + "px";
    s.tools.style.transform = "translateY(-100%)";
  }
  s.remap = (previousPart, previousPrefix) => {
    const part = locate(view,layout,s.row,s.col).part;
    if (begin == null || previousPart == null || !part) return;
    const delta = part.from - previousPart + layout.prefixes[s.row ? s.row+1 : 0].length - previousPrefix;
    begin += delta; end += delta;
  };
  const writeBack = (value) => {
    const {row,col} = s;
    if (s.value === value) return;
    const encoded = escapePipes(value);
    s.value = value;
    const line = view.state.doc.line(layout.first + (row ? row + 1 : 0));
    if (begin == null) {
      const parts = cells(line.text.slice(layout.prefixes[row ? row + 1 : 0].length)).map(c => c.value);
      while (parts.length <= col) parts.push("");
      parts[col] = encoded;
      const prefix =
        "| " +
        parts
          .slice(0, col)
          .map((t) => t + " | ")
          .join("");
      change(
        view,
        start,
        line.from + layout.prefixes[row ? row + 1 : 0].length,
        line.to,
        "| " + parts.join(" | ") + " |",
      );
      begin = layout.prefixes[row ? row + 1 : 0].length + prefix.length;
    } else change(view, start, line.from + begin, line.from + end, encoded);
    end = begin + encoded.length;
  };
  // Cell text and column alignment share the document's undo stack.
  s.history = command => command({
    state: view.state,
    dispatch(tr) {
      const row=s.row;
      const line = view.state.doc.line(layout.first + (row ? row + 1 : 0));
      const separator = delimiter(s).line;
      let inside = begin != null, alignment = true;
      tr.changes.iterChangedRanges((a, b) => {
        inside &&= a >= line.from + begin && b <= line.from + end;
        alignment &&= a >= separator.from && b <= separator.to;
      });
      const recorded = tr.effects.find(e => e.is(tableMove))?.value;
      const siblings = recorded?.axis === "moveRow" ? s.table.rows : s.table.rows[0].cells;
      const move = recorded && siblings[recorded.from] && siblings[recorded.to] ? recorded : null;
      if (!tr.effects.some(e => e.is(tableInput) && e.value === start) || (!inside && !alignment && !move)) {
        endCell();
        view.dispatch(tr);
        view.focus();
        return;
      }
      const finish = move && moveSessionCells(s,move);
      const scroll = view.scrollSnapshot().map(tr.changes);
      view.dispatch(tr);
      view.dispatch({ effects: scroll });
      if (finish) finish();
      else if (alignment) updateAlignment(s);
      else {
        const nextLine = view.state.doc.line(line.number);
        const from = tr.changes.mapPos(line.from + begin, -1);
        const to = tr.changes.mapPos(line.from + end, 1);
        begin = from - nextLine.from;
        end = to - nextLine.from;
        const next = view.state.sliceDoc(from, to);
        const previous = s.inner.state.doc.toString();
        let first = 0, a = previous.length, b = next.length;
        while (first < a && first < b && previous[first] === next[first]) first++;
        while (a > first && b > first && previous[a - 1] === next[b - 1]) {a--; b--;}
        s.value = next;
        s.inner.dispatch({changes: {from: first, to: a, insert: next.slice(first, b)}});
      }
      s.inner.focus();
    }
  });
  s.inner = new EditorView({
    parent: td,
    state: EditorState.create({
      doc: original,
      extensions: [
        markdown({
          extensions: [GFM, Superscript, Subscript],
          addKeymap: false,
        }),
        objectField.init(() => initialObjects),
        cellAppearance,
        selectionAppearance,
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
        EditorView.lineWrapping,
        EditorState.transactionFilter.of((tr) => {
          if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
          return [
            tr,
            {
              changes: Array.from({ length: tr.newDoc.lines - 1 }, (_, i) => {
                const p = tr.newDoc.line(i + 1).to;
                return { from: p, to: p + 1, insert: "<br>" };
              }),
              sequential: true,
            },
          ];
        }),
        EditorView.contentAttributes.of({
          "aria-label": "单元格内容",
          spellcheck: "false",
        }),
        keymap.of([
          { key: "Tab", run: () => moveCell(s, 1) },
          { key: "Shift-Tab", run: () => moveCell(s, -1) },
          { key: "Enter", run: () => moveCell(s, table.rows[0].cells.length) },
          {
            key: "Escape",
            run: () => {
              writeBack(original);
              endCell();
              view.focus();
              return true;
            },
          },
          { key: "Mod-z", run: () => s.history(undo), preventDefault: true },
          { key: "Mod-y", run: () => s.history(redo), preventDefault: true },
          { key: "Mod-Shift-z", run: () => s.history(redo), preventDefault: true },
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && active === s) writeBack(u.state.doc.toString());
        }),
      ],
    }),
  });
  active = s;
  s.inner.dom.addEventListener("focusout", () =>
    queueMicrotask(() => {
      if (
        active === s &&
        !s.inner.dom.contains(document.activeElement) &&
        !s.tools.contains(document.activeElement) &&
        !document.activeElement?.closest(".image-details,.editor-context") &&
        !document.activeElement?.closest("#bar,#menu,#sourceToggle")
      )
        endCell();
    }),
  );
  s.inner.focus();
  let pos = clickedMath
    ? clickedMath.from + 1
    : event
      ? (positionAtHit(s.inner, hit) ??
        s.inner.posAtCoords({ x: event.clientX, y: event.clientY }, false))
      : null;
  if (pos == null) pos = s.inner.state.doc.length;
  s.inner.dispatch({ selection: EditorSelection.cursor(pos) });
  if (imageIndex >= 0)
    s.inner.contentDOM.querySelectorAll(".inline-image")[imageIndex]?.click();
  // The first pointer press targeted the rendered text that has just been replaced.
  // Carry that gesture into the editor. Subsequent gestures are native editor input.
  if (event?.type === "pointerdown" && event.pointerType === "mouse") {
    event.preventDefault();
    s.drag = new AbortController();
    const options = { signal: s.drag.signal };
    const id = event.pointerId;
    window.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerId !== id || !(e.buttons & 1)) return;
        const head = s.inner.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (head != null)
          s.inner.dispatch({ selection: { anchor: pos, head } });
      },
      options,
    );
    const stop = (e) => {
      if (e.pointerId === id) s.drag.abort();
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener("pointercancel", stop, options);
  }
  return true;
}
export function resumeCell(view, el, block, pos) {
  const line = view.state.doc.lineAt(pos);
  for (const table of el.querySelectorAll("table")) {
    const layout = tableLayout(view, el, block, table);
    if (!layout) continue;
    const i = line.number - layout.first;
    if (i < 0 || i >= layout.prefixes.length || i === 1) continue;
    const row = i === 0 ? 0 : i - 1;
    const offset = pos - line.from - layout.prefixes[i].length;
    const col = cells(line.text.slice(layout.prefixes[i].length)).findIndex(
      (c) => offset >= c.from && offset <= c.to,
    );
    const td = table.rows[row]?.cells[col];
    if (!td) continue;
    const bounds = locate(view, layout, row, col);
    if (!beginCell(view, el, block, td, undefined, layout)) continue;
    const cursor = Math.max(
      0,
      Math.min(active.inner.state.doc.length, pos - bounds.from),
    );
    active.inner.dispatch({ selection: { anchor: cursor } });
    return true;
  }
  return false;
}
export function acknowledgeTable(el, html) {
  el._tableHTML = html;
  if (active?.el === el) active.confirmed = active.value;
}
export function installTableEdges(el,view,lookup) {
  let previous;
  const clear=()=>{if(previous) delete previous.dataset.reorderEdge;previous=null;};
  el.addEventListener("pointermove",e=>{
    if(e.buttons) return;
    const td=e.target.closest("td,th"), edge=tableEdge(e,td);
    if(previous!==td || !edge) clear();
    if(edge) {td.dataset.reorderEdge=edge;previous=td;}
  });
  el.addEventListener("pointerleave",clear);
  el.addEventListener("pointerdown",e=>{
    if(e.button!==0 || e.shiftKey || e.ctrlKey || e.altKey) return;
    const td=e.target.closest("td,th"), edge=tableEdge(e,td);
    if(!edge) return;
    const block=lookup();
    if(block && beginCell(view,el,block,td)) {
      const session=active;
      e.stopImmediatePropagation();
      dragTable(session,edge,e,dest=>structure(session,edge,dest));
    }
  },true);
}
export function cellContext(view, block, td, event) {
  const el = td.closest(".rendered");
  if (!block || !el) return null;
  // Locate the click without activating the cell's links or images.
  if (!beginCell(view, el, block, td, event && {target:td, clientX:event.clientX, clientY:event.clientY})) return null;
  const s = active;
  return {
    editor: s.inner,
    row: s.row,
    columns: s.table.rows[0].cells.length,
    align: columnAlignment(delimiter(s).parts[s.col]?.value),
    run: op => { if (active === s) structure(s, op); },
    markdown: () => {
      const first = view.state.doc.line(s.layout.first);
      const last = view.state.doc.line(s.layout.first + s.table.rows.length);
      return view.state.sliceDoc(first.from, last.to).split("\n").map((line, i) =>
        line.slice(s.layout.prefixes[i].length)).join("\n");
    },
  };
}
export function cellCommand(cmd) {
  const s = active;
  if (!s) return false;
  if (cmd === "cut" || cmd === "copy") {
    s.inner.focus();
    document.execCommand(cmd);
    return true;
  }
  if (cmd === "paste") {
    s.inner.focus();
    navigator.clipboard
      .readText()
      .then((t) => {
        if (active === s) s.inner.dispatch(s.inner.state.replaceSelection(t));
      })
      .catch(() => {});
    return true;
  }
  if (cmd === "undo" || cmd === "redo" || cmd === "all") {
    s.inner.focus();
    if (cmd === "all") selectAll(s.inner);
    else s.history(cmd === "undo" ? undo : redo);
    return true;
  }
  const wraps = {
    bold: ["**", "**"],
    italic: ["*", "*"],
    underline: ["<u>", "</u>"],
    strike: ["~~", "~~"],
    code: ["\x60", "\x60"],
    link: ["[", "](https://)"],
  };
  if (wraps[cmd]) {
    s.inner.focus();
    const [l, r] = wraps[cmd],
      v = s.inner,
      a = v.state.selection.main,
      t = v.state.sliceDoc(a.from, a.to);
    const wrapped =
      a.from >= l.length &&
      v.state.sliceDoc(a.from - l.length, a.from) === l &&
      v.state.sliceDoc(a.to, a.to + r.length) === r;
    v.dispatch(
      wrapped
        ? {
            changes: {
              from: a.from - l.length,
              to: a.to + r.length,
              insert: t,
            },
            selection: { anchor: a.from - l.length, head: a.to - l.length },
          }
        : {
            changes: { from: a.from, to: a.to, insert: l + t + r },
            selection: { anchor: a.from + l.length, head: a.to + l.length },
          },
    );
    return true;
  }
  if (["source", "goto"].includes(cmd)) {
    const b = locate(s.view, s.layout, s.row, s.col),
      r = s.inner.state.selection.main;
    const translate = (n) =>
      b.from == null
        ? b.line.to
        : b.from + escapePipes(s.inner.state.sliceDoc(0, n)).length;
    const anchor = Math.min(b.line.to, translate(r.anchor)),
      head = Math.min(b.line.to, translate(r.head));
    endCell();
    s.view.dispatch({ selection: { anchor, head } });
    return false;
  }
  if (["find", "replace", "quick", "stats"].includes(cmd)) endCell();
  return false;
}
