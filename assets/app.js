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

// Words from system messages or Instagram-y boilerplate we don't want in stats
const BAD_WORDS = new Set([
  'message','messages','liked','like','reaction','reacted','removed','unsent','shared','sent','photo','video','audio','gif','sticker','mentioned','created','named','joined','left','missed','call','called','voice','seen','story','reply','replied','forwarded','chat','group','attachment'
]);

function isEmojiToken(s){
  if (!s || typeof s !== 'string') return false;
  // Must not contain letters or digits
  if (/[A-Za-z0-9]/.test(s)) return false;
  // Prefer Unicode property check when available
  try {
    if (/(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji})/u.test(s)) return true;
  } catch {}
  // Fallback: presence of VS16/ZWJ or codepoints in typical emoji ranges
  if (/\uFE0F|\u200D/.test(s)) return true;
  const cp = s.codePointAt(0) || 0;
  return (
    (cp >= 0x1F000 && cp <= 0x1FAFF) ||
    (cp >= 0x1F300 && cp <= 0x1F6FF) ||
    (cp >= 0x1F900 && cp <= 0x1F9FF) ||
    (cp >= 0x2600 && cp <= 0x27BF)
  );
}

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
  return words.filter(w => w.length > 1 && !STOP_WORDS.has(w) && !BAD_WORDS.has(w) && !/^\d+$/.test(w));
}

// ============ Parsing ============
// Accept: FileList or DataTransferItemList from folder or multiple files
async function readAllJsonFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.endsWith('.json'));
  const skipNames = new Set(['ai_conversations.json', 'secret_conversations.json', 'reported_conversations.json']);
  const threadsRaw = [];
  const extra = { saves: [], comments: [], topics: [], logins: [], logouts: [], devices: [], profile: [], signup: [], lastLocation: [], geoPoints: [], twoFA: [], camera: [], inferredEmails: [] };
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
      } else if (isLoginHistory(json)) {
        extra.logins.push(...normalizeLogins(json));
      } else if (isDeviceInfo(json)) {
        extra.devices.push(...normalizeDevices(json));
      } else if (isProfileChanges(json)) {
        extra.profile.push(...normalizeProfile(json));
      } else if (isLogoutActivity(json)) {
        extra.logouts.push(...normalizeLogout(json));
      } else if (isPasswordChangeActivity(json)) {
        extra.profile.push(...normalizePasswordChanges(json));
      } else if (isProfilePrivacyChanges(json)) {
        extra.profile.push(...normalizeProfilePrivacy(json));
      } else if (isProfileStatusChanges(json)) {
        extra.profile.push(...normalizeProfileStatus(json));
      } else if (isSignupDetails(json)) {
        const { signup, profile } = normalizeSignupDetails(json);
        extra.signup.push(...signup);
        extra.profile.push(...profile);
      } else if (isLastKnownLocation(json)) {
        extra.lastLocation.push(...normalizeLastKnownLocation(json));
      } else if (isLocationsOfInterest(json)) {
        extra.geoPoints.push(...normalizeLocationsOfInterest(json));
      } else if (isFriendMap(json)) {
        extra.geoPoints.push(...normalizeFriendMap(json));
      } else if (isMediaWithLocation(json)) {
        extra.geoPoints.push(...normalizeMediaWithLocation(json));
      } else if (isTwoFactorDevices(json)) {
        extra.twoFA.push(...normalizeTwoFactorDevices(json));
      } else if (isCameraDevices(json)) {
        extra.camera.push(...normalizeCameraDevices(json));
      } else if (isPossibleEmails(json)) {
        extra.inferredEmails.push(...normalizePossibleEmails(json));
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
// Security-related recognizers (updated to match actual IG export format)
function isLoginHistory(obj){
  return obj && Array.isArray(obj.account_history_login_history);
}
function isDeviceInfo(obj){ return obj && (Array.isArray(obj.account_device_history) || Array.isArray(obj.devices_sessions) || Array.isArray(obj.devices_devices)); }
function isProfileChanges(obj){
  // personal_information/profile_changes/profile_changes.json: { profile_changes: [ { changed_property, new_value, timestamp } ] }
  return obj && (Array.isArray(obj.profile_changes) || Array.isArray(obj.account_profile_changes));
}
function isLogoutActivity(obj){ return obj && Array.isArray(obj.account_history_logout_history); }
function isPasswordChangeActivity(obj){ return obj && Array.isArray(obj.account_history_password_change_history); }
function isProfilePrivacyChanges(obj){ return obj && Array.isArray(obj.account_history_account_privacy_history); }
function isProfileStatusChanges(obj){ return obj && Array.isArray(obj.account_history_account_active_status_changes); }
function isSignupDetails(obj){ return obj && Array.isArray(obj.account_history_registration_info); }
function isLastKnownLocation(obj){ return obj && Array.isArray(obj.account_history_imprecise_last_known_location); }
// Additional location sources
function isLocationsOfInterest(obj){
  if (!obj) return false;
  if (Array.isArray(obj.locations_of_interest)) return true;
  if (Array.isArray(obj) && obj.length && obj[0] && obj[0].string_map_data && (obj[0].string_map_data['Latitude'] || obj[0].string_map_data['Imprecise Latitude'])) return true;
  if (Array.isArray(obj.label_values)) {
    const lv = obj.label_values.find(x => (x.label||'').toLowerCase().includes('locations of interest'));
    if (lv && (Array.isArray(lv.vec) || typeof lv.value === 'string')) return true;
  }
  return false;
}
function isFriendMap(obj){
  const arr = (obj && (obj.instagram_friend_map || obj.nodes)) || null;
  if (Array.isArray(arr) && arr.length) return true;
  return false;
}
function isMediaWithLocation(obj){
  if (!obj) return false;
  if (Array.isArray(obj)) {
    return obj.some(it => it && (it.location || (Array.isArray(it.media) && it.media.some(m=>m && m.location))));
  }
  if (Array.isArray(obj.media)) return obj.media.some(m=>m && m.location);
  return false;
}
function isTwoFactorDevices(obj){ return obj && Array.isArray(obj.devices_two_factor_authentication); }
function isCameraDevices(obj){ return obj && Array.isArray(obj.devices_camera); }
function isPossibleEmails(obj){ return obj && Array.isArray(obj.inferred_data_inferred_emails); }

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

// ---------- Security normalizers ----------
function normKey(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function smdVal(smd, key){
  if (!smd) return undefined;
  const nk = normKey(key);
  for (const k of Object.keys(smd)) if (normKey(k) === nk) return smd[k];
  return undefined;
}
function pickSmdValue(smd, key){ const v = smdVal(smd, key); return v ? (v.value ?? v.href ?? '') : ''; }
function pickSmdTs(smd, key){ const v = smdVal(smd, key); return v ? (v.timestamp ? v.timestamp*1000 : (v.value && !isNaN(+v.value) ? +v.value : 0)) : 0; }

function normalizeLogins(obj){
  const src = obj.account_history_login_history || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    // Extract timestamp from title (ISO format) or Time field
    let ts = 0;
    if (it.title && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(it.title)) {
      ts = new Date(it.title).getTime();
    } else {
      ts = pickSmdTs(smd, 'Time');
    }
  const location = pickSmdValue(smd,'City') || pickSmdValue(smd,'Location') || pickSmdValue(smd,'Region') || pickSmdValue(smd,'Country') || pickSmdValue(smd,'Country Code') || '';
    const country = pickSmdValue(smd,'Country') || '';
    const countryCode = (pickSmdValue(smd,'Country Code') || '').toUpperCase();
    const ip = pickSmdValue(smd,'IP Address') || pickSmdValue(smd,'IP') || '';
    const device = pickSmdValue(smd,'User Agent') || pickSmdValue(smd,'Device') || '';
    // Geo if present
    let lat = null, lon = null;
    const latV = pickSmdValue(smd,'Latitude'); 
    const lonV = pickSmdValue(smd,'Longitude');
    if (latV && lonV && !isNaN(+latV) && !isNaN(+lonV)) { lat = +latV; lon = +lonV; }
    out.push({ timestamp_ms: ts, location, ip, device, lat, lon, country, countryCode });
  }
  return out;
}

function normalizeDevices(obj){
  const src = obj.account_device_history || obj.devices_sessions || obj.devices_devices || [];
  const out = [];
  for (const it of src) {
    let device = it.device || it.device_model || it.user_agent || it.os || '';
    let last = (it.last_login_timestamp_ms != null ? it.last_login_timestamp_ms : (it.last_login_timestamp ? it.last_login_timestamp*1000 : 0));
    if (!device && it.string_map_data) device = pickSmdValue(it.string_map_data, 'User Agent') || '';
    if (!last && it.string_map_data) last = pickSmdTs(it.string_map_data, 'Last Login') || 0;
    out.push({ device, last_login_ms: last });
  }
  return out;
}

function normalizeProfile(obj){
  const src = obj.profile_changes || obj.account_profile_changes || [];
  const out = [];
  for (const it of src) {
    const type = it.changed_property || it.property || '';
    const value = decodeMojibake(it.new_value || it.value || '');
    const ts = (it.timestamp_ms != null ? it.timestamp_ms : (it.timestamp ? it.timestamp*1000 : 0));
    out.push({ type, value, timestamp_ms: ts });
  }
  return out;
}

function normalizeLogout(obj){
  const src = obj.account_history_logout_history || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    // Extract timestamp from title (ISO format) or Time field
    let ts = 0;
    if (it.title && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(it.title)) {
      ts = new Date(it.title).getTime();
    } else {
      ts = pickSmdTs(smd, 'Time');
    }
    const location = pickSmdValue(smd,'City') || pickSmdValue(smd,'Location') || '';
    const ip = pickSmdValue(smd,'IP Address') || pickSmdValue(smd,'IP') || '';
    const device = pickSmdValue(smd,'User Agent') || pickSmdValue(smd,'Device') || '';
    const cookie = pickSmdValue(smd,'Cookie Name') || '';
    const language = pickSmdValue(smd,'Language Code') || '';
    out.push({ timestamp_ms: ts, location, ip, device, cookie, language });
  }
  return out;
}

