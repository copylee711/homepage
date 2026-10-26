"""Collaborative documents, their members and saved versions."""
import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "doc",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("state", sa.LargeBinary(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("link_token", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("link_role", sa.String(), nullable=False, server_default="none"),
        sa.Column("link_password_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("link_expires_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("allow_copy", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("updated_by", sa.String(), nullable=False, server_default=""),
    )
    op.create_table(
        "doc_member",
        sa.Column("doc_id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), primary_key=True, index=True),
        sa.Column("role", sa.String(), nullable=False, server_default="view"),
        sa.Column("can_share", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("added_by", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "doc_version",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("doc_id", sa.String(), nullable=False, index=True),
        sa.Column("state", sa.LargeBinary(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("label", sa.String(), nullable=False, server_default=""),
        sa.Column("auto", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.Float(), nullable=False, index=True),
        sa.Column("created_by", sa.String(), nullable=False, server_default=""),
    )


def downgrade():
    op.drop_table("doc_version")
    op.drop_table("doc_member")
    op.drop_table("doc")
