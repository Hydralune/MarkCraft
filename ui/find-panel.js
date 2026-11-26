import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  selectMatches,
} from "@codemirror/search";
import { runScopeHandlers } from "@codemirror/view";

export function openFind(view, replace = false) {
  openSearchPanel(view);
  const panel = view.dom.querySelector(".writer-search");
  panel?.showReplace(replace);
  const field = panel?.querySelector("[main-field]");
  field?.focus();
  field?.select();
}

function* mappedText(root, raw, base) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode,
      t = node.nodeValue;
    if (
      !t.trim() ||
      node.parentElement?.closest(".table-tools,.editing-cell,svg,math")
    )
      continue;
    const start = raw.indexOf(t, offset);
    if (start < 0) continue;
    offset = start + t.length;
    yield { node, from: base + start, to: base + offset };
  }
}
export function visibleMatch(state, block) {
  const sel = state.selection.main;
  if (
    !CSS.highlights ||
    sel.empty ||
    state.selection.ranges.length !== 1 ||
    sel.from < block.start ||
    sel.to > block.end
  )
    return false;
  const t = document.createElement("template");
  t.innerHTML = block.html;
  for (const span of mappedText(
    t.content,
    state.sliceDoc(block.start, block.end),
    block.start,
  ))
    if (sel.from >= span.from && sel.to <= span.to) return true;
  return false;
}
export function findPanel(view, blocks) {
  const dom = document.createElement("section");
  dom.className = "writer-search cm-search";
  dom.setAttribute("aria-label", "查找和替换");
  dom.innerHTML =
    '<div class="find-main"><div class="find-line"><label class="find-field"><span>查找</span><input main-field="true" aria-label="查找内容" placeholder="在文稿中查找" autocomplete="off" spellcheck="false"><output aria-live="polite"></output></label><button type="button" data-do="prev" title="上一处 (Shift + Enter)" aria-label="上一处">↑</button><button type="button" data-do="next" title="下一处 (Enter)" aria-label="下一处">↓</button><button type="button" data-do="toggle" aria-expanded="false">替换</button><button type="button" data-do="close" aria-label="关闭查找" title="关闭 (Esc)">×</button></div><div class="find-line replace-line" hidden><label class="find-field"><span>替换为</span><input aria-label="替换内容" autocomplete="off" spellcheck="false"></label><button type="button" data-do="one">替换当前</button><button type="button" data-do="all">全部替换</button></div><div class="find-options"><label><input type="checkbox" name="caseSensitive">区分大小写</label><label><input type="checkbox" name="wholeWord">整词</label><label><input type="checkbox" name="regexp">正则表达式</label><button type="button" data-do="select">选中全部匹配</button></div></div>';
  const [query, replacement] = dom.querySelectorAll(".find-field input"),
    out = dom.querySelector("output"),
    opts = [...dom.querySelectorAll("[type=checkbox]")];
  const commands = {
    prev: findPrevious,
    next: findNext,
    one: replaceNext,
    all: replaceAll,
    select: selectMatches,
    close: closeSearchPanel,
  };
  const toggle = dom.querySelector('[data-do="toggle"]'),
    replaceLine = dom.querySelector(".replace-line");
  dom.showReplace = (value) => {
    replaceLine.hidden = !value;
    toggle.setAttribute("aria-expanded", String(value));
  };
  let positions = [];
  let frame = 0,
    shouldScroll = false;
  function paint(scroll = false) {
    if (!CSS.highlights) return;
    shouldScroll ||= scroll;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const matches = new Highlight(),
        current = new Highlight(),
        sel = view.state.selection.main;
      const byStart = new Map(blocks().map((b) => [b.start, b]));
      for (const el of view.contentDOM.querySelectorAll(".rendered")) {
        const b = byStart.get(view.posAtDOM(el));
        if (!b) continue;
        const cursor = getSearchQuery(view.state);
        if (!cursor.valid) break;
        const hits = cursor.getCursor(view.state, b.start, b.end);
        let hit = hits.next();
        for (const span of mappedText(
          el,
          view.state.sliceDoc(b.start, b.end),
          b.start,
        )) {
          while (!hit.done && hit.value.from < span.from) hit = hits.next();
          while (!hit.done && hit.value.from < span.to) {
            const { from, to } = hit.value;
            if (to <= span.to && to > from) {
              const range = document.createRange();
              range.setStart(span.node, from - span.from);
              range.setEnd(span.node, to - span.from);
              if (from === sel.from && to === sel.to) {
                current.add(range);
                if (shouldScroll) {
                  const box = range.getBoundingClientRect(),
                    port = view.scrollDOM.getBoundingClientRect();
                  if (box.top < port.top || box.bottom > port.bottom)
                    view.scrollDOM.scrollTop +=
                      box.top - port.top - port.height / 2 + box.height / 2;
                }
              } else matches.add(range);
            }
            hit = hits.next();
          }
        }
      }
      CSS.highlights.set("writer-matches", matches);
      CSS.highlights.set("writer-current", current);
      shouldScroll = false;
    });
  }
  function refresh(recount) {
    const spec = getSearchQuery(view.state),
      sel = view.state.selection.main;
    if (recount) {
      positions = [];
      if (spec.valid) {
        const cursor = spec.getCursor(view.state);
        for (let m = cursor.next(); !m.done; m = cursor.next())
          positions.push(m.value.from);
      }
      query.setAttribute("aria-invalid", String(!!spec.search && !spec.valid));
    }
    const idx = sel.empty ? -1 : positions.indexOf(sel.from);
    out.textContent = !spec.search
      ? ""
      : !spec.valid
        ? "表达式无效"
        : !positions.length
          ? "无匹配"
          : idx >= 0
            ? idx + 1 + " / " + positions.length
            : positions.length + " 处";
    for (const b of dom.querySelectorAll(
      '[data-do="prev"],[data-do="next"],[data-do="one"],[data-do="all"],[data-do="select"]',
    ))
      b.disabled = !positions.length;
  }
  function load() {
    const s = getSearchQuery(view.state);
    if (query.value !== s.search) query.value = s.search;
    if (replacement.value !== s.replace) replacement.value = s.replace;
    for (const c of opts) c.checked = s[c.name];
    refresh(true);
  }
  function commit() {
    const config = {
      search: query.value,
      replace: replacement.value,
      literal: true,
    };
    for (const c of opts) config[c.name] = c.checked;
    const spec = new SearchQuery(config);
    if (!spec.eq(getSearchQuery(view.state)))
      view.dispatch({ effects: setSearchQuery.of(spec) });
  }
  dom.addEventListener("input", (e) => {
    if (!e.isComposing) commit();
  });
  dom.addEventListener("compositionend", commit);
  dom.addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.do;
    if (action === "toggle") {
      dom.showReplace(replaceLine.hidden);
      (replaceLine.hidden ? query : replacement).focus();
    } else if (commands[action]) commands[action](view);
  });
  dom.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
    } else if (
      e.key === "Enter" &&
      (e.target === query || e.target === replacement)
    ) {
      e.preventDefault();
      if (e.target === replacement) replaceNext(view);
      else (e.shiftKey ? findPrevious : findNext)(view);
    } else if (runScopeHandlers(view, e, "search-panel")) e.preventDefault();
  });
  load();
  return {
    dom,
    top: true,
    mount() {
      paint();
      query.focus();
      query.select();
    },
    destroy() {
      cancelAnimationFrame(frame);
      CSS.highlights?.delete("writer-matches");
      CSS.highlights?.delete("writer-current");
    },
    update(u) {
      if (u.viewportChanged || u.transactions.length) paint(u.selectionSet);
      if (
        u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))
      )
        load();
      else if (u.docChanged || u.selectionSet) refresh(u.docChanged);
    },
  };
}
