# Instagram DM Analyzer (Client-only)

A modern, privacy-first web app to analyze your Instagram DM export. No backend — everything runs in your browser.

Features
- Drag-and-drop folder upload (select the entire `messages` folder) or multiple JSON files
- Supports Instagram inbox per-thread files (`messages/inbox/<user>/message_*.json`) and aggregated conversations JSON
- Merges multiple `message_*.json` files per thread
- Skips non-DM formats (e.g., `ai_conversations.json`, `secret_conversations.json`, `reported_conversations.json`)
- Decodes Meta/Facebook mojibake emojis (e.g., `\u00f0\u009f…`, `\u00e2\u009d\u00a4`) to real emojis
- Counts emojis from message text and reactions
- Robust emoji extraction with Unicode property regex and fallback
- Overview analytics: total messages, conversations, emojis, date range
- Top conversations, top emojis (incl. reactions), activity over time, time-of-day distribution
- Top words with stop-word filtering
- Detailed stats: average messages/day, most active day, most active hour, average message length, most active conversation, top 1:1 contact
- Modern, responsive UI (Tailwind) with tabs and compact charts
- Lazy chart rendering and cleanup to avoid memory leaks
- Results area capped height with scrolling to prevent page expansion
- 100% client-side processing; no data leaves your browser

Quick start
1. Open `index.html` in a browser (no build step required).
2. Drag and drop your entire `messages` folder from an Instagram export, or select multiple JSON files.
3. Explore the tabs: Overview, Conversations, Emojis, Activity, Words, Stats.

New tabs (optional extras)
- Engagement: summarizes non-DM activity if those JSON files are present
	- Saves timeline, top saved creators, top domains, save types (posts vs reels)
	- Comments timeline, owners you comment on most, top comment emojis, avg/median length
- Interests: your top recommended topics from Instagram

Supported extra files
- your_instagram_activity/saved/saved_posts.json
- your_instagram_activity/comments/post_comments_*.json
- your_instagram_activity/comments/reels_comments.json
- preferences/your_topics/recommended_topics.json

Data compatibility
- Per-thread files: `messages/inbox/<username_id>/message_*.json` (the app merges these automatically)
- Aggregated JSON: an array of thread objects (each with `participants` and `messages`)
- Skipped: non-DM formats like `ai_conversations.json`, `secret_conversations.json`, `reported_conversations.json`

Emoji handling
- Instagram exports sometimes contain mojibake like `\u00f0\u009f\u0098\u0083` or `\u00e2\u009d\u00a4` due to UTF-8 bytes misinterpreted as Latin-1.
- The analyzer converts those sequences back to proper Unicode, so emojis and reactions count correctly.

Privacy
- All processing happens locally in your browser. No uploads. No analytics.

Notes
- Sample data: `sample-data.json` mirrors the export structure with reactions and mojibake emojis. You can load it by just opening the page; it preloads for a quick demo.
- Large exports: parsing happens in-memory. For very large datasets, use modern browsers for best performance.

License
- MIT
