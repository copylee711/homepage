from xml.etree.ElementTree import Element, SubElement, tostring

ATOM = "http://www.w3.org/2005/Atom"


def atom_feed(site: dict, posts: list[dict], site_url: str) -> bytes:
    """最近文章的 Atom 订阅，正文使用发布时已清洗的 HTML。"""
    root = Element("feed", xmlns=ATOM)
    SubElement(root, "title").text = f"{site['name']} · Articles"
    SubElement(root, "id").text = f"{site_url}/posts"
    SubElement(root, "link", href=f"{site_url}/posts")
    SubElement(root, "link", rel="self", href=f"{site_url}/feed.xml")
    SubElement(root, "updated").text = max(
        (p.get("updated_at") or p["published_at"] for p in posts), default="1970-01-01T00:00:00+00:00"
    )
    SubElement(SubElement(root, "author"), "name").text = site["name"]
    for post in posts:
        url = f"{site_url}/posts/{post['slug']}"
        entry = SubElement(root, "entry")
        SubElement(entry, "title").text = post["title"]
        SubElement(entry, "id").text = url
        SubElement(entry, "link", href=url)
        SubElement(entry, "published").text = post["published_at"]
        SubElement(entry, "updated").text = post.get("updated_at") or post["published_at"]
        SubElement(entry, "summary").text = post["summary"]
        SubElement(entry, "content", type="html").text = post["html"]
    return tostring(root, encoding="utf-8", xml_declaration=True)
