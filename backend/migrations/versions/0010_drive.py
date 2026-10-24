"""Cloud drive: storage plans shared with the image host, mounts, credentials and shares."""
import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "storage_plan",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("drive_enabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("images_enabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("quota_bytes", sa.Integer(), nullable=False),
        sa.Column("max_image_bytes", sa.Integer(), nullable=False),
    )
    op.execute(
        "INSERT INTO storage_plan (user_id, drive_enabled, images_enabled, quota_bytes, "
        "max_image_bytes) SELECT user_id, 0, enabled, quota_bytes, max_file_bytes FROM image_quota"
    )
    op.drop_table("image_quota")
    op.create_table(
        "drive_account",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("login", sa.String(), nullable=False),
        sa.Column("login_key", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("legacy_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "drive_mount",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("location", sa.String(), nullable=False),
        sa.Column("quota_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("read_only", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("used_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("used_files", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.UniqueConstraint("user_id", "path"),
    )
    op.create_table(
        "drive_credential",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("secret", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False, server_default="", index=True),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("last_used", sa.Float()),
    )
    op.create_table(
        "drive_share",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("paths", sa.JSON(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False, server_default="read"),
        sa.Column("password_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("expires_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("max_uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("last_used", sa.Float()),
    )
    op.create_table(
        "drive_upload",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("received", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )


def downgrade():
    for table in ("drive_upload", "drive_share", "drive_credential", "drive_mount",
                  "drive_account"):
        op.drop_table(table)
    op.create_table(
        "image_quota",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("quota_bytes", sa.Integer(), nullable=False),
        sa.Column("max_file_bytes", sa.Integer(), nullable=False),
    )
    op.execute(
        "INSERT INTO image_quota (user_id, enabled, quota_bytes, max_file_bytes) "
        "SELECT user_id, images_enabled, quota_bytes, max_image_bytes FROM storage_plan"
    )
    op.drop_table("storage_plan")
