import {
  visibleParagraphs,
  paragraphs,
  folds,
  foldRange,
  toggleFold,
  editParagraphs,
  removeParagraphs,
  moveParagraph,
  formatParagraphs,
} from "./paragraph-document.js";

function element(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}
function button(label, action, text = label) {
  const el = element("button", "", text);
  el.type = "button";
  el.title = label;
  el.setAttribute("aria-label", label);
  el.dataset.action = action;
  return el;
}
const formats = [
  ["正文", "p"],
  ...Array.from({ length: 6 }, (_, i) => [i + 1 + " 级标题", "h" + (i + 1)]),
];
const interactive =
  "input,textarea,select,button,a,[data-link],.editing-cell,.table-tools,.code-toolbar,.image-details,[popover]";

export function installParagraphTools(view, rawField, leaveCell, notify) {
  const host = view.dom.parentElement,
    layer = element("div", "paragraph-layer");
  const marks = element("div", "paragraph-marks");
  const handle = element("div", "paragraph-handle");
  const grip = button("段落操作 · 纵拖移动，横拖多选", "options", "");
  const arrow = button("折叠", "fold", "");
  grip.append(window.toolIcon("grip"));
  arrow.append(window.toolIcon("chevron"));
  handle.append(grip, arrow);
  const menu = element("div", "paragraph-menu");
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "段落操作");
  const dock = element("div", "paragraph-dock");
  dock.setAttribute("role", "toolbar");
  dock.setAttribute("aria-label", "段落多选操作");
  const counter = element("span", "paragraph-count");
  counter.setAttribute("aria-live", "polite");
  dock.append(counter);
  for (const [name, cmd] of [
    ["待办", "task"],
    ["格式", "format"],
    ["全选", "all"],
    ["复制", "copy"],
    ["剪切", "cut"],
    ["删除", "delete"],
    ["完成", "done"],
  ])
    dock.append(button(name, cmd));
  const drop = element("div", "paragraph-drop");
  const ghost = element("div", "paragraph-ghost");
  ghost.hidden = true;
  layer.append(marks, handle, drop, ghost, menu, dock);
  host.append(layer);
  menu.hidden = handle.hidden = drop.hidden = true;
  dock.inert = true;

  let rows = [],
    previousBlocks,
    previousFolds,
    active = null,
    menuAnchor = null;
  let multi = false,
    selected = new Set(),
    swipe = null,
    drag = null,
    ignoreClick = false,
    frame = 0;
  const markers = new Map();
  const byStart = new Map();
  function refresh() {
    const state = view.state,
      blocks = state.field(paragraphs),
      folded = state.field(folds);
    if (blocks !== previousBlocks || folded !== previousFolds) {
      rows = visibleParagraphs(state);
      byStart.clear();
      for (const row of rows) byStart.set(row.start, row);
      previousBlocks = blocks;
      previousFolds = folded;
    }
  }
  function current() {
    return byStart.get(active);
  }
  function chosen() {
    return multi
      ? rows.filter((b) => selected.has(b.start))
      : current()
        ? [current()]
        : [];
  }
  function closeMenu() {
    menu.hidden = true;
    menuAnchor = null;
    grip.setAttribute("aria-expanded", "false");
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(layout);
  }
  function geom() {
    const box = host.getBoundingClientRect(),
      port = view.scrollDOM.getBoundingClientRect();
    const content = view.contentDOM.getBoundingClientRect(),
      style = getComputedStyle(view.contentDOM);
    return {
      box,
      port,
      left: content.left + parseFloat(style.paddingLeft) - box.left,
      right: content.right - parseFloat(style.paddingRight) - box.left,
      base: view.documentTop - box.top,
    };
  }
  function bounds(b, g) {
    return {
      top: g.base + view.lineBlockAt(b.start).top,
      bottom: g.base + view.lineBlockAt(b.fold ? b.start : b.end).bottom,
    };
  }
  function firstLineRect(b) {
    if (b.start < view.viewport.from || b.start > view.viewport.to) return null;
    const {node, offset} = view.domAtPos(b.start, 1);
    const block = node.childNodes[offset];
    if (block?.matches?.(".rendered")) {
      const first = block.firstElementChild;
      if (first?.matches("table") && first.rows.length)
        return first.rows[0].getBoundingClientRect();
      const top = block.getBoundingClientRect().top;
      return {top, bottom: top + view.defaultLineHeight};
    }
    return view.coordsAtPos(b.start, 1);
  }
  function atY(y, target) {
    refresh();
    // Prefer the live DOM line for a pointer on text or a table. Images can
    // resize between frames while the editor is measuring its height map.
    const line = target?.closest(".rendered") || target?.closest(".cm-line");
    const mapped =
      line && view.contentDOM.contains(line) ? view.posAtDOM(line) : null;
    const estimate =
      mapped == null ? view.lineBlockAtHeight(y - view.documentTop) : null;
    const pos = mapped ?? estimate.from;
    const end = mapped ?? estimate.to;
    const hit = rows[firstAfter(end) - 1];
    return hit && hit.bound >= pos ? hit : null;
  }
  function firstAfter(pos) {
    let a = 0,
      b = rows.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (rows[mid].start <= pos) a = mid + 1;
      else b = mid;
    }
    return a;
  }
  function placeMenu(g) {
    const rect = menuAnchor.getBoundingClientRect(),
      box = g.box;
    const width = menu.offsetWidth,
      height = menu.offsetHeight;
    menu.style.left =
      Math.max(4, Math.min(box.width - width - 4, rect.left - box.left)) + "px";
    const below = rect.bottom - box.top + 4,
      above = rect.top - box.top - height - 4;
    menu.style.top =
      Math.max(
        4,
        Math.min(
          box.height - height - 4,
          menuAnchor.closest(".paragraph-dock") ||
            (below + height > box.height && above >= 4)
            ? above
            : below,
        ),
      ) + "px";
  }
  function layout() {
    frame = 0;
    refresh();
    const g = geom(),
      b = current();
    const min = g.port.top - g.box.top,
      max = g.port.bottom - g.box.top;
    let showHandle = false;
    if (!view.state.field(rawField) && !multi && b) {
      const { top, bottom } = bounds(b, g);
      const line = firstLineRect(b);
      const center = line ? (line.top + line.bottom) / 2 - g.box.top : top + view.defaultLineHeight / 2;
      if (Math.max(bottom, center) > min && Math.min(top, center) < max) {
        showHandle = true;
        handle.toggleAttribute("data-rotate", !handle.hidden && handle.dataset.start === String(b.start));
        handle.dataset.start = String(b.start);
        handle.style.left = Math.max(0, g.left - 49) + "px";
        handle.style.width = Math.min(45, Math.max(0, g.left - 4)) + "px";
        handle.style.top = Math.min(max - 12.5, Math.max(min + 12.5, center)) + "px";
        arrow.hidden = !foldRange(b, rows);
        const label = b.fold ? "展开" : "折叠";
        arrow.title = label + (b.level ? "章节" : "段落");
        arrow.setAttribute("aria-label", arrow.title);
        arrow.setAttribute("aria-expanded", String(!b.fold));
      }
    }
    handle.hidden = !showHandle;
    if (multi) {
      const visible = new Set();
      const { from, to } = view.viewport;
      for (let i = Math.max(0, firstAfter(from) - 1); i < rows.length; i++) {
        const row = rows[i];
        if (row.bound < from) continue;
        if (row.start > to) break;
        const { top, bottom } = bounds(row, g);
        if (bottom <= min || top >= max) continue;
        visible.add(row.start);
        let marker = markers.get(row.start);
        if (!marker) {
          marker = element("div", "paragraph-row");
          const tick = button("选择第 " + (i + 1) + " 段", "tick", "✓");
          tick.dataset.start = String(row.start);
          marker.append(tick);
          marks.append(marker);
          markers.set(row.start, marker);
        }
        marker.style.left = Math.max(0, g.left - 5) + "px";
        marker.style.right = Math.max(2, g.box.width - g.right - 24) + "px";
        marker.style.top = top + "px";
        marker.style.height = Math.max(16, bottom - top) + "px";
        const tick = marker.firstChild;
        tick.style.top =
          Math.max(
            0,
            (Math.min(bottom, max) - Math.max(top, min)) / 2 +
              Math.max(top, min) -
              top -
              10,
          ) + "px";
        marker.classList.toggle("picked", selected.has(row.start));
        tick.setAttribute("aria-pressed", String(selected.has(row.start)));
      }
      for (const [start, el] of markers)
        if (!visible.has(start)) {
          el.remove();
          markers.delete(start);
        }
    }
    if (!menu.hidden && menuAnchor) {
      if (menuAnchor === grip && handle.hidden) closeMenu();
      else placeMenu(g);
    }
    if (drag?.moving) updateDrop();
  }
  function syncDock() {
    counter.textContent = "已选 " + selected.size + " 段";
    const canFormat = chosen().every((b) => b.prose);
    for (const el of dock.querySelectorAll("button")) {
      const cmd = el.dataset.action;
      el.disabled =
        !["all", "done"].includes(cmd) &&
        (!selected.size || (["format", "task"].includes(cmd) && !canFormat));
    }
    dock.querySelector('[data-action="all"]').textContent =
      selected.size === rows.length && rows.length ? "取消全选" : "全选";
    schedule();
  }
  function enter(start) {
    if (view.state.field(rawField) || !rows.length) return;
    leaveCell();
    closeMenu();
    multi = true;
    selected = new Set(start == null ? [] : [start]);
    layer.classList.add("multi");
    dock.inert = false;
    dock.querySelector('[data-action="done"]').focus({ preventScroll: true });
    syncDock();
  }
  function finish(focus = true) {
    closeMenu();
    multi = false;
    selected.clear();
    layer.classList.remove("multi");
    dock.inert = true;
    for (const el of markers.values()) el.remove();
    markers.clear();
    if (focus) view.focus();
    schedule();
  }
  function toggle(start) {
    closeMenu();
    if (selected.has(start)) selected.delete(start);
    else selected.add(start);
    syncDock();
  }
  function showMenu(anchor, onlyFormat = false) {
    const items = chosen();
    if (!items.length) return;
    menu.replaceChildren();
    const grid = element("div", "paragraph-formats");
    for (const [label, cmd] of formats) {
      const el = button(label, cmd, cmd === "p" ? "正文" : cmd.toUpperCase());
      el.disabled = items.some((b) => !b.prose);
      el.setAttribute(
        "aria-pressed",
        String(
          items.every(
            (b) => b.level === (cmd === "p" ? 0 : Number(cmd.slice(1))),
          ),
        ),
      );
      grid.append(el);
    }
    menu.append(grid);
    if (!onlyFormat) {
      const b = current(),
        index = rows.indexOf(b);
      for (const [label, cmd] of [
        ["在下方新建", "new"],
        ["创建副本", "duplicate"],
        ["复制段落", "copy"],
        ["上移", "up"],
        ["下移", "down"],
        [b.fold ? "展开" : "折叠", "fold"],
        ["多选段落", "multi"],
        ["删除段落", "delete"],
      ]) {
        const el = button(label, cmd);
        el.disabled =
          (cmd === "up" && index === 0) ||
          (cmd === "down" && index === rows.length - 1) ||
          (cmd === "fold" && !foldRange(b, rows));
        menu.append(el);
      }
    }
    menuAnchor = anchor;
    menu.hidden = false;
    grip.setAttribute("aria-expanded", "true");
    placeMenu(geom());
    menu.querySelector("button:enabled")?.focus({ preventScroll: true });
  }
  async function run(cmd, control) {
    refresh();
    if (cmd === "done") {
      finish();
      return;
    }
    if (cmd === "tick") {
      toggle(Number(control.dataset.start));
      return;
    }
    if (cmd === "all") {
      selected =
        selected.size === rows.length
          ? new Set()
          : new Set(rows.map((b) => b.start));
      syncDock();
      return;
    }
    const items = chosen(),
      first = items[0];
    if (cmd === "multi") {
      enter(active);
      return;
    }
    if (!first) return;
    if (cmd === "options" || cmd === "format") {
      if (!menu.hidden && menuAnchor === control) closeMenu();
      else showMenu(control, cmd === "format");
      return;
    }
    closeMenu();
    const s = view.state;
    if (cmd === "fold") {
      const r = foldRange(first, rows);
      if (r)
        view.dispatch({
          effects: toggleFold.of(r),
          selection: { anchor: first.start },
        });
    } else if (cmd === "copy" || cmd === "cut") {
      const text =
        items.length === rows.length
          ? s.doc.toString()
          : items
              .map((b, i) => {
                const previous = items[i - 1];
                const gap = previous ? s.sliceDoc(previous.bound, b.start) : "";
                return (
                  (gap.trim() ? "\n\n" : gap) + s.sliceDoc(b.start, b.bound)
                );
              })
              .join("");
      const stamp = s.doc,
        ticket = items.map((b) => b.start).join(",");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        notify("未能写入剪贴板");
        return;
      }
      if (cmd === "cut") {
        if (
          view.state.doc !== stamp ||
          ticket !==
            chosen()
              .map((b) => b.start)
              .join(",")
        )
          return;
        removeParagraphs(view, rows, new Set(items.map((b) => b.start)));
      } else notify("已复制 " + items.length + " 段");
    } else if (cmd === "delete")
      removeParagraphs(view, rows, new Set(items.map((b) => b.start)));
    else if (cmd === "new" || cmd === "duplicate") {
      const value = cmd === "new" ? "" : s.sliceDoc(first.start, first.bound);
      // A following block can start on the very next line. Leave a real
      // blank paragraph for the caret even in that case.
      const suffix =
        cmd === "new" &&
        first.bound < s.doc.length &&
        !s.sliceDoc(first.bound, first.bound + 2).startsWith("\n\n")
          ? "\n"
          : "";
      editParagraphs(
        view,
        { from: first.bound, insert: "\n\n" + value + suffix },
        first.bound + 2,
      );
    } else if (cmd === "up" || cmd === "down") {
      const i = rows.indexOf(first);
      moveParagraph(view, rows, i, i + (cmd === "up" ? -1 : 1));
    } else formatParagraphs(view, items, cmd);
    if (multi && cmd !== "copy") finish();
    else if (!multi) view.focus();
    schedule();
  }
  layer.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el && !el.disabled) {
      if (el === grip && ignoreClick) {
        ignoreClick = false;
        return;
      }
      run(el.dataset.action, el);
    }
  });
  function updateDrop() {
    const hit = atY(drag.y);
    if (!hit) return;
    const index = rows.indexOf(hit),
      source = rows.findIndex((b) => b.start === drag.start),
      g = geom(),
      { top, bottom } = bounds(hit, g);
    const after = drag.y - g.box.top > (top + bottom) / 2;
    const slot = index + (after ? 1 : 0);
    drag.target = slot > source ? slot - 1 : slot;
    drop.hidden = drag.target === source;
    drop.style.left = g.left + "px";
    drop.style.width = g.right - g.left + "px";
    drop.style.top = (after ? bottom : top) + "px";
  }
  function endDrag() {
    if (drag?.autoscroll) cancelAnimationFrame(drag.autoscroll);
    drag = null;
    drop.hidden = ghost.hidden = true;
    grip.classList.remove("dragging");
  }
  function autoScroll() {
    if (!drag?.moving) return;
    const rect = view.scrollDOM.getBoundingClientRect();
    const delta =
      drag.y > rect.bottom - 30 ? 12 : drag.y < rect.top + 30 ? -12 : 0;
    if (delta) {
      view.scrollDOM.scrollTop += delta;
      updateDrop();
    }
    drag.autoscroll = requestAnimationFrame(autoScroll);
  }
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    ignoreClick = false;
    drag = {
      id: e.pointerId,
      start: active,
      x: e.clientX,
      y: e.clientY,
      initialY: e.clientY,
    };
    grip.setPointerCapture(e.pointerId);
  };
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      drag.y = e.clientY;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.initialY;
      if (
        !drag.moving &&
        Math.abs(dx) > 22 &&
        Math.abs(dx) > Math.abs(dy) * 1.4
      ) {
        const start = drag.start;
        ignoreClick = true;
        endDrag();
        enter(start);
        return;
      }
      if (!drag.moving && Math.abs(dy) > 7 && Math.abs(dy) > Math.abs(dx)) {
        drag.moving = true;
        ignoreClick = true;
        closeMenu();
        grip.classList.add("dragging");
        const b = current();
        ghost.textContent = b
          ? view.state
              .sliceDoc(b.start, Math.min(b.end, b.start + 48))
              .split("\n")[0]
          : "";
        ghost.hidden = false;
        autoScroll();
      }
      if (drag.moving) {
        const rect = host.getBoundingClientRect();
        ghost.style.transform =
          "translate(" +
          Math.max(
            4,
            Math.min(
              rect.width - ghost.offsetWidth - 4,
              e.clientX - rect.left + 12,
            ),
          ) +
          "px," +
          Math.max(
            0,
            Math.min(
              rect.height - ghost.offsetHeight,
              e.clientY - rect.top + 10,
            ),
          ) +
          "px)";
        updateDrop();
      }
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moving)
        moveParagraph(
          view,
          rows,
          rows.findIndex((b) => b.start === drag.start),
          drag.target ?? -1,
        );
      endDrag();
    },
    true,
  );
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("blur", endDrag);
  host.addEventListener(
    "pointermove",
    (e) => {
      if (swipe && swipe.id === e.pointerId) {
        const dx = Math.abs(e.clientX - swipe.x),
          dy = Math.abs(e.clientY - swipe.y);
        if (dy > 10 && dy >= dx) {
          swipe = null;
          return;
        }
        if (!multi && dx >= 36 && dx > dy * 1.6) {
          const start = swipe.start;
          swipe = null;
          enter(start);
          return;
        }
        if (dx > 12 || dy > 10) swipe.tap = false;
      }
      if (
        e.pointerType !== "mouse" ||
        e.buttons ||
        multi ||
        drag ||
        !menu.hidden ||
        layer.contains(e.target)
      )
        return;
      const next = atY(e.clientY, e.target)?.start ?? null;
      if (next !== active) {
        active = next;
        schedule();
      }
    },
    true,
  );
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  host.addEventListener(
    "pointerdown",
    (e) => {
      if (
        layer.contains(e.target) ||
        !view.scrollDOM.contains(e.target) ||
        view.state.field(rawField) ||
        e.button !== 0
      )
        return;
      closeMenu();
      if (!e.isPrimary) {
        swipe = null;
        return;
      }
      const box = geom();
      if (e.clientX >= box.port.left + view.scrollDOM.clientWidth) return;
      const b = atY(e.clientY, e.target);
      active = b?.start ?? null;
      schedule();
      const inMargin =
        e.clientX < box.box.left + box.left ||
        e.clientX > box.box.left + box.right;
      if (
        multi ||
        (b &&
          (e.pointerType === "touch" || inMargin) &&
          !e.target.closest(interactive))
      ) {
        swipe = {
          id: e.pointerId,
          start: active,
          x: e.clientX,
          y: e.clientY,
          tap: true,
        };
        if (multi || (inMargin && e.pointerType === "mouse")) stop(e);
      }
    },
    true,
  );
  host.addEventListener(
    "pointerup",
    (e) => {
      if (
        multi &&
        !layer.contains(e.target) &&
        view.scrollDOM.contains(e.target)
      ) {
        if (swipe?.id === e.pointerId && swipe.tap && swipe.start != null)
          toggle(swipe.start);
        stop(e);
      }
      swipe = null;
    },
    true,
  );
  host.addEventListener(
    "pointercancel",
    () => {
      swipe = null;
    },
    true,
  );
  for (const type of ["mousedown", "click", "contextmenu", "beforeinput"])
    host.addEventListener(
      type,
      (e) => {
        if (multi && view.scrollDOM.contains(e.target)) stop(e);
      },
      true,
    );
  host.addEventListener("pointerleave", () => {
    if (!multi && !drag && menu.hidden) {
      active = null;
      schedule();
    }
  });
  view.scrollDOM.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(host);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!layer.contains(e.target) && !view.scrollDOM.contains(e.target)) {
        if (multi) finish(false);
        else closeMenu();
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && (multi || !menu.hidden || drag)) {
        stop(e);
        endDrag();
        if (!menu.hidden) {
          closeMenu();
          (multi ? dock.querySelector('[data-action="format"]') : grip).focus({
            preventScroll: true,
          });
        } else finish();
        return;
      }
      if (!multi || !host.contains(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const cmd =
        mod && !e.shiftKey && /^[0-6]$/.test(e.key)
          ? e.key === "0"
            ? "p"
            : "h" + e.key
          : mod
            ? { a: "all", c: "copy", x: "cut" }[e.key.toLowerCase()]
            : e.key === "Delete"
              ? "delete"
              : null;
      if (cmd) {
        stop(e);
        run(cmd);
      }
    },
    true,
  );
  return {
    open(multiple = false) {
      refresh();
      if (!rows.length || view.state.field(rawField)) return;
      const pos = view.state.selection.main.head;
      active = (
        rows.find((b) => b.start <= pos && b.bound >= pos) ||
        rows.find((b) => b.start >= pos) ||
        rows.at(-1)
      ).start;
      if (multiple) enter(active);
      else {
        layout();
        if (handle.hidden) {
          view.dispatch({
            selection: { anchor: active },
            scrollIntoView: true,
          });
          requestAnimationFrame(() => {
            layout();
            showMenu(grip);
          });
        } else showMenu(grip);
      }
    },
    reset() {
      endDrag();
      swipe = null;
      active = null;
      finish(false);
    },
    update(u) {
      if (
        u.docChanged ||
        u.state.field(rawField) !== u.startState.field(rawField)
      ) {
        this.reset();
      }
      if (
        u.geometryChanged ||
        u.viewportChanged ||
        u.docChanged ||
        u.transactions.some((t) => t.effects.length)
      )
        schedule();
    },
  };
}
