import nh3
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin

# 公式保留 TeX 原文，由前端 KaTeX 在浏览器渲染。
markdown = (
    # 允许 Markdown 中的 HTML（如 <br>、<sup>），输出统一经 nh3 白名单清洗。
    MarkdownIt("commonmark", {"html": True})
    .enable(["table", "strikethrough"])
    .use(dollarmath_plugin, double_inline=True)
)


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
            "s",
            "sub",
            "sup",
            "mark",
            "kbd",
            "details",
            "summary",
            "span",
            "div",
            "video",
            "source",
        },
        attributes={
            "a": {"href", "title"},
            "img": {"src", "alt", "title", "width", "height"},
            # 网络视频：只保留播放所需的属性，不允许 autoplay 等打扰读者的属性。
            "video": {"src", "controls", "width", "height", "poster", "preload", "playsinline", "loop", "muted"},
            "source": {"src", "type"},
            "ol": {"start"},
            "code": {"class"},
        },
        allowed_classes={"span": {"math", "inline"}, "div": {"math", "block"}},
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
    )
