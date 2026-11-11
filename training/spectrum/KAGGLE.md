# Free GPU training with Kaggle

This is an optional, no-paid-compute route for testing the Spectrum QLoRA scaffold.

## Before starting

- Create/sign in to a Kaggle account and open Kaggle Notebooks.
- Create a new notebook and select **GPU** under Notebook Settings → Accelerator.
- Kaggle documents free NVIDIA GPU notebook access, including P100 and T4 options. Availability is limited and a queue may occur; published guidance describes up to 30 GPU hours per week, subject to quota and demand.
- Do not enter payment details or enable paid accelerators for this workflow.
- The starter `data/train.jsonl` contains only five examples. It is a format check, not a meaningful training dataset. Replace it with a substantially larger, reviewed, rights-cleared dataset before training. Keep private conversations, secrets, and personal records out of the dataset.

## Notebook cells

Clone this repository branch and install the pinned training dependencies:

```bash
!git clone --depth 1 --branch spectrum-training https://github.com/ynlmir2-source/social-watch-dashboard.git /kaggle/working/social-watch-dashboard
%cd /kaggle/working/social-watch-dashboard/training/spectrum
!pip install -q -r requirements.txt
!nvidia-smi
```

Upload your reviewed JSONL file to the Kaggle notebook as a dataset, then set `DATA_FILE` to its mounted path. Do not train on the five-row starter sample:

```python
from pathlib import Path

DATA_FILE = Path("/kaggle/input/YOUR-DATASET/train.jsonl")  # change to your Kaggle dataset path
assert DATA_FILE.exists(), f"Training data not found: {DATA_FILE}"
assert sum(1 for line in DATA_FILE.read_text(encoding="utf-8").splitlines() if line.strip()) >= 100, (
    "Add at least 100 reviewed examples before starting a training run."
)
```

Start a conservative first run. A 7B model may exceed the memory available on some free GPU types; if it does, stop the run rather than enabling paid hardware. A smaller sequence length can reduce memory use, but it does not guarantee a fit:

```python
!python train_lora.py --data {DATA_FILE} --output /kaggle/working/spectrum-qwen25-7b-lora --model Qwen/Qwen2.5-7B --epochs 1 --max-length 1024 --batch-size 1 --grad-accum 16
```

When training completes, use the notebook's **Save Version** flow and download the adapter from `/kaggle/working/spectrum-qwen25-7b-lora`. Keep the base model and adapter separate. Do not switch the live gateway to the adapter until held-out evaluation passes and a rollback copy exists.

## Important limits

Kaggle free GPU access is shared, availability can vary, and notebook sessions have runtime limits. This is a training/experiment environment, not a production hosting environment. No Kaggle notebook has been created or run by this guide, and no paid compute has been provisioned.
