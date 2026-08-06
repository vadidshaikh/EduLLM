"""Bulk upload all PDFs from the docs/ folder into the database.

This script finds every .pdf in the project root's docs/ folder, registers it
in the database, and queues it for ingestion. Use this to pre-populate the RAG
system with documents on first setup.

Usage:
    python scripts/bulk_upload_docs.py [--roles student,faculty] [--dry-run]

Examples:
    # Upload all to both student and faculty
    python scripts/bulk_upload_docs.py

    # Student access only
    python scripts/bulk_upload_docs.py --roles student

    # Preview what would be uploaded without actually uploading
    python scripts/bulk_upload_docs.py --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.db.pool import pool
from app.db.queries import insert_document
from app.ingestion.pipeline import run_ingestion
from app.storage import compute_file_hash


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--roles",
        default="faculty",
        help="Comma-separated roles that can access these docs (default: faculty). Use 'student,faculty' for both.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would be uploaded without actually uploading",
    )
    args = parser.parse_args()

    docs_dir = Path(__file__).resolve().parent.parent.parent / "docs"
    if not docs_dir.exists():
        print(f"ERROR: docs/ folder not found at {docs_dir}")
        sys.exit(1)

    pdfs = sorted(docs_dir.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {docs_dir}")
        return

    roles = [r.strip() for r in args.roles.split(",")]
    print(f"Found {len(pdfs)} PDF(s) to upload with roles: {roles}")

    if args.dry_run:
        print("\n[DRY RUN] Would upload:")
        for pdf in pdfs:
            print(f"  - {pdf.name}")
        return

    pool.open()
    try:
        for pdf in pdfs:
            try:
                file_bytes = pdf.read_bytes()
                file_hash = compute_file_hash(file_bytes)

                doc = insert_document(
                    title=pdf.stem,  # filename without extension as title
                    filename=pdf.name,
                    storage_path=str(pdf),
                    allowed_roles=roles,
                    file_hash=file_hash,
                    uploaded_by="bulk_import",
                )

                # Queue ingestion (runs in background in real deployment)
                run_ingestion(doc["id"])
                print(f"✓ {pdf.name} (ID: {doc['id']}, status: {doc['status']})")

            except Exception as e:
                print(f"✗ {pdf.name}: {e}")

        print(f"\nUpload complete. Documents are queued for ingestion.")
        print("Check /admin to see status (queued → processing → indexed)")

    finally:
        pool.close()


if __name__ == "__main__":
    main()
