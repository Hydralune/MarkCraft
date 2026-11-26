import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

// Keep the original top-level blocks. The rendering layer may subdivide a
// list or quotation to mount a nested table; it still moves as one paragraph.
export const setParagraphs = StateEffect.define();
export const toggleFold = StateEffect.define();
export const clearFolds = StateEffect.define();
export const paragraphs = StateField.define({
  create: () => [],
  update(blocks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setParagraphs)) {
        return effect.value.map((b) => {
          const line = tr.state.doc.lineAt(b.start);
          const start = /^\s*$/.test(tr.state.sliceDoc(line.from, b.start))
            ? line.from
            : b.start;
          return {
            start,
            end: b.end,
            level: b.level || 0,
            prose:
              !!b.level ||
              (/^<p>/.test(b.html) &&
                !/<img\b|class="display-equation|class="doc-toc/.test(b.html)),
          };
        });
      }
    }
    return tr.docChanged ? [] : blocks;
  },
});

export const folds = StateField.define({
  create: () => [],
  update(ranges, tr) {
    if (tr.docChanged) {
      ranges = ranges
        .filter((r) => !tr.changes.touchesRange(r.start, r.to))
        .map((r) => ({
          start: tr.changes.mapPos(r.start, 1),
          from: tr.changes.mapPos(r.from, 1),
          to: tr.changes.mapPos(r.to, -1),
        }));
    }
    for (const effect of tr.effects) {
      if (effect.is(clearFolds)) return [];
      if (effect.is(toggleFold)) {
        const r = effect.value;
        ranges = ranges.some((old) => old.start === r.start)
          ? ranges.filter((old) => old.start !== r.start)
          : [...ranges, r].sort((a, b) => a.start - b.start);
      }
    }
    if (tr.selection && ranges.length) {
      const head = tr.selection.main.head;
      if (ranges.some((r) => head > r.from && head < r.to))
        ranges = ranges.filter((r) => head <= r.from || head >= r.to);
    }
    return ranges;
  },
});

class FoldLabel extends WidgetType {
  constructor(range, section) {
    super();
    this.range = range;
    this.section = section;
  }
  eq(other) {
    return this.range === other.range && this.section === other.section;
  }
  toDOM(view) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "paragraph-folded";
    badge.textContent = this.section ? "⋯" : "⋯ 已折叠段落";
    badge.setAttribute("aria-label", this.section ? "展开章节" : "展开段落");
    badge.title = badge.getAttribute("aria-label");
    badge.onmousedown = (e) => e.preventDefault();
    badge.onclick = (e) => {
      e.stopPropagation();
      view.dispatch({ effects: toggleFold.of(this.range) });
    };
    return badge;
  }
}

export function foldDecorations(state, decorations, wrappers) {
  const ranges = state.field(folds);
  if (!ranges.length) return { decorations, wrappers };
  let end = -1;
  const outer = ranges.filter((r) => {
    if (r.start < end) return false;
    end = r.to;
    return true;
  });
  for (const r of outer) {
    const filter = (a, b) => a < r.from || a >= r.to || b > r.to;
    wrappers = wrappers.update({ filterFrom: r.from, filterTo: r.to, filter });
    decorations = decorations.update({
      filterFrom: r.from,
      filterTo: r.to,
      filter,
      add: [
        Decoration.replace({
          widget: new FoldLabel(r, r.start !== r.from),
          folded: true,
        }).range(r.from, r.to),
      ],
    });
  }
  return { decorations, wrappers };
}

export function visibleParagraphs(state) {
  const folded = new Map(state.field(folds).map((r) => [r.start, r]));
  const result = [];
  let end = -1;
  for (const b of state.field(paragraphs)) {
    if (b.start < end) continue;
    const fold = folded.get(b.start);
    end = fold?.to ?? b.end;
    result.push({ ...b, bound: end, fold });
  }
  return result;
}
export function foldRange(block, blocks) {
  if (block.fold) return block.fold;
  if (!block.level)
    return { start: block.start, from: block.start, to: block.end };
  let end = block.end;
  for (let i = blocks.indexOf(block) + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.level && b.level <= block.level) break;
    end = b.bound;
  }
  return end > block.end
    ? { start: block.start, from: block.end, to: end }
    : null;
}

export function editParagraphs(view, changes, anchor) {
  view.dispatch({
    changes,
    ...(anchor == null ? {} : { selection: { anchor } }),
    annotations: isolateHistory.of("full"),
    userEvent: "input.paragraph",
  });
}

export function removeParagraphs(view, rows, selected) {
  const changes = [];
  for (let i = 0; i < rows.length; i++) {
    if (!selected.has(rows[i].start)) continue;
    const first = i;
    while (i + 1 < rows.length && selected.has(rows[i + 1].start)) i++;
    const atEnd = i === rows.length - 1;
    changes.push({
      from: atEnd ? (rows[first - 1]?.bound ?? 0) : rows[first].start,
      to: atEnd ? view.state.doc.length : rows[i + 1].start,
    });
  }
  if (changes.length) editParagraphs(view, changes);
}

export function moveParagraph(view, rows, source, target) {
  if (source === target || source < 0 || target < 0 || target >= rows.length)
    return;
  const lo = Math.min(source, target),
    hi = Math.max(source, target);
  const order = rows.slice(lo, hi + 1);
  order.splice(target - lo, 0, order.splice(source - lo, 1)[0]);
  const text = order.map((b) => view.state.sliceDoc(b.start, b.bound));
  // Keep existing blank lines. New neighbours need a blank separator so
  // paragraphs, lists and indented code do not accidentally merge.
  let replacement = text[0];
  for (let i = lo; i < hi; i++) {
    const gap = view.state.sliceDoc(rows[i].bound, rows[i + 1].start);
    replacement += (gap.includes("\n\n") ? gap : "\n\n") + text[i - lo + 1];
  }
  editParagraphs(view, {
    from: rows[lo].start,
    to: rows[hi].bound,
    insert: replacement,
  });
}

export function formatParagraphs(view, chosen, kind) {
  if (!chosen.length || chosen.some((b) => !b.prose)) return;
  const changes = chosen
    .map((b) => {
      const raw = view.state.sliceDoc(b.start, b.end);
      let body = raw;
      if (b.level) {
        const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
        body = atx.test(raw)
          ? raw.replace(atx, "").replace(/[ \t]+#+[ \t]*$/, "")
          : raw.replace(/\n[ \t]*(?:=+|-+)[ \t]*$/, "");
      }
      let insert = body;
      if (kind === "task") insert = "- [ ] " + body.replace(/\n/g, "\n  ");
      else if (kind !== "p")
        insert =
          "#".repeat(Number(kind.slice(1))) +
          " " +
          body.replace(/\s*\n\s*/g, " ");
      return { from: b.start, to: b.end, insert };
    })
    .filter((c) => view.state.sliceDoc(c.from, c.to) !== c.insert);
  if (changes.length) editParagraphs(view, changes);
}
