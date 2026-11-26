import { WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

function codeBody(view, toolbar) {
  return codeBodyAt(view, view.posAtDOM(toolbar) + 1);
}
export function codeBodyAt(view, pos) {
  const state = view.state,
    doc = state.doc;
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node) return null;
  const open = doc.lineAt(node.from),
    last = doc.lineAt(node.to);
  const closed =
    last.number > open.number && node.lastChild?.name === "CodeMark";
  const from = Math.min(open.to + 1, node.to);
  return {
    node,
    from,
    to: Math.max(from, closed ? last.from - 1 : node.to),
  };
}

function languageChoices(current) {
  const hl = window.hljs;
  const ids = new Set([
    "",
    "plaintext",
    "python",
    "bash",
    "rust",
    "javascript",
    "typescript",
    "json",
    ...(hl?.listLanguages() || []).sort(),
    "mermaid",
    current,
  ]);
  const labels = {
    "": "自动识别",
    plaintext: "纯文本",
    bash: "Bash / Shell",
    mermaid: "Mermaid",
  };
  return [...ids].map((id) => {
    const lang = hl?.getLanguage(id);
    return {
      id,
      label: labels[id] || lang?.name || id,
      aliases: lang?.aliases || [],
    };
  });
}

function showLanguages(trigger, current, apply) {
  const panel = document.createElement("div");
  panel.className = "language-panel";
  panel.popover = "manual";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "选择代码语言");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜索代码语言";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "搜索代码语言");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "language-options");
  const list = document.createElement("div");
  list.className = "language-options";
  list.id = "language-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "代码语言");
  panel.append(input, list);
  document.body.append(panel);
  const listeners = new AbortController();
  const choices = languageChoices(current);
  let items, active;
  function close() {
    if (!panel.isConnected) return;
    listeners.abort();
    trigger.setAttribute("aria-expanded", "false");
    panel.remove();
  }
  function position() {
    const a = trigger.getBoundingClientRect(),
      gap = 6;
    const below = innerHeight - a.bottom - 2 * gap,
      above = a.top - 2 * gap;
    const up = below < 200 && above > below;
    panel.style.maxHeight = Math.max(0, up ? above : below) + "px";
    panel.style.left =
      Math.max(
        gap,
        Math.min(
          innerWidth - panel.offsetWidth - gap,
          a.right - panel.offsetWidth,
        ),
      ) + "px";
    panel.style.top =
      (up ? a.top - panel.offsetHeight - gap : a.bottom + gap) + "px";
  }
  function highlight(index) {
    active = index;
    const row = list.children[index];
    for (const child of list.children)
      child.classList.toggle("active", child === row);
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (
        row.offsetTop + row.offsetHeight >
        list.scrollTop + list.clientHeight
      )
        list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    } else input.removeAttribute("aria-activedescendant");
  }
  function choose(index) {
    if (!items[index]) return;
    const value = items[index].id;
    close();
    apply(value);
  }
  function filter() {
    const term = input.value.trim(),
      q = term.toLowerCase();
    const matches = (c) =>
      [c.id, c.label, ...c.aliases].map((s) => s.toLowerCase());
    items = choices.filter((c) => matches(c).some((s) => s.includes(q)));
    const exact = items.findIndex((c) => matches(c).includes(q));
    if (term && exact < 0 && !/[\s\x60]/.test(term))
      items.push({ id: term, label: "使用「" + term + "」" });
    list.replaceChildren();
    for (const [i, item] of items.entries()) {
      const row = document.createElement("div");
      row.id = "language-option-" + i;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.id === current));
      row.textContent = item.label;
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => choose(i);
      list.append(row);
    }
    if (!items.length) {
      const hint = document.createElement("div");
      hint.className = "language-empty";
      hint.textContent = "没有匹配的语言";
      list.append(hint);
    }
    position();
    const initial = term ? exact : items.findIndex((c) => c.id === current);
    highlight(items.length ? Math.max(0, initial) : -1);
  }
  input.oninput = filter;
  input.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Tab") {
      close();
      trigger.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      close();
      trigger.focus({ preventScroll: true });
    } else if (e.key === "Enter") choose(active);
    else if (items.length)
      highlight(
        (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length,
      );
  };
  const opts = { signal: listeners.signal };
  function outside(e) {
    if (!panel.contains(e.target) && !trigger.contains(e.target)) close();
  }
  document.addEventListener("pointerdown", outside, { ...opts, capture: true });
  document.addEventListener("focusin", outside, opts);
  window.addEventListener("resize", position, opts);
  document.addEventListener(
    "scroll",
    (e) => {
      if (!panel.contains(e.target)) close();
    },
    { ...opts, capture: true },
  );
  panel.addEventListener(
    "toggle",
    (e) => {
      if (e.newState === "closed") close();
    },
    opts,
  );
  trigger.setAttribute("aria-expanded", "true");
  panel.showPopover();
  filter();
  input.focus({ preventScroll: true });
  return close;
}

const opened = new WeakMap();
export class LanguagePicker extends WidgetType {
  constructor(language) {
    super();
    this.language = language;
  }
  eq(other) {
    return other.language === this.language;
  }
  toDOM(view) {
    const root = document.createElement("span");
    root.className = "code-toolbar";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "select-code";
    select.textContent = "选中代码";
    select.title = "选中此块的全部代码";
    select.onclick = () => {
      const body = codeBody(view, root);
      if (!body) return;
      view.dispatch({
        selection: { anchor: body.from, head: body.to },
        userEvent: "select",
      });
      view.focus();
    };
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "block-language";
    trigger.textContent = this.language || "自动识别";
    trigger.title = "选择代码语言";
    trigger.setAttribute("aria-label", "代码语言，" + trigger.textContent);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.onclick = () => {
      if (trigger.getAttribute("aria-expanded") === "true") {
        opened.get(root)?.();
        return;
      }
      opened.set(
        root,
        showLanguages(trigger, this.language, (lang) => {
          const body = codeBody(view, root);
          if (!body) return;
          const state = view.state,
            info = body.node.getChild("CodeInfo");
          const from = info?.from ?? body.node.firstChild.to;
          const to = info
            ? from + state.sliceDoc(from, info.to).split(/\s+/)[0].length
            : from;
          const selection = state.selection.main;
          const changes = state.changes({ from, to, insert: lang });
          const stays = selection.from >= body.from && selection.to <= body.to;
          view.dispatch({
            changes,
            selection: stays
              ? state.selection.map(changes)
              : { anchor: changes.mapPos(body.from, 1) },
            userEvent: "input.language",
          });
          view.focus();
        }),
      );
    };
    // Keep the document range intact while a toolbar control is pressed.
    root.onmousedown = (e) => e.preventDefault();
    root.append(select, trigger);
    return root;
  }
  destroy(root) {
    opened.get(root)?.();
    opened.delete(root);
  }
}
