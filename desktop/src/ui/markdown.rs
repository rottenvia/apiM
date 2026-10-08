//! Markdown drawn the way the web app's `.prose-chat` draws it (globals.css,
//! CodeBlock.tsx): 15px on a 25.5px line, the same margins and the same code
//! blocks. No bullets or numbers on lists and no syntax colours: the web app
//! shows neither.

use super::theme::{self, W, p};
use super::{icons, widgets};
use eframe::egui::{self, Color32, CornerRadius, Rect, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use egui::text::{LayoutJob, TextFormat};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::iter::Peekable;
use std::sync::LazyLock;

const SIZE: f32 = 15.0;
const LINE: f32 = 25.5;
/// Half an em: the margin above and below a paragraph.
const GAP: f32 = 7.5;
/// Code blocks longer than this fold into a card that opens beside the chat.
const CARD_THRESHOLD: usize = 14;

pub enum Click {
    Link(String),
    Copy(String),
    /// A long code block was clicked: (title, language, code).
    Open(String, String, String),
}

#[derive(Clone, Default, Debug, PartialEq)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Block {
    Para(Vec<Span>),
    Heading(u8, Vec<Span>),
    Code { lang: String, code: String },
    Quote(Vec<Block>),
    List(Vec<Vec<Block>>),
    Rule,
    Table { head: Vec<Vec<Span>>, rows: Vec<Vec<Vec<Span>>> },
}

// ------------------------------------------------------------------ find in chat

/// The find bar's query being highlighted in one message (`.search-hit`).
///
/// Hits are numbered in reading order across the message, so the bar's "3/7" can point at one.
// ponytail: the bar counts matches in the message as stored, like the web; code blocks are counted
// but never marked, so a number can land on a hit that is not drawn. Count the drawn text if that bites.
pub struct Marks<'a> {
    pub matcher: &'a crate::find::Matcher,
    /// Which hit of this message is the focused one.
    pub active: Option<usize>,
    /// Hits met so far in this message.
    pub seen: usize,
    /// Bring the focused hit into view.
    pub reveal: bool,
    /// The focused hit was drawn (and scrolled to, when asked).
    pub shown: bool,
}

impl Marks<'_> {
    /// Gives every hit in `job` its own text colour and 2px of room each side (the web's `px-0.5`).
    /// Returns where they are, as character ranges, and which one is the focused hit.
    pub fn apply(&mut self, job: &mut LayoutJob) -> Vec<(std::ops::Range<usize>, bool)> {
        let found = self.matcher.ranges(&job.text);
        if found.is_empty() {
            return Vec::new();
        }
        let focused = self.active.and_then(|n| n.checked_sub(self.seen)).filter(|n| *n < found.len());
        self.seen += found.len();
        let mut sections = Vec::new();
        for section in std::mem::take(&mut job.sections) {
            let (start, end) = (usize::from(section.byte_range.start), usize::from(section.byte_range.end));
            // The section falls apart where a hit starts or ends inside it.
            let mut cuts: Vec<usize> = found.iter().flat_map(|r| [r.start, r.end]).filter(|at| *at > start && *at < end).collect();
            cuts.push(end);
            cuts.dedup();
            let mut from = start;
            for to in cuts {
                let mut piece = section.clone();
                piece.byte_range = egui::text::ByteIndex(from)..egui::text::ByteIndex(to);
                piece.leading_space = if from == start { section.leading_space } else { 0.0 };
                piece.leading_space += 2.0 * found.iter().filter(|r| r.start == from || r.end == from).count() as f32;
                if let Some(hit) = found.iter().position(|r| r.contains(&from)) {
                    piece.format.color = if focused == Some(hit) { Color32::WHITE } else { Color32::from_rgb(0xed, 0xe9, 0xe2) };
                }
                sections.push(piece);
                from = to;
            }
        }
        job.sections = sections;
        let chars = |byte: usize| job.text[..byte].chars().count();
        found.iter().enumerate().map(|(i, r)| (chars(r.start)..chars(r.end), focused == Some(i))).collect()
    }

    /// Paints the boxes behind the hits of a galley drawn at `origin`, into the slot kept for them
    /// under the text, and scrolls to the focused one when that was asked for.
    pub fn paint(&mut self, ui: &Ui, under: egui::layers::ShapeIdx, galley: &egui::Galley, hits: &[(std::ops::Range<usize>, bool)], origin: egui::Vec2) {
        // The box is the font's own height around the baseline, as an inline `<mark>` is.
        let (ascent, height) = galley.rows.iter().find_map(|r| r.row.glyphs.first()).map_or((14.0, 18.0), |g| (g.font_ascent, g.font_height));
        let boxes = |focused: bool| {
            let ranges: Vec<_> = hits.iter().filter(|h| h.1 == focused).map(|h| h.0.clone()).collect();
            runs(galley, &ranges).into_iter().map(move |[left, right, _, baseline]| Rect::from_min_max(pos2(left - 2.0, baseline - ascent), pos2(right + 2.0, baseline - ascent + height)).translate(origin))
        };
        let mut shapes: Vec<egui::Shape> = boxes(false).map(|rect| egui::Shape::rect_filled(rect, 3.0, Color32::from_rgba_unmultiplied(201, 100, 66, 64))).collect();
        for rect in boxes(true) {
            shapes.push(egui::Shape::rect_filled(rect, 3.0, Color32::from_rgb(0xc9, 0x64, 0x42)));
            if self.reveal && !self.shown {
                ui.scroll_to_rect(rect, Some(egui::Align::Center));
            }
            self.shown = true;
        }
        ui.painter().set(under, egui::Shape::Vec(shapes));
    }
}

