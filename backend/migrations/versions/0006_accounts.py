"""Visitor accounts: email signup, favorites, history and mail settings."""
import json

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = depends_on = None

DOMAINS = [
    "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn",
    "sohu.com", "aliyun.com", "139.com", "189.cn", "gmail.com", "outlook.com",
    "hotmail.com", "live.com", "icloud.com", "me.com", "yahoo.com", "proton.me",
    "protonmail.com", "mail.scut.edu.cn",
]
CONFIG = {
    "registrationOpen": False,
    "allowedDomains": DOMAINS,
    "dailyLimit": 100,
    "smtp": {"host": "smtp.qq.com", "port": 465, "security": "ssl", "username": "",
             "fromName": "Copy Lee", "fromAddress": ""},
    "smtpPassword": "",
}


def upgrade():
    op.create_table(
        "user",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("avatar", sa.String(), nullable=False, server_default=""),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("last_login", sa.String()),
    )
    op.create_table(
        "user_session",
        sa.Column("token_hash", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("csrf", sa.String(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "email_code",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False, index=True),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("code_hash", sa.String(), nullable=False),
        sa.Column("ip_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )
    for name, column in (("favorite", "created_at"), ("history", "viewed_at")):
        op.create_table(
            name,
            sa.Column("user_id", sa.String(), primary_key=True),
            sa.Column("kind", sa.String(), primary_key=True),
            sa.Column("slug", sa.String(), primary_key=True),
            sa.Column("title", sa.String(), nullable=False, server_default=""),
            sa.Column(column, sa.String(), nullable=False, index=True),
        )
    op.create_table(
        "scut_reading",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT 1 FROM content WHERE key = 'site'")).first():
        bind.execute(
            sa.text("INSERT INTO content (key, value, revision) VALUES ('accounts', :v, 1)"),
            {"v": json.dumps(CONFIG)},
        )


def downgrade():
    for table in ("scut_reading", "history", "favorite", "email_code", "user_session", "user"):
        op.drop_table(table)
    op.execute("DELETE FROM content WHERE key = 'accounts'")
