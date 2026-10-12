from alembic import context

from app.database import make_engine
from app.models import SQLModel
from app.settings import Settings

config = context.config
engine = config.attributes.get("engine")
if engine is None:
    engine = make_engine(Settings())

with engine.connect() as connection:
    context.configure(
        connection=connection, target_metadata=SQLModel.metadata, render_as_batch=True
    )
    with context.begin_transaction():
        context.run_migrations()
