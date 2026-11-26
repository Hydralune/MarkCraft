import { tableEdge } from "./table-reorder.js";
import { cellPositionAt, paintSelection } from "./text-selection.js";
import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection } from "@codemirror/view";

// Use the browser's glyph selection for a single range. CodeMirror supplies the
// wider caret, and paints separate ranges for multi-cursor editing.
export const selectionAppearance = [
  drawSelection({ drawRangeCursor: false }),
  EditorView.editorAttributes.compute(["selection"], (s) => ({
    class: s.selection.ranges.length === 1 ? "native-range" : "multi-range",
  })),
];

export const pointerSelection = (
  blocks,
  cellAnchor,
  tablePositions,
  leaveCell,
) =>
  ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.life = new AbortController();
        const capture = { capture: true, signal: this.life.signal };
        view.dom.addEventListener("mousedown", (e) => this.start(e), capture);
        view.dom.addEventListener(
          "pointerdown",
          (e) => {
            this.suppressClick = false;
            const td = e.target.closest("td,th");
            if (
              !td || tableEdge(e, td) ||
              !view.contentDOM.contains(td) ||
              e.pointerType !== "mouse" ||
              e.button !== 0 ||
              e.altKey ||
              e.shiftKey ||
              e.ctrlKey ||
              e.metaKey ||
              e.target.closest("button,[popover]")
            )
              return;
            // The cell editor is created during this press. While the pointer stays
            // in it, it owns its own text selection. Crossing its edge selects the document.
            this.track(e, null, td, td);
          },
          capture,
        );
        view.dom.addEventListener(
          "click",
          (e) => {
            if (this.suppressClick) {
              this.suppressClick = false;
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }
            const target = e.target.closest("[data-link],a[href]");
            if (
              !target ||
              !view.contentDOM.contains(target) ||
              target.closest(".code-toolbar,.table-tools") ||
              e.shiftKey ||
              e.altKey
            )
              return;
            if (e.target.closest(".inline-image") && !(e.ctrlKey || e.metaKey))
              return;
            e.preventDefault();
            e.stopImmediatePropagation();
            window.openDocLink(
              target.closest("[data-resolved-link]")?.dataset.resolvedLink ||
                target.dataset.link ||
                target.getAttribute("href"),
            );
          },
          capture,
        );
        view.dom.addEventListener(
          "dragstart",
          (e) => {
            if (e.target.closest("[data-link],a,.inline-object"))
              e.preventDefault();
          },
          capture,
        );
      }
      start(e) {
        const v = this.view;
        if (
          e.button !== 0 ||
          e.detail !== 1 ||
          e.shiftKey ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.sourceCapabilities?.firesTouchEvents ||
          !v.contentDOM.contains(e.target) ||
          e.target.closest(
            "input,button,textarea,select,.table-tools,.code-toolbar,.editing-cell,td,th,[popover]",
          )
        )
          return;
        const at = v.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (at == null) return;
        const widget = e.target.closest(
          ".rendered,.inline-object,[contenteditable=false],[data-link],a",
        );
        e.preventDefault();
        e.stopImmediatePropagation();
        this.track(e, at, widget, null);
      }
      track(e, at, widget, cell) {
        const v = this.view;
        this.stop();
        const gesture = new AbortController();
        this.gesture = gesture;
        const capture = { capture: true, signal: gesture.signal };
        const startX = e.clientX,
          startY = e.clientY;
        let x = startX,
          y = startY,
          dragging = false;
        const select = () => {
          const box = v.scrollDOM.getBoundingClientRect();
          const coords = {
            x: Math.min(box.right - 2, Math.max(box.left + 2, x)),
            y: Math.min(box.bottom - 2, Math.max(box.top + 2, y)),
          };
          let head = v.posAtCoords(coords, false);
          const td = document
            .elementFromPoint(coords.x, coords.y)
            ?.closest("td,th");
          if (td?.closest(".rendered") && v.contentDOM.contains(td)) {
            const start = v.posAtDOM(td.closest(".rendered"));
            const b = v.state.field(blocks).find((b) => b.start === start);
            const bounds = tablePositions(v, b, td);
            if (bounds?.from != null)
              head = cellPositionAt(v, td, bounds, coords.x, coords.y);
          }
          if (head == null) return;
          const sel = v.state.selection.main;
          if (sel.anchor !== at || sel.head !== head)
            v.dispatch({
              selection: EditorSelection.single(at, head),
              userEvent: "select.drag",
            });
        };
        const scroll = () => {
          this.frame = 0;
          if (!dragging) return;
          const box = v.scrollDOM.getBoundingClientRect(),
            band = 22;
          const speed =
            y > box.bottom - band
              ? Math.min(22, (y - box.bottom + band) * 0.45)
              : y < box.top + band
                ? -Math.min(22, (box.top + band - y) * 0.45)
                : 0;
          if (!speed) return;
          const before = v.scrollDOM.scrollTop;
          v.scrollDOM.scrollTop +=
            Math.sign(speed) * Math.max(1, Math.abs(speed));
          if (v.scrollDOM.scrollTop !== before) {
            select();
            this.frame = requestAnimationFrame(scroll);
          }
        };
        window.addEventListener(
          cell ? "pointermove" : "mousemove",
          (m) => {
            if (cell && e.pointerId !== m.pointerId) return;
            if (!(m.buttons & 1)) {
              this.stop();
              return;
            }
            if (cell && at == null) {
              at = cellAnchor(v, cell, startX, startY);
              if (at == null) return;
            }
            x = m.clientX;
            y = m.clientY;
            if (!dragging && Math.hypot(x - startX, y - startY) < 3) return;
            if (
              !dragging &&
              cell &&
              cell.contains(document.elementFromPoint(x, y))
            )
              return;
            if (!dragging) {
              dragging = true;
              if (cell) leaveCell();
              v.focus();
            }
            m.preventDefault();
            select();
            if (!this.frame) this.frame = requestAnimationFrame(scroll);
          },
          capture,
        );
        window.addEventListener(
          cell ? "pointerup" : "mouseup",
          (m) => {
            if (cell && e.pointerId !== m.pointerId) return;
            if (m.button !== 0) return;
            if (dragging) {
              x = m.clientX;
              y = m.clientY;
              select();
              this.suppressClick = true;
            } else if (!widget) {
              v.focus();
              v.dispatch({
                selection: { anchor: at },
                userEvent: "select.pointer",
              });
            }
            this.stop();
          },
          capture,
        );
        window.addEventListener("pointercancel", () => this.stop(), capture);
        window.addEventListener("blur", () => this.stop(), {signal:gesture.signal});
      }
      stop() {
        this.gesture?.abort();
        this.gesture = null;
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      }
      update(update) {
        if (update.docChanged) this.stop();
        if (
          !update.selectionSet &&
          !update.viewportChanged &&
          !update.docChanged &&
          !update.transactions.some((t) => t.effects.length)
        )
          return;
        const v = update.view;
        const hasRange = v.state.selection.ranges.some(r => !r.empty);
        if (!hasRange && !this.hadRange) return;
        this.hadRange = hasRange;
        v.requestMeasure({
          key: this,
          read: () => paintSelection(v, v.state.field(blocks), tablePositions),
        });
      }
      destroy() {
        CSS.highlights?.delete("markcraft-text");
        this.stop();
        this.life.abort();
      }
    },
  );
