"""Check actual CDN cache keys: entry assets must load, missing assets must not cache."""

import sys
import uuid
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        path = attrs.get("src") if tag == "script" else attrs.get("href") if tag == "link" else None
        if path and path.startswith("/assets/"):
            self.paths.add(path)


def fetch(url):
    try:
        return urlopen(Request(url, headers={"User-Agent": "CopyLee-deploy-check"}), timeout=30)
    except HTTPError as error:
        return error


def check(base):
    with fetch(base.rstrip("/") + "/") as response:
        if response.status != 200:
            raise RuntimeError(f"Homepage returned {response.status}")
        entry = EntryAssets()
        entry.feed(response.read().decode("utf-8"))
    if not any(path.endswith(".js") for path in entry.paths) or not any(path.endswith(".css") for path in entry.paths):
        raise RuntimeError("Homepage did not reference both JS and CSS assets")
    for path in sorted(entry.paths):
        # Do not append a query: that would bypass the cache key used by browsers.
        with fetch(urljoin(base, path)) as response:
            mime = response.headers.get_content_type()
            allowed = {"text/css"} if path.endswith(".css") else {"text/javascript", "application/javascript"}
            if response.status != 200 or mime not in allowed:
                raise RuntimeError(f"{path}: status={response.status}, type={mime}")
            print(f"PASS {path}: 200 {mime}")
    path = f"/assets/__deploy_missing_{uuid.uuid4().hex}.js"
    with fetch(urljoin(base, path)) as response:
        cache = response.headers.get("Cache-Control", "").lower()
        if response.status != 404 or "no-store" not in cache or "immutable" in cache:
            raise RuntimeError(f"Missing asset: status={response.status}, Cache-Control={cache}")
        print("PASS missing asset: 404, no-store")


if __name__ == "__main__":
    check(sys.argv[1] if len(sys.argv) > 1 else "https://copylee.cn")
