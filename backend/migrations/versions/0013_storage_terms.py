"""Record acceptance of the drive and image host terms."""
import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("storage_plan") as batch:
        batch.add_column(sa.Column("terms_version", sa.String(), nullable=False, server_default=""))
        batch.add_column(sa.Column("terms_accepted_at", sa.String(), nullable=True))


def downgrade():
    with op.batch_alter_table("storage_plan") as batch:
        batch.drop_column("terms_accepted_at")
        batch.drop_column("terms_version")