// ------------------------------------------------------------------ parsing

type Events<'a> = Peekable<Parser<'a>>;

fn parse(text: &str) -> Vec<Block> {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    blocks(&mut Parser::new_ext(text, options).peekable())
}

fn is_inline_end(end: &TagEnd) -> bool {
    matches!(end, TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link | TagEnd::Image | TagEnd::Superscript | TagEnd::Subscript)
}

fn is_inline_start(tag: &Tag) -> bool {
    matches!(tag, Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. } | Tag::Image { .. } | Tag::Superscript | Tag::Subscript)
}

/// Everything up to the end of the enclosing container (which is consumed), or the end of the text.
fn blocks(ev: &mut Events) -> Vec<Block> {
    let mut out = Vec::new();
    loop {
        match ev.peek() {
            None => break,
            Some(Event::End(_)) => {
                ev.next();
                break;
            }
            Some(Event::Rule) => {
                ev.next();
                out.push(Block::Rule);
            }
            Some(Event::Start(tag)) if !is_inline_start(tag) => {
                let Some(Event::Start(tag)) = ev.next() else { unreachable!() };
                match tag {
                    Tag::Paragraph => {
                        out.push(Block::Para(inlines(ev)));
                        ev.next();
                    }
                    Tag::Heading { level, .. } => {
                        out.push(Block::Heading(level as u8, inlines(ev)));
                        ev.next();
                    }
                    Tag::CodeBlock(kind) => {
                        let lang = match kind {
                            CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_string(),
                            CodeBlockKind::Indented => String::new(),
                        };
                        let mut code = String::new();
                        for e in ev.by_ref() {
                            match e {
                                Event::Text(t) => code.push_str(&t),
                                Event::End(TagEnd::CodeBlock) => break,
                                _ => {}
                            }
                        }
                        if code.ends_with('\n') {
                            code.pop();
                        }
                        out.push(Block::Code { lang, code });
                    }
                    Tag::BlockQuote(_) => out.push(Block::Quote(blocks(ev))),
                    Tag::List(_) => {
                        let mut items = Vec::new();
                        while let Some(e) = ev.next() {
                            match e {
                                Event::Start(Tag::Item) => items.push(blocks(ev)),
                                Event::End(TagEnd::List(_)) => break,
                                _ => {}
                            }
                        }
                        out.push(Block::List(items));
                    }
                    Tag::Table(_) => {
                        let (mut head, mut rows) = (Vec::new(), Vec::new());
                        while let Some(e) = ev.next() {
                            match e {
                                Event::Start(Tag::TableHead) => head = cells(ev),
                                Event::Start(Tag::TableRow) => rows.push(cells(ev)),
                                Event::End(TagEnd::Table) => break,
                                _ => {}
                            }
                        }
                        out.push(Block::Table { head, rows });
                    }
                    // Raw HTML is shown as written, like the web app (no rehype-raw).
                    Tag::HtmlBlock => {
                        out.push(Block::Para(inlines(ev)));
                        ev.next();
                    }
                    // Footnotes, definition lists, metadata: their content, unstyled.
                    _ => out.extend(blocks(ev)),
                }
            }
            // Text straight inside a list item (a "tight" list has no <p>).
            Some(_) => out.push(Block::Para(inlines(ev))),
        }
    }
    out
}

/// The cells of one table row, up to and including its end tag.
fn cells(ev: &mut Events) -> Vec<Vec<Span>> {
    let mut out = Vec::new();
    while let Some(e) = ev.next() {
        match e {
            Event::Start(Tag::TableCell) => {
                out.push(inlines(ev));
                ev.next();
            }
            Event::End(_) => break,
            _ => {}
        }
    }
    out
}

