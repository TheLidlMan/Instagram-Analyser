// Instagram DM Analyzer - client-only
// Framework: Alpine.js + Tailwind (CDN) + Chart.js
// Features: Drag-and-drop folder upload, JSON parsing & merging, mojibake emoji decode, analytics, lazy charts

// ============ Utilities ============
const textDecoder = new TextDecoder('utf-8');

// Decode common mojibake (UTF-8 interpreted as Latin-1) like \u00f0\u009f... into real emoji
// Works for cases where JSON escapes were already parsed into raw characters (e.g., 'ð\u009f…').
function decodeMojibake(str) {
  if (!str) return str;
  // Detect typical mojibake signatures: control chars 0x80-0x9F, or bytes E2/F0/C3/C2
  const hasSuspicious = /[\u0080-\u009F\u00C2\u00C3\u00E2\u00F0]/.test(str) || /\\u00[0-9a-f]{2}/i.test(str);
  if (!hasSuspicious) return str;
  try {
  // Interpret the string as Latin-1 bytes and re-decode as UTF-8.
  // Even if it contains real Unicode, we'll compare and only use decoded when it improves the text.
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
  const decoded = textDecoder.decode(bytes);
    // Prefer decoded if it increases presence of emoji or removes control bytes
    const moreEmojis = extractEmojis(decoded).length >= extractEmojis(str).length;
  const fewerCtrls = (/[^\u0000-\u001F\u007F-\u009F]/.test(decoded) && (decoded.match(/[\u0080-\u009F]/g)||[]).length <= (str.match(/[\u0080-\u009F]/g)||[]).length);
    return (moreEmojis || fewerCtrls) ? decoded : str;
  } catch {
    return str;
  }
}

// Emoji extraction: robust property regex with fallback
const emojiRegex = (() => {
  try {
    return new RegExp('(?:\\p{RGI_Emoji}|\\p{Emoji_Presentation}|\\p{Extended_Pictographic})', 'gu');
  } catch {
    return /[\u203C-\u3299\uD83C-\uDBFF\uDC00-\uDFFF\u1F000-\u1FAFF\u1F300-\u1F6FF\u1F900-\u1F9FF\u2600-\u27BF\uFE0F\u200D]+/g;
  }
})();

function extractEmojis(s) {
  if (!s) return [];
  const out = [];
  const iter = s.matchAll(emojiRegex);
  for (const m of iter) if (m[0]) out.push(m[0]);
  return out;
}

