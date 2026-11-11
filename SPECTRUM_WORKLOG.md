# Spectrum engineering work log

Updated: 2026-11-11

## Completed

- Verified the current Railway dashboard deployment is `SUCCESS` and the Social Watch bot deployment is also `SUCCESS`.
- Confirmed the local Ollama gateway is running on the authorized Windows PC and its authenticated health endpoint returns `ok`.
- Confirmed the gateway can enumerate the installed models: `qwen2.5:7b`, `qwen2.5vl:3b`, and `qwen2.5vl:7b`.
- Increased the local gateway request-body cap from 1 MiB to 48 MiB. This addresses the known mismatch where the dashboard can attach up to five 6 MiB files, but base64-encoded image payloads can exceed the former gateway cap.
- Backed up the previous gateway source as `gateway.js.bak-20261111`, syntax-checked the new gateway, restarted it, and verified the new process is listening on port 8787 with an empty gateway error log.
- Added a Spectrum welcome state with quick-start prompts in the `spectrum-polish` branch.
- Aligned the AI status endpoint's fallback vision model with the model selected by image chat (`qwen2.5vl:7b`).
- Validated the dashboard inline JavaScript and server JavaScript with `node --check`.

## Issues found and handling

- **Large attachments:** the old gateway's 1 MiB cap was lower than the possible encoded payload from the dashboard's allowed attachments. The local gateway cap is now 48 MiB. A full end-to-end upload through the logged-in dashboard still needs to be exercised.
- **Vision status mismatch:** when `AI_VISION_MODEL` was unset, the status route checked `qwen2.5vl:3b` while image chat selected `qwen2.5vl:7b`. The branch change makes the fallback consistent. If the environment variable is set, both paths continue to use it.
- **Client disconnects:** Railway HTTP logs contain successful chat requests (200) and two client-closed requests (499). A 499 indicates the client closed the request before the server replied; it is not evidence that the model returned a refusal. The latest observed successful chat completed in about 22 seconds.
- **One prior chat error:** a 502 was observed in earlier logs. Its underlying gateway response was not preserved in the HTTP record, so the exact cause is not proven.
- **Training hardware:** the current PC does not expose `nvidia-smi`; it is not a practical 7B QLoRA training machine. No cloud GPU has been provisioned and no paid compute has been started.

## Training status

- The isolated `spectrum-training` branch now masks prompt tokens and applies training loss to the final assistant response, uses dynamic padding, and creates a small held-out split when there are at least five records.
- Python 3.13 syntax compilation passed; all five starter JSONL examples parsed and end with an assistant response.
- Five examples are only a format sample and are not enough to fine-tune a useful model. The Kaggle guide documents a free-GPU route, but GPU availability is limited and the user must sign in to their own account.
- No training job has run. No model weights have changed.

## Release state

- Draft PR #3: Spectrum UI polish and vision status alignment.
- Draft PR #4: QLoRA training scaffold improvements.
- Neither draft PR has been merged or deployed. The production deployment remains unchanged.
