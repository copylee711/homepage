"""Optional TOTP and passkeys for visitor accounts."""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("user") as table:
        table.add_column(sa.Column("totp_secret", sa.String()))
        table.add_column(sa.Column("pending_secret", sa.String()))
        table.add_column(sa.Column("pending_expires", sa.Float(), nullable=False, server_default="0"))
        table.add_column(sa.Column("last_totp_step", sa.Integer(), nullable=False, server_default="-1"))
        table.add_column(sa.Column("recovery_hashes", sa.JSON(), nullable=False, server_default="[]"))
    op.create_table(
        "user_passkey",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("public_key", sa.String(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("last_used", sa.Float()),
    )
    op.create_table(
        "user_challenge",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("challenge", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False, server_default=""),
        sa.Column("session_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(), nullable=False, server_default="", index=True),
        sa.Column("expires_at", sa.Float(), nullable=False),
    )


def downgrade():
    op.drop_table("user_challenge")
    op.drop_table("user_passkey")
    with op.batch_alter_table("user") as table:
        for name in ("totp_secret", "pending_secret", "pending_expires", "last_totp_step",
                     "recovery_hashes"):
            table.drop_column(name)