function normalizePasswordChanges(obj){
  const src = obj.account_history_password_change_history || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const ts = pickSmdTs(smd, 'Time') || 0;
    out.push({ type: 'password_change', value: 'Changed', timestamp_ms: ts });
  }
  return out;
}

function normalizeProfilePrivacy(obj){
  const src = obj.account_history_account_privacy_history || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const ts = pickSmdTs(smd, 'Time') || 0;
    const v = it.title || pickSmdValue(smd, 'Privacy') || pickSmdValue(smd,'Status') || '';
    out.push({ type: 'privacy', value: v, timestamp_ms: ts });
  }
  return out;
}

function normalizeProfileStatus(obj){
  const src = obj.account_history_account_active_status_changes || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const ts = pickSmdTs(smd, 'Time') || 0;
    const activationType = pickSmdValue(smd, 'Activation Type') || '';
    const automated = pickSmdValue(smd, 'Automated') || '';
    const reason = pickSmdValue(smd, 'Inactivation Reason') || '';
    const desc = `${activationType} (${automated})${reason ? ' - ' + reason : ''}`;
    out.push({ type: 'account_status', value: desc, timestamp_ms: ts });
  }
  return out;
}

function normalizeSignupDetails(obj){
  const src = obj.account_history_registration_info || [];
  const signup = [];
  const profile = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const ts = pickSmdTs(smd, 'Time') || 0;
    const email = pickSmdValue(smd, 'Email') || '';
    const phone = pickSmdValue(smd, 'Phone Number') || '';
    const username = pickSmdValue(smd, 'Username') || '';
    const ip = pickSmdValue(smd, 'IP Address') || '';
    const device = pickSmdValue(smd, 'Device') || '';
    if (email) profile.push({ type: 'email', value: email, timestamp_ms: ts });
    if (phone) profile.push({ type: 'phone_number', value: phone, timestamp_ms: ts });
    if (username) profile.push({ type: 'username', value: username, timestamp_ms: ts });
    signup.push({ timestamp_ms: ts, email, phone, username, ip, device });
  }
  return { signup, profile };
}

