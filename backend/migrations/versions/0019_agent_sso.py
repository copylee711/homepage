"""Independent, revocable first-party Agent sessions."""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "agent_session",
        sa.Column("token_hash", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("user.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("parent_hash", sa.String(),
                  sa.ForeignKey("user_session.token_hash", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )
    op.create_index("ix_agent_session_user_id", "agent_session", ["user_id"])
    op.create_index("ix_agent_session_parent_hash", "agent_session", ["parent_hash"])


def downgrade():
    op.drop_table("agent_session")
