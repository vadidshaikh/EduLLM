# Next Steps — Manual Setup Required

The app is fully functional right now with dev tokens. When you're ready to connect the real auth service, follow these steps:

## Step 1: Get JWT details from your auth team

Contact the team that manages your institute's authentication service and ask for:
- The JWT signing secret (HMAC key) or JWKS/public key URL (if using RSA)
- Confirmation of the exact claim names they use (e.g., is it `role` or `user_role`? is it `sub` or `user_id`?)

## Step 2: Update `app/auth/jwt.py`

Replace the dev HS256 setup with the real signing details:
- If using HMAC: update `JWT_SECRET` in `.env`, keep `JWT_ALGORITHM: HS256`
- If using RSA: fetch the public key from the JWKS URL, switch to `algorithms=["RS256"]`

Example file: `backend/app/auth/jwt.py` lines 5-6

## Step 3: Decide on admin access

Ask: should only certain faculty members be admins, or are all faculty admins?
- **Current v1 setup**: anyone with `role == faculty` can upload/delete docs
- **If you want stricter control**: ask auth team for a separate `admin` claim, then update `app/auth/dependencies.py` line 18

## Step 4: Set up domain + SSL (optional, if needed outside campus network)

If users need to access this from outside your network:
- Register a domain (e.g., `edullm.myinstitute.edu`)
- Get an SSL certificate (free via Let's Encrypt)
- Update `docker-compose.yml` port bindings and proxy rules

---

**Until you complete these steps**, use dev tokens: `python backend/scripts/mint_dev_token.py --sub user@college.edu --role student`
