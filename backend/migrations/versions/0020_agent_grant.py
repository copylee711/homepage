"""Explicit expiring Agent execution grants."""
import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = depends_on = None


def upgrade():
    op.create_table("agent_grant",
                    sa.Column("user_id", sa.String(), sa.ForeignKey("user.id", ondelete="CASCADE"), primary_key=True),
                    sa.Column("expires_at", sa.Float(), nullable=False),
                    sa.Column("granted_by", sa.String(), nullable=False),
                    sa.Column("updated_at", sa.Float(), nullable=False))


def downgrade():
    op.drop_table("agent_grant")
