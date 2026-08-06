import datetime

import jwt as pyjwt

from app.config import settings

VALID_ROLES = {"student", "faculty"}


class AuthError(Exception):
    """Raised for any invalid/expired/malformed token or unrecognized role."""


def create_session_token(claims: dict, expiry_days: int) -> str:
    """Issue Edu LLM's own session JWT after a magic link is verified. Same
    signing key/algorithm as before — only the issuer changes from the old
    external auth service to this one, so every downstream consumer of
    verify_token() is unaffected.
    """
    now = datetime.datetime.now(tz=datetime.timezone.utc)
    payload = {**claims, "iat": now, "exp": now + datetime.timedelta(days=expiry_days)}
    return pyjwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def verify_token(token: str) -> dict:
    """Decode and validate a JWT, returning its claims.

    This is the single place the raw token is ever parsed — callers get back
    trusted claims or an AuthError, never a role from anywhere else (e.g. the
    request body).
    """
    try:
        claims = pyjwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except pyjwt.ExpiredSignatureError as exc:
        raise AuthError("token expired") from exc
    except pyjwt.InvalidTokenError as exc:
        raise AuthError("invalid token") from exc

    if "sub" not in claims or "role" not in claims:
        raise AuthError("token missing required claims")
    if claims["role"] not in VALID_ROLES:
        raise AuthError(f"unrecognized role: {claims['role']!r}")

    return claims