function normalizeLastKnownLocation(obj){
  const src = obj.account_history_imprecise_last_known_location || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const ts = pickSmdTs(smd, 'GPS Time Uploaded') || 0;
    // Get both precise and imprecise coordinates
    const impreciseLat = pickSmdValue(smd, 'Imprecise Latitude');
    const impreciseLon = pickSmdValue(smd, 'Imprecise Longitude');
    const preciseLat = pickSmdValue(smd, 'Precise Latitude');
    const preciseLon = pickSmdValue(smd, 'Precise Longitude');
    
    // Prefer precise if available, fallback to imprecise
    const lat = (preciseLat && !isNaN(+preciseLat)) ? +preciseLat : 
                (impreciseLat && !isNaN(+impreciseLat)) ? +impreciseLat : null;
    const lon = (preciseLon && !isNaN(+preciseLon)) ? +preciseLon : 
                (impreciseLon && !isNaN(+impreciseLon)) ? +impreciseLon : null;
    
    out.push({ 
      timestamp_ms: ts, 
      location: 'Last known location', 
      ip: '', 
      device: '', 
      lat, 
      lon,
      precise: !!(preciseLat && preciseLon)
    });
  }
  return out;
}

// ----- Other location sources normalizers -----
function normalizeLocationsOfInterest(obj){
  const out = [];
  // Case 1: array of objects with string_map_data
  const src = obj.locations_of_interest || obj || [];
  if (Array.isArray(src) && src.length && src[0] && src[0].string_map_data) {
    for (const it of src) {
      const smd = it.string_map_data || {};
      const name = pickSmdValue(smd, 'Location') || pickSmdValue(smd, 'Name') || it.title || 'Location of interest';
      const ts = pickSmdTs(smd, 'Time') || pickSmdTs(smd, 'GPS Time Uploaded') || 0;
      const pLat = pickSmdValue(smd, 'Precise Latitude');
      const pLon = pickSmdValue(smd, 'Precise Longitude');
      const iLat = pickSmdValue(smd, 'Imprecise Latitude') || pickSmdValue(smd, 'Latitude');
      const iLon = pickSmdValue(smd, 'Imprecise Longitude') || pickSmdValue(smd, 'Longitude');
      const lat = (pLat && !isNaN(+pLat)) ? +pLat : ((iLat && !isNaN(+iLat)) ? +iLat : null);
      const lon = (pLon && !isNaN(+pLon)) ? +pLon : ((iLon && !isNaN(+iLon)) ? +iLon : null);
      if (lat != null && lon != null) out.push({ timestamp_ms: ts, lat, lon, location: name, type: 'interest_location' });
    }
  }
  // Case 2: label_values with vec of { value: "City, Country" }
  if (Array.isArray(obj.label_values)) {
    const lv = obj.label_values.find(x => (x.label||'').toLowerCase().includes('locations of interest'));
    if (lv) {
      const list = Array.isArray(lv.vec) ? lv.vec.map(v => v.value) : (lv.value ? [lv.value] : []);
      for (const name of list) {
        if (!name) continue;
        // Derive country by suffix after comma, or whole string
        const parts = String(name).split(',');
        const tail = parts.length > 1 ? parts[parts.length-1].trim() : String(name).trim();
        const centroid = findCountryCentroid(tail, null) || findCountryCentroid(name, null);
        if (centroid) {
          out.push({ timestamp_ms: 0, lat: centroid.lat, lon: centroid.lon, location: name, type: 'interest_label' });
        }
      }
    }
  }
  return out;
}

function normalizeFriendMap(obj){
  const src = obj.instagram_friend_map || obj.nodes || [];
  const out = [];
  for (const it of src) {
    const lat = (it.latitude != null ? +it.latitude : (it.lat != null ? +it.lat : null));
    const lon = (it.longitude != null ? +it.longitude : (it.lng != null ? +it.lng : (it.lon != null ? +it.lon : null)));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const ts = (it.timestamp_ms != null ? +it.timestamp_ms : (it.timestamp ? (+it.timestamp * 1000) : 0));
    const name = it.name || it.title || 'Friend map';
    out.push({ timestamp_ms: ts, lat, lon, location: name, type: 'friend_map' });
  }
  return out;
}

function normalizeMediaWithLocation(obj){
  const out = [];
  const pushFromItem = (item) => {
    if (!item) return;
    const loc = item.location || {};
    const lat = (loc.lat != null ? +loc.lat : (loc.latitude != null ? +loc.latitude : null));
    const lon = (loc.lng != null ? +loc.lng : (loc.longitude != null ? +loc.longitude : null));
    if (!isFinite(lat) || !isFinite(lon)) return;
    const ts = (item.creation_timestamp ? +item.creation_timestamp * 1000 : (item.taken_at ? +item.taken_at * 1000 : 0));
    const name = loc.name || loc.title || 'Media location';
    out.push({ timestamp_ms: ts, lat, lon, location: name, type: 'media_location' });
  };
  if (Array.isArray(obj)) {
    for (const it of obj) {
      if (Array.isArray(it?.media)) it.media.forEach(pushFromItem);
      else pushFromItem(it);
    }
  } else if (Array.isArray(obj.media)) {
    obj.media.forEach(pushFromItem);
  }
  return out;
}

function normalizeTwoFactorDevices(obj){
  const src = obj.devices_two_factor_authentication || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const nickname = pickSmdValue(smd, 'Nickname') || '';
    const deviceId = pickSmdValue(smd, 'Device ID') || '';
    out.push({ nickname, deviceId });
  }
  return out;
}

function normalizeCameraDevices(obj){
  const src = obj.devices_camera || [];
  const out = [];
  for (const it of src) {
    const smd = it.string_map_data || {};
    const deviceId = pickSmdValue(smd, 'Device ID') || '';
    const sdk = pickSmdValue(smd, 'Supported SDK Versions') || '';
    const compression = pickSmdValue(smd, 'Compression') || '';
    const faceTracker = pickSmdValue(smd, 'Face Tracker Version') || '';
    out.push({ deviceId, sdk, compression, faceTracker });
  }
  return out;
}

