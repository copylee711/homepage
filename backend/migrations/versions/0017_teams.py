"""Teams: shared storage carved out of the owner's quota, members, and team documents."""
import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0015"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "team",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False, server_default=""),
        sa.Column("quota_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("used_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("used_files", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "team_member",
        sa.Column("team_id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), primary_key=True, index=True),
        sa.Column("role", sa.String(), nullable=False, server_default="view"),
        sa.Column("added_by", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    with op.batch_alter_table("doc") as batch:
        batch.add_column(sa.Column("team_id", sa.String(), nullable=False, server_default=""))
        batch.add_column(sa.Column("folder", sa.String(), nullable=False, server_default="/"))
        batch.add_column(sa.Column("markdown", sa.String(), nullable=False, server_default=""))
        batch.create_index("ix_doc_team_id", ["team_id"])
    with op.batch_alter_table("drive_upload") as batch:
        batch.add_column(sa.Column("team_id", sa.String(), nullable=False, server_default=""))


def downgrade():
    with op.batch_alter_table("drive_upload") as batch:
        batch.drop_column("team_id")
    with op.batch_alter_table("doc") as batch:
        batch.drop_index("ix_doc_team_id")
        batch.drop_column("markdown")
        batch.drop_column("folder")
        batch.drop_column("team_id")
    op.drop_table("team_member")
    op.drop_table("team")
