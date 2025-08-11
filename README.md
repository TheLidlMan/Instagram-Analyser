# Instagram DM Analyzer 📱📊

A privacy-focused, client-side web application for analyzing your Instagram Direct Message data exports.

## ✨ Features

- **Complete Privacy**: All processing happens in your browser - no data leaves your device
- **Comprehensive Analytics**: Message counts, emoji usage, conversation patterns, activity trends
- **Interactive Charts**: Beautiful visualizations using Chart.js
- **Drag & Drop**: Simply drag your Instagram data export folder
- **Dark/Light Mode**: Automatic theme detection with manual toggle
- **Thread Filtering**: Analyze specific conversations or all at once
- **Emoji Decoding**: Fixes mojibake encoding issues in Instagram exports

## 🚀 Quick Start

1. **Get your Instagram data**:
   - Go to Instagram → Settings → Privacy → Download Your Information
   - Request data download (JSON format)
   - Wait for Instagram to prepare your data (can take up to 14 days)

2. **Run the analyzer**:
   - Download this repository
   - Open `index.html` in any modern web browser
   - OR serve locally: `python -m http.server 8000` then visit `http://localhost:8000`

3. **Analyze your data**:
   - Drag and drop your extracted Instagram data folder
   - Explore the different tabs for various insights

## 📊 Analytics Included

- **Overview**: Total messages, conversations, date ranges, trends
- **Conversations**: Most active chats and participants
- **Emojis & Reactions**: Most used emojis in messages and reactions
- **Activity Patterns**: Daily/hourly messaging patterns, streaks
- **Word Analysis**: Most frequently used words
- **Engagement**: Saved posts/reels analysis (if available in export)
- **Statistics**: Detailed metrics and sender breakdowns

## 🔧 Technical Details

- **Framework**: Alpine.js for reactivity
- **Styling**: Tailwind CSS
- **Charts**: Chart.js for visualizations
- **Processing**: Client-side JSON parsing and analysis
- **Compatibility**: Modern browsers with ES6+ support

## 📁 File Structure

```
Instagram-Analyser/
├── index.html          # Main application
├── assets/
│   └── app.js         # Core application logic
└── README.md
```

## 🛠️ Development

This is a client-side application with no build process required. Simply edit the files and refresh your browser.

## 🔒 Privacy & Security

- **No server required**: Runs entirely in your browser
- **No data transmission**: Your Instagram data never leaves your device
- **No tracking**: No analytics, cookies, or external requests (except CDN assets)
- **Open source**: Full transparency - inspect the code yourself

## 🐛 Known Issues

- Large datasets (>50k messages) may cause performance issues
- Some Instagram exports may have encoding issues (partially addressed)
- Chart rendering may be slow on older devices

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

Issues and pull requests welcome! Please ensure any contributions maintain the privacy-first, client-side approach.

---

**⚠️ Alpha Version Notice**: This is an alpha release. Some features may be incomplete or buggy. Please report issues on GitHub.
