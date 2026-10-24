from __future__ import annotations

"""对象存储接口；生产环境用阿里云 OSS SDK，测试用 tests 里的内存实现。"""

import io
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class ObjectInfo:
    key: str
    size: int
    mtime: float
    etag: str


class IterReader(io.RawIOBase):
    """把分块迭代器包装成可 read(n) 的文件对象。"""

    def __init__(self, chunks, closer):
        self.chunks = iter(chunks)
        self.closer = closer
        self.buffer = b""

    def readable(self):
        return True

    def readinto(self, target) -> int:
        while not self.buffer:
            try:
                self.buffer = next(self.chunks)
            except StopIteration:
                return 0
        size = min(len(target), len(self.buffer))
        target[:size] = self.buffer[:size]
        self.buffer = self.buffer[size:]
        return size

    def close(self):
        if not self.closed:
            self.closer()
        super().close()


def timestamp(value: datetime | None) -> float:
    return value.timestamp() if value else 0


class OssStore:
    def __init__(self, settings):
        import alibabacloud_oss_v2 as oss

        self.oss = oss
        config = oss.config.load_default()
        config.credentials_provider = oss.credentials.StaticCredentialsProvider(
            settings.oss_access_key_id, settings.oss_access_key_secret
        )
        config.region = settings.oss_region
        if settings.oss_endpoint:
            config.endpoint = settings.oss_endpoint
        self.client = oss.Client(config)
        self.bucket = settings.oss_bucket

    def missing(self, error) -> bool:
        cause = error.unwrap() if hasattr(error, "unwrap") else error
        return getattr(cause, "status_code", None) == 404

    def list(self, prefix: str, delimiter: str = "/", limit: int | None = None):
        objects, prefixes, token = [], [], None
        while True:
            result = self.client.list_objects_v2(self.oss.ListObjectsV2Request(
                bucket=self.bucket, prefix=prefix, delimiter=delimiter or None,
                max_keys=limit or 1000, continuation_token=token,
            ))
            objects += [ObjectInfo(item.key, item.size or 0, timestamp(item.last_modified),
                                   (item.etag or "").strip('"')) for item in result.contents or []]
            prefixes += [item.prefix for item in result.common_prefixes or []]
            token = result.next_continuation_token
            if limit or not result.is_truncated or not token:
                return objects, prefixes

    def head(self, key: str) -> ObjectInfo | None:
        if key.endswith("/") or not key:
            return None
        try:
            result = self.client.head_object(self.oss.HeadObjectRequest(bucket=self.bucket, key=key))
        except self.oss.exceptions.OperationError as error:
            if self.missing(error):
                return None
            raise
        return ObjectInfo(key, result.content_length or 0, timestamp(result.last_modified),
                          (result.etag or "").strip('"'))

    def get(self, key: str, offset: int = 0):
        request = self.oss.GetObjectRequest(bucket=self.bucket, key=key,
                                            range_header=f"bytes={offset}-" if offset else None)
        body = self.client.get_object(request).body
        return io.BufferedReader(IterReader(body.iter_bytes(block_size=256 * 1024), body.close),
                                 256 * 1024)

    def put_file(self, key: str, path: Path):
        self.client.uploader().upload_file(
            self.oss.PutObjectRequest(bucket=self.bucket, key=key), str(path)
        )

    def put_bytes(self, key: str, data: bytes):
        self.client.put_object(self.oss.PutObjectRequest(bucket=self.bucket, key=key, body=data))

    def delete(self, keys: "list[str]"):
        for start in range(0, len(keys), 1000):
            batch = [self.oss.DeleteObject(key=key) for key in keys[start:start + 1000]]
            self.client.delete_multiple_objects(self.oss.DeleteMultipleObjectsRequest(
                bucket=self.bucket, objects=batch, quiet=True,
            ))

    def copy(self, source: str, target: str, size: int, spool):
        self.client.copier().copy(self.oss.CopyObjectRequest(
            bucket=self.bucket, key=target, source_bucket=self.bucket, source_key=source,
        ))


_store = None


def use_store(store):
    """替换对象存储实现（测试用）。"""
    global _store
    _store = store


def oss_store(settings):
    global _store
    if _store is None and settings.oss_bucket and settings.oss_access_key_id:
        _store = OssStore(settings)
    return _store
