import { ViewPlugin } from "@codemirror/view";

// Typeset equations can exceed the writing column. Text and tables wrap at full size.
export const fitEditorWidth = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.measure = {
        read: () => {
          const changes = [];
          for (const node of view.contentDOM.querySelectorAll("math")) {
            const host = node.parentElement.closest(
              ".cm-line, .formula-preview, .display-equation, th, td, li, p, .nested-content, .rendered",
            );
            if (!host) continue;
            const style = getComputedStyle(host);
            const limit =
              host.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight);
            const currentScale = Number(node.style.zoom) || 1;
            const width =
              node.getBoundingClientRect().width /
              (node.currentCSSZoom || currentScale);
            if (!(limit > 0 && width > 0)) continue;
            const paintedWidth = width * currentScale;
            // Math fonts round their advances at the fitted size. Keep an
            // already fitted run stable as the user scrolls through it.
            if (
              currentScale < 1 &&
              width > limit &&
              paintedWidth <= limit &&
              paintedWidth >= limit * 0.98
            )
              continue;
            const inset = Math.max(2, limit * 0.013);
            const scale =
              width > limit + 0.25
                ? Math.max(0.00001, (limit - inset) / width)
                : 1;
            const zoom = scale < 1 ? String(Number(scale.toFixed(5))) : "";
            if (node.style.zoom !== zoom) changes.push({ node, zoom });
          }
          return changes;
        },
        write(changes) {
          for (const { node, zoom } of changes) {
            node.style.zoom = zoom;
          }
          if (changes.length) view.requestMeasure();
        },
      };
      view.requestMeasure(this.measure);
    }
    update(update) {
      if (
        update.geometryChanged ||
        update.viewportChanged ||
        update.docChanged || update.transactions.some(tr => tr.effects.length)
      )
        update.view.requestMeasure(this.measure);
    }
  },
);
