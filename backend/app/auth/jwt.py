import jwt as pyjwt

from app.config import settings

VALID_ROLES = {"student", "faculty"}


class AuthError(Exception):
    """Raised for any invalid/expired/malformed token or unrecognized role."""


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
