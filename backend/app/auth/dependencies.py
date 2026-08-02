from fastapi import Depends, Header, HTTPException, status

from app.auth.jwt import AuthError, verify_token


def get_claims(authorization: str = Header(default="")) -> dict:
    """Verify the bearer token on every request. This is the only place a
    request's role is ever trusted from — never from the request body.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        return verify_token(token)
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc


def require_faculty(claims: dict = Depends(get_claims)) -> dict:
    if claims["role"] != "faculty":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "faculty access required")
    return claims
