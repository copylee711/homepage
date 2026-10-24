"""Images referenced by articles and notes move to the system image host."""
import json
import re

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = depends_on = None

PATH = re.compile(r"\d{4}/\d{2}/[A-Za-z0-9]{12}\.(?:jpg|png|webp|gif)")


def upgrade():
    connection = op.get_bind()
    texts = [json.dumps([draft, published], ensure_ascii=False) if not isinstance(draft, str)
             else f"{draft}{published or ''}"
             for draft, published in connection.execute(sa.text("SELECT draft, published FROM article"))]
    texts += [f"{markdown}{html}" for markdown, html in
              connection.execute(sa.text("SELECT markdown, html FROM note"))]
    used = {match for text in texts for match in PATH.findall(text)}
    for path in used:
        connection.execute(sa.text("UPDATE image SET owner = 'system' WHERE path = :path"),
                           {"path": path})


def downgrade():
    # 无法区分原归属；系统图片保留为 system。
    pass
