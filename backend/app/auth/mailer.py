import logging
from html import escape
from urllib.parse import urlsplit

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_SEND_URL = "https://api.resend.com/emails"


def _send(to_email: str, subject: str, text_body: str, html_body: str) -> None:
    """Sends one email via Resend's API."""
    payload = {
        "from": f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>",
        "to": [to_email],
        "subject": subject,
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
    _send(to_email, "Sign in to Edu LLM", text_body, html_body)


def _login_page_url() -> str:
    """The frontend's /login page, on the same origin as the magic link."""
    parts = urlsplit(settings.MAGIC_LINK_BASE_URL)
    return f"{parts.scheme}://{parts.netloc}/login"


def send_workspace_invite(to_email: str, inviter_name: str, workspace_name: str) -> None:
    """Tells a faculty member who hasn't signed in yet that they were added
    to a shared workspace. Logged instead when Resend isn't configured.
    """
    login_url = _login_page_url()
    if not settings.RESEND_API_KEY:
        logger.info(
            "Resend not configured; %s was added to workspace %r by %s (sign in at %s)",
            to_email, workspace_name, inviter_name, login_url,
        )
        return

    text_body = (
        f"{inviter_name} added you to the shared workspace \"{workspace_name}\" on Edu LLM.\n\n"
        f"Sign in with this email address to see its documents and classrooms:\n{login_url}"
    )
    html_body = (
        f"<p>{escape(inviter_name)} added you to the shared workspace "
        f"<b>{escape(workspace_name)}</b> on Edu LLM.</p>"
        f"<p>Sign in with this email address to see its documents and classrooms:</p>"
        f'<p><a href="{login_url}">{login_url}</a></p>'
    )
    _send(to_email, f"You were added to {workspace_name} on Edu LLM", text_body, html_body)