function normalizePossibleEmails(obj){
  const src = obj.inferred_data_inferred_emails || [];
  const out = [];
  for (const it of src) {
    const lst = it.string_list_data || [];
    for (const s of lst) if (s && s.value) out.push(s.value);
  }
  return out;
}

// ============ Analytics ============
function computeAnalytics(threads) {
  const overview = { totalMessages: 0, totalConversations: threads.length, totalEmojis: 0, startDate: '-', endDate: '-', rangeDays: 0 };
  const convCounts = new Map();
  const emojiTextCounts = new Map();
  const emojiReactionCounts = new Map();
  const daily = new Map();
  const hours = Array(24).fill(0);
  const words = new Map();
  const bySender = new Map();
  const bySenderTextLen = new Map();
  const bySenderMsgCount = new Map();
  const bySenderWords = new Map();
  const bySenderMedia = new Map();
  const goodBoyBySender = new Map();

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
  const ems = extractEmojis(text).filter(isEmojiToken);
  for (const e of ems) emojiTextCounts.set(e, (emojiTextCounts.get(e)||0)+1);
        const toks = tokenizeWords(text);
        for (const w of toks) words.set(w, (words.get(w)||0)+1);
        if (m.sender_name) {
          bySenderTextLen.set(m.sender_name, (bySenderTextLen.get(m.sender_name)||0) + text.length);
          bySenderMsgCount.set(m.sender_name, (bySenderMsgCount.get(m.sender_name)||0) + 1);
          bySenderWords.set(m.sender_name, (bySenderWords.get(m.sender_name)||0) + toks.length);
      // 'good boy' counter (case-insensitive, allows multiple spaces)
      const lower = text.toLowerCase();
      const matches = lower.match(/\bgood\s+boy\b/g);
      const inc = matches ? matches.length : 0;
      if (inc) goodBoyBySender.set(m.sender_name, (goodBoyBySender.get(m.sender_name)||0) + inc);
        }
      }
      if (Array.isArray(m.reactions)) {
        reactions += m.reactions.length;
        for (const r of m.reactions) {
          if (r && r.reaction) {
            const ems = extractEmojis(r.reaction).filter(isEmojiToken);
            for (const e of ems) emojiReactionCounts.set(e, (emojiReactionCounts.get(e)||0)+1);
          }
        }
      }
  if (Array.isArray(m.photos) && m.photos.length) { photos += m.photos.length; mediaMsgs++; if (m.sender_name) bySenderMedia.set(m.sender_name, (bySenderMedia.get(m.sender_name)||0) + m.photos.length); }
  if (Array.isArray(m.videos) && m.videos.length) { videos += m.videos.length; mediaMsgs++; if (m.sender_name) bySenderMedia.set(m.sender_name, (bySenderMedia.get(m.sender_name)||0) + m.videos.length); }
  if (Array.isArray(m.audio_files) && m.audio_files.length) { audios += m.audio_files.length; mediaMsgs++; if (m.sender_name) bySenderMedia.set(m.sender_name, (bySenderMedia.get(m.sender_name)||0) + m.audio_files.length); }
    }
  }

  if (minTs !== Infinity) {
    overview.startDate = fmtDate(minTs);
    overview.endDate = fmtDate(maxTs);
    overview.rangeDays = Math.max(1, Math.round((toDateOnly(maxTs) - toDateOnly(minTs)) / 86400000) + 1);
  }

  const totalEmoji = (map) => Array.from(map.values()).reduce((a,b)=>a+b,0);
  overview.totalEmojis = totalEmoji(emojiTextCounts) + totalEmoji(emojiReactionCounts);

  // Highest messages in a single day
  let maxPerDayCount = 0; let maxPerDayDate = '-';
  if (daily.size) {
    const maxEntry = [...daily.entries()].sort((a,b)=>b[1]-a[1])[0];
    if (maxEntry) { maxPerDayDate = maxEntry[0]; maxPerDayCount = maxEntry[1]; }
  }

  // Streaks
  function computeStreaks(minTs, maxTs){
    if (!isFinite(minTs) || !isFinite(maxTs)) return { current: 0, longest: 0 };
    const start = toDateOnly(minTs);
    const end = toDateOnly(maxTs);
    const active = new Set([...daily.entries()].map(e=>e[0]));
    let longest = 0, current = 0, run = 0;
    for (let d = new Date(start); d <= end; d = new Date(d.getTime()+86400000)) {
      const key = d.toISOString().slice(0,10);
      if (active.has(key)) { run++; longest = Math.max(longest, run); }
      else { run = 0; }
    }
    // current streak from end backwards
    for (let d = new Date(end); d >= start; d = new Date(d.getTime()-86400000)) {
      const key = d.toISOString().slice(0,10);
      if (active.has(key)) current++; else break;
    }
    return { current, longest };
  }
  const streak = computeStreaks(minTs, maxTs);

  // Trend: compare last 30 days vs previous 30 days
  function sumRange(from, to){
    let sum = 0;
    for (let d = new Date(from); d <= to; d = new Date(d.getTime()+86400000)) {
      const k = d.toISOString().slice(0,10);
      sum += daily.get(k) || 0;
    }
    return sum;
  }
  let trend = { direction: 'flat', deltaPct: 0 };
  if (isFinite(maxTs)) {
    const end = toDateOnly(maxTs);
    const start2 = new Date(end.getTime()-29*86400000);
    const prevEnd = new Date(start2.getTime()-1*86400000);
    const prevStart = new Date(prevEnd.getTime()-29*86400000);
    const curr = sumRange(start2, end);
    const prev = sumRange(prevStart, prevEnd);
    if (prev === 0 && curr > 0) trend = { direction: 'up', deltaPct: 100 };
    else if (prev === 0 && curr === 0) trend = { direction: 'flat', deltaPct: 0 };
    else {
      const delta = ((curr - prev) / Math.max(1, prev)) * 100;
      trend = { direction: delta > 3 ? 'up' : (delta < -3 ? 'down' : 'flat'), deltaPct: Math.round(delta) };
    }
  }

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
    topSender: '-',
    maxPerDayCount,
    maxPerDayDate,
    streakCurrent: streak.current,
    streakLongest: streak.longest,
    activeDaysPct: overview.rangeDays ? Math.round((daily.size / overview.rangeDays) * 100) : 0,
  trend,
  wordsTotal: Array.from(words.values()).reduce((a,b)=>a+b,0)
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
  let topMediaSender = null;
  if (bySenderMedia.size) {
    const top = [...bySenderMedia.entries()].sort((a,b)=>b[1]-a[1])[0];
    topMediaSender = `${top[0]} (${top[1].toLocaleString()} media)`;
  }
  stats.topMediaSender = topMediaSender || '-';

  const charts = {
    conversationsTop10: topNMap(convCounts, 10),
    emojisTextTop15: topNMap(emojiTextCounts, 15),
    emojisReactionsTop15: topNMap(emojiReactionCounts, 15),
    emojisCombinedTop15: topNMap(mergeCountMaps(emojiTextCounts, emojiReactionCounts), 15),
    dailySeries: [...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0])),
    hoursSeries: hours.map((v,i)=>[i, v]),
    wordsTop20: topNMap(words, 20),
    bySenderSorted: topNMap(bySender, bySender.size),
    bySenderAvgLen: (()=>{
      const arr = [];
      for (const [name, sumLen] of bySenderTextLen.entries()) {
        const cnt = bySenderMsgCount.get(name)||1;
        arr.push([name, +(sumLen/cnt).toFixed(1)]);
      }
      return arr.sort((a,b)=>b[1]-a[1]);
    })(),
    bySenderWords: [...bySenderWords.entries()].sort((a,b)=>b[1]-a[1]),
  bySenderMedia: [...bySenderMedia.entries()].sort((a,b)=>b[1]-a[1]),
  goodBoyBySenderSorted: [...goodBoyBySender.entries()].sort((a,b)=>b[1]-a[1])
  };

  return { overview, stats, charts };
}

