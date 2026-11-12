# Spectrum engineering work log

Updated: 2026-11-12

## Completed

- Verified the current Railway dashboard deployment is `SUCCESS` (deployment `cabee73e-1b10-49af-b311-eed4579b0557`) and the production bot deployment was previously verified `SUCCESS`.
- Confirmed the local Ollama gateway is running on the authorized Windows PC and its authenticated health endpoint returns `ok`.
- Confirmed the gateway can enumerate the installed models: `qwen2.5:7b`, `qwen2.5vl:3b`, and `qwen2.5vl:7b`.
- Increased the local gateway request-body cap from 1 MiB to 48 MiB. This accommodates the current dashboard allowance of five 6 MiB files: up to 30 MiB raw, or about 40 MiB when images are base64-encoded, plus request overhead.
- Backed up the previous gateway source as `gateway.js.bak-20261111`, syntax-checked the new gateway, restarted it, and verified the new process is listening on port 8787 with an empty gateway error log.
- Sent an authenticated text-chat test through the local gateway to Ollama; it returned HTTP 200 and the expected test response.
- Added a Spectrum welcome state with quick-start prompts in the `spectrum-polish` branch.
- Aligned the AI status endpoint's fallback vision model with the model selected by image chat (`qwen2.5vl:7b`).
- Validated the dashboard inline JavaScript and server JavaScript with `node --check`.

## Upload investigation

- The previous 1 MiB local gateway cap was a real blocker for larger image payloads; it is now 48 MiB.
- The dashboard submits uploads as `multipart/form-data`, and the frontend correctly leaves the multipart Content-Type/boundary to the browser.
- Express's `express.json({ limit: "100kb" })` middleware does **not** parse multipart uploads. Multer handles `/api/ai/chat` uploads directly, so increasing the global JSON parser limit would not fix this issue and would unnecessarily enlarge the JSON request surface.
- The server allows up to five files at 6 MiB each; the gateway's 48 MiB cap is sized above the approximately 40 MiB worst-case base64 image payload.
- A full authenticated browser-to-Railway-to-gateway image/document upload has **not** yet been verified. The text gateway test is not proof that photo upload works end to end.

## Other issues and handling

- **Vision status mismatch:** when `AI_VISION_MODEL` was unset, the status route checked `qwen2.5vl:3b` while image chat selected `qwen2.5vl:7b`. The branch change makes the fallback consistent. If the environment variable is set, both paths continue to use it.
- **Client disconnects:** previous Railway HTTP logs contained successful chat requests (200) and client-closed requests (499). A 499 indicates the client closed before the server replied; it is not evidence that the model returned a refusal.
- **Prior upload error:** Railway runtime logs previously recorded local AI HTTP 413. The gateway cap has been increased, but a new end-to-end upload is still required to confirm the 413 is gone.
- **One prior chat error:** a 502 was observed in earlier logs. Its underlying gateway response was not preserved in the HTTP record, so the exact cause is not proven.
- **Training hardware:** the current PC does not expose `nvidia-smi`; it is not a practical 7B QLoRA training machine. No cloud GPU has been provisioned and no paid compute has been started.

## Training status

- The isolated `spectrum-training` branch masks prompt tokens and applies training loss to the final assistant response, uses dynamic padding, and creates a small held-out split when there are at least five records.
- Python 3.13 syntax compilation passed; all five starter JSONL examples parsed and end with an assistant response.
- Five examples are only a format sample and are not enough to fine-tune a useful model. The Kaggle guide documents a free-GPU route, but GPU availability is limited and the user must sign in to their own account.
- No training job has run. No model weights have changed.

## Release state

- Draft PR #3: Spectrum UI polish, vision status alignment, and this engineering work log.
- Draft PR #4: QLoRA training scaffold improvements.
- Neither draft PR has been merged or deployed. Production remains on the verified successful deployment above.
