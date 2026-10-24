"""Administrators become flagged site users; feedback inbox."""
import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("user") as table:
        table.add_column(sa.Column("is_admin", sa.Boolean(), nullable=False, server_default="0"))
    with op.batch_alter_table("login_session") as table:
        table.add_column(sa.Column("user_id", sa.String(), nullable=False, server_default=""))
    # 旧的独立管理员会话不再有效，需要用站点账户重新登录后台。
    op.execute("DELETE FROM login_session")
    op.create_table(
        "feedback",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("category", sa.String(), nullable=False, server_default="suggestion"),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("page", sa.String(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="new", index=True),
        sa.Column("reply", sa.String(), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(), nullable=False, server_default="", index=True),
        sa.Column("created_at", sa.Float(), nullable=False, index=True),
        sa.Column("replied_at", sa.Float()),
    )


def downgrade():
    op.drop_table("feedback")
    with op.batch_alter_table("login_session") as table:
        table.drop_column("user_id")
    with op.batch_alter_table("user") as table:
        table.drop_column("is_admin")
