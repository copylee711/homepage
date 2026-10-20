"""Notes from GitHub or the admin, social links, and the Notion entry removal."""
import json

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = depends_on = None

NOTES_CONFIG = {
    "repo": "copylee711/notes",
    "branch": "master",
    "autoPublish": True,
    "exclude": [".*", "docs", "node_modules", "README.md"],
    "last_commit": "",
    "last_success": None,
    "last_error": "",
}


def upgrade():
    op.create_table(
        "note",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("slug", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("summary", sa.String(), nullable=False, server_default=""),
        sa.Column("category", sa.String(), nullable=False, server_default=""),
        sa.Column("markdown", sa.Text(), nullable=False),
        sa.Column("html", sa.Text(), nullable=False),
        sa.Column("source", sa.String(), nullable=False, server_default="manual"),
        sa.Column("path", sa.String(), unique=True),
        sa.Column("sha", sa.String(), nullable=False, server_default=""),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    bind = op.get_bind()
    row = bind.execute(sa.text("SELECT value FROM content WHERE key = 'site'")).first()
    if row is None:
        return  # 尚未 seed，初始化时写入新结构。
    site = json.loads(row[0]) if isinstance(row[0], str) else dict(row[0])
    site.pop("notes", None)
    site.setdefault("socials", [
        {"platform": "github", "url": f"https://github.com/{site['github']}", "visible": True},
        {"platform": "linkedin", "url": "https://www.linkedin.com/in/fuzhi-lee-8517b9441",
         "visible": True},
        {"platform": "instagram", "url": "", "visible": False},
    ])
    for portal in site.get("portals", []):
        if portal.get("icon") == "note":
            portal.update(href="/notes", hint="copylee.cn/notes")
    bind.execute(
        sa.text("UPDATE content SET value = :value, revision = revision + 1 WHERE key = 'site'"),
        {"value": json.dumps(site, ensure_ascii=False)},
    )
    bind.execute(
        sa.text("INSERT INTO content (key, value, revision) VALUES ('notes', :value, 1)"),
        {"value": json.dumps(NOTES_CONFIG)},
    )


def downgrade():
    op.drop_table("note")
    op.execute("DELETE FROM content WHERE key = 'notes'")
