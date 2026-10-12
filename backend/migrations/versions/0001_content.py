"""Initial content schema (frozen migration, independent of future models)."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "content",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_table(
        "article",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("draft", sa.JSON(), nullable=False),
        sa.Column("published", sa.JSON()),
        sa.Column("slug_locked", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    op.create_index("ix_article_slug", "article", ["slug"], unique=True)
    op.create_table(
        "administrator",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
    )
    op.create_table(
        "login_session",
        sa.Column("token_hash", sa.String(), primary_key=True),
        sa.Column("csrf", sa.String(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "login_attempt",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("failures", sa.Integer(), nullable=False),
        sa.Column("window_start", sa.Float(), nullable=False),
    )


def downgrade():
    for table in ("login_attempt", "login_session", "administrator", "article", "content"):
        op.drop_table(table)