fn push(out: &mut Vec<Span>, style: &Span, text: &str, code: bool) {
    if !text.is_empty() {
        out.push(Span { text: text.to_string(), code, ..style.clone() });
    }
}

/// Running text, with bare addresses turned into links the way GitHub-flavoured markdown does.
fn push_text(out: &mut Vec<Span>, style: &Span, text: &str) {
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?:https?://|\bwww\.)[^\s<]+").unwrap());
    if style.link.is_some() {
        return push(out, style, text, false);
    }
    let mut at = 0;
    for found in URL.find_iter(text) {
        // Punctuation that ends the sentence is not part of the address; nor is a bracket that closes one opened before it.
        let mut url = found.as_str().trim_end_matches(['?', '!', '.', ',', ':', ';', '*', '_', '~', '\'', '"']);
        while url.ends_with(')') && url.matches(')').count() > url.matches('(').count() {
            url = &url[..url.len() - 1];
        }
        push(out, style, &text[at..found.start()], false);
        let href = if url.starts_with("www.") { format!("http://{url}") } else { url.to_string() };
        out.push(Span { text: url.to_string(), link: Some(href), ..style.clone() });
        at = found.start() + url.len();
    }
    push(out, style, &text[at..], false);
}

/// Inline content up to (not including) the next block-level start or end.
fn inlines(ev: &mut Events) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    // Styles nest: each opened tag pushes the style in force inside it.
    let mut styles = vec![Span::default()];
    loop {
        match ev.peek() {
            None | Some(Event::Rule) => break,
            Some(Event::End(end)) if !is_inline_end(end) => break,
            Some(Event::Start(tag)) if !is_inline_start(tag) => break,
            _ => {}
        }
        let style = styles.last().cloned().unwrap_or_default();
        match ev.next() {
            Some(Event::Text(t)) => push_text(&mut out, &style, &t),
            Some(Event::Html(t) | Event::InlineHtml(t) | Event::InlineMath(t) | Event::DisplayMath(t)) => push(&mut out, &style, &t, false),
            Some(Event::Code(t)) => push(&mut out, &style, &t, true),
            // CSS folds a newline inside a paragraph into a space.
            Some(Event::SoftBreak) => push(&mut out, &style, " ", false),
            Some(Event::HardBreak) => push(&mut out, &style, "\n", false),
            Some(Event::TaskListMarker(done)) => push(&mut out, &style, if done { "☑ " } else { "☐ " }, false),
            Some(Event::FootnoteReference(name)) => push(&mut out, &style, &format!("[{name}]"), false),
            Some(Event::Start(tag)) => styles.push(match tag {
                Tag::Emphasis => Span { italic: true, ..style },
                Tag::Strong => Span { bold: true, ..style },
                Tag::Strikethrough => Span { strike: true, ..style },
                // ponytail: a picture in a reply shows as a link to it. Fetch and draw it if models start sending them.
                Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => Span { link: Some(dest_url.to_string()), ..style },
                _ => style,
            }),
            Some(Event::End(_)) => {
                if styles.len() > 1 {
                    styles.pop();
                }
            }
            _ => {}
        }
    }
    out
}

// ------------------------------------------------------------------ drawing

/// The top and bottom margins a block ends up with. Margins of a first or last
/// child pass through a quote or a list item, as CSS margin collapsing has it.
fn margins(block: &Block) -> (f32, f32) {
    let through = |inner: &[Block], own: f32| (inner.first().map_or(own, |b| margins(b).0.max(own)), inner.last().map_or(own, |b| margins(b).1.max(own)));
    match block {
        Block::Para(_) | Block::Table { .. } => (GAP, GAP),
        Block::Heading(1..=3, _) => (SIZE, GAP),
        Block::Heading(..) | Block::Rule => (0.0, 0.0),
        Block::Code { .. } => (12.0, 12.0),
        Block::Quote(inner) => through(inner, GAP),
        Block::List(items) => (items.first().map_or(GAP, |i| through(i, GAP / 2.0).0.max(GAP)), items.last().map_or(GAP, |i| through(i, GAP / 2.0).1.max(GAP))),
    }
}

/// Draws `text`. Returns what was clicked in it, if anything.
pub fn show(ui: &mut Ui, text: &str, color: Color32, marks: &mut Option<Marks>) -> Option<Click> {
    // ponytail: parsed again every frame it is on screen. Cache per message if long replies stutter.
    let parsed = parse(text);
    let mut click = None;
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        // The prose box keeps its first and last margins inside itself.
        flow(ui, &parsed, color, false, &mut click, marks);
    });
    click
}