function topNMap(map, n) { return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n); }

function mergeCountMaps(a, b){
  const out = new Map(a);
  for (const [k,v] of b.entries()) out.set(k, (out.get(k)||0)+v);
  return out;
}

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
  { id: 'reactions', label: 'Reactions' },
      { id: 'activity', label: 'Activity' },
      { id: 'words', label: 'Words' },
      { id: 'stats', label: 'Stats' },
      { id: 'engagement', label: 'Engagement' },
  { id: 'interests', label: 'Interests' },
  { id: 'security', label: 'Security' }
    ],
    activeTab: 'overview',
    loading: false,
    hasData: false,
    errors: [],
    isDrag: false,
    dark: false,
  extra: { saves: [], comments: [], topics: [], logins: [], logouts: [], devices: [], profile: [], signup: [], lastLocation: [] },
  extrasAnalytics: null,
  extrasSecurity: null,
  // IP geolocation state
  ipGeoWorking: false,
  ipGeoSummary: '',

    // filtering
    selectedThreadKey: 'ALL',
    threadOptions: [], // { key, label }
    searchQuery: '',

    // computed data
    threads: [],
    overview: { totalMessages: 0, totalConversations: 0, totalEmojis: 0, startDate: '-', endDate: '-', rangeDays: 0 },
    stats: { avgPerDay: 0, mostActiveDayLabel: '-', mostActiveHourLabel: '-', avgMsgLength: 0, medianMsgLength: 0, mostActiveConversation: '-', topOneToOne: '-', uniqueActiveDays: 0, media: { photos: 0, videos: 0, audios: 0, messagesWithMedia: 0 }, reactionsTotal: 0, topSender: '-' },
    charts: null,

    // utility functions for templates
    fmtDate: fmtDate,

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
    geolocateIPs(){
      if (!this.extrasSecurity || this.ipGeoWorking) return;
      const sec = this.extrasSecurity;
      // Collect login + logout records lacking coordinates
      const need = [];
      for (const l of (this.extra.logins||[])) if (!isFinite(l.lat) || !isFinite(l.lon)) need.push({ type:'login', rec:l });
      for (const l of (this.extra.logouts||[])) if (!l._geoAdded && (!isFinite(l.lat) || !isFinite(l.lon))) need.push({ type:'logout', rec:l });
      if (!need.length){ this.ipGeoSummary = 'No IPs to geolocate'; return; }
      this.ipGeoWorking = true;
      // Simple local IP->country/region heuristic (no external API) using prefixes
      const ipBlocks = [
        { prefix:'86.25.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'92.40.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'134.219.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'81.100.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'82.1.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'86.29.', lat:51.5, lon:-0.1, label:'UK (approx)' },
        { prefix:'2a00:23c7', lat:51.5, lon:-0.1, label:'UK (approx, v6)' }
      ];
      let added = 0;
      for (const {rec,type} of need){
        const ip = rec.ip || '';
        if (!ip) continue;
        const block = ipBlocks.find(b=> ip.startsWith(b.prefix));
        if (block){
          rec.lat = block.lat + (Math.random()-0.5)*0.4; // jitter
          rec.lon = block.lon + (Math.random()-0.5)*0.4;
          rec.location = rec.location || block.label;
          rec._ipGeo = true;
          added++;
          // Add to map points immediately
        }
      }
      // Recompute security analytics to rebuild map points including new coords
      this.extrasSecurity = computeSecurityAnalytics(this.extra);
      this.renderChartsForTab('security');
      this.ipGeoSummary = added ? `Geolocated ${added} IP login/logout events` : 'No matches for local IP heuristics';
      this.ipGeoWorking = false;
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
  this.extra = extra || { saves: [], comments: [], topics: [], logins: [], logouts: [], devices: [], profile: [], signup: [], lastLocation: [] };
        this.buildThreadOptions();
        this.selectedThreadKey = 'ALL';
        const a = computeAnalytics(threads);
        this.overview = a.overview; this.stats = a.stats; this.charts = a.charts; this.hasData = true;
        this.extrasAnalytics = computeExtrasAnalytics(this.extra);
  this.extrasSecurity = computeSecurityAnalytics(this.extra);
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
  const [el, ev] = splitLabelsVals(this.charts.emojisCombinedTop15);
        makeBarChart('chartEmojis', el, ev, { label: 'Count', color: 'rgba(245,158,11,0.7)' });
      }
      if (tab === 'conversations') {
        const [cl, cv] = splitLabelsVals(this.charts.conversationsTop10);
        makeBarChart('chartConversationsFull', cl, cv, { label: 'Messages', color: 'rgba(59,130,246,0.7)' });
      }
      if (tab === 'emojis') {
        const [el, ev] = splitLabelsVals(this.charts.emojisTextTop15);
        makeBarChart('chartEmojisFull', el, ev, { label: 'Text emojis', color: 'rgba(234,179,8,0.7)' });
      }
      if (tab === 'reactions') {
        const [rel, rev] = splitLabelsVals(this.charts.emojisReactionsTop15);
        makeBarChart('chartReactionEmojis', rel, rev, { label: 'Reaction emojis', color: 'rgba(251,113,133,0.8)' });
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
      if (tab === 'security' && this.extrasSecurity) {
  makeLineChart('chartLoginTimeline', this.extrasSecurity.logins.timeline.labels, this.extrasSecurity.logins.timeline.values, { label: 'Logins/day' });
        // Render map once per tab activation
  renderLoginMap(this.extrasSecurity.logins.mapPoints || []);
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
  // Deduplicate topics case-insensitively while preserving first encountered original form
  const topicsUniqueMap = new Map();
  for (const t of topics) {
    if (!t) continue;
    const key = t.trim().toLowerCase();
    if (!topicsUniqueMap.has(key)) topicsUniqueMap.set(key, t.trim());
  }
  const uniqueTopics = Array.from(topicsUniqueMap.values());

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

  // After dedupe, each topic occurs once; keep order of appearance (capped at 20 for display)
  const topicsTop = uniqueTopics.slice(0,20).map(t => [t, 1]);

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
      count: uniqueTopics.length,
      top: { labels: topicsTop.map(([k])=>k), values: topicsTop.map(([,v])=>v) }
    }
  };
}

