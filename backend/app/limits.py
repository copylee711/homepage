from starlette.responses import JSONResponse

# 图片上传接口自行按配额限制读取大小，不经过 2 MiB 的 JSON 限制。
UPLOAD_PATHS = {"/api/admin/media", "/api/upload", "/api/account/images"}


class JsonBodyLimit:
    """在 JSON 解析前限制内存，亦适用于无 Content-Length 的分块请求。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        limited = (
            scope["type"] == "http"
            and scope["path"].startswith("/api/")
            and scope["path"] not in UPLOAD_PATHS
            and scope["method"] not in {"GET", "HEAD", "OPTIONS"}
        )
        if not limited:
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            size += len(body)
            if size > 2 * 1024 * 1024:
                response = JSONResponse({"detail": "请求内容不能超过 2 MiB"}, status_code=413)
                return await response(scope, receive, send)
            chunks.append(body)
            if not message.get("more_body", False):
                break
        pending = True

        async def replay():
            nonlocal pending
            if pending:
                pending = False
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
