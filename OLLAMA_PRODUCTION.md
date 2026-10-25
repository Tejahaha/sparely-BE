# Ollama on a separate PC for a Vercel backend

The existing Wi-Fi URL works only while Sparely and Ollama are on the same private network. Vercel cannot route to that private address. A stable public HTTPS tunnel plus authentication is needed for the hosted backend to use your `gemma3:4b` model.

Because you do not have a Cloudflare domain, use **Tailscale Funnel** on the Ollama PC. Funnel supplies a stable `https://...ts.net` URL without port forwarding or your own domain, but that URL is public. Point Funnel at the included **authenticated gateway**, never at Ollama's unauthenticated port 11434.

1. On the Ollama PC, install Tailscale, sign in, enable MagicDNS/HTTPS and Funnel for that device. Keep Tailscale and Ollama running. Follow Tailscale's current Funnel setup instructions.
2. Copy or clone the sanitized backend source onto that PC. Create `backend/.env.ollama-gateway` from `.env.ollama-gateway.example`. Generate a new random token of at least 32 bytes; keep it private. Set `OLLAMA_LOCAL_URL=http://127.0.0.1:11434` and `OLLAMA_GATEWAY_PORT=11435`.
3. Run `npm run ollama:gateway` from `backend/`. The gateway binds to `127.0.0.1:11435`, accepts only `POST /v1/chat/completions`, requires `Authorization: Bearer <token>`, caps request/response size and forwards only to loopback Ollama.
4. On the Ollama PC, run `tailscale funnel --bg 11435`. Record the stable HTTPS URL it prints. Test from a different network: without the bearer token, `/v1/chat/completions` must return 401; with the token, a model request must succeed. Do not put the token in a URL or browser page.
5. In the **backend Vercel project environment**, set `LLM_URL` to the Funnel HTTPS origin, `LLM_API_KEY` to that same gateway token, `LLM_MODEL=gemma3:4b`, and `LLM_TIMEOUT_MS=20000`. Redeploy the backend. These are server-only values; never use `VITE_*` or commit them to Git.
6. Through the deployed frontend, sign in, run “Find my fit” with a clear tool request and confirm the response says it was understood by AI. Verify a translation and reminder with safe sample data before calling the AI path production-ready. Check fallback behavior by stopping the gateway: search must use local rules, translated text must revert to the original, and reminders must use fixed wording.

If that PC sleeps, Ollama stops, Tailscale disconnects or the tunnel changes, the deployed app remains usable through deterministic fallbacks, but AI will be unavailable. Keep this gateway token separate from the exposed `ORIGIN_SECRET` and rotate it if disclosed. For an always-on product, move inference to a hosted service or dedicated always-on model host.
