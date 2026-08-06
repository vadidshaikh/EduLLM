import logging
import smtplib
from email.message import EmailMessage

from app.config import settings

logger = logging.getLogger(__name__)


def send_magic_link(to_email: str, link: str) -> None:
    """Send the magic-link login email via SMTP. If SMTP isn't configured
    (SMTP_HOST unset), log the link instead — lets local dev work with zero
    email setup.
    """
    if not settings.SMTP_HOST:
        logger.info("SMTP not configured; magic link for %s: %s", to_email, link)
        return

    message = EmailMessage()
    message["Subject"] = "Sign in to Edu LLM"
    message["From"] = settings.SMTP_FROM or settings.SMTP_USER
    message["To"] = to_email
    message.set_content(
        f"Click the link below to sign in to Edu LLM. It expires in "
        f"{settings.LOGIN_TOKEN_EXPIRY_MINUTES} minutes.\n\n{link}\n\n"
        f"If you didn't request this, you can ignore this email."
    )

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        if settings.SMTP_USE_TLS:
            server.starttls()
        if settings.SMTP_USER:
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.send_message(message)