/// Blocks one under another with collapsed margins. `hoisted` means the outer
/// margins were already given to the parent.
fn flow(ui: &mut Ui, blocks: &[Block], color: Color32, hoisted: bool, click: &mut Option<Click>, marks: &mut Option<Marks>) {
    let mut below = 0.0_f32;
    for (i, block) in blocks.iter().enumerate() {
        let (top, bottom) = margins(block);
        match i {
            0 if hoisted => {}
            0 => ui.add_space(top),
            _ => ui.add_space(below.max(top)),
        }
        ui.push_id(i, |ui| draw(ui, block, color, click, marks));
        below = bottom;
    }
    if !hoisted {
        ui.add_space(below);
    }
}

/// A child area shifted right by `indent`, as wide as what is left.
pub fn indented(ui: &mut Ui, indent: f32, add: impl FnOnce(&mut Ui)) -> Rect {
    let mut rect = ui.available_rect_before_wrap();
    rect.min.x += indent;
    rect.max.y = f32::INFINITY;
    ui.scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
        ui.set_width(rect.width());
        add(ui)
    })
    .response
    .rect
}

fn draw(ui: &mut Ui, block: &Block, color: Color32, click: &mut Option<Click>, marks: &mut Option<Marks>) {
    let p = p();
    match block {
        Block::Para(spans) => text(ui, spans, color, 400.0, click, marks),
        Block::Heading(level, spans) => text(ui, spans, color, if *level <= 3 { 650.0 } else { 400.0 }, click, marks),
        Block::Code { lang, code } => code_block(ui, lang, code, click),
        Block::Rule => {
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
            ui.painter().rect_filled(rect, 0.0, color);
        }
        Block::Quote(inner) => {
            let left = ui.cursor().left();
            let used = indented(ui, 18.0, |ui| flow(ui, inner, p.text2, true, click, marks));
            ui.painter().rect_filled(Rect::from_min_max(pos2(left, used.top()), pos2(left + 3.0, used.bottom())), 0.0, p.accent);
        }
        Block::List(items) => {
            let mut below = 0.0_f32;
            for (i, item) in items.iter().enumerate() {
                let top = item.first().map_or(GAP / 2.0, |b| margins(b).0.max(GAP / 2.0));
                if i > 0 {
                    ui.add_space(below.max(top));
                }
                ui.push_id(i, |ui| indented(ui, SIZE * 1.5, |ui| flow(ui, item, color, true, click, marks)));
                below = item.last().map_or(GAP / 2.0, |b| margins(b).1.max(GAP / 2.0));
            }
        }
        Block::Table { head, rows } => table(ui, head, rows, color, marks),
    }
}

fn format(span: &Span, color: Color32, weight: f32) -> TextFormat {
    let p = p();
    let weight = if span.bold { weight.max(700.0) } else { weight };
    let mut f = TextFormat { font_id: theme::font(SIZE, W::Regular), color, line_height: Some(LINE), italics: span.italic, ..Default::default() };
    if weight != 400.0 {
        f.coords = egui::epaint::text::VariationCoords::new([("wght", weight)]);
    }
    if weight == 650.0 {
        f.extra_letter_spacing = -0.15;
    }
    if span.strike {
        f.strikethrough = Stroke::new(1.0, color);
    }
    if span.code {
        f.font_id = theme::mono(SIZE * 0.85);
    }
    if span.link.is_some() {
        f.color = p.accent_light;
    }
    f
}

/// What inline code keeps clear on each side of its text: 5.1 of padding and the border.
const CODE_PAD: f32 = 6.1;

fn job(spans: &[Span], color: Color32, weight: f32, wrap: f32) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = wrap;
    let mut after_code = false;
    for span in spans {
        let lead = if span.code { CODE_PAD } else { 0.0 } + if after_code { CODE_PAD } else { 0.0 };
        let style = format(span, color, weight);
        // Emoji keep their place in the line but are not drawn: `pictures` paints them in colour on top.
        let (mut at, mut lead) = (0, lead);
        for emoji in super::emoji::clusters(&span.text) {
            job.append(&span.text[at..emoji.start], lead, style.clone());
            job.append(&span.text[emoji.clone()], 0.0, TextFormat { color: Color32::TRANSPARENT, ..style.clone() });
            (at, lead) = (emoji.end, 0.0);
        }
        job.append(&span.text[at..], lead, style);
        after_code = span.code;
    }
    job
}

