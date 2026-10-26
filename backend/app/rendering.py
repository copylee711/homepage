from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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


# 允许嵌入的视频站播放器，与前端 src/components/editor/embeds.ts 一致；其他 iframe 的 src 会被清掉。
EMBED_PREFIXES = (
    "https://player.bilibili.com/player.html",
    "https://www.youtube-nocookie.com/embed/",
    "https://www.youtube.com/embed/",
    "https://player.vimeo.com/video/",
    "https://v.qq.com/txp/iframe/player.html",
    "https://player.youku.com/embed/",
)


def embed_src(value: str) -> str | None:
    src = value.strip().replace("&amp;", "&")
    if src.startswith("//"):
        src = "https:" + src
    if src.startswith("http://"):
        src = "https://" + src[len("http://"):]
    if not src.startswith(EMBED_PREFIXES):
        return None
    if src.startswith(EMBED_PREFIXES[0]):
        # 哔哩哔哩的外链播放器默认自动播放，发布页上关掉。
        parts = urlsplit(src)
        query = dict(parse_qsl(parts.query))
        query.setdefault("autoplay", "0")
        query["isOutside"] = "true"
        src = urlunsplit(parts._replace(query=urlencode(query)))
    return src


def filter_attribute(tag: str, attribute: str, value: str) -> str | None:
    if tag == "iframe" and attribute == "src":
        return embed_src(value)
    return value


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
            "iframe",
        },
        attributes={
            "a": {"href", "title"},
            "img": {"src", "alt", "title", "width", "height"},
            # 网络视频：只保留播放所需的属性，不允许 autoplay 等打扰读者的属性。
            "video": {"src", "controls", "width", "height", "poster", "preload", "playsinline", "loop", "muted"},
            "source": {"src", "type"},
            "iframe": {"src", "width", "height", "title", "allowfullscreen"},
            "ol": {"start"},
            "code": {"class"},
        },
        allowed_classes={"span": {"math", "inline"}, "div": {"math", "block"}},
        attribute_filter=filter_attribute,
        # 嵌入播放器统一加上沙箱与安全属性，不信任原文里写的这些属性。
        set_tag_attribute_values={"iframe": {
            "sandbox": "allow-scripts allow-same-origin allow-popups allow-presentation",
            "allow": "fullscreen; picture-in-picture; encrypted-media",
            "referrerpolicy": "strict-origin-when-cross-origin",
            "loading": "lazy",
            "allowfullscreen": "",
        }},
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
    )
