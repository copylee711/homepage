"""Friends, friend requests, invite links and direct messages."""
import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "friendship",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("friend_id", sa.String(), primary_key=True, index=True),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "friend_request",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("from_id", sa.String(), nullable=False, index=True),
        sa.Column("to_id", sa.String(), nullable=False, index=True),
        sa.Column("message", sa.String(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="pending", index=True),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("responded_at", sa.Float(), nullable=True),
    )
    op.create_table(
        "friend_invite",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("token", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "message",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("sender_id", sa.String(), nullable=False, index=True),
        sa.Column("recipient_id", sa.String(), nullable=False, index=True),
        sa.Column("kind", sa.String(), nullable=False, server_default="text"),
        sa.Column("body", sa.String(), nullable=False, server_default=""),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=False, index=True),
        sa.Column("updated_at", sa.Float(), nullable=False, index=True),
        sa.Column("read_at", sa.Float(), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_table("message")
    op.drop_table("friend_invite")
    op.drop_table("friend_request")
    op.drop_table("friendship")