/// Paints the colour emoji of a laid-out text over the room `job` kept for them.
fn pictures(ui: &Ui, galley: &egui::Galley, spans: &[Span], origin: egui::Vec2, color: Color32) {
    let (mut ranges, mut found, mut at) = (Vec::new(), Vec::new(), 0);
    for span in spans {
        for emoji in super::emoji::clusters(&span.text) {
            let start = at + span.text[..emoji.start].chars().count();
            ranges.push(start..start + span.text[emoji.clone()].chars().count());
            found.push(&span.text[emoji]);
        }
        at += span.text.chars().count();
    }
    if ranges.is_empty() {
        return;
    }
    let row_height = galley.rows.first().map_or(LINE, |r| r.row.size.y);
    // One stretch per emoji: a cluster is never split across rows.
    for ([left, right, top, _], emoji) in runs(galley, &ranges).into_iter().zip(found) {
        super::emoji::paint(ui, emoji, pos2((left + right) / 2.0, top + row_height / 2.0) + origin, SIZE, color);
    }
}

/// Where the spans picked by `wanted` ended up: one stretch per span per row, as
/// (left, right, top of the row, baseline) in the galley's own coordinates.
/// egui's own backgrounds and underlines follow the line height, not the text, so these are drawn by hand.
fn stretches(galley: &egui::Galley, spans: &[Span], wanted: impl Fn(&Span) -> bool) -> Vec<[f32; 4]> {
    let mut ranges = Vec::new();
    let mut at = 0;
    for span in spans {
        let len = span.text.chars().count();
        if wanted(span) {
            ranges.push(at..at + len);
        }
        at += len;
    }
    runs(galley, &ranges)
}

/// Where character ranges of a laid-out text ended up: one stretch per range per
/// row, as (left, right, top of the row, baseline) in the galley's own coordinates.
pub fn runs(galley: &egui::Galley, ranges: &[std::ops::Range<usize>]) -> Vec<[f32; 4]> {
    let mut out = Vec::new();
    if ranges.is_empty() {
        return out;
    }
    let mut index = 0;
    for row in &galley.rows {
        let mut run: Option<(usize, [f32; 4])> = None;
        for glyph in &row.row.glyphs {
            let hit = ranges.iter().position(|r| r.contains(&index));
            let left = row.pos.x + glyph.pos.x;
            match (&mut run, hit) {
                (Some((range, at)), Some(hit)) if *range == hit => at[1] = left + glyph.advance_width,
                _ => {
                    out.extend(run.take().map(|(_, at)| at));
                    run = hit.map(|hit| (hit, [left, left + glyph.advance_width, row.pos.y, row.pos.y + glyph.pos.y]));
                }
            }
            index += 1;
        }
        out.extend(run.map(|(_, at)| at));
        index += row.ends_with_newline as usize;
    }
    out
}

/// The boxes behind inline code and the lines under links.
fn decorations(galley: &egui::Galley, spans: &[Span], origin: egui::Vec2) -> Vec<egui::Shape> {
    let p = p();
    let row_height = galley.rows.first().map_or(LINE, |r| r.row.size.y);
    let boxes = stretches(galley, spans, |s| s.code).into_iter().map(|[left, right, top, _]| {
        let centre = top + row_height / 2.0 + 0.75;
        let rect = Rect::from_x_y_ranges((left - CODE_PAD).max(0.0)..=right + CODE_PAD, centre - 11.4..=centre + 11.4);
        egui::Shape::Rect(egui::epaint::RectShape::new(rect.translate(origin), 8.0, p.elevated, Stroke::new(1.0, p.border), StrokeKind::Inside))
    });
    let lines = stretches(galley, spans, |s| s.link.is_some()).into_iter().map(|[left, right, _, baseline]| {
        let y = (baseline + 2.0).round() + 0.5;
        egui::Shape::line_segment([pos2(left, y) + origin, pos2(right, y) + origin], Stroke::new(1.0, p.accent_light))
    });
    boxes.chain(lines).collect()
}

