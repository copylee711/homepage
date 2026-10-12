"""SCUT list metadata and resumable sync state."""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = depends_on = None


def upgrade():
    op.create_table("scut_notice",
                    sa.Column("url", sa.String(), primary_key=True),
                    sa.Column("title", sa.String(), nullable=False),
                    sa.Column("published_at", sa.String()),
                    sa.Column("first_seen", sa.String(), nullable=False))
    op.create_table("scut_membership",
                    sa.Column("url", sa.String(), sa.ForeignKey("scut_notice.url"), primary_key=True),
                    sa.Column("column_id", sa.String(), primary_key=True))
    op.create_table("scut_column",
                    sa.Column("id", sa.String(), primary_key=True),
                    sa.Column("last_success", sa.String()),
                    sa.Column("last_attempt", sa.String()),
                    sa.Column("last_error", sa.String(), nullable=False, server_default=""),
                    sa.Column("initialized", sa.Boolean(), nullable=False, server_default="0"),
                    sa.Column("scan_page", sa.Integer(), nullable=False, server_default="1"),
                    sa.Column("scan_started", sa.String()),
                    sa.Column("last_full_scan", sa.String()),
                    sa.Column("pages_scanned", sa.Integer(), nullable=False, server_default="0"),
                    sa.Column("total_pages", sa.Integer()),
                    sa.Column("revision", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_table("scut_membership")
    op.drop_table("scut_notice")
    op.drop_table("scut_column")
