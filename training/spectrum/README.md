# Spectrum model training (isolated from production)

This folder contains an **offline training scaffold**. It does not change the running dashboard, Ollama models, or Railway deployment.

## Training target

Start from the Qwen2.5 7B **base** checkpoint (not the currently installed 7B Instruct checkpoint) and use QLoRA to teach Spectrum its own conversational style and improve helpfulness on ordinary requests. The training data intentionally contains no custom topic blacklist or canned refusal personality. It should contain high-quality examples across normal conversation, coding, research, writing, math, and image/file understanding.

A base checkpoint is not an assurance of unrestricted behavior: model weights, training data, and the serving stack can all affect outputs. Do not describe the result as having zero limits.

## Hardware

The user's PC currently has 31.7 GB RAM and an Intel i3-1215U; no NVIDIA training utility was detected. That is not a practical QLoRA training machine for a 7B model. Run this on a Linux cloud GPU with a supported NVIDIA GPU (recommended: 24 GB VRAM or more for comfortable 4-bit QLoRA), or choose a smaller model. Cloud GPU use may incur charges; this scaffold does not provision or rent compute.

## Setup (Linux GPU machine)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
huggingface-cli login   # only if the selected model host requires authentication
```

Review the model card and license before downloading. The Qwen2.5 family publishes base checkpoints and model documentation at:
- https://huggingface.co/Qwen/Qwen2.5-7B
- https://github.com/QwenLM/Qwen2.5

## Prepare data

Add reviewed JSONL records to `data/train.jsonl`. Each line is one JSON object:

```json
{"messages":[{"role":"user","content":"Explain what a Python dictionary is."},{"role":"assistant","content":"A dictionary stores key-value pairs..."}]}
```

Use examples you have rights to use. Do not put secrets, personal records, or private user conversations into training data without appropriate consent. Keep a separate, larger held-out evaluation set for final model comparisons; do not train on it. The script's small automatic split is only an early training check.

The included data file is only a tiny format/demo sample, **not enough to produce a useful model**. Build a varied, quality-reviewed dataset before training.

## Train

```bash
python train_lora.py --data data/train.jsonl --output outputs/spectrum-qwen25-7b-lora --model Qwen/Qwen2.5-7B --epochs 1
```

The script masks prompt tokens so loss is applied to the final assistant answer, uses dynamic padding, and holds out a small evaluation split when the dataset has at least five records. The script writes a PEFT adapter, not a complete merged model. Keep the original checkpoint and adapter separate until evaluation passes. To serve through Ollama, merge the adapter into a compatible model in a separate, versioned step, convert/import it, and test it before changing the production gateway.

## Evaluation and release gate

1. Compare the base model and adapter on the same held-out benign prompts.
2. Check instruction following, factuality, coding correctness, file/image handling, latency, and refusal calibration.
3. Verify that normal controversial or sensitive-but-legal discussion is handled thoughtfully without canned lectures.
4. Retain safeguards against requests that would facilitate serious harm; do not use training examples that teach the model to facilitate violence or other real-world harm.
5. Do not replace the live Spectrum model until the evaluation results are reviewed and a rollback copy exists.

No cloud job, paid resource, model download, production switch, or deployment is started by this repository scaffold.