/// A run of inline text. Selectable; links open in the browser.
fn text(ui: &mut Ui, spans: &[Span], color: Color32, weight: f32, click: &mut Option<Click>, marks: &mut Option<Marks>) {
    let mut job = job(spans, color, weight, ui.available_width());
    let hits = marks.as_mut().map_or(Vec::new(), |m| m.apply(&mut job));
    let galley = ui.painter().layout_job(job);
    // Reserved now so the boxes end up under the text.
    let under = ui.painter().add(egui::Shape::Noop);
    let found = ui.painter().add(egui::Shape::Noop);
    let response = ui.add(egui::Label::new(galley.clone()).selectable(true));
    ui.painter().set(under, egui::Shape::Vec(decorations(&galley, spans, response.rect.min.to_vec2())));
    if let Some(marks) = marks.as_mut().filter(|_| !hits.is_empty()) {
        marks.paint(ui, found, &galley, &hits, response.rect.min.to_vec2());
    }
    pictures(ui, &galley, spans, response.rect.min.to_vec2(), color);
    if !spans.iter().any(|s| s.link.is_some()) {
        return;
    }
    let Some(at) = response.hover_pos() else { return };
    let local = at - response.rect.min;
    let cursor = galley.cursor_from_pos(local);
    // The nearest caret can be far from the pointer (past a line's end): only a hit on the glyphs counts.
    let caret = galley.pos_from_cursor(cursor);
    if (caret.center().x - local.x).abs() > SIZE || local.y < caret.top() || local.y > caret.bottom() {
        return;
    }
    let mut seen = 0;
    for span in spans {
        let len = span.text.chars().count();
        if cursor.index.0 < seen + len {
            if let Some(url) = &span.link {
                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                if response.clicked() {
                    *click = Some(Click::Link(url.clone()));
                }
            }
            return;
        }
        seen += len;
    }
}

/// True for two seconds after `id` was marked copied.
fn copied(ui: &Ui, id: egui::Id) -> bool {
    let at: Option<f64> = ui.data(|d| d.get_temp(id));
    let fresh = at.is_some_and(|t| ui.input(|i| i.time) - t < 2.0);
    if fresh {
        ui.ctx().request_repaint_after(std::time::Duration::from_millis(200));
    }
    fresh
}

fn mark_copied(ui: &Ui, id: egui::Id) {
    let now = ui.input(|i| i.time);
    ui.data_mut(|d| d.insert_temp(id, now));
}

fn code_block(ui: &mut Ui, lang: &str, code: &str, click: &mut Option<Click>) {
    let p = p();
    let lines = code.split('\n').count();
    let id = ui.id().with("code");
    let was: Option<Rect> = ui.data(|d| d.get_temp(id));
    let hovered = was.is_some_and(|r| ui.rect_contains_pointer(r));
    let done = copied(ui, id.with("copied"));
    let width = ui.available_width();

    if lines > CARD_THRESHOLD {
        let t = widgets::fade(ui, id, hovered);
        let frame = egui::Frame::new().fill(widgets::lerp(p.bg2, p.bg3, t)).stroke(Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t))).corner_radius(12).inner_margin(egui::Margin::symmetric(12, 10));
        let shown = frame.show(ui, |ui| {
            ui.set_width(width - 26.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 12.0;
                let (tile, _) = ui.allocate_exact_size(vec2(36.0, 36.0), Sense::hover());
                ui.painter().rect_filled(tile, 8.0, p.elevated);
                icons::paint(ui, icons::CODE, tile.center(), 16.0, p.accent_light);
                let title = title_of(code).unwrap_or_else(|| if lang.is_empty() { "Snippet".to_string() } else { format!("{lang} snippet") });
                let mut copy = false;
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let (rect, response) = ui.allocate_exact_size(vec2(32.0, 32.0), Sense::click());
                    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(if done { "Copied" } else { "Copy code" });
                    if response.hovered() {
                        ui.painter().rect_filled(rect, 8.0, p.hover);
                    }
                    let (icon, colour) = if done { (icons::CHECK_THIN, p.success) } else { (icons::COPY_SMALL.stroke(1.7), if response.hovered() { p.text } else { p.muted }) };
                    icons::paint(ui, icon, rect.center(), 15.0, colour);
                    copy = response.clicked();
                    ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                        ui.add_space(0.5);
                        ui.add(egui::Label::new(widgets::lines(title.as_str(), 14.0, 20.0, W::Medium, p.text)).truncate().selectable(false));
                        ui.add(egui::Label::new(widgets::lines(format!("{} · {lines} lines · click to open", if lang.is_empty() { "text" } else { lang }), 11.0, 16.5, W::Regular, p.muted)).truncate().selectable(false));
                    });
                });
                (copy, title)
            })
            .inner
        });
        let rect = shown.response.rect;
        ui.data_mut(|d| d.insert_temp(id, rect));
        let (copy, title) = shown.inner;
        let whole = ui.interact(rect, id.with("open"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        if copy {
            mark_copied(ui, id.with("copied"));
            *click = Some(Click::Copy(code.to_string()));
        } else if whole.clicked() {
            *click = Some(Click::Open(title, lang.to_string(), code.to_string()));
        }
        return;
    }

    let frame = egui::Frame::new().fill(p.bg2).stroke(Stroke::new(1.0, p.border)).corner_radius(12);
    let shown = frame.show(ui, |ui| {
        ui.set_width(width - 2.0);
        // Header: the language on the left, Copy on the right once the block is hovered.
        let (bar, _) = ui.allocate_exact_size(vec2(width - 2.0, 40.0), Sense::hover());
        ui.painter().rect_filled(bar, CornerRadius { nw: 11, ne: 11, sw: 0, se: 0 }, p.bg3);
        let label = if lang.is_empty() { "CODE".to_string() } else { lang.to_uppercase() };
        let mut job = LayoutJob::simple_singleline(label, theme::mono(11.0), p.muted);
        job.sections[0].format.extra_letter_spacing = 0.55;
        widgets::text_at(ui, bar.left() + 14.0, bar.center().y, ui.painter().layout_job(job));
        if hovered || done {
            let text = widgets::galley(ui, if done { "Copied" } else { "Copy" }, theme::font(12.0, W::Medium), if done { p.success } else { p.text2 });
            let w = 10.0 + 14.0 + 6.0 + text.size().x + 10.0;
            let rect = Rect::from_min_size(pos2(bar.right() - 6.0 - w, bar.center().y - 14.0), vec2(w, 28.0));
            let response = ui.interact(rect, id.with("copy"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(if done { "Copied" } else { "Copy code" });
            if response.hovered() {
                ui.painter().rect_filled(rect, 8.0, p.hover);
            }
            let colour = if done { p.success } else if response.hovered() { p.text } else { p.text2 };
            icons::paint(ui, if done { icons::CHECK_THIN } else { icons::COPY_SMALL.stroke(1.7) }, pos2(rect.left() + 17.0, rect.center().y), 14.0, colour);
            let mut job = LayoutJob::simple_singleline(if done { "Copied" } else { "Copy" }.into(), theme::font(12.0, W::Medium), colour);
            job.wrap.max_width = f32::INFINITY;
            widgets::text_at(ui, rect.left() + 30.0, rect.center().y, ui.painter().layout_job(job));
            if response.clicked() {
                mark_copied(ui, id.with("copied"));
                *click = Some(Click::Copy(code.to_string()));
            }
        }
        let (line, _) = ui.allocate_exact_size(vec2(width - 2.0, 1.0), Sense::hover());
        ui.painter().rect_filled(line, 0.0, p.border);

        egui::ScrollArea::horizontal().id_salt(id.with("scroll")).show(ui, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::same(14)).show(ui, |ui| {
                let mut job = LayoutJob::simple(code.to_string(), theme::mono(12.25), p.text, f32::INFINITY);
                job.sections[0].format.line_height = Some(23.8);
                ui.add(egui::Label::new(job).selectable(true).extend());
            });
        });
    });
    ui.data_mut(|d| d.insert_temp(id, shown.response.rect));
}

