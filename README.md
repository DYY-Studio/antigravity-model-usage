# model-usage

A **Model Usage** side panel for the **Antigravity 2.0** desktop app that displays live model quota, reset countdowns, subscription plan, and AI credits without opening **Settings -> Models**.

## What it shows

- **Model Quota**: Remaining percentage, progress bar, reset countdown (`Resets in ...`), and exact local reset time for each model group (e.g., Gemini Models 5-hour & weekly limits, Claude and GPT models 5-hour & weekly limits).
- **Plan & AI Credits**: Current subscription tier, available Google One AI credits, minimum credit threshold, and overage toggle status.
- **Zero-Token Live Refresh**: Queries the local Antigravity Language Server (`RetrieveUserQuotaSummary`, `GetUserStatus`, `GetLoadCodeAssist`) directly from the sidecar backend.

## Installation

1. Clone or copy this folder into your Antigravity plugins directory:

   ```bash
   # macOS / Linux
   git clone https://github.com/DYY-Studio/antigravity-model-usage.git ~/.gemini/config/plugins/model-usage
   ```

   ```powershell
   # Windows (PowerShell)
   git clone https://github.com/DYY-Studio/antigravity-model-usage.git "$HOME\.gemini\config\plugins\model-usage"
   ```

2. Restart Antigravity and open **Model Usage** in the right-side auxiliary panel.
