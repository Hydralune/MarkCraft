use html5ever::tokenizer::{
    BufferQueue, StartTag, Tag, Token, TokenSink, TokenSinkResult, Tokenizer,
};
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct SingleImage {
    tag: RefCell<Option<Tag>>,
    other_content: Cell<bool>,
}

impl TokenSink for SingleImage {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        match token {
            Token::TagToken(tag) if tag.kind == StartTag && tag.name.as_ref() == "img" => {
                if self.tag.replace(Some(tag)).is_some() {
                    self.other_content.set(true);
                }
            }
            Token::CharacterTokens(text) if text.trim().is_empty() => {}
            Token::EOFToken | Token::ParseError(_) => {}
            _ => self.other_content.set(true),
        }
        TokenSinkResult::Continue
    }
}

// Only reconstruct a single image. Other HTML still follows the editor's text escaping rules.
pub(super) fn parse(raw: &str) -> Option<(String, String)> {
    let text = raw.trim();
    if !text.get(..4)?.eq_ignore_ascii_case("<img") || !text.ends_with('>') {
        return None;
    }
    let input = BufferQueue::default();
    input.push_back(text.into());
    let tokens = Tokenizer::new(SingleImage::default(), Default::default());
    let _ = tokens.feed(&input);
    tokens.end();
    if tokens.sink.other_content.get() {
        return None;
    }
    let tag = tokens.sink.tag.into_inner()?;
    let attr = |name: &str| {
        tag.attrs
            .iter()
            .find(|a| a.name.local.as_ref() == name)
            .map(|a| a.value.as_ref())
    };
    let path = attr("src")?.trim();
    if path.is_empty() {
        return None;
    }
    let escaped = |v: &str| {
        v.replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut markup = format!(
        "<img src=\"{}\" alt=\"{}\"",
        escaped(&super::image_url(path)),
        escaped(attr("alt").unwrap_or(""))
    );
    if let Some(title) = attr("title") {
        markup.push_str(&format!(" title=\"{}\"", escaped(title)));
    }
    for key in ["width", "height"] {
        if let Some(n) = attr(key).and_then(|s| s.trim().parse::<u32>().ok()) {
            markup.push_str(&format!(" {key}=\"{n}\""));
        }
    }
    if let Some(style) = attr("style") {
        for property in style.split(';') {
            let Some((name, value)) = property.split_once(':') else {
                continue;
            };
            if !name.trim().eq_ignore_ascii_case("zoom") {
                continue;
            }
            let value = value.trim();
            let scale = match value.strip_suffix('%') {
                Some(n) => n.trim().parse::<f64>().ok().map(|n| n / 100.0),
                None => value.parse::<f64>().ok(),
            };
            if let Some(n) = scale.filter(|n| n.is_finite() && *n > 0.0 && *n <= 10.0) {
                markup.push_str(&format!(" style=\"zoom:{n}\""));
                break;
            }
        }
    }
    markup.push('>');
    Some((path.to_owned(), markup))
}
