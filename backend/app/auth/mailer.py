import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_SEND_URL = "https://api.resend.com/emails"


def send_magic_link(to_email: str, link: str) -> None:
    """Send the magic-link login email via Resend's API. If Resend isn't
    configured (RESEND_API_KEY unset), log the link instead — lets local
    dev work with zero email setup.
    """
    if not settings.RESEND_API_KEY:
        logger.info("Resend not configured; magic link for %s: %s", to_email, link)
        return

    text_body = (
        f"Click the link below to sign in to Edu LLM. It expires in "
        f"{settings.LOGIN_TOKEN_EXPIRY_MINUTES} minutes.\n\n{link}\n\n"
        f"If you didn't request this, you can ignore this email."
    )
    html_body = (
        f"<p>Click the link below to sign in to Edu LLM. It expires in "
        f"{settings.LOGIN_TOKEN_EXPIRY_MINUTES} minutes.</p>"
        f'<p><a href="{link}">{link}</a></p>'
        f"<p>If you didn't request this, you can ignore this email.</p>"
    )

    payload = {
        "from": f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>",
        "to": [to_email],
        "subject": "Sign in to Edu LLM",
        "text": text_body,
        "html": html_body,
    }

    response = httpx.post(
        RESEND_SEND_URL,
        headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
        json=payload,
        timeout=10.0,
    )
    response.raise_for_status()
