from fastapi import APIRouter, HTTPException, status

from app.api.schemas import LoginRequest, LoginResponse, TokenResponse, VerifyRequest
from app.auth.email_rules import EmailFormatError, parse_institute_email
from app.auth.jwt import AuthError, create_session_token
from app.auth.magic_link import consume_login_token, generate_login_token
from app.auth.mailer import send_magic_link
from app.config import settings

router = APIRouter()


@router.post("/auth/login", response_model=LoginResponse)
def request_login(body: LoginRequest) -> LoginResponse:
    try:
        parse_institute_email(body.email)
    except EmailFormatError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    email = body.email.strip().lower()
    token = generate_login_token(email, settings.LOGIN_TOKEN_EXPIRY_MINUTES)
    link = f"{settings.MAGIC_LINK_BASE_URL}?token={token}"
    send_magic_link(email, link)

    return LoginResponse(detail="Check your email for a sign-in link.")


@router.post("/auth/verify", response_model=TokenResponse)
def verify_login(body: VerifyRequest) -> TokenResponse:
    try:
        email = consume_login_token(body.token)
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    try:
        claims = parse_institute_email(email)
    except EmailFormatError as exc:
        # Shouldn't happen — the email was validated at /auth/login time —
        # but don't issue a session for a malformed address regardless.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    claims["sub"] = email
    access_token = create_session_token(claims, settings.SESSION_JWT_EXPIRY_DAYS)
    return TokenResponse(access_token=access_token)
