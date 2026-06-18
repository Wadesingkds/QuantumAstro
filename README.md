# Quantum Leaps

Gann Square of 9 Calculator untuk XAUUSD trading dengan sistem premium subscription.

**Live:** https://quantum-leaps-gamma.vercel.app

---

## Tech Stack

- **Frontend:** HTML + Tailwind CSS CDN
- **Backend:** Vercel Serverless Functions
- **Auth:** Supabase (email/password + Google OAuth)
- **Payment:** Pakasir (QRIS + VA)
- **Database:** Supabase PostgreSQL

---

## Features

✅ Gann Square of 9 calculator  
✅ Premium subscription (monthly/lifetime)  
✅ Pakasir payment integration  
✅ Google OAuth login  
✅ Session persistence

---

## Setup

**1. Environment Variables (Vercel)**

```bash
SUPABASE_URL=https://deqjvxsxovobpfisjyhg.supabase.co
SUPABASE_ANON_KEY=eyJhbG...ps1I
SUPABASE_SERVICE_KEY=eyJhbG...RYkg
PAKASIR_API_KEY=***
PAKASIR_SLUG=kiosk-wa
PAKASIR_WEBHOOK_URL=https://quantum-leaps-gamma.vercel.app/api/pakasir/webhook
```

**2. Supabase Setup**

Database table:
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);
```

OAuth redirect URLs (Supabase dashboard):
```
https://quantum-leaps-gamma.vercel.app
https://quantum-leaps-gamma.vercel.app/**
```

**3. Deploy**

```bash
vercel deploy --prod
```

---

## API Endpoints

### POST `/api/pakasir/checkout`
Generate payment URL.

**Request:**
```json
{"email":"user@example.com","plan":"monthly","amount":300000}
```

**Response:**
```json
{"checkout_url":"https://app.pakasir.com/pay/..."}
```

### POST `/api/pakasir/webhook`
Handle payment notifications from Pakasir.

### GET `/api/subscription/check?email=...`
Check premium status.

**Response:**
```json
{"premium":true,"plan":"monthly","status":"active"}
```

---

## File Structure

```
quantum-leaps/
├── index.html          # Main app (971 lines)
├── success.html        # Payment success page
├── api/
│   ├── pakasir/
│   │   ├── checkout.js
│   │   └── webhook.js
│   └── subscription/
│       └── check.js
└── vercel.json
```

---

## Development Notes

**Authentication:**
- `onAuthStateChange()` listener untuk real-time session
- `DOMContentLoaded` fallback untuk localStorage
- User info fixed position top-right

**Payment Flow:**
1. Checkout → Pakasir URL generation
2. User bayar → Pakasir webhook hit `/api/pakasir/webhook`
3. Webhook update status `pending` → `active`
4. Calculator unlock otomatis

**Known Issues:**
- Tailwind CDN warning (non-blocking)
- Favicon 404 (cosmetic)

---

**Last Updated:** 2026-06-05  
**Status:** ✅ Production Ready
