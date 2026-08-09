import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

MAILJET_SEND_URL = "https://api.mailjet.com/v3.1/send"


def send_magic_link(to_email: str, link: str) -> None:
    """Send the magic-link login email via Mailjet's API. If Mailjet isn't
    configured (MAILJET_API_KEY unset), log the link instead — lets local
    dev work with zero email setup.
    """
    if not settings.MAILJET_API_KEY:
        logger.info("Mailjet not configured; magic link for %s: %s", to_email, link)
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
        "Messages": [
            {
                "From": {
                    "Email": settings.MAILJET_FROM_EMAIL,
                    "Name": settings.MAILJET_FROM_NAME,
                },
                "To": [{"Email": to_email}],
                "Subject": "Sign in to Edu LLM",
                "TextPart": text_body,
                "HTMLPart": html_body,
            }
        ]
    }

    response = httpx.post(
        MAILJET_SEND_URL,
        auth=(settings.MAILJET_API_KEY, settings.MAILJET_API_SECRET),
        json=payload,
        timeout=10.0,
    )
    response.raise_for_status()
