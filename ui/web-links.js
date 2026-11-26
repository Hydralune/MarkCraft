import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import LinkifyIt from "linkify-it";

const detector = new LinkifyIt({ fuzzyEmail: false, fuzzyIP: false });
export function webLinks(text) {
  if (!/(?:https?:\/\/|www\.)/i.test(text)) return [];
  const result = [];
  // Chinese sentence punctuation is often written immediately after a URL.
  for (const part of text.matchAll(/[^，。；！？、：（）【】《》「」“”]+/gu)) {
    for (const m of detector.match(part[0]) || []) {
      if (!/^(?:https?:\/\/|www\.)/i.test(m.raw)) continue;
      result.push({
        from: part.index + m.index,
        to: part.index + m.lastIndex,
        href: m.url,
      });
    }
  }
  return result;
}
export function linkifyText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.parentElement?.closest("a,pre,code,kbd,samp,math,svg,script,style"))
      nodes.push(n);
  }
  for (const n of nodes) {
    const text = n.nodeValue,
      links = webLinks(text);
    if (!links.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const { from, to, href } of links) {
      frag.append(text.slice(pos, from));
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text.slice(from, to);
      frag.append(a);
      pos = to;
    }
    frag.append(text.slice(pos));
    n.replaceWith(frag);
  }
}

export function inlineWebLinks(state, line) {
  return webLinks(line.text).filter((link) => {
    let node = syntaxTree(state).resolveInner(line.from + link.from + 1, -1);
    while (node) {
      if (
        [
          "InlineCode",
          "FencedCode",
          "CodeBlock",
          "Link",
          "Image",
          "LinkReference",
          "HTMLBlock",
          "HTMLTag",
        ].includes(node.name)
      )
        return false;
      node = node.parent;
    }
    return true;
  });
}
export function linkMark(href) {
  return Decoration.mark({
    class: "md-link",
    tagName: "a",
    attributes: { href, "data-link": href, draggable: "false", title: "单击打开链接 · Alt + 单击编辑" },
  });
}
