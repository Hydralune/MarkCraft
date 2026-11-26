"use strict";
let diagramId = 0;
let currentTheme = "";
const libraries = new Map();
function loadLibrary(name) {
  if (!libraries.has(name)) {
    libraries.set(
      name,
      new Promise((resolve) => {
        const tag = document.createElement("script");
        tag.nonce = "markcraft-ui";
        tag.src = "http://craftui.localhost/" + name + ".js";
        tag.onload = () => resolve(true);
        tag.onerror = () => {
          libraries.delete(name);
          resolve(false);
        };
        document.head.append(tag);
      }),
    );
  }
  return libraries.get(name);
}
function shellColors(markup, source) {
  const spans = [];
  for (const m of source.matchAll(
    /(?:^|&&|\|\||[;|])(?:[ \t]*)(cd|cat|echo|export|source|mkdir|rm|cp|mv|ls|pwd|printf|read|test|set|exit|git|node|npm|bun|python3?)\b/gm,
  ))
    spans.push({
      from: m.index + m[0].length - m[1].length,
      to: m.index + m[0].length,
      cls: "hljs-built_in",
    });
  for (const m of source.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)=/gm))
    spans.push({
      from: m.index + m[0].length - 1 - m[1].length,
      to: m.index + m[0].length - 1,
      cls: "shell-variable",
    });
  for (const m of source.matchAll(/(?:^|[ \t])(--[a-z][\w-]*)/gim))
    spans.push({
      from: m.index + m[0].length - m[1].length,
      to: m.index + m[0].length,
      cls: "shell-flag",
    });
  if (!spans.length) return markup;
  spans.sort((a, b) => a.from - b.from);
  const t = document.createElement("template");
  t.innerHTML = markup;
  const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  let offset = 0,
    i = 0;
  for (const n of nodes) {
    const text = n.nodeValue,
      end = offset + text.length;
    while (i < spans.length && spans[i].to <= offset) i++;
    let j = i,
      at = 0;
    const frag = document.createDocumentFragment();
    for (; j < spans.length && spans[j].from < end; j++) {
      const span = spans[j];
      if (
        span.from < offset + at ||
        span.to > end ||
        n.parentElement?.closest(".hljs-comment") ||
        (n.parentElement?.closest(".hljs-string") &&
          span.cls !== "shell-variable")
      )
        continue;
      const tag = document.createElement("span");
      tag.className = span.cls;
      tag.textContent = text.slice(span.from - offset, span.to - offset);
      frag.append(text.slice(at, span.from - offset), tag);
      at = span.to - offset;
    }
    if (at) {
      frag.append(text.slice(at));
      n.replaceWith(frag);
    }
    offset = end;
  }
  return t.innerHTML;
}
window.highlightCode = (text, language = "") => {
  if (
    !text.trim() ||
    !window.hljs ||
    text.length > 160000 ||
    language === "mermaid"
  )
    return null;
  let lang = language.toLowerCase();
  if (["shell", "sh", "zsh"].includes(lang)) lang = "bash";
  if (
    !lang &&
    /^(?:[ \t]*#[^\n]*\n)*[ \t]*(?:cd |cat\s|export \w+=)/m.test(text)
  )
    lang = "bash";
  const result = lang
    ? hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
      : null
    : hljs.highlightAuto(text, [
        "rust",
        "javascript",
        "python",
        "json",
        "cpp",
        "java",
        "bash",
        "sql",
        "xml",
        "css",
      ]);
  if (!result || (!lang && !result.relevance)) return null;
  return result.language === "bash"
    ? shellColors(result.value, text)
    : result.value;
};
async function typeset(root, theme) {
  for (const code of root.querySelectorAll("pre code")) {
    const lang =
      Array.from(code.classList)
        .find((c) => c.startsWith("language-"))
        ?.slice(9) || "";
    const html = window.highlightCode(code.textContent, lang);
    if (html) code.innerHTML = html;
  }
  if (!root.querySelector("pre code.language-mermaid")) return;
  await loadLibrary("mermaid");
  if (!window.mermaid) return;
  const diagramTheme =
    theme === "lucid" ? "default" : theme === "dark" ? "dark" : "neutral";
  if (currentTheme !== diagramTheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: diagramTheme,
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 45000,
    });
    currentTheme = diagramTheme;
  }
  for (const code of root.querySelectorAll("pre code.language-mermaid")) {
    const pre = code.parentElement;
    try {
      const result = await mermaid.render(
        "craftDiagram" + ++diagramId,
        code.textContent,
      );
      if (pre.isConnected) {
        const figure = document.createElement("figure");
        figure.className = "diagram";
        figure.innerHTML = result.svg;
        pre.replaceWith(figure);
      }
    } catch {
      /* The editable source remains visible for incomplete diagrams. */
    }
  }
}
