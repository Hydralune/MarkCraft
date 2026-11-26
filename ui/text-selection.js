import { syntaxTree } from "@codemirror/language";

const omit =
  "button,input,select,textarea,script,[aria-hidden=true],[role=toolbar],.cm-widgetBuffer,.live-list-marker,.code-toolbar,.inline-image,.writing-block-label,.table-grip";
function textNodes(root, accept) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.length && !n.parentElement.closest(omit)) accept(n);
  }
}
function append(highlight, n, a = 0, b = n.length) {
  if (b <= a) return;
  const range = document.createRange();
  range.setStart(n, a);
  range.setEnd(n, b);
  highlight.add(range);
}

// Match displayed cell glyphs to source positions, skipping destinations and
// inline markers. Only boundary cells need this map, even in a large table.
function cellGlyphs(view, td, bounds, visit) {
  const hidden = [];
  syntaxTree(view.state).iterate({
    from: bounds.from,
    to: bounds.to,
    enter(n) {
      if (
        [
          "EmphasisMark",
          "StrikethroughMark",
          "CodeMark",
          "LinkMark",
          "LinkTitle",
          "HTMLTag",
        ].includes(n.name) ||
        (n.name === "URL" && n.node.parent?.name === "Link")
      )
        hidden.push([n.from, n.to]);
    },
  });
  const source = view.state.sliceDoc(bounds.from, bounds.to),
    offsets = [];
  let visible = "",
    i = 0,
    mark = 0;
  while (i < source.length) {
    const p = bounds.from + i;
    while (mark < hidden.length && hidden[mark][1] <= p) mark++;
    if (mark < hidden.length && hidden[mark][0] <= p) {
      i = hidden[mark][1] - bounds.from;
      continue;
    }
    if (
      source[i] === "\\" &&
      /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(source[i + 1] || "")
    )
      i++;
    offsets.push(bounds.from + i);
    visible += source[i++];
  }
  let cursor = 0;
  textNodes(td, (n) => {
    let at = visible.indexOf(n.data, cursor);
    if (at < 0) at = cursor;
    visit(n, offsets.slice(at, at + n.length));
    cursor = at + n.length;
  });
}
export function cellPositionAt(view, td, bounds, x, y) {
  if (bounds?.from == null) return bounds?.line.to;
  const hit = document.caretRangeFromPoint(x, y);
  if (!hit || !td.contains(hit.startContainer)) return bounds.to;
  let position = bounds.from;
  cellGlyphs(view, td, bounds, (n, offsets) => {
    if (n !== hit.startContainer || !offsets.length) return;
    position =
      hit.startOffset === n.length
        ? offsets.at(-1) + 1
        : offsets[hit.startOffset];
  });
  return Math.max(bounds.from, Math.min(position ?? bounds.to, bounds.to));
}
export function paintSelection(view, blocks, tablePositions) {
  if (!CSS.highlights) return;
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  const paint = ranges.length > 0;
  view.scrollDOM.toggleAttribute("data-text-range", paint);
  if (!paint) {
    CSS.highlights.delete("markcraft-text");
    return;
  }
  const h = new Highlight();
  for (const sel of ranges) addTextRanges(view, blocks, tablePositions, sel, h);
  CSS.highlights.set("markcraft-text", h);
}
function addTextRanges(view, blocks, tablePositions, sel, h) {
  const dom = document.createRange();
  const a = view.domAtPos(sel.from),
    b = view.domAtPos(sel.to);
  dom.setStart(a.node, a.offset);
  dom.setEnd(b.node, b.offset);
  const layouts = new Map();
  for (const el of view.contentDOM.querySelectorAll(".cm-line,.rendered")) {
    if (el.closest(".editing-cell") || el.parentElement.closest(".rendered"))
      continue;
    if (el.matches(".rendered") && el.querySelector("table")) {
      const start = view.posAtDOM(el);
      const block = blocks.find((b) => b.start === start);
      if (!block || sel.from >= block.end || sel.to <= block.start) continue;
      if (sel.from <= block.start && sel.to >= block.end) {
        textNodes(el, (n) => append(h, n));
        continue;
      }
      for (const td of el.querySelectorAll("td,th")) {
        const bounds = tablePositions(view, block, td, layouts);
        if (
          bounds?.from == null ||
          sel.from >= bounds.to ||
          sel.to <= bounds.from
        )
          continue;
        if (sel.from <= bounds.from && sel.to >= bounds.to)
          textNodes(td, (n) => append(h, n));
        else
          cellGlyphs(view, td, bounds, (n, offsets) => {
            const from = offsets.findIndex((p) => p >= sel.from);
            const to = offsets.findIndex((p) => p >= sel.to);
            if (from >= 0) append(h, n, from, to < 0 ? offsets.length : to);
          });
      }
    } else if (dom.intersectsNode(el))
      textNodes(el, (n) => {
        if (dom.intersectsNode(n))
          append(
            h,
            n,
            n === dom.startContainer ? dom.startOffset : 0,
            n === dom.endContainer ? dom.endOffset : n.length,
          );
      });
  }
}
