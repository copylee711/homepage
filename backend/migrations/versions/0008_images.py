"""Image hosting: per-user quota, upload tokens and image records."""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "image_quota",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("quota_bytes", sa.Integer(), nullable=False),
        sa.Column("max_file_bytes", sa.Integer(), nullable=False),
    )
    op.create_table(
        "image_token",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("owner", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("last_used", sa.String()),
    )
    op.create_table(
        "image",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner", sa.String(), nullable=False, index=True),
        sa.Column("path", sa.String(), nullable=False, unique=True),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False, index=True),
        sa.Column("created_at", sa.String(), nullable=False, index=True),
    )


def downgrade():
    for table in ("image", "image_token", "image_quota"):
        op.drop_table(table)
