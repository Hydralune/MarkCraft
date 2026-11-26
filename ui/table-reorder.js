// A header's top edge moves a column; the leading edge of a body row moves the row.
export function tableEdge(event, td) {
  if (!td || event.pointerType === "touch") return null;
  const box = td.getBoundingClientRect();
  if (
    td.parentElement.rowIndex === 0 &&
    event.clientY - box.top < 8 &&
    td.parentElement.cells.length > 1
  )
    return "moveCol";
  if (
    td.parentElement.rowIndex > 0 &&
    td.cellIndex === 0 &&
    event.clientX - box.left < 8 &&
    td.closest("table").rows.length > 2
  )
    return "moveRow";
  return null;
}

export function moveInParent(node, target) {
  const parent = node.parentElement;
  const before =
    node.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
      ? target.nextElementSibling
      : target;
  if (parent.moveBefore) parent.moveBefore(node, before);
  else parent.insertBefore(node, before);
}

export function dragTable(s, axis, down, commit) {
  if (down.button !== 0) return;
  down.preventDefault();
  down.stopPropagation();
  s.reorder?.abort();
  const life = (s.reorder = new AbortController());
  const row = axis === "moveRow",
    origin = row ? s.row : s.col;
  const table = s.table,
    rect = table.getBoundingClientRect();
  const cells = row
    ? [...table.rows[origin].cells]
    : [...table.rows].map((r) => r.cells[origin]);
  const first = cells[0].getBoundingClientRect();
  const viewport = s.view.scrollDOM.getBoundingClientRect();
  const options = { capture: true, signal: life.signal };
  let preview, guide, destination;
  function start() {
    preview = document.createElement("div");
    preview.className = "table-drag-preview";
    preview.setAttribute("aria-hidden", "true");
    // A long table only needs a preview of the visible portion of its column.
    const top = row ? first.top : Math.max(rect.top, viewport.top);
    const bottom = row ? first.bottom : Math.min(rect.bottom, viewport.bottom);
    Object.assign(preview.style, {
      left: (row ? rect.left : first.left) + "px",
      top: top + "px",
      width: (row ? rect.width : first.width) + "px",
      height: Math.max(0, bottom - top) + "px",
    });
    for (const td of cells) {
      const b = td.getBoundingClientRect();
      if (b.bottom <= top || b.top >= bottom) continue;
      const tile = document.createElement("div"),
        cs = getComputedStyle(td);
      tile.className = "drag-cell";
      Object.assign(tile.style, {
        top: b.top - top + "px",
        left: (row ? b.left - rect.left : 0) + "px",
        width: b.width + "px",
        height: b.height + "px",
        padding: cs.padding,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        letterSpacing: cs.letterSpacing,
        lineHeight: cs.lineHeight,
        color: cs.color,
        textAlign: cs.textAlign,
      });
      const content = document.createElement("div");
      const original = td.querySelector(".cm-content .cm-line") || td;
      for (const child of original.childNodes)
        content.append(child.cloneNode(true));
      for (const element of content.querySelectorAll("[id]"))
        element.removeAttribute("id");
      content
        .querySelectorAll(".cm-widgetBuffer,.table-tools")
        .forEach((node) => node.remove());
      content.inert = true;
      tile.append(content);
      preview.append(tile);
    }
    guide = document.createElement("div");
    guide.className = "table-drop-guide";
    for (const td of cells) td.classList.add("drag-origin");
    document.body.append(preview, guide);
  }
  function move(e) {
    if (e.pointerId !== down.pointerId) return;
    if (
      !preview &&
      Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4
    )
      return;
    if (!preview) start();
    const td = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("td,th");
    const index =
      td && td.closest("table") === table
        ? row
          ? td.parentElement.rowIndex
          : td.cellIndex
        : null;
    destination =
      index !== null && index !== origin && (!row || index > 0) ? index : null;
    guide.hidden = destination === null;
    const fromHandle =
      down.currentTarget?.closest?.(".move-tool") ||
      down.target.closest(".move-tool");
    const pointer = row ? e.clientY : e.clientX;
    const offset = fromHandle
      ? pointer -
        (row ? first.top + first.height / 2 : first.left + first.width / 2)
      : pointer - (row ? down.clientY : down.clientX);
    preview.style.transform = row
      ? "translateY(" + offset + "px)"
      : "translateX(" + offset + "px)";
    if (destination !== null) {
      const b = td.getBoundingClientRect();
      if (row)
        Object.assign(guide.style, {
          left: rect.left + "px",
          top: (index < origin ? b.top : b.bottom) - 1 + "px",
          width: rect.width + "px",
          height: "2px",
        });
      else
        Object.assign(guide.style, {
          left: (index < origin ? b.left : b.right) - 1 + "px",
          top: Math.max(rect.top, viewport.top) + "px",
          width: "2px",
          height:
            Math.min(rect.bottom, viewport.bottom) -
            Math.max(rect.top, viewport.top) +
            "px",
        });
    }
    e.preventDefault();
  }
  life.signal.addEventListener(
    "abort",
    () => {
      preview?.remove();
      guide?.remove();
      for (const td of cells) td.classList.remove("drag-origin");
    },
    { once: true },
  );
  window.addEventListener("pointermove", move, options);
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId !== down.pointerId) return;
      move(e);
      life.abort();
      if (!preview) return;
      e.stopPropagation();
      const clicks = new AbortController();
      window.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        { capture: true, once: true, signal: clicks.signal },
      );
      setTimeout(() => clicks.abort(), 0);
      if (destination != null) commit(destination);
    },
    options,
  );
  window.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerId === down.pointerId) life.abort();
    },
    options,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        life.abort();
      }
    },
    options,
  );
  window.addEventListener("blur", () => life.abort(), { signal: life.signal });
  window.addEventListener("resize", () => life.abort(), {
    signal: life.signal,
  });
  s.view.scrollDOM.addEventListener("scroll", () => life.abort(), {
    signal: life.signal,
  });
}
