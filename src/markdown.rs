use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, html};
use serde::Serialize;
#[path = "html_image.rs"]
mod html_image;
use std::{
    ops::Range,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct InlineObject {
    from: usize,
    to: usize,
    kind: &'static str,
    html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}
#[derive(Serialize)]
pub struct Block {
    start: usize,
    end: usize,
    html: String,
    heading: String,
    level: u8,
    tasks: Vec<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    inlines: Vec<InlineObject>,
}

fn image_url(path: &str) -> String {
    if path.starts_with("https://")
        || [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/gif;base64,",
            "data:image/webp;base64,",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    {
        return path.to_owned();
    }
    format!("http://craftimg.localhost/{}", URL_SAFE_NO_PAD.encode(path))
}

pub fn local_image(root: Option<&Path>, key: &str) -> Option<(&'static str, Vec<u8>)> {
    let name = String::from_utf8(URL_SAFE_NO_PAD.decode(key).ok()?).ok()?;
    let name = percent_encoding::percent_decode_str(&name)
        .decode_utf8()
        .ok()?;
    let name = name.as_ref();
    let file = Path::new(name);
    // A local drive path is common in desktop editors. Keep network, device
    // paths and alternate data streams outside the document image protocol.
    let drive = name.as_bytes().get(..3).is_some_and(|p| {
        p[0].is_ascii_alphabetic() && p[1] == b':' && matches!(p[2], b'\\' | b'/')
    });
    if name.starts_with(['/', '\\']) || (if drive { &name[2..] } else { name }).contains(':') {
        return None;
    }
    let path: PathBuf = if drive {
        file.to_owned()
    } else {
        root?.join(file)
    };
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    let info = path.metadata().ok()?;
    if !info.is_file() || info.len() > 48 * 1024 * 1024 {
        return None;
    }
    Some((mime, std::fs::read(path).ok()?))
}

fn math(text: CowStr<'_>, block: bool) -> Event<'_> {
    let style = if block {
        latex2mathml::DisplayStyle::Block
    } else {
        latex2mathml::DisplayStyle::Inline
    };
    match latex2mathml::latex_to_mathml(&text, style) {
        Ok(markup) => Event::InlineHtml(markup.into()),
        Err(_) => Event::Code(text),
    }
}

fn safe_event(event: Event<'_>) -> Event<'_> {
    match event {
        Event::InlineHtml(s)
            if matches!(
                s.as_ref(),
                "<u>"
                    | "</u>"
                    | "<mark>"
                    | "</mark>"
                    | "<sub>"
                    | "</sub>"
                    | "<sup>"
                    | "</sup>"
                    | "<br>"
                    | "<br/>"
                    | "<br />"
            ) =>
        {
            Event::InlineHtml(s)
        }
        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
        Event::InlineMath(s) => math(s, false),
        Event::DisplayMath(s) => math(s, true),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: image_url(&dest_url).into(),
            title,
            id,
        }),
        other => other,
    }
}

struct Builder<'a> {
    source: &'a str,
    bytes: usize,
    utf16: usize,
    blocks: Vec<Block>,
}
impl Builder<'_> {
    fn add(
        &mut self,
        range: Range<usize>,
        html: String,
        heading: String,
        level: u8,
        tasks: Vec<usize>,
        inlines: Vec<InlineObject>,
    ) {
        let end = range.start
            + self.source[range.clone()]
                .trim_end_matches(['\r', '\n'])
                .len();
        if end <= range.start {
            return;
        }
        let start = self.utf16 + self.source[self.bytes..range.start].encode_utf16().count();
        self.utf16 = start + self.source[range.start..end].encode_utf16().count();
        self.bytes = end;
        self.blocks.push(Block {
            start,
            end: self.utf16,
            html,
            heading,
            level,
            tasks,
            inlines,
        });
    }
    fn gap(&mut self, to: usize) {
        let gap = &self.source[self.bytes..to];
        if gap.trim().is_empty() {
            return;
        }
        let start = self.bytes + gap.len() - gap.trim_start_matches(['\r', '\n']).len();
        let mut markup = String::new();
        html::push_html(
            &mut markup,
            [Event::Code(
                self.source[start..to].trim_end_matches(['\r', '\n']).into(),
            )]
            .into_iter(),
        );
        self.add(start..to, markup, String::new(), 0, vec![], vec![]);
    }
}

struct DisplayEquation {
    range: Range<usize>,
    body: Range<usize>,
}

