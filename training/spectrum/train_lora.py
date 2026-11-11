#!/usr/bin/env python3
"""Offline QLoRA SFT scaffold for Spectrum. Does not deploy or modify production."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


def load_records(path: Path) -> list[dict]:
    records: list[dict] = []
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        messages = item.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            raise ValueError(f"{path}:{line_no}: expected at least a user and assistant message")
        if messages[-1].get("role") != "assistant":
            raise ValueError(f"{path}:{line_no}: the final message must be an assistant response")
        if not any(m.get("role") == "user" for m in messages):
            raise ValueError(f"{path}:{line_no}: missing user message")
        if any(m.get("role") not in {"system", "user", "assistant"} for m in messages):
            raise ValueError(f"{path}:{line_no}: unsupported role")
        records.append({"messages": messages})
    if not records:
        raise ValueError(f"No training records found in {path}")
    return records


def assistant_only_features(messages: list[dict], tokenizer, max_length: int) -> dict:
    # Train on the final assistant answer, not on the user's prompt or earlier context.
    full_text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    prompt_text = tokenizer.apply_chat_template(
        messages[:-1], tokenize=False, add_generation_prompt=True
    )
    full_ids = tokenizer(full_text, add_special_tokens=False)["input_ids"]
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]

    # Use the actual common token prefix so tokenizer boundary differences cannot
    # accidentally mask answer tokens or train the model to reproduce the prompt.
    prefix_len = 0
    for left, right in zip(full_ids, prompt_ids):
        if left != right:
            break
        prefix_len += 1
    if prefix_len >= len(full_ids):
        raise ValueError("No assistant answer tokens remain after the prompt.")

    full_ids = full_ids[:max_length]
    labels = list(full_ids)
    mask_len = min(prefix_len, len(labels))
    labels[:mask_len] = [-100] * mask_len
    if all(token == -100 for token in labels):
        raise ValueError("Assistant answer was truncated; increase --max-length.")
    return {
        "input_ids": full_ids,
        "attention_mask": [1] * len(full_ids),
        "labels": labels,
    }


class AssistantOnlyCollator:
    def __init__(self, pad_token_id: int):
        self.pad_token_id = pad_token_id

    def __call__(self, features: list[dict]) -> dict:
        width = max(len(item["input_ids"]) for item in features)
        input_ids, attention_masks, labels = [], [], []
        for item in features:
            padding = width - len(item["input_ids"])
            input_ids.append(item["input_ids"] + [self.pad_token_id] * padding)
            attention_masks.append(item["attention_mask"] + [0] * padding)
            labels.append(item["labels"] + [-100] * padding)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_masks, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="Qwen/Qwen2.5-7B")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA GPU not detected. This 7B QLoRA scaffold is intended for a Linux NVIDIA GPU; "
            "do not run it on the current low-power PC."
        )

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        quantization_config=quant,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(
        model,
        LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )
    model.print_trainable_parameters()

    records = load_records(args.data)
    dataset = Dataset.from_list(records).map(
        lambda row: assistant_only_features(row["messages"], tokenizer, args.max_length),
        remove_columns=["messages"],
    )
    eval_dataset = None
    if len(dataset) >= 5:
        split = dataset.train_test_split(test_size=max(1, round(len(dataset) * 0.1)), seed=42)
        dataset, eval_dataset = split["train"], split["test"]

    has_eval = eval_dataset is not None
    training_args = TrainingArguments(
        output_dir=str(args.output),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.learning_rate,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=5,
        evaluation_strategy="epoch" if has_eval else "no",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=has_eval,
        metric_for_best_model="eval_loss" if has_eval else None,
        greater_is_better=False if has_eval else None,
        optim="paged_adamw_8bit",
        gradient_checkpointing=True,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        report_to="none",
        remove_unused_columns=False,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        eval_dataset=eval_dataset,
        data_collator=AssistantOnlyCollator(tokenizer.pad_token_id),
    )
    trainer.train()
    args.output.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    if has_eval:
        print("Held-out evaluation:", trainer.evaluate())
    print(f"Adapter saved to {args.output}")


if __name__ == "__main__":
    main()
