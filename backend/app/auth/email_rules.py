"""Derives role/dept/year/division from an SCET institute email address —
no manual role assignment, no hardcoded per-department table. See
edu-llm-phase2-changes.md section 5.

Faculty:  firstname.lastname@scet.ac.in       — no digits in either segment
Student:  name.co23d1@scet.ac.in              — second segment has digits
                                                 (co23d1 = dept co, year 23,
                                                 division d, section 1)
"""
import re

from app.config import settings

_DOMAIN = "@scet.ac.in"
_STUDENT_SEGMENT_RE = re.compile(r"^([a-z]+)(\d{2})([a-z])(\d)$")


class EmailFormatError(Exception):
    """Raised when an email isn't a recognizable @scet.ac.in address."""


def _dev_faculty_emails() -> set[str]:
    return {e.strip().lower() for e in settings.DEV_FACULTY_EMAILS.split(",") if e.strip()}


def parse_institute_email(email: str) -> dict:
    """Reads an @scet.ac.in email address and figures out whether it belongs
    to a faculty member or a student, pulling out the student's department,
    year, division, and section when it's a student address.

    Example: parse_institute_email("jane.co23d1@scet.ac.in") ->
    {"role": "student", "dept": "co", "year": "23", "division": "d", "section": "1"}

    Emails listed in DEV_FACULTY_EMAILS (dev/testing only) short-circuit to
    faculty regardless of domain.
    """
    normalized = email.strip().lower()
    if normalized in _dev_faculty_emails():
        return {"role": "faculty"}
    if not normalized.endswith(_DOMAIN):
        raise EmailFormatError("email must be an @scet.ac.in address")

    local = normalized[: -len(_DOMAIN)]
    parts = local.split(".")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise EmailFormatError("unrecognized email format")

    second = parts[1]
    if not any(ch.isdigit() for ch in second):
        return {"role": "faculty"}

    claims: dict = {"role": "student"}
    match = _STUDENT_SEGMENT_RE.match(second)
    if match:
        dept, year, division, section = match.groups()
        claims.update(dept=dept, year=year, division=division, section=section)
    return claims