// A standalone $$ pair delimits literal LaTeX, including blank lines and lines
// beginning with '+' or '#'. Keep the document in one Markdown parse so that
// reference definitions and footnotes still resolve across display equations.
fn display_equations(source: &str, options: Options) -> Vec<DisplayEquation> {
    if !source.contains("$$") {
        return Vec::new();
    }
    let mut protected = Parser::new_ext(source, options)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(
                event,
                Event::Start(
                    Tag::CodeBlock(_) | Tag::HtmlBlock | Tag::List(_) | Tag::BlockQuote(_)
                )
            )
            .then_some(range)
        })
        .peekable();
    let mut equations = Vec::new();
    let mut opening = None;
    let mut at = 0;
    for line in source.split_inclusive('\n') {
        let next = at + line.len();
        let content = line.trim_end_matches(['\r', '\n']);
        let indent = content.len() - content.trim_start_matches(' ').len();
        if indent < 4 && content[indent..].trim_end_matches([' ', '\t']) == "$$" {
            if let Some((start, body)) = opening.take() {
                equations.push(DisplayEquation {
                    range: start..at + indent + 2,
                    body: body..at,
                });
            } else {
                let marker = at + indent;
                while protected.peek().is_some_and(|r| r.end <= marker) {
                    protected.next();
                }
                if !protected.peek().is_some_and(|r| r.contains(&marker)) {
                    opening = Some((marker, next));
                }
            }
        }
        at = next;
    }
    equations
}

pub fn heading_line(text: &str, fragment: &str) -> Option<u64> {
    let mut used = std::collections::HashSet::new();
    for b in blocks(text).into_iter().filter(|b| b.level > 0) {
        let clean: String = b
            .heading
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
            .collect();
        let base = clean.split_whitespace().collect::<Vec<_>>().join("-");
        let base = if base.is_empty() { "section" } else { &base };
        let mut slug = base.to_owned();
        let mut n = 1;
        while !used.insert(slug.clone()) {
            slug = format!("{base}-{n}");
            n += 1;
        }
        if slug == fragment || b.heading == fragment {
            return Some(
                1 + text
                    .encode_utf16()
                    .take(b.start)
                    .filter(|c| *c == 10)
                    .count() as u64,
            );
        }
    }
    None
}
pub fn image_paths(blocks: &[Block]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    blocks
        .iter()
        .flat_map(|b| &b.inlines)
        .filter(|i| i.kind == "image")
        .filter_map(|i| i.path.as_ref())
        .filter(|p| seen.insert(*p))
        .cloned()
        .collect()
}

