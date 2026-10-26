"""Where images pasted into documents are stored."""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("doc") as batch:
        batch.add_column(sa.Column("image_target", sa.String(), nullable=False, server_default=""))
        batch.add_column(sa.Column("image_custom", sa.JSON(), nullable=True))
    op.create_table(
        "doc_image_setting",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("target", sa.String(), nullable=False, server_default="builtin"),
        sa.Column("custom", sa.JSON(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_table("doc_image_setting")
    with op.batch_alter_table("doc") as batch:
        batch.drop_column("image_custom")
        batch.drop_column("image_target")
