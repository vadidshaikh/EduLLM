"""Mint a dev JWT for local testing, until the real auth service is live.

Usage: python scripts/mint_dev_token.py --sub student1@college.edu --role student
"""
from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

import jwt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import settings  # noqa: E402


def mint(sub: str, role: str, minutes: int = 120) -> str:
    """Create a signed login token (JWT) for a given user and role that expires after a set number of minutes.

    Example: mint("student1@college.edu", "student", 120) -> "<encoded JWT string>"
    """
    now = datetime.datetime.now(tz=datetime.timezone.utc)
    payload = {
        "sub": sub,
        "role": role,
        "iat": now,
        "exp": now + datetime.timedelta(minutes=minutes),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sub", required=True, help="user id/email for the `sub` claim")
    parser.add_argument("--role", required=True, choices=["student", "faculty"])
    parser.add_argument("--minutes", type=int, default=120, help="token lifetime in minutes")
    args = parser.parse_args()

    print(mint(args.sub, args.role, args.minutes))