pub fn blocks(source: &str) -> Vec<Block> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_SUPERSCRIPT
        | Options::ENABLE_SUBSCRIPT
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let equations = display_equations(source, options);
    // A one-line ATX placeholder interrupts adjacent paragraphs. Padding it to
    // the original byte length keeps every original UTF-8 offset valid.
    let masked = if equations.is_empty() {
        None
    } else {
        let mut bytes = source.as_bytes().to_vec();
        for eq in &equations {
            let segment = &mut bytes[eq.range.clone()];
            segment.fill(b' ');
            segment[..3].copy_from_slice(b"# x");
        }
        Some(String::from_utf8(bytes).expect("complete equation ranges were replaced with ASCII"))
    };
    let input = masked.as_deref().unwrap_or(source);
    let mut equations = equations.into_iter().peekable();
    let mut out = Builder {
        source,
        bytes: 0,
        utf16: 0,
        blocks: Vec::new(),
    };
    let mut depth: usize = 0;
    let mut group = Vec::new();
    let (mut start, mut end) = (0, 0);
    let mut heading = String::new();
    let mut level = 0;
    let mut tasks = Vec::new();
    let mut inlines = Vec::new();
    let mut inline_byte = 0;
    let mut inline_offset = 0;
    for (event, mut range) in Parser::new_ext(input, options).into_offset_iter() {
        // pulldown-cmark resolves a collapsed image reference but its event
        // range stops after the caption, before the empty reference label.
        if matches!(
            &event,
            Event::Start(Tag::Image {
                link_type: pulldown_cmark::LinkType::Collapsed,
                ..
            })
        ) && source[range.end..].starts_with("[]")
        {
            range.end += 2;
        }
        if depth == 0 {
            start = range.start;
            inline_byte = start;
            inline_offset = 0;
            end = range.end;
            out.gap(start);
            if let Event::Start(Tag::Heading { level: value, .. }) = &event {
                level = *value as u8;
            }
        }
        end = end.max(range.end);
        match &event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Text(t) | Event::Code(t) if level > 0 => heading.push_str(t),
            Event::TaskListMarker(_) => {
                tasks.push(source[start..range.start].encode_utf16().count())
            }
            _ => {}
        }
        // Keep the parser-resolved destination for reference links and escaped
        // paths. A link can contain an image, so it has its own offset cursor.
        if let Event::Start(Tag::Link { dest_url, .. }) = &event {
            let from = source[start..range.start].encode_utf16().count();
            inlines.push(InlineObject {
                from,
                to: from + source[range.clone()].encode_utf16().count(),
                kind: "link",
                html: String::new(),
                path: Some(dest_url.to_string()),
            });
        }
        let html_image = match &event {
            Event::Html(text) | Event::InlineHtml(text) => html_image::parse(text),
            _ => None,
        };
        if html_image.is_some() {
            // HtmlBlock events may include the final newline or initial indentation.
            let raw = &source[range.clone()];
            range.end = range.start + raw.trim_end().len();
            range.start += raw.len() - raw.trim_start().len();
        }
        let kind = match &event {
            _ if html_image.is_some() => Some("image"),
            Event::InlineMath(_) => Some("math"),
            Event::FootnoteReference(_) => Some("note"),
            Event::Start(Tag::Image { .. }) => Some("image"),
            _ => None,
        };
        let mut path = match &event {
            Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.to_string()),
            _ => None,
        };
        let safe = if let Some((src, markup)) = html_image {
            path = Some(src);
            Event::InlineHtml(markup.into())
        } else {
            safe_event(event)
        };
        if let Some(kind) = kind {
            // Image events can contain nested alt text. Keep the outermost object.
            if range.start >= inline_byte {
                let from = inline_offset + source[inline_byte..range.start].encode_utf16().count();
                let to = from + source[range.clone()].encode_utf16().count();
                let mut markup = String::new();
                if kind == "math" {
                    html::push_html(&mut markup, std::iter::once(safe.clone()));
                }
                inlines.push(InlineObject {
                    from,
                    to,
                    kind,
                    html: markup,
                    path,
                });
                inline_byte = range.end;
                inline_offset = to;
            }
        }
        group.push(safe);
        if depth == 0 {
            let mut markup = String::new();
            if equations.peek().is_some_and(|eq| eq.range.start == start) {
                let eq = equations.next().unwrap();
                group.clear();
                heading.clear();
                level = 0;
                let tex = source[eq.body].trim();
                markup.push_str("<div class=\"display-equation\">");
                if !tex.is_empty() {
                    html::push_html(&mut markup, std::iter::once(math(tex.into(), true)));
                }
                markup.push_str("</div>");
                end = eq.range.end;
            } else {
                html::push_html(&mut markup, group.drain(..));
            }
            out.add(
                start..end,
                markup,
                std::mem::take(&mut heading),
                level,
                std::mem::take(&mut tasks),
                std::mem::take(&mut inlines),
            );
            level = 0;
        }
    }
    out.gap(source.len());
    out.blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_images_share_markdown_ranges_and_only_render_image_attributes() {
        let tag = r#"<IMG alt='北岸 &amp; 南桥' width="320" style="zoom:25%;color:red" src="图.png" class="old">"#;
        let source =
            format!("🪴 {tag} 文\n\n{tag}\n\n|图|\n|---|\n|{tag}|\n\n```html\n{tag}\n```\n");
        let utf16: Vec<_> = source.encode_utf16().collect();
        let blocks = blocks(&source);
        let mut seen = 0;
        for b in &blocks {
            for i in &b.inlines {
                assert_eq!(i.path.as_deref(), Some("图.png"));
                assert_eq!(
                    String::from_utf16(&utf16[b.start + i.from..b.start + i.to]).unwrap(),
                    tag
                );
                assert!(b.html.contains("alt=\"北岸 &amp; 南桥\""));
                assert!(b.html.contains("style=\"zoom:0.25\""));
                assert!(b.html.contains("width=\"320\""));
                assert!(!b.html.contains("color:red") && !b.html.contains("class=\"old\""));
                seen += 1;
            }
        }
        assert_eq!(seen, 3);
        assert!(blocks.last().unwrap().html.contains("&lt;IMG"));
    }
    #[test]
    fn reads_document_images_from_drive_paths_and_relative_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("雨 量.png");
        std::fs::write(&path, b"fixture").unwrap();
        for name in [path.to_str().unwrap(), "雨%20量.png"] {
            let key = URL_SAFE_NO_PAD.encode(name);
            assert_eq!(local_image(Some(dir.path()), &key).unwrap().1, b"fixture");
        }
        for name in [r"\\server\share\a.png", r"\\?\C:\a.png", r"C:\a:stream.png"] {
            assert!(local_image(Some(dir.path()), &URL_SAFE_NO_PAD.encode(name)).is_none());
        }
    }
    #[test]
    fn image_reference_ranges_cover_the_label_and_preserve_the_resolved_path() {
        let source = "🪴 ![图][]、![名字][图]、![图]。\n\n[图]: <雨 图.png>\n";
        let paragraph = &blocks(source)[0];
        let utf16: Vec<_> = source.encode_utf16().collect();
        let images: Vec<_> = paragraph
            .inlines
            .iter()
            .map(|item| {
                assert_eq!(item.path.as_deref(), Some("雨 图.png"));
                String::from_utf16(&utf16[item.from..item.to]).unwrap()
            })
            .collect();
        assert_eq!(images, ["![图][]", "![名字][图]", "![图]"]);
    }
    #[test]
    fn inline_objects_use_editor_offsets_in_lists_and_paragraphs() {
        let source = "标题\n\n1. 🪴 $x^2$ 和 $y$。[^a]\n2. ![图](a.png)\n\n[^a]: 注\n";
        let block = &blocks(source)[1];
        let utf16: Vec<_> = source.encode_utf16().collect();
        let parts: Vec<_> = block
            .inlines
            .iter()
            .map(|i| {
                (
                    i.kind,
                    String::from_utf16(&utf16[block.start + i.from..block.start + i.to]).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            parts,
            vec![
                ("math", "$x^2$".into()),
                ("math", "$y$".into()),
                ("note", "[^a]".into()),
                ("image", "![图](a.png)".into())
            ]
        );
        assert!(block.inlines[0].html.contains("<msup>"));
    }
    #[test]
    fn unicode_offsets_and_gfm() {
        let s = "# 标题 🪴\n\n- [ ] 一项\n- [x] 完成\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n\n<script>alert(1)</script>\n";
        let b = blocks(s);
        assert_eq!(b[0].heading, "标题 🪴");
        assert_eq!(b[1].start, "# 标题 🪴\n\n".encode_utf16().count());
        assert_eq!(b[1].tasks, vec![2, 11]);
        assert!(b.iter().any(|x| x.html.contains("<table>")));
        assert!(b.iter().any(|x| x.html.contains("<math")));
        assert!(!b.iter().any(|x| x.html.contains("<script>")));
    }
    #[test]
    fn display_equations_preserve_multiline_tex_and_source_offsets() {
        let s = "前言🪴\n$$\n\\frac{a}{b}\n+ 3\n\n- 4\n$$\n[文献][k]\n\n\x60\x60\x60text\n$$\n+ 9\n$$\n\x60\x60\x60\n\n[k]: https://example.org\n";
        let b = blocks(s);
        let eq = b
            .iter()
            .find(|b| b.html.contains("display-equation"))
            .unwrap();
        assert_eq!(eq.start, "前言🪴\n".encode_utf16().count());
        assert_eq!(
            eq.end,
            s[..s.find("\n[文献]").unwrap()].encode_utf16().count()
        );
        assert!(
            eq.html.contains("<mfrac>")
                && eq.html.contains("<mn>3</mn>")
                && eq.html.contains("<mn>4</mn>")
        );
        assert!(
            b.iter()
                .any(|b| b.html.contains("href=\"https://example.org\""))
        );
        assert!(
            b.iter()
                .any(|b| b.html.contains("<pre>") && b.html.contains("$$\n+ 9\n$$"))
        );
        assert!(b.iter().all(|b| b.level == 0));
    }

    #[test]
    fn definitions_and_whitespace_survive_edit_ranges() {
        let s = "\n[ref]: https://example.com\n\n## Title\n\n[visit][ref]\n";
        let b = blocks(s);
        assert_eq!(b.len(), 3);
        assert!(b[2].html.contains("https://example.com"));
        assert!(b.windows(2).all(|p| p[0].end <= p[1].start));
    }
}
