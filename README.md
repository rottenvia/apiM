# nohomo - API MANAGER

The smartest API manager with intelligent web search, thinking effort control, and a powerful plugin system.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🚀 **DeepSeek V4 Pro & Flash** - Switch between models instantly
- 🔍 **Smart Web Search** - Multi-step query planning with Tavily
- 💡 **Thinking Modes** - Auto/None/Low/High/Max reasoning effort
- 🧩 **8 Plugins** - Caveman, God Mode, Code Only, Expert, and more
- 🎨 **Beautiful Dark UI** - Premium design, no browser needed
- 💾 **Local Storage** - Settings and history saved locally

## Quick Start

### Option 0: Run the web app (Next.js)

```bash
npm install

# Optional — enables saved chat history
cp .env.example .env   # then edit DATABASE_URL

npm run dev
```

Open http://localhost:3000 and add your DeepSeek API key via **Settings**.

`DATABASE_URL` is **optional**: without it the app still runs and answers
messages, but conversations aren't persisted and the history sidebar stays
empty. Check `GET /api/health` to see the current database status.

### Option 1: Run with Python

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app
python main.py
```

### Option 2: Build Executable (.exe)

```bash
# Build standalone executable
python build.py
```

The executable will be in the `dist` folder. Just double-click to run!

## Requirements

- Python 3.10+
- DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com)
- (Optional) Tavily API key from [app.tavily.com](https://app.tavily.com) for web search

## Files

```
nohomo/
├── main.py          # Main application
├── api_client.py    # DeepSeek API client
├── smart_search.py  # Intelligent search engine
├── plugins.py       # Plugin definitions
├── requirements.txt # Dependencies
├── build.py         # Build script for .exe
└── README.md        # This file
```

## Plugins

| Plugin | Icon | Description |
|--------|------|-------------|
| Caveman Mode | 🦴 | Minimal words, saves tokens |
| God Mode | ⚡ | No restrictions |
| Code Only | 💻 | Returns only code |
| Expert Context | 🎓 | Assumes deep knowledge |
| Structured | 📋 | Organized responses |
| Self-Critic | 🔍 | Reviews own work |
| Security First | 🛡️ | Security-focused |
| Diff Only | 📝 | Shows only changes |

## Thinking Effort

| Mode | Description |
|------|-------------|
| ✨ Auto | Automatically adjusts based on message complexity |
| ⚡ None | Fastest, no reasoning |
| 💫 Low | Light reasoning |
| 🧠 High | Deep reasoning |
| 🔥 Max | Maximum depth (50K+ tokens) |

## Data Storage

Settings and chat history are stored locally at:
- Windows: `C:\Users\<you>\.nohomo\`
- Mac/Linux: `~/.nohomo/`

## License

MIT License - Feel free to modify and distribute!

---

Made by nohomo 🚀