/// `<title>…</title>` inside a page of HTML names its card.
fn title_of(code: &str) -> Option<String> {
    let lower = code.to_ascii_lowercase();
    let start = lower.find("<title>")? + 7;
    let end = start + lower[start..].find("</title>")?;
    let title = code.get(start..end)?.trim();
    (!title.is_empty() && title.chars().count() <= 60 && !title.contains('<')).then(|| title.to_string())
}

// ponytail: columns share the width in proportion to their longest cell, and a
// table wider than the column wraps instead of overflowing like the web app's.
fn table(ui: &mut Ui, head: &[Vec<Span>], rows: &[Vec<Vec<Span>>], color: Color32, marks: &mut Option<Marks>) {
    let p = p();
    const PAD: egui::Vec2 = vec2(11.25, 7.5);
    let columns = rows.iter().map(Vec::len).chain([head.len()]).max().unwrap_or(0);
    if columns == 0 {
        return;
    }
    let all = || std::iter::once((head, true)).chain(rows.iter().map(|r| (r.as_slice(), false)));
    let mut natural = vec![PAD.x * 2.0 + 8.0; columns];
    for (row, is_head) in all() {
        for (i, cell) in row.iter().enumerate() {
            let w = ui.painter().layout_job(job(cell, color, if is_head { 600.0 } else { 400.0 }, f32::INFINITY)).size().x + PAD.x * 2.0;
            natural[i] = natural[i].max(w);
        }
    }
    let width = ui.available_width();
    let total: f32 = natural.iter().sum();
    let widths: Vec<f32> = natural.iter().map(|w| w / total * width).collect();
    let border = Stroke::new(1.0, p.border);
    for (row, is_head) in all() {
        if row.is_empty() {
            continue;
        }
        let cells: Vec<_> = (0..columns)
            .map(|i| {
                let mut job = job(row.get(i).map_or(&[][..], Vec::as_slice), color, if is_head { 600.0 } else { 400.0 }, (widths[i] - PAD.x * 2.0).max(8.0));
                let hits = marks.as_mut().map_or(Vec::new(), |m| m.apply(&mut job));
                (ui.painter().layout_job(job), hits)
            })
            .collect();
        let height = cells.iter().map(|(g, _)| g.size().y).fold(LINE, f32::max) + PAD.y * 2.0 + 1.0;
        let (rect, _) = ui.allocate_exact_size(vec2(width, height), Sense::hover());
        let mut x = rect.left();
        for (i, (galley, hits)) in cells.into_iter().enumerate() {
            // Borders overlap by a pixel, as `border-collapse` draws them.
            let cell = Rect::from_min_size(pos2(x, rect.top()), vec2(widths[i] + if i + 1 < columns { 1.0 } else { 0.0 }, height + 1.0));
            ui.painter().rect(cell, 0.0, if is_head { p.elevated } else { Color32::TRANSPARENT }, border, StrokeKind::Inside);
            if let Some(marks) = marks.as_mut().filter(|_| !hits.is_empty()) {
                let found = ui.painter().add(egui::Shape::Noop);
                marks.paint(ui, found, &galley, &hits, vec2(x + PAD.x, rect.top() + PAD.y));
            }
            ui.painter().galley(pos2(x + PAD.x, rect.top() + PAD.y), galley, color);
            x += widths[i];
        }
    }
    ui.add_space(1.0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Span {
        Span { text: text.into(), ..Default::default() }
    }

    #[test]
    fn parses_what_replies_contain() {
        let parsed = parse("# Title\n\nSome **bold** and `code` and [a link](https://x.y).\n\n- one\n- two\n  - nested\n\n> quoted\n\n---\n\n```rust\nfn main() {}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert_eq!(parsed[0], Block::Heading(1, vec![plain("Title")]));
        let Block::Para(spans) = &parsed[1] else { panic!("{:?}", parsed[1]) };
        assert!(spans[1].bold && spans[3].code && spans[5].link.as_deref() == Some("https://x.y"));
        // A tight list: text straight in the item, the nested list after it.
        let Block::List(items) = &parsed[2] else { panic!("{:?}", parsed[2]) };
        assert_eq!(items[0], vec![Block::Para(vec![plain("one")])]);
        assert!(matches!(items[1].as_slice(), [Block::Para(_), Block::List(inner)] if inner.len() == 1));
        assert_eq!(parsed[3], Block::Quote(vec![Block::Para(vec![plain("quoted")])]));
        assert_eq!(parsed[4], Block::Rule);
        assert_eq!(parsed[5], Block::Code { lang: "rust".into(), code: "fn main() {}".into() });
        let Block::Table { head, rows } = &parsed[6] else { panic!("{:?}", parsed[6]) };
        assert_eq!((head.len(), rows.len(), &rows[0][1]), (2, 1, &vec![plain("2")]));
    }

    #[test]
    fn marks_split_the_job_at_every_hit() {
        let matcher = crate::find::Matcher::new("ab", false).unwrap();
        let mut marks = Marks { matcher: &matcher, active: Some(2), seen: 1, reveal: false, shown: false };
        let mut job = job(&[plain("xab "), Span { text: "abab".into(), bold: true, ..Default::default() }], Color32::GRAY, 400.0, 100.0);
        let hits = marks.apply(&mut job);
        // Three hits; the second of this text is the message's third, the focused one.
        assert_eq!(hits, [(1..3, false), (4..6, true), (6..8, false)]);
        assert_eq!(marks.seen, 4);
        let pieces: Vec<(&str, f32, Color32)> = job.sections.iter().map(|s| (&job.text[usize::from(s.byte_range.start)..usize::from(s.byte_range.end)], s.leading_space, s.format.color)).collect();
        let hit = Color32::from_rgb(0xed, 0xe9, 0xe2);
        assert_eq!(pieces, [("x", 0.0, Color32::GRAY), ("ab", 2.0, hit), (" ", 2.0, Color32::GRAY), ("ab", 2.0, Color32::WHITE), ("ab", 4.0, hit)]);
    }

    #[test]
    fn margins_collapse_like_css() {
        // h2 after p: the larger margin wins.
        assert_eq!(margins(&Block::Heading(2, vec![])), (15.0, 7.5));
        // A code block first in a quote pushes its 12px out through the quote.
        assert_eq!(margins(&Block::Quote(vec![Block::Code { lang: String::new(), code: String::new() }])), (12.0, 12.0));
        // A tight list keeps the list's own half em; items sit a quarter em apart.
        assert_eq!(margins(&Block::List(vec![vec![Block::Para(vec![])]])), (7.5, 7.5));
        assert_eq!(title_of("<html><title> My page </title>").as_deref(), Some("My page"));
    }
}
