# model-usage

A **Model Usage** side panel for the **Antigravity 2.0** desktop app that displays live model quota, reset countdowns, subscription plan, and AI credits without opening **Settings -> Models**.

## What it shows

- **Model Quota (`Quota` tab)**: Remaining percentage, progress bar with a live window-time pacing tick mark (showing remaining time % in the 5-hour or weekly window), reset countdown (`Resets in ...`), and exact local reset time for each model group (e.g., Gemini Models 5-hour & weekly limits, Claude and GPT models 5-hour & weekly limits).
- **Plan & AI Credits (`Quota` tab)**: Current subscription tier, available Google One AI credits, minimum credit threshold, and overage toggle status.
- **Usage Statistics (`Stats` tab)**: OpenChamber-inspired historical analytics across `7d`, `30d`, `90d`, and `All` time ranges with combined **Project** and **Model** filtering (by model series or specific variant, plus click-to-filter in the Models list):
  - **Summary Tiles**: Sessions (with subagent count), Prompts (with model steps & compactions), Tokens (`In · Out · Cache`), Public API Equivalent Cost (`Est. Cost`), Active days, and Longest streak.
  - **Public API Pricing Card (when a model is selected)**: Automatically fetches and caches official `Standard` tier pricing from Google AI Studio (`aistudio.google.com/docs/pricing.md`) and Anthropic (`platform.claude.com/docs/en/about-claude/pricing.md`) with automatic promotional date window and context-length tier resolution, displaying unit rates (`Input`, `Output`, `Reasoning`, and `Cache read` per 1M tokens), per-segment cost breakdown, prompt cache savings, and explicit live/cached/fallback source status.
  - **Activity Chart**: Interactive daily/weekly model step bar chart.
  - **Token Composition**: 4-segment stacked bar (`Input`, `Output`, `Reasoning`, `Cache reads`).
  - **Efficiency & Performance**: Cache hit rate, Est. cost / session, Est. cost / 1M tokens, Tokens / session, Steps / session, Reasoning share, Average output speed (`tok/s`), and Median TTFT.
  - **Models & Tool Calls**: Per-model breakdown comparable by `Tokens`, `Cost`, or `Steps`, plus per-tool execution counts, success rates, and P50 median durations (with MCP tools broken down as `server.tool`).
- **Zero-Token Live Refresh**: Queries the local Antigravity Language Server (`RetrieveUserQuotaSummary`, `GetUserStatus`, `GetLoadCodeAssist`, `GetAvailableModels`) and local SQLite conversation databases directly from the sidecar backend.

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
