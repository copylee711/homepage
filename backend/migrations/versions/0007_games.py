"""Mini game best scores for the public leaderboard."""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "game_score",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("game", sa.String(), primary_key=True),
        sa.Column("best", sa.Integer(), nullable=False, index=True),
        sa.Column("detail", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("plays", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("best_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )


def downgrade():
    op.drop_table("game_score")
