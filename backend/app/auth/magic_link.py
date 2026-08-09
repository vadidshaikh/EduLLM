import secrets
from datetime import datetime, timedelta, timezone

from app.auth.jwt import AuthError
from app.db.queries import get_login_token, insert_login_token, mark_login_token_used


def generate_login_token(email: str, expiry_minutes: int) -> str:
    """Creates a random one-time login token for an email address, saves it
    with an expiry time, and returns it so it can be put into a magic link.
    """
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(tz=timezone.utc) + timedelta(minutes=expiry_minutes)
    insert_login_token(token, email, expires_at)
    return token


def consume_login_token(token: str) -> str:
    """Validate a magic-link token single-use and within its expiry window,
    mark it used, and return the email it was issued for.
    """
    row = get_login_token(token)
    if row is None:
        raise AuthError("invalid login link")
    if row["used"]:
        raise AuthError("login link already used")
    if row["expires_at"] < datetime.now(tz=timezone.utc):
        raise AuthError("login link expired")

    mark_login_token_used(token)
    return row["email"]