function toDateOnly(tsMs) {
  const d = new Date(tsMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmtDate(tsMs) {
  const d = new Date(tsMs);
  return d.toLocaleDateString();
}

const STOP_WORDS = new Set((`a,an,the,and,or,of,to,in,is,it,that,this,for,on,with,as,at,by,be,are,was,were,from,not,have,has,had,he,she,they,you,i,we,me,my,our,his,her,them,their,our,ours,your,yours,its,if,then,so,do,does,did,can,could,should,would,will,just,about,im,ill,ive,dont,doesnt,wasnt,werent,arent,isnt,cant,couldnt,shouldnt,wont,yep,yeah,ok,okay,uh,um,like,got,get,gotta,nah,oh,ah,eh,ya,yo,mm,mmm,rt,btw,idk,lol,omg,brb,gtg,thx,thanks,pls,please`)
  .split(',')
  .map(s => s.trim()));

function tokenizeWords(text) {
  if (!text) return [];
  const lower = decodeMojibake(text).toLowerCase();
  let cleaned = lower;
  try {
    cleaned = lower.replace(/[\p{P}\p{S}]/gu, ' ');
  } catch {
    // Fallback: remove non-alphanum basic ASCII characters
    cleaned = lower.replace(/[^a-z0-9\s]/g, ' ');
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.filter(w => !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

// ============ Parsing ============
// Accept: FileList or DataTransferItemList from folder or multiple files
async function readAllJsonFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.endsWith('.json'));
  const skipNames = new Set(['ai_conversations.json', 'secret_conversations.json', 'reported_conversations.json']);
  const threadsRaw = [];
  const extra = { saves: [], comments: [], topics: [] };
  for (const file of files) {
    if (skipNames.has(file.name)) continue;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (isAggregated(json)) {
        threadsRaw.push(...normalizeAggregated(json));
      } else if (json && Array.isArray(json.conversations) && json.conversations.length && json.conversations[0].messages) {
        threadsRaw.push(...normalizeAggregated(json.conversations));
      } else if (isThread(json)) {
        threadsRaw.push(normalizeThread(json));
      } else if (json && json.messages && json.participants) {
        threadsRaw.push(normalizeThread(json));
      } else if (isSaved(json)) {
        extra.saves.push(...normalizeSaved(json));
      } else if (isCommentsReels(json)) {
        extra.comments.push(...normalizeCommentsReels(json));
      } else if (isCommentsPosts(json)) {
        extra.comments.push(...normalizeCommentsPosts(json));
      } else if (isTopics(json)) {
        extra.topics.push(...normalizeTopics(json));
      }
    } catch (e) {
      console.warn('Failed to parse', file.name, e);
    }
  }
  const threads = mergeThreads(threadsRaw);
  return { threads, extra };
}

function isAggregated(obj) {
  return Array.isArray(obj) && obj.length && obj[0].messages && obj[0].participants;
}

function isThread(obj) {
  return obj && Array.isArray(obj.messages) && Array.isArray(obj.participants);
}

function isSaved(obj){ return obj && Array.isArray(obj.saved_saved_media); }
function isCommentsReels(obj){ return obj && Array.isArray(obj.comments_reels_comments); }
function isCommentsPosts(obj){ return Array.isArray(obj) && obj.length && obj[0].string_map_data && (obj[0].string_map_data.Time || obj[0].string_map_data.Comment); }
function isTopics(obj){ return obj && Array.isArray(obj.topics_your_topics); }

function normalizeAggregated(arr) {
  return arr.map(normalizeThread);
}

function normalizeThread(obj) {
  const rawTitle = obj.title ? decodeMojibake(obj.title) : null;
  const title = rawTitle || deriveTitle(obj.participants);
  const path = obj.thread_path || obj.threadPath || 'unknown/thread';
  const messages = (obj.messages || []).map(m => ({
    sender_name: m.sender_name ? decodeMojibake(m.sender_name) : m.sender_name,
    timestamp_ms: m.timestamp_ms,
    content: m.content ? decodeMojibake(m.content) : undefined,
    reactions: Array.isArray(m.reactions) ? m.reactions.map(r => ({ reaction: decodeMojibake(r.reaction), actor: r.actor })) : undefined,
    photos: m.photos,
    videos: m.videos,
    audio_files: m.audio_files
  }));
  const participants = (obj.participants || []).map(p => ({ ...p, name: p && p.name ? decodeMojibake(p.name) : p?.name }));
  return { title, thread_path: path, participants, messages };
}

function deriveTitle(participants) {
  const names = (participants||[]).map(p => p && p.name ? decodeMojibake(p.name) : p?.name).filter(Boolean);
  if (names.length <= 2) return names.filter(n=>n.toLowerCase() !== 'me')[0] || names.join(', ');
  return names.slice(0, 3).join(', ') + (names.length>3 ? ` +${names.length-3}` : '');
}

function mergeThreads(threads) {
  const map = new Map();
  for (const t of threads) {
    const key = t.thread_path || `title:${t.title}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...t, messages: [...(t.messages||[])] });
    } else {
      existing.messages.push(...(t.messages||[]));
      const seen = new Set((existing.participants||[]).map(p=>p.name));
      for (const p of (t.participants||[])) if (p && p.name && !seen.has(p.name)) existing.participants.push(p);
    }
  }
  for (const v of map.values()) v.messages.sort((a,b)=>a.timestamp_ms-b.timestamp_ms);
  return Array.from(map.values());
}

function normalizeSaved(obj){
  const out = [];
  for (const it of obj.saved_saved_media || []) {
    const map = it.string_map_data && it.string_map_data['Saved on'];
    if (!map) continue;
    const href = map.href || '';
    const ts = (map.timestamp||0) * 1000;
    const creator = it.title || '';
    let type = 'other';
    if (/\/reel\//.test(href)) type = 'reel';
    else if (/\/p\//.test(href)) type = 'post';
    out.push({ href, timestamp_ms: ts, creator, type });
  }
  return out;
}

function normalizeCommentsPosts(arr){
  const out = [];
  for (const it of arr) {
    const sm = it.string_map_data || {};
    const text = sm.Comment && sm.Comment.value ? decodeMojibake(sm.Comment.value) : '';
    const owner = sm['Media Owner'] && sm['Media Owner'].value || '';
    const ts = (sm.Time && sm.Time.timestamp ? sm.Time.timestamp : 0) * 1000;
    out.push({ text, owner, timestamp_ms: ts });
  }
  return out;
}

function normalizeCommentsReels(obj){
  return normalizeCommentsPosts(obj.comments_reels_comments || []);
}

function normalizeTopics(obj){
  const out = [];
  for (const it of obj.topics_your_topics || []) {
    const name = it.string_map_data && it.string_map_data.Name && it.string_map_data.Name.value;
    if (name) out.push(name);
  }
  return out;
}

// ============ Analytics ============
function computeAnalytics(threads) {
  const overview = { totalMessages: 0, totalConversations: threads.length, totalEmojis: 0, startDate: '-', endDate: '-', rangeDays: 0 };
  const convCounts = new Map();
  const emojiCounts = new Map();
  const daily = new Map();
  const hours = Array(24).fill(0);
  const words = new Map();
  const bySender = new Map();

  let minTs = Infinity, maxTs = -Infinity;
  let totalLength = 0, textCount = 0;
  const lengths = [];
  const oneToOne = new Map();
  let photos=0, videos=0, audios=0, reactions=0, mediaMsgs=0;

  for (const t of threads) {
    const count = t.messages.length;
    convCounts.set(t.title, (convCounts.get(t.title)||0)+count);
    const participants = (t.participants||[]).map(p=>p.name);
    if (participants.length === 2) {
      const partner = participants.find(n => n && n.toLowerCase() !== 'me') || participants[1];
      if (partner) oneToOne.set(partner, (oneToOne.get(partner)||0)+count);
    }

    for (const m of t.messages) {
      overview.totalMessages++;
      if (m.sender_name) bySender.set(m.sender_name, (bySender.get(m.sender_name)||0)+1);
      if (m.timestamp_ms) {
        if (m.timestamp_ms < minTs) minTs = m.timestamp_ms;
        if (m.timestamp_ms > maxTs) maxTs = m.timestamp_ms;
        const d = toDateOnly(m.timestamp_ms);
        const key = d.toISOString().slice(0,10);
        daily.set(key, (daily.get(key)||0) + 1);
        const hour = new Date(m.timestamp_ms).getHours();
        hours[hour]++;
      }
      if (m.content) {
        const text = m.content;
        totalLength += text.length; textCount++;
        lengths.push(text.length);
        const ems = extractEmojis(text);
        for (const e of ems) emojiCounts.set(e, (emojiCounts.get(e)||0)+1);
        for (const w of tokenizeWords(text)) words.set(w, (words.get(w)||0)+1);
      }
      if (Array.isArray(m.reactions)) {
        reactions += m.reactions.length;
        for (const r of m.reactions) {
          if (r && r.reaction) {
            const ems = extractEmojis(r.reaction);
            for (const e of ems) emojiCounts.set(e, (emojiCounts.get(e)||0)+1);
          }
        }
      }
      if (Array.isArray(m.photos) && m.photos.length) { photos += m.photos.length; mediaMsgs++; }
      if (Array.isArray(m.videos) && m.videos.length) { videos += m.videos.length; mediaMsgs++; }
      if (Array.isArray(m.audio_files) && m.audio_files.length) { audios += m.audio_files.length; mediaMsgs++; }
    }
  }

  if (minTs !== Infinity) {
    overview.startDate = fmtDate(minTs);
    overview.endDate = fmtDate(maxTs);
    overview.rangeDays = Math.max(1, Math.round((toDateOnly(maxTs) - toDateOnly(minTs)) / 86400000) + 1);
  }

  overview.totalEmojis = Array.from(emojiCounts.values()).reduce((a,b)=>a+b,0);

  const stats = { 
    avgPerDay: overview.totalMessages / (overview.rangeDays || 1), 
    mostActiveDayLabel: '-', 
    mostActiveHourLabel: '-', 
    avgMsgLength: textCount ? totalLength / textCount : 0, 
    medianMsgLength: lengths.length ? (lengths.sort((a,b)=>a-b)[Math.floor(lengths.length/2)]) : 0,
    mostActiveConversation: '-', 
    topOneToOne: '-',
    uniqueActiveDays: daily.size,
    media: { photos, videos, audios, messagesWithMedia: mediaMsgs },
    reactionsTotal: reactions,
    topSender: '-'
  };

  if (daily.size) {
    const best = [...daily.entries()].sort((a,b)=>b[1]-a[1])[0];
    stats.mostActiveDayLabel = `${best[0]} (${best[1].toLocaleString()})`;
  }
  {
    const bestHour = hours.map((v,i)=>[i,v]).sort((a,b)=>b[1]-a[1])[0];
    if (bestHour) stats.mostActiveHourLabel = `${bestHour[0]}:00 (${bestHour[1].toLocaleString()})`;
  }
  if (convCounts.size) {
    const bestConv = [...convCounts.entries()].sort((a,b)=>b[1]-a[1])[0];
    stats.mostActiveConversation = `${cleanTitle(bestConv[0])} (${bestConv[1].toLocaleString()} msgs)`;
  }
  if (oneToOne.size) {
    const best12 = [...oneToOne.entries()].sort((a,b)=>b[1]-a[1])[0];
    if (best12) stats.topOneToOne = `${best12[0]} (${best12[1].toLocaleString()} msgs)`;
  }
  if (bySender.size) {
    const bestSender = [...bySender.entries()].sort((a,b)=>b[1]-a[1])[0];
    stats.topSender = `${bestSender[0]} (${bestSender[1].toLocaleString()} msgs)`;
  }

  const charts = {
    conversationsTop10: topNMap(convCounts, 10),
    emojisTop15: topNMap(emojiCounts, 15),
    dailySeries: [...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0])),
    hoursSeries: hours.map((v,i)=>[i, v]),
    wordsTop20: topNMap(words, 20)
  };

  return { overview, stats, charts };
}

function topNMap(map, n) { return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n); }

// ============ Charts ============
const chartState = { charts: {}, destroy(id){ if(this.charts[id]) { this.charts[id].destroy(); delete this.charts[id]; } } };

function makeBarChart(id, labels, values, opts={}) {
  chartState.destroy(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const dark = document.documentElement.classList.contains('dark');
  const tick = dark ? '#cbd5e1' : '#334155';
  const grid = dark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';
  chartState.charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: opts.label || '', data: values, backgroundColor: opts.color || (dark ? 'rgba(99,102,241,0.8)' : 'rgba(37, 99, 235, 0.6)') }]},
    options: { animation: false, responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: tick, maxRotation: 0, autoSkip: true }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: tick }, grid: { color: grid } } }, plugins: { legend: { display: false } } }
  });
}

function makeLineChart(id, labels, values, opts={}) {
  chartState.destroy(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const dark = document.documentElement.classList.contains('dark');
  const tick = dark ? '#cbd5e1' : '#334155';
  const grid = dark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';
  chartState.charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: opts.label || '', data: values, fill: false, borderColor: opts.color || (dark ? 'rgb(99,102,241)' : 'rgb(37,99,235)'), tension: 0.2, pointRadius: 0 }]},
    options: { animation: false, responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: tick }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: tick }, grid: { color: grid } } }, plugins: { legend: { display: false } } }
  });
}

// ============ Alpine App ============
function app() {
  return {
    // state
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'conversations', label: 'Conversations' },
      { id: 'emojis', label: 'Emojis' },
      { id: 'activity', label: 'Activity' },
      { id: 'words', label: 'Words' },
      { id: 'stats', label: 'Stats' },
      { id: 'engagement', label: 'Engagement' },
      { id: 'interests', label: 'Interests' }
    ],
    activeTab: 'overview',
    loading: false,
    hasData: false,
    errors: [],
    isDrag: false,
    dark: false,
    extra: { saves: [], comments: [], topics: [] },
    extrasAnalytics: null,

    // filtering
    selectedThreadKey: 'ALL',
    threadOptions: [], // { key, label }

    // computed data
    threads: [],
    overview: { totalMessages: 0, totalConversations: 0, totalEmojis: 0, startDate: '-', endDate: '-', rangeDays: 0 },
    stats: { avgPerDay: 0, mostActiveDayLabel: '-', mostActiveHourLabel: '-', avgMsgLength: 0, medianMsgLength: 0, mostActiveConversation: '-', topOneToOne: '-', uniqueActiveDays: 0, media: { photos: 0, videos: 0, audios: 0, messagesWithMedia: 0 }, reactionsTotal: 0, topSender: '-' },
    charts: null,

    init() {
      // theme
      this.dark = this.getInitialTheme();
      this.applyDark();
      // preload sample
      fetch('./sample-data.json').then(r=>r.ok?r.json():null).then(j=>{
        if (!j) return;
        const merged = mergeThreads([normalizeThread(j)]);
        this.threads = merged;
        this.buildThreadOptions();
        const a = computeAnalytics(merged);
        this.overview = a.overview; this.stats = a.stats; this.charts = a.charts; this.hasData = true;
        this.renderChartsForTab('overview');
      }).catch(()=>{});
    },

    getInitialTheme(){
      const saved = localStorage.getItem('theme');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    applyDark(){
      document.documentElement.classList.toggle('dark', this.dark);
    },
    toggleDark(){
      this.dark = !this.dark;
      localStorage.setItem('theme', this.dark ? 'dark' : 'light');
      this.applyDark();
      // re-render charts to update colors
      this.renderChartsForTab(this.activeTab);
    },

    setTab(id){ this.activeTab = id; this.renderChartsForTab(id); },

    buildThreadOptions(){
      const items = [];
      for (const t of this.threads) {
        const key = t.thread_path || `title:${t.title}`;
        const labelDisplay = (t.title ? decodeMojibake(t.title) : key) || key;
        const sortKey = cleanTitle(labelDisplay).toLowerCase();
        items.push({ key, label: labelDisplay, sortKey });
      }
      // Sort A–Z by cleaned sortKey
      items.sort((a,b)=> a.sortKey.localeCompare(b.sortKey));
      // Deduplicate visible labels by suffixing an index when necessary
      const seen = new Map();
      for (const it of items) {
        const base = it.label;
        const count = seen.get(base) || 0;
        if (count > 0) it.label = `${base} (${count+1})`;
        seen.set(base, count+1);
      }
      this.threadOptions = [{ key: 'ALL', label: 'All conversations', sortKey: '' }, ...items];
    },
    searchQuery: '',
    filteredThreadOptions(){
      const q = (this.searchQuery || '').toLowerCase().trim();
      if (!q) return this.threadOptions;
      return this.threadOptions.filter(o => o.key === 'ALL' || o.label.toLowerCase().includes(q));
    },

    async handleFileInput(e){ const files = e.target.files; await this.processFiles(files); e.target.value = ''; },

    async onDrop(e){
      this.isDrag = false;
      const items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        const files = await this.readDataTransferItems(items);
        await this.processFiles(files);
      } else {
        await this.processFiles(e.dataTransfer.files);
      }
    },

    async readDataTransferItems(items){
      const filePromises = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) filePromises.push(this.traverseEntry(entry));
      }
      const nested = await Promise.all(filePromises);
      return nested.flat();
    },

    traverseEntry(entry){
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file(file => resolve([file]));
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const all = [];
          const readEntries = () => dirReader.readEntries(entries => {
            if (!entries.length) return resolve(Promise.all(all).then(a=>a.flat()));
            for (const ent of entries) all.push(this.traverseEntry(ent));
            readEntries();
          });
          readEntries();
        } else {
          resolve([]);
        }
      });
    },

    async processFiles(fileList){
      try {
        this.loading = true; this.errors = [];
        const { threads, extra } = await readAllJsonFiles(fileList);
        if (!threads.length) throw new Error('No valid DM JSON files found.');
        this.threads = threads;
        this.extra = extra || { saves: [], comments: [], topics: [] };
        this.buildThreadOptions();
        this.selectedThreadKey = 'ALL';
        const a = computeAnalytics(threads);
        this.overview = a.overview; this.stats = a.stats; this.charts = a.charts; this.hasData = true;
        this.extrasAnalytics = computeExtrasAnalytics(this.extra);
        this.renderChartsForTab(this.activeTab);
      } catch (e) {
        this.errors.push(e.message || String(e));
      } finally {
        this.loading = false;
      }
    },

    applyThreadFilter(){
      const filtered = this.selectedThreadKey === 'ALL' ? this.threads : this.threads.filter(t => (t.thread_path || `title:${t.title}`) === this.selectedThreadKey);
      const a = computeAnalytics(filtered);
      this.overview = a.overview; this.stats = a.stats; this.charts = a.charts; this.hasData = true;
      this.renderChartsForTab(this.activeTab);
    },

    renderChartsForTab(tab){
      if (!this.charts) return;
      if (tab === 'overview') {
        const [cl, cv] = splitLabelsVals(this.charts.conversationsTop10);
        makeBarChart('chartConversations', cl, cv, { label: 'Messages', color: 'rgba(99,102,241,0.7)' });
        const [el, ev] = splitLabelsVals(this.charts.emojisTop15);
        makeBarChart('chartEmojis', el, ev, { label: 'Count', color: 'rgba(245,158,11,0.7)' });
      }
      if (tab === 'conversations') {
        const [cl, cv] = splitLabelsVals(this.charts.conversationsTop10);
        makeBarChart('chartConversationsFull', cl, cv, { label: 'Messages', color: 'rgba(59,130,246,0.7)' });
      }
      if (tab === 'emojis') {
        const [el, ev] = splitLabelsVals(this.charts.emojisTop15);
        makeBarChart('chartEmojisFull', el, ev, { label: 'Count', color: 'rgba(234,179,8,0.7)' });
      }
      if (tab === 'activity') {
        const labels = this.charts.dailySeries.map(d=>d[0]);
        const values = this.charts.dailySeries.map(d=>d[1]);
        makeLineChart('chartDaily', labels, values, { label: 'Messages per day' });
        const hLabels = this.charts.hoursSeries.map(d=>d[0]);
        const hValues = this.charts.hoursSeries.map(d=>d[1]);
        makeBarChart('chartHours', hLabels, hValues, { label: 'Messages', color: 'rgba(16,185,129,0.7)' });
      }
      if (tab === 'words') {
        const [wl, wv] = splitLabelsVals(this.charts.wordsTop20);
        makeBarChart('chartWords', wl, wv, { label: 'Count', color: 'rgba(107,114,128,0.8)' });
      }
      if (tab === 'engagement' && this.extrasAnalytics) {
        makeLineChart('chartSavesTimeline', this.extrasAnalytics.saves.timeline.labels, this.extrasAnalytics.saves.timeline.values, { label: 'Saves/day' });
        makeBarChart('chartSavesTopCreators', this.extrasAnalytics.saves.topCreators.labels, this.extrasAnalytics.saves.topCreators.values, { label: 'Top saved creators' });
        makeBarChart('chartSavesTopDomains', this.extrasAnalytics.saves.topDomains.labels, this.extrasAnalytics.saves.topDomains.values, { label: 'Top saved domains' });
        makeLineChart('chartCommentsTimeline', this.extrasAnalytics.comments.timeline.labels, this.extrasAnalytics.comments.timeline.values, { label: 'Comments/day' });
        makeBarChart('chartCommentsTopOwners', this.extrasAnalytics.comments.topOwners.labels, this.extrasAnalytics.comments.topOwners.values, { label: 'Owners you comment on' });
        makeBarChart('chartCommentsTopEmojis', this.extrasAnalytics.comments.topEmojis.labels, this.extrasAnalytics.comments.topEmojis.values, { label: 'Top comment emojis' });
      }
      if (tab === 'interests' && this.extrasAnalytics) {
        makeBarChart('chartTopicsTop', this.extrasAnalytics.topics.top.labels, this.extrasAnalytics.topics.top.values, { label: 'Your topics' });
      }
    },
  };
}

window.app = app;

function splitLabelsVals(entries){ const labels = entries.map(e=>e[0]); const values = entries.map(e=>e[1]); return [labels, values]; }

// Remove emojis and tidy whitespace for display labels
function cleanTitle(s){
  if (!s) return '';
  try {
    const noEmoji = s.replace(emojiRegex, '').replace(/[\uFE0F\u200D]/g,'');
    return noEmoji.replace(/\s+/g,' ').trim();
  } catch {
    return s.trim();
  }
}

function computeExtrasAnalytics(extra){
  const saves = extra.saves || [];
  const comments = extra.comments || [];
  const topics = extra.topics || [];

  const byDay = new Map();
  let firstSave = null, lastSave = null;
  const byCreator = new Map();
  const byDomain = new Map();
  const typeCount = { post:0, reel:0, other:0 };
  for (const s of saves) {
  const d = toDateOnly(s.timestamp_ms).toISOString().slice(0,10);
  byDay.set(d, (byDay.get(d)||0)+1);
    if (!firstSave || s.timestamp_ms < firstSave) firstSave = s.timestamp_ms;
    if (!lastSave || s.timestamp_ms > lastSave) lastSave = s.timestamp_ms;
    if (s.creator) byCreator.set(s.creator, (byCreator.get(s.creator)||0)+1);
    try {
      const u = new URL(s.href);
      byDomain.set(u.hostname, (byDomain.get(u.hostname)||0)+1);
    } catch {}
    if (s.type && typeCount[s.type] != null) typeCount[s.type]++;
  }
  const savesTimeline = Array.from(byDay.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  const topCreators = Array.from(byCreator.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topDomains = Array.from(byDomain.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const cByDay = new Map();
  const cByOwner = new Map();
  const cEmoji = new Map();
  let cTotalLen = 0;
  const lengths = [];
  let cFirst=null, cLast=null;
  for (const c of comments) {
  const d = toDateOnly(c.timestamp_ms).toISOString().slice(0,10);
  cByDay.set(d, (cByDay.get(d)||0)+1);
    if (!cFirst || c.timestamp_ms < cFirst) cFirst = c.timestamp_ms;
    if (!cLast || c.timestamp_ms > cLast) cLast = c.timestamp_ms;
    if (c.owner) cByOwner.set(c.owner, (cByOwner.get(c.owner)||0)+1);
    const text = c.text || '';
    cTotalLen += text.length;
    lengths.push(text.length);
    for (const e of extractEmojis(text)) cEmoji.set(e, (cEmoji.get(e)||0)+1);
  }
  lengths.sort((a,b)=>a-b);
  const cMedian = lengths.length ? (lengths[Math.floor((lengths.length-1)/2)] + lengths[Math.ceil((lengths.length-1)/2)]) / 2 : 0;
  const commentsTimeline = Array.from(cByDay.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  const topOwners = Array.from(cByOwner.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topCommentEmojis = Array.from(cEmoji.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const topicsCount = new Map();
  for (const t of topics) topicsCount.set(t, (topicsCount.get(t)||0)+1);
  const topicsTop = Array.from(topicsCount.entries()).sort((a,b)=>b[1]-a[1]).slice(0,20);

  return {
    saves: {
      total: saves.length,
  first: firstSave ? fmtDate(firstSave) : null,
  last: lastSave ? fmtDate(lastSave) : null,
      typeCount,
      timeline: { labels: savesTimeline.map(([d])=>d), values: savesTimeline.map(([,v])=>v) },
      topCreators: { labels: topCreators.map(([k])=>k), values: topCreators.map(([,v])=>v) },
      topDomains: { labels: topDomains.map(([k])=>k), values: topDomains.map(([,v])=>v) },
    },
    comments: {
      total: comments.length,
  first: cFirst ? fmtDate(cFirst) : null,
  last: cLast ? fmtDate(cLast) : null,
      avgLen: comments.length ? (cTotalLen / comments.length) : 0,
      medianLen: cMedian,
      timeline: { labels: commentsTimeline.map(([d])=>d), values: commentsTimeline.map(([,v])=>v) },
      topOwners: { labels: topOwners.map(([k])=>k), values: topOwners.map(([,v])=>v) },
      topEmojis: { labels: topCommentEmojis.map(([k])=>k), values: topCommentEmojis.map(([,v])=>v) },
    },
    topics: {
      count: topics.length,
      top: { labels: topicsTop.map(([k])=>k), values: topicsTop.map(([,v])=>v) }
    }
  };
}
