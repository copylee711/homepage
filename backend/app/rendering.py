import nh3
from markdown_it import MarkdownIt

markdown = MarkdownIt("commonmark", {"html": False}).enable("table")


def render_markdown(source: str) -> str:
    return nh3.clean(
        markdown.render(source),
        tags={
            "p",
            "br",
            "hr",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "strong",
            "em",
            "blockquote",
            "ul",
            "ol",
            "li",
            "pre",
            "code",
            "a",
            "img",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
        },
        attributes={
            "a": {"href", "title"},
            "img": {"src", "alt", "title"},
            "ol": {"start"},
            "code": {"class"},
        },
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
    )
