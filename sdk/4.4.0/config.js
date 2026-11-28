// config.js — baked, dep-free configuration constants (Verified-Client Phase 1). App tag, the solo key
// model, and the PUBLIC Google OAuth client id + VAPID key. Imported wherever needed so no module owns them.

export const APP_TAG = 'spaces'
export const SOLO = { keyModel: '1-of-1' }
export const GOOGLE_CLIENT_ID = '138139257987-2s658reba6jjsc6rmuahputsts3qvjlk.apps.googleusercontent.com'
export const VAPID_PUBLIC_KEY = 'BADZvvI-iJ1LUpormHIdAvhtNiiArDSf30QRJ6kFh2grgAob6oP_X1GKQdDOXlogfUvgtDt3a74rIVfsw0tMvms' // public by design; unset ⇒ the notify row stays hidden
// Raw-bytes cap for a document attachment (PDF/Word/Excel) — kept under the server's 5MB base64 cap; the agent reads
// them via read_file (text extraction), and the turn POSTs straight to API Gateway (10MB limit). Shared by the composer's
// attachments and the WhatsApp import (both stage documents through the same reader).
export const MAX_FILE_BYTES = 3_500_000