// ---------- Security analytics and map ----------
// Lightweight country centroids for offline fallback plotting
const COUNTRY_CENTROIDS = {
  US: [37.1, -95.7], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-10.8, -52.9], AR: [-34.6, -64.0], CL: [-35.7, -71.5], CO: [4.6, -74.1], PE: [-9.2, -75.0],
  GB: [55.4, -3.4], IE: [53.1, -8.2], FR: [46.2, 2.2], ES: [40.5, -3.7], PT: [39.4, -8.2], IT: [41.9, 12.6], DE: [51.2, 10.4], NL: [52.1, 5.3], BE: [50.5, 4.5],
  CH: [46.8, 8.2], AT: [47.5, 14.6], CZ: [49.8, 15.5], PL: [52.2, 19.1], SE: [60.1, 18.6], NO: [60.5, 8.5], FI: [64.0, 26.0], DK: [56.2, 10.0], RU: [61.5, 105.3], UA: [49.0, 32.0],
  TR: [39.0, 35.2], GR: [39.1, 21.8], RO: [45.9, 25.0], HU: [47.2, 19.5], BG: [42.7, 25.5], RS: [44.0, 20.9], HR: [45.1, 15.2], SI: [46.1, 14.8], SK: [48.7, 19.7],
  AU: [-25.3, 133.8], NZ: [-41.8, 171.8], ZA: [-30.6, 22.9], EG: [26.8, 30.8], MA: [31.8, -7.1], NG: [9.1, 8.7], KE: [0.0, 37.9], ET: [9.1, 40.5], GH: [7.9, -1.0],
  AE: [24.3, 54.4], SA: [23.9, 45.1], IL: [31.0, 35.0], IR: [32.4, 53.7], IQ: [33.2, 43.7], JO: [31.3, 36.4], QA: [25.3, 51.2], KW: [29.3, 47.5], OM: [20.6, 56.1],
  IN: [22.6, 79.0], PK: [30.4, 69.3], BD: [23.7, 90.4], LK: [7.9, 80.8], NP: [28.4, 84.1],
  CN: [35.9, 104.2], HK: [22.3, 114.1], TW: [23.7, 121.0], JP: [36.2, 138.3], KR: [36.6, 127.9], VN: [14.1, 108.3], TH: [15.8, 101.0], MY: [4.2, 102.0], SG: [1.35, 103.8], ID: [-2.5, 118.0], PH: [12.9, 121.8]
};
const COUNTRY_ALIASES = {
  'united states': 'US', 'usa': 'US', 'us': 'US', 'u.s.': 'US', 'u.s.a.': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB',
  'south korea': 'KR', 'republic of korea': 'KR', 'korea, republic of': 'KR',
  'russia': 'RU', 'russian federation': 'RU',
  'czech republic': 'CZ', 'czechia': 'CZ', 'uae': 'AE', 'united arab emirates': 'AE', 'saudi arabia': 'SA', 'turkiye': 'TR', 'turkey': 'TR'
};
function findCountryCentroid(countryName, code){
  const cc = (code && COUNTRY_CENTROIDS[code]) ? code : (countryName ? COUNTRY_ALIASES[String(countryName).toLowerCase()] : null);
  const final = cc || (code || '').toUpperCase();
  if (COUNTRY_CENTROIDS[final]) return { code: final, lat: COUNTRY_CENTROIDS[final][0], lon: COUNTRY_CENTROIDS[final][1] };
  return null;
}
function computeSecurityAnalytics(extra){
  const logins = extra.logins || [];
  const logouts = extra.logouts || [];
  const devices = extra.devices || [];
  const profile = extra.profile || [];
  const signup = extra.signup || [];
  const lastLocation = extra.lastLocation || [];
  const geoPoints = extra.geoPoints || [];
  const twoFA = extra.twoFA || [];
  const camera = extra.camera || [];
  const inferredEmails = extra.inferredEmails || [];

  // Login timeline per day
  const byDay = new Map();
  let first=null, last=null;
  const locSet = new Set();
  const pts = [];
  for (const l of logins) {
    const d = toDateOnly(l.timestamp_ms).toISOString().slice(0,10);
    byDay.set(d, (byDay.get(d)||0)+1);
    if (!first || l.timestamp_ms < first) first = l.timestamp_ms;
    if (!last || l.timestamp_ms > last) last = l.timestamp_ms;
    // count textual location if present
    const locText = (l.location||'').trim(); if (locText) locSet.add(locText);
    // count coordinate-based unique location if present
    if (typeof l.lat === 'number' && typeof l.lon === 'number' && isFinite(l.lat) && isFinite(l.lon)) {
      const key = `${(+l.lat).toFixed(3)},${(+l.lon).toFixed(3)}`;
      locSet.add(key);
      pts.push({ lat: l.lat, lon: l.lon, when: fmtDate(l.timestamp_ms), location: l.location||key, ip: l.ip||'', device: l.device||'', type: 'login' });
    } else {
      // Fallback: plot by country centroid if available
      const c = findCountryCentroid(l.country, l.countryCode);
      if (c) {
        const key = `${c.code}:${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;
        locSet.add(key);
        pts.push({ lat: c.lat, lon: c.lon, when: fmtDate(l.timestamp_ms), location: l.country || l.countryCode || c.code, ip: l.ip||'', device: l.device||'', type: 'country_fallback' });
      }
    }
  }
  
  // Add last known locations to map
  for (const ll of lastLocation) {
    if (typeof ll.lat === 'number' && typeof ll.lon === 'number' && isFinite(ll.lat) && isFinite(ll.lon)) {
      const key = `${(+ll.lat).toFixed(3)},${(+ll.lon).toFixed(3)}`;
      locSet.add(key);
      pts.push({ 
        lat: ll.lat, lon: ll.lon, 
        when: fmtDate(ll.timestamp_ms), 
        location: ll.location || key, 
        ip: ll.ip||'', 
        device: ll.device||'', 
        type: ll.precise ? 'precise_location' : 'imprecise_location' 
      });
    }
  }

  // Add additional geo points (locations of interest, media with location, friend map)
  for (const gp of geoPoints) {
    if (typeof gp.lat === 'number' && typeof gp.lon === 'number' && isFinite(gp.lat) && isFinite(gp.lon)) {
      const key = `${(+gp.lat).toFixed(3)},${(+gp.lon).toFixed(3)}`;
      locSet.add(key);
      pts.push({ lat: gp.lat, lon: gp.lon, when: gp.timestamp_ms ? fmtDate(gp.timestamp_ms) : '-', location: gp.location || key, ip: '', device: '', type: gp.type || 'geo' });
    }
  }

  const timeline = Array.from(byDay.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  const deviceCount = new Set([...logins.map(l=>l.device), ...logouts.map(l=>l.device)].filter(Boolean)).size;
  const recent = [...logins].sort((a,b)=>b.timestamp_ms-a.timestamp_ms).slice(0,15).map((l,i)=>({ 
    id: i+':'+l.timestamp_ms, 
    when: fmtDate(l.timestamp_ms), 
    location: l.location||'', 
    ip: l.ip||'', 
    device: l.device||'' 
  }));

  // Profile events: include username, email, phone changes, plus privacy/status changes
  const interesting = new Set(['username', 'email', 'phone_number', 'phone', 'name', 'bio', 'privacy', 'account_status', 'password_change']);
  const profileEvents = profile.filter(p => interesting.has(String(p.type||'').toLowerCase())).sort((a,b)=>a.timestamp_ms-b.timestamp_ms).map((p,i)=>({ 
    id: i+':'+p.timestamp_ms, 
    when: fmtDate(p.timestamp_ms), 
    type: p.type, 
    value: p.value 
  }));

  // Device analytics
  const userAgents = {};
  const ips = new Set();
  const languages = new Set();
  for (const l of [...logins, ...logouts]) {
    if (l.device) {
      // Extract browser/device info from User Agent
      const ua = l.device;
      let deviceType = 'Unknown';
      if (/iPhone|iPad|iOS/i.test(ua)) deviceType = 'iOS';
      else if (/Android/i.test(ua)) deviceType = 'Android'; 
      else if (/Instagram/i.test(ua)) deviceType = 'Instagram App';
      else if (/Mozilla|Safari|Chrome/i.test(ua)) deviceType = 'Web Browser';
      userAgents[deviceType] = (userAgents[deviceType] || 0) + 1;
    }
    if (l.ip) ips.add(l.ip);
    if (l.language) languages.add(l.language);
  }
  // User-agent aggregation
  const uaMap = new Map(); // ua -> { count, lastTs }
  const touchUA = (ua, ts) => {
    if (!ua) return;
    const rec = uaMap.get(ua) || { count: 0, lastTs: 0 };
    rec.count++;
    if (ts && ts > rec.lastTs) rec.lastTs = ts;
    uaMap.set(ua, rec);
  };
  for (const l of logins) touchUA(l.device, l.timestamp_ms);
  for (const l of logouts) touchUA(l.device, l.timestamp_ms);
  // Merge known devices (devices.json may not provide UA; we used 'device' to store UA)
  for (const d of devices) {
    if (d.device) {
      const rec = uaMap.get(d.device) || { count: 0, lastTs: 0 };
      if (d.last_login_ms && d.last_login_ms > rec.lastTs) rec.lastTs = d.last_login_ms;
      uaMap.set(d.device, rec);
    }
  }

  // UA parser -> nice labels
  function parseDeviceUA(ua){
    const U = String(ua||'');
    const out = { company: 'Unknown', model: '', os: 'Unknown', app: '', browser: '', platform: 'Unknown', icon: '📱' };
    const has = (s)=> new RegExp(s, 'i').test(U);
    const match = (re)=>{ const m = U.match(re); return m ? m[1] : ''; };
    // App/browser
    if (has('Instagram')) out.app = 'Instagram';
    if (has('Barcelona')) out.app = 'Threads';
    if (has('Safari') && !has('Chrome')) out.browser = 'Safari';
    if (has('Chrome|CriOS')) out.browser = 'Chrome';
    if (has('Firefox')) out.browser = 'Firefox';
    // Platform / OS / vendor / model
    if (has('iPhone|iPad|iOS|iPadOS')) {
      out.company = 'Apple';
      out.os = has('iPad') ? 'iPadOS' : 'iOS';
      out.platform = has('iPad') ? 'Tablet' : 'Mobile';
      out.icon = '🍎';
      const model = match(/\((iPhone[^;\)]*|iPad[^;\)]*)/i) || match(/\(([^;\)]*); iOS /i);
      out.model = model || (has('iPhone') ? 'iPhone' : has('iPad') ? 'iPad' : 'iOS Device');
    } else if (has('Android')) {
      out.company = has('Pixel|Google') ? 'Google' : 'Android';
      out.os = 'Android';
      out.platform = 'Mobile';
      out.icon = '🤖';
      const model = match(/Android \([^;]*;[^;]*;\s*([^;\)]*)/i);
      out.model = model || 'Android Device';
    } else if (has('Macintosh|Mac OS X|Mac OS')) {
      out.company = 'Apple';
      out.os = 'macOS';
      out.platform = 'Desktop';
      out.icon = '💻';
      out.model = 'Mac';
    } else if (has('Windows')) {
      out.company = 'Microsoft';
      out.os = 'Windows';
      out.platform = 'Desktop';
      out.icon = '🖥️';
      out.model = 'PC';
    } else if (has('Linux') && has('X11')) {
      out.company = 'Linux';
      out.os = 'Linux';
      out.platform = 'Desktop';
      out.icon = '🖥️';
      out.model = 'Linux';
    } else if (has('Mozilla/')) {
      out.company = 'Web';
      out.os = 'Web';
      out.platform = 'Web';
      out.icon = '🌐';
      out.model = 'Browser';
    }
    // App label preference
    const subtitle = out.app ? `${out.app}${out.browser? ' · '+out.browser: ''}` : (out.browser || '');
    const title = `${out.company} ${out.model}`.trim();
    const chips = [out.os, out.platform].filter(Boolean);
    return { title, subtitle, chips, icon: out.icon };
  }

  const deviceSummary = [...uaMap.entries()].map(([ua, meta])=>{
    const parsed = parseDeviceUA(ua);
    return { id: ua, ua, title: parsed.title, subtitle: parsed.subtitle, chips: parsed.chips, icon: parsed.icon, lastTs: meta.lastTs || 0, lastSeen: meta.lastTs ? fmtDate(meta.lastTs) : '-', count: meta.count };
  }).sort((a,b)=>{
    if (!!b.lastTs !== !!a.lastTs) return (b.lastTs?1:0) - (a.lastTs?1:0);
    if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;
    return b.count - a.count;
  });

  // Known devices list (simple list by last login)
  const knownDevices = devices.map(d => ({ device: d.device, when: d.last_login_ms ? fmtDate(d.last_login_ms) : '-' }))
    .sort((a,b)=> (a.when==='-'?1:0) - (b.when==='-'?1:0));

  // Logout data
  const recentLogouts = [...logouts].sort((a,b)=>b.timestamp_ms-a.timestamp_ms).slice(0,10).map((l,i)=>({ 
    id: i+':'+l.timestamp_ms, 
    when: fmtDate(l.timestamp_ms), 
    ip: l.ip||'', 
    device: l.device||'',
    cookie: l.cookie||'' 
  }));

  // Signup info
  const signupInfo = signup.length ? signup[0] : null; // Usually just one signup event

  return {
    logins: {
      total: logins.length,
      first: first ? fmtDate(first) : null,
      last: last ? fmtDate(last) : null,
  uniqueLocations: locSet.size,
      deviceCount,
      timeline: { labels: timeline.map(([d])=>d), values: timeline.map(([,v])=>v) },
      recent,
      mapPoints: pts
    },
    logouts: {
      total: logouts.length,
      recent: recentLogouts
    },
    devices: {
      types: Object.entries(userAgents).sort((a,b)=>b[1]-a[1]),
      uniqueIPs: ips.size,
  languages: Array.from(languages),
  known: knownDevices,
  twoFA,
  camera,
  inferredEmails,
  summary: deviceSummary,
  totalUnique: deviceSummary.length,
  twoFACount: twoFA.length
    },
    profile: { events: profileEvents },
    signup: signupInfo,
  locations: lastLocation.length + geoPoints.length
  };
}

let loginMapInstance = null;
let loginMapLayer = null;
function renderLoginMap(points){
  const el = document.getElementById('mapLogins');
  if (!el) return;
  // init map
  if (!loginMapInstance) {
    loginMapInstance = L.map('mapLogins');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(loginMapInstance);
    loginMapLayer = L.layerGroup().addTo(loginMapInstance);
  }
  // clear existing markers
  if (loginMapLayer) loginMapLayer.clearLayers();
  if (!points.length) {
    loginMapInstance.setView([20,0], 2);
    setTimeout(()=> loginMapInstance.invalidateSize(), 0);
    return;
  }
  const grp = L.featureGroup();
  for (const p of points) {
    let color = 'blue';
    let icon = '🔐';
    if (p.type === 'precise_location') { color = 'red'; icon = '📍'; }
    else if (p.type === 'imprecise_location') { color = 'orange'; icon = '📍'; }
    
    const customIcon = L.divIcon({
      html: `<div style="background-color: ${color}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; display: flex; align-items: center; justify-content: center; font-size: 12px;">${icon}</div>`,
      iconSize: [20, 20],
      className: 'custom-div-icon'
    });
    
    const popup = `<strong>${p.when}</strong><br>${p.location||''}<br>${p.ip||''}<br><small>${p.device||''}</small>`;
    const m = L.marker([p.lat, p.lon], {icon: customIcon}).bindPopup(popup);
    grp.addLayer(m);
  }
  if (loginMapLayer) loginMapLayer.addLayer(grp);
  loginMapInstance.fitBounds(grp.getBounds().pad(0.2));
  // ensure proper sizing after tab becomes visible
  setTimeout(()=> loginMapInstance.invalidateSize(), 0);
}
