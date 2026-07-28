# 🔐 MFA Setup Instructions

## Your TOTP Secret

```
JBSWY3DPEHPK3PXP
```

## Setup Steps

### 1. Add to Your Authenticator App

Open your authenticator app (Google Authenticator, Microsoft Authenticator, Authy, etc.) and:

**Option A: Manual Entry**
1. Tap "Add Account" or "+"
2. Select "Enter a setup key" or "Manual entry"
3. Account name: **Fitness Tracker**
4. Secret key: **JBSWY3DPEHPK3PXP**
5. Type: **Time-based**
6. Tap "Add" or "Save"

**Option B: QR Code** (if you have a second device)
1. Use this link to generate QR code: https://www.authenticator-qr.com/?secret=JBSWY3DPEHPK3PXP&name=FitnessTracker
2. Scan with your authenticator app

### 2. Verify It's Working

1. Open your app: **https://dqfpaf6w13wqv.cloudfront.net**
2. Enter password
3. Enter the 6-digit code from your authenticator app
4. ✅ Check "Trust this device" (valid for 90 days)
5. Optionally enable Face ID

---

## 🔒 Security Flow

### New/Untrusted Device
- **Password** → **MFA Code** → Trust Device? → Face ID Setup

### Trusted Device  
- **Face ID** directly (no password, no MFA)
- Or **Password** only (no MFA needed)

### Untrusted Device
- Always requires **Password + MFA** (cannot bypass)

---

## Important Notes

⚠️ **DO NOT share this secret** - anyone with it can generate your codes

✅ **Device trust lasts 90 days** - after that you'll need MFA again

✅ **No setup UI in app** - this prevents attackers from registering their own TOTP

✅ **TOTP secret is server-side only** - stored in Lambda environment variable

✅ **MFA bypassed ONLY on trusted devices** - maximum security + convenience

---

## Troubleshooting

**Code not working?**
- Ensure your phone's clock is accurate (TOTP is time-based)
- Try waiting for next code cycle (30 seconds)
- Double-check secret was entered correctly

**Lost access to authenticator?**
- You'll need to update the `TOTP_SECRET` environment variable in Lambda
- Use AWS Console → Lambda → fitness-tracker-TrackerFunction → Configuration → Environment variables

**Want to change the secret?**
1. Generate new secret (any TOTP generator)
2. Add to your authenticator app
3. Update Lambda environment variable: `TOTP_SECRET`
4. Redeploy with `sam deploy`
