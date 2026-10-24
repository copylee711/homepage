from sqlalchemy import event
from sqlmodel import create_engine

from .settings import Settings


def make_engine(settings: Settings):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    settings.media_dir.chmod(0o755)
    settings.images_dir.mkdir(exist_ok=True)
    settings.images_dir.chmod(0o755)
    engine = create_engine(
        f"sqlite:///{settings.db_path.resolve().as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )

    @event.listens_for(engine, "connect")
    def configure(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    return engine
