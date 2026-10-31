"""Explicit GitHub identity bindings; no changes to existing accounts or sessions."""
import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "github_identity",
        sa.Column("github_id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("user.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("login", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index("ix_github_identity_user_id", "github_identity", ["user_id"], unique=True)


def downgrade():
    op.drop_table("github_identity")
