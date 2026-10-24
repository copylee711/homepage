"""网盘操作错误；Web、SFTP、WebDAV 各自把它翻译成协议里的错误码。"""


class DriveError(Exception):
    status = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Invalid(DriveError):
    status = 400


class Forbidden(DriveError):
    status = 403


class NotFound(DriveError):
    status = 404


class Conflict(DriveError):
    status = 409


class QuotaExceeded(DriveError):
    status = 413
