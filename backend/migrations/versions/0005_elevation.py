"""Short-lived identity verification for security settings."""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("login_session") as batch:
        batch.add_column(sa.Column("elevated_until", sa.Float(), nullable=False, server_default="0"))


def downgrade():
    with op.batch_alter_table("login_session") as batch:
        batch.drop_column("elevated_until")
