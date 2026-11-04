// assets/js/shared/src/dom.js
var $ = (sel, root = document) => root.querySelector(sel);
var $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function el(tag, attrs = {}, children = []) {
  const node2 = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node2.className = value;
    else if (key === "text") node2.textContent = value;
    else if (key === "dataset") Object.assign(node2.dataset, value);
    else if (key.startsWith("on")) node2.addEventListener(key.slice(2), value);
    else node2.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node2.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node2;
}
function clear(node2) {
  while (node2.firstChild) node2.removeChild(node2.firstChild);
}
function replace(node2, ...children) {
  clear(node2);
  for (const child of children) if (child != null) node2.append(child);
}
function show(node2, visible) {
  node2.hidden = !visible;
}

// assets/js/shared/src/config.js
function readJson(id) {
  const node2 = document.getElementById(id);
  if (!node2) throw new Error(`missing config block: ${id}`);
  return JSON.parse(node2.textContent);
}
function readOptional(id) {
  return document.getElementById(id) ? readJson(id) : {};
}
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}
var strings = merge(readOptional("page-shared-strings"), readJson("page-strings"));
var config = merge(readOptional("page-shared-config"), readJson("page-config"));
var query = new URLSearchParams(location.search);
function fmt(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => vars[key] == null ? m : String(vars[key]));
}
function t(path, fallback = "") {
  return path.split(".").reduce((node2, key) => node2 == null ? void 0 : node2[key], strings) ?? fallback;
}
var dev = (() => {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!local) return { local: false };
  const params = new URLSearchParams(location.search);
  return {
    local: true,
    to: params.get("to"),
    // Repeatable: ?relay=wss://localhost:7000&relay=wss://dead.invalid
    relays: params.getAll("relay"),
    noNip07: params.has("nonip07"),
    noNip44: params.has("nonip44"),
    no10050: params.has("no10050"),
    noPow: params.has("nopow")
  };
})();

// assets/js/shared/src/vendor.js
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  SimplePool,
  decodeNip19,
  npubEncode,
  neventEncode,
  getConversationKey,
  nip44Encrypt,
  nip44Decrypt,
  BunkerSigner,
  createNostrConnectURI
} from "/assets/js/vendor/nostr-tools/nostr-tools-2.25.2.esm.min.js";
import { encode } from "/assets/js/vendor/uqr/uqr-0.1.3.esm.min.js";

// assets/js/shared/src/signers.js
var SignerError = class extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
};
var HEX64 = /^[0-9a-f]{64}$/;
function wipe(secretKey) {
  if (secretKey instanceof Uint8Array) secretKey.fill(0);
}
function detectNip07({ timeout = 800 } = {}) {
  if (dev.noNip07) return Promise.resolve(false);
  if (window.nostr) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (window.nostr) return resolve(true);
      if (Date.now() - started >= timeout) return resolve(false);
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  });
}
async function connectNip07() {
  if (!window.nostr) throw new SignerError("nip07_missing");
  const nip44 = dev.noNip44 ? null : window.nostr.nip44;
  if (!nip44 || typeof nip44.encrypt !== "function") throw new SignerError("nip07_no_nip44");
  let pubkey;
  try {
    pubkey = await window.nostr.getPublicKey();
  } catch (err) {
    throw new SignerError("nip07_refused", err);
  }
  if (!HEX64.test(pubkey)) throw new SignerError("nip07_bad_pubkey");
  return {
    kind: "nip07",
    pubkey,
    signEvent: (template) => window.nostr.signEvent(template),
    nip44Encrypt: (target, plaintext) => nip44.encrypt(target, plaintext),
    nip44Decrypt: (target, ciphertext) => nip44.decrypt(target, ciphertext),
    close() {
    }
  };
}
var PERMS = ["sign_event:13", "nip44_encrypt"];
function bunkerParams(onauth) {
  return { onauth };
}
function parseBunkerUri(input) {
  const raw = (input || "").trim();
  if (!raw) throw new SignerError("bunker_empty");
  if (!raw.startsWith("bunker://")) {
    throw new SignerError(raw.includes("@") ? "bunker_is_nip05" : "bunker_bad_scheme");
  }
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new SignerError("bunker_unparseable", err);
  }
  const pubkey = url.hostname || url.pathname.replace(/^\/+/, "");
  if (!HEX64.test(pubkey)) throw new SignerError("bunker_bad_pubkey");
  const relays = url.searchParams.getAll("relay").filter(isRelayUrl);
  if (!relays.length) throw new SignerError("bunker_no_relay");
  return { pubkey, relays, secret: url.searchParams.get("secret") };
}
function isRelayUrl(url) {
  try {
    return new URL(url).protocol === "wss:";
  } catch {
    return false;
  }
}
async function wrapBunker(signer, clientSecretKey) {
  let pubkey;
  try {
    pubkey = await signer.getPublicKey();
  } catch (err) {
    wipe(clientSecretKey);
    throw new SignerError("nip46_no_pubkey", err);
  }
  if (!HEX64.test(pubkey)) {
    wipe(clientSecretKey);
    throw new SignerError("nip46_bad_pubkey");
  }
  return {
    kind: "nip46",
    pubkey,
    signEvent: (template) => signer.signEvent(template),
    nip44Encrypt: (target, plaintext) => signer.nip44Encrypt(target, plaintext),
    nip44Decrypt: (target, ciphertext) => signer.nip44Decrypt(target, ciphertext),
    async close() {
      try {
        await signer.close();
      } finally {
        wipe(clientSecretKey);
      }
    }
  };
}
function startNostrConnect({ onauth, signal } = {}) {
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const relays = config.relays.nip46;
  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    perms: PERMS,
    name: config.client.name,
    url: location.origin
  });
  const connected = BunkerSigner.fromURI(clientSecretKey, uri, bunkerParams(onauth), signal).then((signer) => wrapBunker(signer, clientSecretKey)).catch((err) => {
    wipe(clientSecretKey);
    throw err instanceof SignerError ? err : new SignerError("nip46_connect_failed", err);
  });
  return { uri, connected };
}
async function connectBunker(input, { onauth } = {}) {
  const pointer = parseBunkerUri(input);
  const clientSecretKey = generateSecretKey();
  try {
    const signer = BunkerSigner.fromBunker(clientSecretKey, pointer, bunkerParams(onauth));
    await signer.connect({ name: config.client.name, url: location.origin });
    return await wrapBunker(signer, clientSecretKey);
  } catch (err) {
    wipe(clientSecretKey);
    throw err instanceof SignerError ? err : new SignerError("nip46_connect_failed", err);
  }
}
function hasSessionKey(storageKey = "nostr4.session-key") {
  try {
    return /^[0-9a-f]{64}$/.test(sessionStorage.getItem(storageKey) || "");
  } catch {
    return false;
  }
}
function createSessionSigner(storageKey = "nostr4.session-key") {
  let secretKey = null;
  try {
    const hex = sessionStorage.getItem(storageKey);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) secretKey = hexToBytes(hex);
  } catch {
  }
  if (!secretKey) {
    secretKey = generateSecretKey();
    try {
      sessionStorage.setItem(storageKey, bytesToHex(secretKey));
    } catch {
    }
  }
  const pubkey = getPublicKey(secretKey);
  return {
    kind: "session",
    pubkey,
    async signEvent(template) {
      return finalizeEvent(template, secretKey);
    },
    async nip44Encrypt(target, plaintext) {
      return nip44Encrypt(plaintext, getConversationKey(secretKey, target));
    },
    async nip44Decrypt(target, ciphertext) {
      return nip44Decrypt(ciphertext, getConversationKey(secretKey, target));
    },
    close() {
    },
    forget() {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
      }
      wipe(secretKey);
    }
  };
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// assets/js/shared/src/relays.js
var KIND_DM_RELAYS = 10050;
var MAX_RELAYS = 5;
var LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
function normalizeRelay(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && LOOPBACK.includes(parsed.hostname))) return null;
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
function dedupe(urls) {
  return Array.from(new Set(urls.filter(Boolean)));
}
function siteRelays() {
  return dedupe((config.relays?.site || []).map(normalizeRelay));
}
function discoveryRelays() {
  return dedupe([...config.relays?.discovery || [], ...config.relays?.site || []].map(normalizeRelay));
}
async function inboxRelaysFor(pool, pubkey) {
  if (dev.local && dev.relays.length) {
    const relays2 = dedupe(dev.relays.map(normalizeRelay)).slice(0, MAX_RELAYS);
    if (relays2.length) return { relays: relays2, usedFallback: false };
  }
  const fallback = () => ({
    relays: siteRelays().slice(0, MAX_RELAYS),
    usedFallback: true
  });
  if (dev.no10050) return fallback();
  let event = null;
  try {
    event = await pool.get(
      discoveryRelays(),
      { kinds: [KIND_DM_RELAYS], authors: [pubkey] },
      { maxWait: config.timeouts.discovery }
    );
  } catch {
    return fallback();
  }
  if (!event) return fallback();
  const relays = dedupe(
    event.tags.filter((tag) => tag[0] === "relay").map((tag) => normalizeRelay(tag[1]))
  ).slice(0, MAX_RELAYS);
  return relays.length ? { relays, usedFallback: false } : fallback();
}

// assets/js/shared/src/profiles.js
var KIND_PROFILE = 0;
var MAX_NAME = 40;
async function fetchProfileName(pool, pubkey) {
  let event = null;
  try {
    event = await pool.get(
      discoveryRelays(),
      { kinds: [KIND_PROFILE], authors: [pubkey] },
      { maxWait: config.timeouts.profile }
    );
  } catch {
    return null;
  }
  if (!event) return null;
  try {
    const meta = JSON.parse(event.content);
    const name = [meta.display_name, meta.name, meta.username].find(
      (v) => typeof v === "string" && v.trim()
    );
    return name ? name.trim().slice(0, MAX_NAME) : null;
  } catch {
    return null;
  }
}

// assets/js/shared/src/qr.js
var NS = "http://www.w3.org/2000/svg";
function qrSvg(text2, { label, margin = 2 } = {}) {
  const { data, size } = encode(text2, { ecc: "M", border: margin });
  const side = size;
  let d = "";
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.classList.add("qr");
  if (label) {
    const title = document.createElementNS(NS, "title");
    title.textContent = label;
    svg.append(title);
  }
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(side));
  bg.setAttribute("height", String(side));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#14111c");
  svg.append(path);
  return svg;
}

// assets/js/shared/src/connect.js
function setError(node2, code) {
  if (!node2) return;
  const message = code ? t(`errors.${code}`) || t("errors.unknown") : "";
  node2.textContent = message;
  show(node2, Boolean(message));
}
function setStatus(node2, message) {
  if (!node2) return;
  node2.textContent = message || "";
  show(node2, Boolean(message));
}
function shortNpub(hex) {
  try {
    const npub = npubEncode(hex);
    return `${npub.slice(0, 9)}\u2026${npub.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 8)}\u2026${hex.slice(-4)}`;
  }
}
function renderIdentity(signer, profileName) {
  const name = $("#identity-name");
  const key = $("#identity-key");
  const note = $("#identity-note");
  if (!signer) return;
  if (name) name.textContent = profileName || t("identity.unnamed");
  if (key) key.textContent = shortNpub(signer.pubkey);
  if (note) note.textContent = t(`identity.${signer.kind}`);
}
function markExtension(available) {
  const button = $("#sign-extension");
  if (button) button.classList.toggle("is-missing", !available);
}
function openBunkerModal() {
  const dialog = $("#bunker-modal");
  if (dialog) {
    if (!dialog.open) dialog.showModal();
    return;
  }
  const panel = $("#bunker-panel");
  if (panel) panel.hidden = false;
}
function closeBunkerModal() {
  const dialog = $("#bunker-modal");
  if (dialog) {
    if (dialog.open) dialog.close();
    return;
  }
  const panel = $("#bunker-panel");
  if (panel) panel.hidden = true;
}
function renderConnect({ uri }) {
  const qrHost = $("#bunker-qr");
  if (qrHost) replace(qrHost, qrSvg(uri, { label: t("bunker.qr_alt") }));
  const uriField = $("#bunker-uri");
  if (uriField) uriField.value = uri;
  const links = $("#bunker-signers");
  if (links) {
    clear(links);
    for (const signer of config.nip46.signers) {
      links.append(
        el("a", {
          class: "btn btn--secondary btn--compact",
          href: signer.nostrconnect_url.replace("{uri}", encodeURIComponent(uri)),
          target: "_blank",
          rel: "noopener",
          text: signer.label
        })
      );
    }
  }
}
function renderAuthUrl(url) {
  const host = $("#bunker-auth");
  if (!host) return;
  if (!url) return show(host, false);
  replace(
    host,
    el("p", { class: "contact__note", text: t("bunker.auth_note") }),
    el("a", { class: "btn btn--primary btn--compact", href: url, target: "_blank", rel: "noopener", text: t("bunker.auth_open") })
  );
  show(host, true);
}

// assets/js/shared/src/signin.js
var errorCode = (err) => err instanceof SignerError ? err.code : err?.code || "unknown";
function createSignIn({ onChange } = {}) {
  let signer = null;
  let profileName = null;
  let connectAbort = null;
  function show2(mode) {
    const guest = $("#sign-guest");
    const signed = $("#sign-signed");
    if (guest && !guest.closest("dialog")) guest.hidden = mode !== "guest";
    if (signed) signed.hidden = mode !== "signed";
  }
  async function adopt(next) {
    signer = next;
    profileName = null;
    renderIdentity(signer, null);
    show2("signed");
    setError($("#sign-error"), null);
    onChange?.(signer);
    const pool = new SimplePool();
    try {
      const name = await fetchProfileName(pool, next.pubkey);
      if (signer === next && name) {
        profileName = name;
        renderIdentity(signer, name);
      }
    } finally {
      pool.destroy();
    }
  }
  async function signInExtension() {
    setError($("#sign-error"), null);
    setStatus($("#sign-status"), t("status.connecting_nip07"));
    try {
      await adopt(await connectNip07());
    } catch (err) {
      setError($("#sign-error"), errorCode(err));
    } finally {
      setStatus($("#sign-status"), "");
    }
  }
  async function signInBunker() {
    cancelConnect();
    setError($("#sign-error"), null);
    setError($("#bunker-error"), null);
    renderAuthUrl(null);
    openBunkerModal();
    const controller = new AbortController();
    connectAbort = controller;
    const { uri, connected } = startNostrConnect({ onauth: renderAuthUrl, signal: controller.signal });
    renderConnect({ uri });
    const timer = setTimeout(() => controller.abort(), config.timeouts.nip46_connect);
    try {
      const next = await connected;
      closeBunkerModal();
      await adopt(next);
    } catch (err) {
      if (!controller.signal.aborted) setError($("#bunker-error"), errorCode(err));
    } finally {
      clearTimeout(timer);
      if (connectAbort === controller) connectAbort = null;
    }
  }
  async function connectPastedBunker(event) {
    event.preventDefault();
    const input = $("#field-bunker");
    setError($("#bunker-error"), null);
    $("#bunker-status-text").textContent = t("status.connecting_nip46");
    try {
      const next = await connectBunker(input.value, { onauth: renderAuthUrl });
      input.value = "";
      cancelConnect();
      closeBunkerModal();
      await adopt(next);
    } catch (err) {
      setError($("#bunker-error"), errorCode(err));
    } finally {
      $("#bunker-status-text").textContent = t("bunker.waiting", "");
    }
  }
  function cancelConnect() {
    connectAbort?.abort();
    connectAbort = null;
    renderAuthUrl(null);
  }
  function signOut() {
    cancelConnect();
    signer?.close();
    signer = null;
    profileName = null;
    show2("guest");
    onChange?.(null);
  }
  function wire2() {
    $("#sign-extension")?.addEventListener("click", signInExtension);
    $("#sign-bunker")?.addEventListener("click", signInBunker);
    $("#sign-out")?.addEventListener("click", signOut);
    $("#form-bunker")?.addEventListener("submit", connectPastedBunker);
    $("#bunker-cancel")?.addEventListener("click", closeBunkerModal);
    $("#bunker-modal")?.addEventListener("close", cancelConnect);
    $("#bunker-copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#bunker-uri").value);
        $("#bunker-status-text").textContent = t("bunker.copied");
      } catch {
        $("#bunker-uri").select();
      }
    });
    window.addEventListener("pagehide", () => {
      cancelConnect();
      signer?.close();
    });
    show2("guest");
  }
  return {
    wire: wire2,
    markExtension,
    signOut,
    current: () => signer,
    profileName: () => profileName
  };
}

// assets/js/shared/src/recipients.js
var HEX642 = /^[0-9a-f]{64}$/;
var RecipientError = class extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
};
function toPubkey(value) {
  if (HEX642.test(value)) return value;
  if (typeof value === "string" && value.startsWith("npub1")) {
    try {
      const { type, data } = decodeNip19(value);
      if (type === "npub" && HEX642.test(data)) return data;
    } catch {
      return null;
    }
  }
  return null;
}
async function loadRecipients() {
  if (dev.local && dev.to && (dev.to.startsWith("npub1") || HEX642.test(dev.to))) {
    const pubkey = toPubkey(dev.to.trim());
    if (!pubkey) throw new RecipientError("recipients_bad_override");
    return [{ name: "test", pubkey }];
  }
  let json;
  try {
    const res = await fetch("/.well-known/nostr.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    throw new RecipientError("recipients_unavailable", err);
  }
  const names = json && typeof json.names === "object" ? json.names : null;
  if (!names) throw new RecipientError("recipients_malformed");
  const recipients = [];
  for (const [name, value] of Object.entries(names)) {
    const pubkey = toPubkey(String(value).trim());
    if (pubkey) recipients.push({ name, pubkey });
  }
  if (!recipients.length) throw new RecipientError("recipients_empty");
  return recipients;
}
function pickRecipient(recipients, wanted) {
  const name = (wanted || "").trim().toLowerCase();
  return recipients.find((r) => r.name.toLowerCase() === name) || recipients[0];
}

// assets/js/calculator/src/inputs.js
var HOURS = ["0", "5", "25", "60"];
var NOSTR = ["0", "0.5", "1"];
var GROWTH = ["0", "0.25", "0.5", "1"];
var HEADS_BAND = ["1", "3", "15", "140", "500", "2000"];
var WHO = ["nobody", "team", "vendor"];
var TEAM = ["one", "ten", "fifty", "more"];
var KIND = ["messaging", "feed", "community", "marketplace"];
var band = (options, omit) => ({ type: "option", required: false, default: null, options, omit });
var INPUTS = {
  // Nostr: the opener, then "Your app uses Nostr for the following"
  nostr_now: band(NOSTR),
  // does the app already use Nostr: not at all / somewhat / fully
  n_keys: band(NOSTR, "0"),
  // user accounts are private keys
  n_raw_keys: band(NOSTR, "0"),
  // app handles raw private keys (the inverse)
  n_signed_events: band(NOSTR, "0"),
  // user data stored as signed events
  n_event_storage: band(NOSTR, "0"),
  // user choice for event storage
  n_media_storage: band(NOSTR, "0"),
  // user choice for media storage
  n_labels: band(NOSTR, "0"),
  // content tags and labels as signed events
  n_feeds: band(NOSTR, "0"),
  // user configurable feeds and algos
  n_algos: band(NOSTR, "0"),
  // user choice for algo processing
  n_p2p: band(NOSTR, "0"),
  // peer to peer in-app payments
  n_nips: band(NOSTR, "0"),
  // NIP standards published publicly (read, not priced)
  // Users: the opener, then growth
  mau: { type: "integer", required: true, default: 5e4, min: 1, max: 2e9 },
  growth: { ...band(GROWTH), start: "0.5" },
  // users a year from now, as a share of today's; blank means the assumptions' default (flat); the form starts on Fast
  // Content: the opener (the form starts on Messaging, so the illustrative app is a messaging app; a link that says nothing means "an app"), then the two per-user numbers (blank means derived from the kind of app)
  kind: { ...band(KIND), start: "messaging" },
  posts_per_user: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  mb: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  // Moderation: the opener, then the head count (blank means the default count)
  mod_who: band(WHO),
  mod_heads: band(HEADS_BAND),
  // Team: the opener, required (the engineering defaults rest on it: no silent team size), then hours a week per area (blank means derived from the team size) and legal spend
  team: { type: "option", required: true, default: "ten", options: TEAM },
  eng_accounts: band(HOURS),
  // managing user accounts
  eng_content: band(HOURS),
  // managing user content
  eng_infra: band(HOURS),
  // managing infrastructure
  eng_legal: band(HOURS),
  // legal and compliance
  legal_usd: { type: "number", required: false, default: null, min: 0, max: 1e12, omit: "0" },
  // 0 means not given
  // Payments: the opener, the gross monthly volume of payments between the app's users in USD (tips, creator payments, sales between users; the app's own sales are not a custody cost and are not counted; 0 means none; the form starts on 5,000 so the illustrative app shows the line), then the rails (blank means derived from distribution) and balances. Links made before version 4 call it `rev`; the codec reads that too.
  p2p_volume: { type: "number", required: false, default: 0, min: 0, max: 1e12, start: 5e3, omit: "0" },
  rails: { type: "multi", required: false, default: [], options: ["p2p", "apple", "google", "processor", "reseller"] },
  balances: { type: "multi", required: false, default: [], options: ["yes"] },
  // Reach: the opener (the form starts on the US), then distribution
  jur: { type: "multi", required: true, default: ["us"], options: ["eu", "uk", "us", "other"] },
  distribution: { type: "multi", required: false, default: [], options: ["apple", "google", "web"] }
};
var GRIDS = {
  nostr: ["n_keys", "n_raw_keys", "n_signed_events", "n_event_storage", "n_media_storage", "n_labels", "n_feeds", "n_algos", "n_p2p", "n_nips"],
  engineering: ["eng_accounts", "eng_content", "eng_infra", "eng_legal"]
};
function defaultsFor() {
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) out[key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  return out;
}
var InputError = class extends Error {
  constructor(key, code) {
    super(`${key}: ${code}`);
    this.key = key;
    this.code = code;
  }
};
function toNumber(v) {
  if (v === "" || v == null) return NaN;
  if (typeof v === "number") return v;
  return Number(String(v).replace(/[,\s_]/g, ""));
}
function normalizeInputs(raw = {}) {
  const defaults = defaultsFor(raw);
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    let v = raw[key];
    const blank = v == null || v === "" || Array.isArray(v) && v.length === 0;
    if (blank) {
      if (spec.required) throw new InputError(key, "required");
      out[key] = defaults[key];
      continue;
    }
    if (spec.type === "option") {
      v = String(v);
      if (!spec.options.includes(v)) throw new InputError(key, "invalid");
      out[key] = v;
    } else if (spec.type === "multi") {
      const list = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
      for (const item of list) if (!spec.options.includes(item)) throw new InputError(key, "invalid");
      out[key] = spec.options.filter((o) => list.includes(o));
      if (spec.required && out[key].length === 0) throw new InputError(key, "required");
    } else {
      const n = toNumber(v);
      if (!Number.isFinite(n)) throw new InputError(key, "not_a_number");
      if (spec.type === "integer" && !Number.isInteger(n)) throw new InputError(key, "not_an_integer");
      if (n < spec.min) throw new InputError(key, "too_small");
      if (n > spec.max) throw new InputError(key, "too_large");
      out[key] = n;
    }
  }
  return out;
}

// assets/js/calculator/src/model.js
var LINES = ["accounts", "graph", "storage", "compliance", "moderation", "payments"];
var SCENARIOS = ["low", "typical", "high"];
var JURISDICTIONS = ["eu", "uk", "us", "other"];
var TEAMS = ["one", "ten", "fifty", "more"];
var HOURS_PER_YEAR = 2e3;
var WEEKS_PER_YEAR = 50;
var RETENTION_MONTHS = 12;
var YEARS = 5;
var DAYS_PER_MONTH = 30.4375;
var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(iso) {
  const m = ISO_DATE.exec(String(iso ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
var isDate = (iso) => parseDate(iso) != null;
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
var pad = (n) => String(n).padStart(2, "0");
var formatDate = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
function monthsBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return NaN;
  return (b.y - a.y) * 12 + (b.m - a.m) + (b.d - a.d) / DAYS_PER_MONTH;
}
function addMonths(iso, months) {
  const a = parseDate(iso);
  if (!a || !Number.isFinite(months)) return null;
  const whole = Math.floor(months);
  const days = Math.round((months - whole) * DAYS_PER_MONTH);
  const index = a.m - 1 + whole;
  const y = a.y + Math.floor(index / 12);
  const m = (index % 12 + 12) % 12 + 1;
  const base = new Date(Date.UTC(y, m - 1, Math.min(a.d, daysInMonth(y, m))));
  base.setUTCDate(base.getUTCDate() + days);
  return formatDate({ y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() });
}
function rowType(a) {
  if (a.unit === "date") return "date";
  if (/^ratio/.test(a.unit || "")) return "share";
  return "number";
}
function resolveAssumptions(data, scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const out = {};
  for (const [key, a] of Object.entries(data.assumptions)) {
    const o = Object.hasOwn(overrides, key) ? overrides[key] : null;
    const base = a[a.scenario_varies ? scenario : "typical"];
    if (rowType(a) === "date") out[key] = isDate(o) ? o : base;
    else out[key] = o != null && Number.isFinite(Number(o)) ? Number(o) : base;
  }
  return out;
}
var FORM_REPLACES = /^(default_hours_|team_factor_|kind_|posts_default$|mb_default$|mod_heads_default$|growth_default$)/;
function sourcingCounts(data) {
  const out = { sourced: 0, replaceable: 0, thesis: 0, total: 0 };
  for (const [key, a] of Object.entries(data.assumptions)) {
    out.total++;
    if (a.source) out.sourced++;
    else if (FORM_REPLACES.test(key)) out.replaceable++;
    else out.thesis++;
  }
  return out;
}
var DATE_MIN = "2015-01-01";
var DATE_MAX = "2050-12-31";
var DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;
function parseStrict(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!DECIMAL.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function rowRange(a) {
  const type = rowType(a);
  if (type === "date") return { min: DATE_MIN, max: DATE_MAX };
  if (type === "share") return { min: 0, max: 1 };
  return { min: 0, max: Number((10 * Math.max(...[a.typical, a.low, a.high].map(Number).filter(Number.isFinite), 0)).toPrecision(12)) };
}
function cleanOverrides(data, overrides = {}, report = null) {
  const out = {};
  for (const [key, v] of Object.entries(overrides)) {
    if (!Object.hasOwn(data.assumptions, key)) continue;
    const a = data.assumptions[key];
    const { min, max } = rowRange(a);
    if (rowType(a) === "date") {
      if (!isDate(v)) continue;
      const d = v < min ? min : v > max ? max : String(v);
      if (d !== v) report?.push({ key, from: v, to: d });
      if (d === a.typical) continue;
      out[key] = d;
      continue;
    }
    const n = parseStrict(v);
    if (n == null) continue;
    const c = Math.min(max, Math.max(min, n));
    if (c !== n) report?.push({ key, from: n, to: c });
    if (c === a.typical) continue;
    out[key] = c;
  }
  return out;
}
var loadedHourly = (v) => v.eng_base_salary * v.loaded_multiplier * v.overhead_multiplier / HOURS_PER_YEAR;
var loadedYear = (base, v) => base * v.loaded_multiplier * v.overhead_multiplier;
var num = (x) => x == null || x === "" ? null : Number(x);
function defaultHours(area, v) {
  if (area === "accounts") return v.default_hours_accounts;
  if (area === "content") return v.default_hours_content;
  if (area === "infra") return v.default_hours_infra;
  return v.default_hours_legal;
}
function engHoursWeek(area, inputs, v) {
  const given = num(inputs[`eng_${area}`]);
  return given != null ? given : defaultHours(area, v);
}
function engineering(area, inputs, v) {
  const hours = engHoursWeek(area, inputs, v);
  const hourly = loadedHourly(v);
  const from = inputs.derived?.[`eng_${area}`];
  return { cost: hours * WEEKS_PER_YEAR * hourly, hours, hourly, defaulted: num(inputs[`eng_${area}`]) == null || Boolean(from), from };
}
function kindPosts(kind, v) {
  if (kind === "messaging") return v.kind_messaging_posts;
  if (kind === "feed") return v.kind_feed_posts;
  if (kind === "community") return v.kind_community_posts;
  if (kind === "marketplace") return v.kind_marketplace_posts;
  return v.posts_default;
}
function kindMb(kind, v) {
  if (kind === "messaging") return v.kind_messaging_mb;
  if (kind === "feed") return v.kind_feed_mb;
  if (kind === "community") return v.kind_community_mb;
  if (kind === "marketplace") return v.kind_marketplace_mb;
  return v.mb_default;
}
function teamFactor(team, v) {
  if (team === "one") return v.team_factor_one;
  if (team === "ten") return v.team_factor_ten;
  if (team === "fifty") return v.team_factor_fifty;
  if (team === "more") return v.team_factor_more;
  return null;
}
function complianceFactor(team, v) {
  if (team === "one") return v.compliance_tier_factor_one;
  if (team === "ten") return v.compliance_tier_factor_ten;
  if (team === "fifty") return v.compliance_tier_factor_fifty;
  return v.compliance_tier_factor_more;
}
function breachLoss(team, v) {
  if (team === "one") return v.breach_loss_one;
  if (team === "ten") return v.breach_loss_ten;
  if (team === "fifty") return v.breach_loss_fifty;
  return v.breach_loss_more;
}
function kindEgress(kind, v) {
  if (kind === "messaging") return v.kind_messaging_egress_gb;
  if (kind === "feed") return v.kind_feed_egress_gb;
  if (kind === "community") return v.kind_community_egress_gb;
  if (kind === "marketplace") return v.kind_marketplace_egress_gb;
  return null;
}
function kindCompute(kind, v) {
  if (kind === "messaging") return v.kind_messaging_compute;
  if (kind === "feed") return v.kind_feed_compute;
  if (kind === "community") return v.kind_community_compute;
  if (kind === "marketplace") return v.kind_marketplace_compute;
  return null;
}
function applyKind(v, kind, overrides = {}) {
  const out = { ...v };
  const set = {};
  const egress = kindEgress(kind, v);
  if (egress != null && !Object.hasOwn(overrides, "egress_gb_per_mau_month")) {
    out.egress_gb_per_mau_month = egress;
    set.egress_gb_per_mau_month = "kind";
  }
  const compute = kindCompute(kind, v);
  if (compute != null && !Object.hasOwn(overrides, "compute_per_mau_year")) {
    out.compute_per_mau_year = compute;
    set.compute_per_mau_year = "kind";
  }
  return { values: out, set };
}
var NOSTR_ROWS = ["n_keys", "n_raw_keys", "n_signed_events", "n_event_storage", "n_media_storage", "n_labels", "n_feeds", "n_algos", "n_p2p", "n_nips"];
var RAIL_FOR = { apple: "apple", google: "google", web: "processor" };
function deriveInputs(inputs, v) {
  const eff = { ...inputs };
  const derived = {};
  if (eff.growth == null) {
    eff.growth = String(v.growth_default);
    derived.growth = "default";
  }
  if (eff.nostr_now == null) {
    eff.nostr_now = "0";
    derived.nostr_now = "default";
  }
  if (eff.posts_per_user == null) {
    eff.posts_per_user = kindPosts(inputs.kind, v);
    derived.posts_per_user = inputs.kind ? "kind" : "default";
  }
  if (eff.mb == null) {
    eff.mb = kindMb(inputs.kind, v);
    derived.mb = inputs.kind ? "kind" : "default";
  }
  const factor = teamFactor(eff.team, v);
  for (const area of ["accounts", "content", "infra", "legal"]) {
    const key = `eng_${area}`;
    if (num(inputs[key]) != null) continue;
    eff[key] = defaultHours(area, v) * factor;
    derived[key] = "team";
  }
  if ((inputs.mod_who === "team" || inputs.mod_who === "vendor") && num(inputs.mod_heads) == null) {
    eff.mod_heads = v.mod_heads_default;
    derived.mod_heads = "default";
  }
  if (eff.p2p_volume > 0 && !inputs.rails.length) {
    const places = inputs.distribution.length ? inputs.distribution : ["apple", "google", "web"];
    eff.rails = [...new Set(places.map((d) => RAIL_FOR[d]))];
    derived.rails = "distribution";
  }
  for (const key of NOSTR_ROWS) {
    if (num(inputs[key]) != null) continue;
    eff[key] = key === "n_raw_keys" ? "0" : eff.nostr_now;
    derived[key] = "nostr_now";
  }
  eff.derived = derived;
  return eff;
}
function nostrShares(inputs) {
  const g = (k) => num(inputs[k]) ?? 0;
  const avg = (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const accounts2 = g("n_keys") * (1 - g("n_raw_keys"));
  const storage2 = avg(g("n_event_storage"), g("n_media_storage"));
  return {
    accounts: accounts2,
    graph: avg(g("n_signed_events"), g("n_feeds")),
    storage: storage2,
    compliance: avg(accounts2, storage2),
    moderation: avg(g("n_labels"), g("n_algos")),
    payments: g("n_p2p")
  };
}
function jurShares(inputs, v) {
  const weights = { eu: v.jur_weight_eu, uk: v.jur_weight_uk, us: v.jur_weight_us, other: v.jur_weight_other };
  const chosen = JURISDICTIONS.filter((j) => inputs.jur.includes(j));
  const total = chosen.reduce((acc, j) => acc + weights[j], 0);
  const out = { eu: 0, uk: 0, us: 0, other: 0 };
  for (const j of chosen) out[j] = total > 0 ? weights[j] / total : 1 / chosen.length;
  return out;
}
function caConsumers(inputs, v, shares = jurShares(inputs, v)) {
  return inputs.mau * v.annual_users_per_mau * shares.us * v.ca_share_of_us_users;
}
function ccpaApplies(inputs, v, shares = jurShares(inputs, v)) {
  return inputs.jur.includes("us") && caConsumers(inputs, v, shares) >= v.ccpa_consumer_threshold;
}
var part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra });
var sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0);
var has = (inputs, j) => inputs.jur.includes(j);
var posts = (inputs) => inputs.mau * inputs.posts_per_user;
function accounts(inputs, v) {
  const { mau } = inputs;
  const shares = jurShares(inputs, v);
  const verifyShare = shares.uk * v.verify_share_uk + shares.us * v.verify_share_us + shares.eu * v.verify_share_eu + shares.other * v.verify_share_other;
  const verify = mau * verifyShare * v.verify_price;
  const eng = engineering("accounts", inputs, v);
  const handoff = v.support_self_service_contact + v.key_handoff_live_share * v.support_live_contact;
  const parts = [
    part("auth", mau * v.auth_per_mau_month * 12, 0),
    part("resets", mau * v.reset_rate_per_mau_year * v.reset_cost, 0),
    // Age assurance becomes a layer the app reads (store, wallet) rather than buys; a share remains.
    part("verify", verify, verify * v.verify_remains_share, { rate: verifyShare }),
    // Signer login, the recovery hand-off and sessions still need building and keeping.
    part("engineering", eng.cost, eng.cost * v.accounts_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
    part("key_handoff", 0, mau * v.reset_rate_per_mau_year * handoff, { rate: v.reset_rate_per_mau_year, contact: handoff })
  ];
  return { parts };
}
function graph(inputs, v) {
  const { mau } = inputs;
  const dbGb = mau * v.db_mb_per_mau / 1024 + posts(inputs) * RETENTION_MONTHS * v.db_kb_per_post / 1024 / 1024;
  const eng = engineering("content", inputs, v);
  const parts = [
    part("database", dbGb * v.db_gb_month * 12, 0, { gb: dbGb, posts: posts(inputs) }),
    part("feed_compute", mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part("engineering", eng.cost, eng.cost * v.graph_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
    part("ranking", 0, mau * v.ranking_fee_per_mau_year)
  ];
  return { parts };
}
function storage(inputs, v) {
  const { mau, mb } = inputs;
  const blobGb = mau * mb / 1024;
  const blob = blobGb * v.blob_gb_month * 12;
  const egressGb = mau * v.egress_gb_per_mau_month * 12;
  const egress = egressGb * v.egress_gb;
  const eng = engineering("infra", inputs, v);
  const sponsored = mau * v.relay_sponsored_share * v.relay_per_mau_year;
  const parts = [
    part("blob", blob, blob * v.media_sponsor_share, { gb: blobGb }),
    part("egress", egress, egress * v.media_sponsor_share, { gb: egressGb }),
    part("serving", mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year, { share: 1 - v.feed_compute_share }),
    // Relay connections, caching and media handling still need engineering time.
    part("engineering", eng.cost, eng.cost * v.infra_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
    // Relay capacity for the users who don't bring their own, rented from a
    // provider who carries the hosting duties; never below one managed relay.
    part("relay", 0, Math.max(v.relay_floor_year, sponsored), { sponsored: v.relay_sponsored_share, minimum: sponsored < v.relay_floor_year })
  ];
  return { parts };
}
function compliance(inputs, v) {
  const { mau } = inputs;
  const eu = has(inputs, "eu");
  const uk = has(inputs, "uk");
  const us = has(inputs, "us");
  const factor = complianceFactor(inputs.team, v);
  const gdpr = eu || uk ? v.gdpr_program_year * factor : 0;
  const osa = uk ? v.uk_osa_year * factor : 0;
  const dsa = eu ? v.dsa_year * (inputs.team === "more" ? factor : v.compliance_tier_factor_one) : 0;
  const shares = jurShares(inputs, v);
  const usTier = us ? ccpaApplies(inputs, v, shares) ? "large" : "small" : null;
  const usp = us ? usTier === "large" ? v.us_privacy_year_large : v.us_privacy_year_small : 0;
  const contentLaw = osa + dsa;
  const reported = num(inputs.legal_usd) || null;
  let programs;
  let programsRemain;
  if (reported != null && reported > 0) {
    programs = reported;
    programsRemain = Math.min(reported, contentLaw) * v.content_law_remains_share + Math.max(0, reported - contentLaw) * v.privacy_remains_share;
  } else {
    programs = gdpr + usp + contentLaw;
    programsRemain = contentLaw * v.content_law_remains_share + (gdpr + usp) * v.privacy_remains_share;
  }
  const legal = engineering("legal", inputs, v);
  const dsarUsers = mau * (shares.eu + shares.uk + (usTier === "large" ? shares.us : 0));
  const dsar = dsarUsers * v.dsar_rate_per_mau_year * v.dsar_cost;
  const loss = breachLoss(inputs.team, v);
  const breach = v.breach_prob_year * loss;
  const breachRemains = breach * v.retained_data_share;
  const parts = [
    part("privacy_programs", programs, programsRemain, { us_tier: usTier, reported: reported != null && reported > 0, gdpr, osa, dsa, usp, content_law: contentLaw, us_share: shares.us, ca_consumers: caConsumers(inputs, v, shares), factor, team: inputs.team }),
    part("legal_labour", legal.cost, legal.cost * v.privacy_remains_share, { defaulted: legal.defaulted, hours: legal.hours, hourly: legal.hourly, from: legal.from }),
    part("dsar", dsar, dsar * v.retained_data_share, { users: dsarUsers }),
    part("insurance", v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part("breach", breach, breachRemains, { kind: "risk", loss, team: inputs.team, policy: v.cyber_insurance_year })
  ];
  return { parts };
}
function moderation(inputs, v) {
  const { mau } = inputs;
  const who = inputs.mod_who === "team" || inputs.mod_who === "vendor" || inputs.mod_who === "nobody" ? inputs.mod_who : "benchmark";
  const benchmark = { people: mau / 1e6 * v.mods_per_million_mau, loaded: loadedYear(v.moderator_base_salary, v) };
  benchmark.cost = benchmark.people * benchmark.loaded;
  const nobody = who === "nobody";
  const implied = who === "benchmark";
  let labour;
  let people;
  let loaded;
  if (who === "team") {
    people = num(inputs.mod_heads) ?? 0;
    loaded = loadedYear(v.ts_base_salary, v);
    labour = people * loaded;
  } else if (who === "vendor") {
    people = num(inputs.mod_heads) ?? 0;
    loaded = v.moderator_seat_outsourced;
    labour = people * loaded;
  } else if (nobody) {
    people = 0;
    loaded = 0;
    labour = 0;
  } else {
    people = benchmark.people;
    loaded = benchmark.loaded;
    labour = benchmark.cost;
  }
  const appeals = labour * v.appeals_share;
  const tooling = nobody ? 0 : mau * v.ts_tooling_per_mau_year;
  const labels = nobody ? 0 : mau * v.label_provider_per_mau_year;
  const parts = [
    part("labour", labour, labour * v.moderation_remains_share, { implied, nobody, who, people, loaded, heads_from: inputs.derived?.mod_heads, ...nobody ? { benchmark } : {} }),
    part("appeals", appeals, appeals * v.moderation_remains_share),
    part("tooling", tooling, tooling * v.tooling_remains_share),
    part("labels", 0, labels)
  ];
  return { parts, implied, nobody };
}
function payments(inputs, v) {
  const rails = inputs.rails;
  if (!rails.length || !(inputs.p2p_volume > 0)) return { parts: [], none: true };
  const annual = inputs.p2p_volume * 12;
  const share = 1 / rails.length;
  const proceeds = annual * share;
  const small = proceeds < v.store_small_threshold;
  const conv = Math.min(1, Math.max(0, v.p2p_conversion_share));
  const fee = (id, custodial, noncustodial, extra = {}) => part(id, custodial, noncustodial, { kind: "fees", conversion: conv, ...extra });
  const parts = [];
  for (const rail of rails) {
    const rev = proceeds;
    if (rail === "apple" || rail === "google") {
      const rate = rail === "apple" ? small ? v.apple_rate_small : v.apple_rate_standard : small ? v.google_rate_small : v.google_rate_standard;
      const custodial = rev * rate;
      const converted = rev * conv * (rate * v.p2p_store_fee_remains_share + v.lightning_rate);
      parts.push(fee(`store_${rail}`, custodial, converted + rev * (1 - conv) * rate, { rate, tier: small ? "small" : "standard", revenue: rev }));
    } else if (rail === "processor") {
      const cost = rev * v.processor_rate + rev / v.avg_ticket * v.processor_fixed;
      parts.push(fee("processor", cost, rev * conv * v.lightning_rate + (1 - conv) * cost, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev, tickets: rev / v.avg_ticket }));
    } else if (rail === "reseller") {
      const cost = rev * v.reseller_rate + rev / v.avg_ticket * v.reseller_fixed;
      parts.push(fee("reseller", cost, rev * conv * v.lightning_rate + (1 - conv) * cost, { rate: v.reseller_rate, fixed: v.reseller_fixed, revenue: rev, tickets: rev / v.avg_ticket }));
    } else {
      const cost = rev * v.lightning_rate;
      parts.push(fee("p2p", cost, cost, { rate: v.lightning_rate, revenue: rev }));
    }
  }
  const holds = inputs.balances.includes("yes");
  parts.push(fee("money_transmitter", holds ? v.mt_avoidance_year : 0, holds ? v.mt_avoidance_year * v.mt_remains_share : 0, { holds }));
  return { parts, tier: small ? "small" : "standard", rails_from: inputs.derived?.rails };
}
var LINE_FN = { accounts, graph, storage, compliance, moderation, payments };
function derivedAssumptions(key, from, inputs) {
  if (/^eng_/.test(key)) return [`team_factor_${inputs.team}`];
  if (key === "posts_per_user") return [from === "kind" ? `kind_${inputs.kind}_posts` : "posts_default"];
  if (key === "mb") return [from === "kind" ? `kind_${inputs.kind}_mb` : "mb_default"];
  if (key === "mod_heads") return ["mod_heads_default"];
  if (key === "egress_gb_per_mau_month") return [`kind_${inputs.kind}_egress_gb`];
  if (key === "compute_per_mau_year") return [`kind_${inputs.kind}_compute`];
  return [];
}
var PEOPLE = ["eng_base_salary", "loaded_multiplier", "overhead_multiplier"];
var WEIGHTS = ["jur_weight_eu", "jur_weight_uk", "jur_weight_us", "jur_weight_other"];
var TIERS = TEAMS.map((t2) => `compliance_tier_factor_${t2}`);
var LOSSES = TEAMS.map((t2) => `breach_loss_${t2}`);
var PART_ASSUMPTIONS = {
  "accounts.auth": ["auth_per_mau_month"],
  "accounts.resets": ["reset_rate_per_mau_year", "reset_cost"],
  "accounts.verify": ["verify_share_uk", "verify_share_us", "verify_share_eu", "verify_share_other", "verify_price", "verify_remains_share", ...WEIGHTS],
  "accounts.engineering": [...PEOPLE, "default_hours_accounts", "accounts_eng_remains_share"],
  "accounts.key_handoff": ["reset_rate_per_mau_year", "support_self_service_contact", "support_live_contact", "key_handoff_live_share"],
  "graph.database": ["db_mb_per_mau", "db_kb_per_post", "db_gb_month"],
  "graph.feed_compute": ["compute_per_mau_year", "feed_compute_share"],
  "graph.engineering": [...PEOPLE, "default_hours_content", "graph_eng_remains_share"],
  "graph.ranking": ["ranking_fee_per_mau_year"],
  "storage.blob": ["blob_gb_month", "media_sponsor_share"],
  "storage.egress": ["egress_gb_per_mau_month", "egress_gb", "media_sponsor_share"],
  "storage.serving": ["compute_per_mau_year", "feed_compute_share", "cache_per_mau_year"],
  "storage.engineering": [...PEOPLE, "default_hours_infra", "infra_eng_remains_share"],
  "storage.relay": ["relay_per_mau_year", "relay_sponsored_share", "relay_floor_year"],
  "compliance.privacy_programs": ["gdpr_program_year", "uk_osa_year", "dsa_year", ...TIERS, "us_privacy_year_small", "us_privacy_year_large", "ccpa_consumer_threshold", "annual_users_per_mau", "ca_share_of_us_users", ...WEIGHTS, "content_law_remains_share", "privacy_remains_share"],
  "compliance.legal_labour": [...PEOPLE, "default_hours_legal", "privacy_remains_share"],
  "compliance.dsar": ["dsar_rate_per_mau_year", "dsar_cost", "retained_data_share", "ccpa_consumer_threshold", "annual_users_per_mau", "ca_share_of_us_users", ...WEIGHTS],
  "compliance.insurance": ["cyber_insurance_year", "insurance_remains_share"],
  "compliance.breach": ["breach_prob_year", ...LOSSES, "retained_data_share", "cyber_insurance_year"],
  "moderation.labour": ["ts_base_salary", "moderator_base_salary", "moderator_seat_outsourced", "mods_per_million_mau", "loaded_multiplier", "overhead_multiplier", "moderation_remains_share"],
  "moderation.appeals": ["appeals_share", "moderation_remains_share"],
  "moderation.tooling": ["ts_tooling_per_mau_year", "tooling_remains_share"],
  "moderation.labels": ["label_provider_per_mau_year"],
  "payments.store_apple": ["apple_rate_standard", "apple_rate_small", "store_small_threshold", "p2p_store_fee_remains_share", "p2p_conversion_share", "lightning_rate"],
  "payments.store_google": ["google_rate_standard", "google_rate_small", "store_small_threshold", "p2p_store_fee_remains_share", "p2p_conversion_share", "lightning_rate"],
  "payments.processor": ["processor_rate", "processor_fixed", "avg_ticket", "p2p_conversion_share", "lightning_rate"],
  "payments.reseller": ["reseller_rate", "reseller_fixed", "avg_ticket", "p2p_conversion_share", "lightning_rate"],
  "payments.p2p": ["lightning_rate", "p2p_conversion_share"],
  "payments.money_transmitter": ["mt_avoidance_year", "mt_remains_share", "p2p_conversion_share"]
};
function evaluate(inputs, v) {
  const shares = nostrShares(inputs);
  const lines = {};
  let custodial = 0;
  let noncustodial = 0;
  let fees = 0;
  const breach = { custodial: 0, noncustodial: 0 };
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v);
    const share = Math.min(1, Math.max(0, shares[name]));
    const cash = r.parts.filter((p) => p.kind !== "risk");
    const nc = sum(cash, "noncustodial");
    const full2 = sum(cash, "custodial");
    const c = full2 - share * (full2 - nc);
    const kindSaving = (kind) => {
      const parts = r.parts.filter((p) => p.kind === kind);
      const kindFull = sum(parts, "custodial");
      const kindNc = sum(parts, "noncustodial");
      return kindFull - share * (kindFull - kindNc) - kindNc;
    };
    const feesSaving = kindSaving("fees");
    for (const p of r.parts.filter((q) => q.kind === "risk")) {
      breach.custodial += p.custodial - share * (p.custodial - p.noncustodial);
      breach.noncustodial += p.noncustodial;
    }
    lines[name] = { ...r, custodial: c, noncustodial: nc, full: full2, share, already: share >= 0.999, partly: share > 0 && share < 0.999, saving: c - nc, saving_cash: c - nc - feesSaving, saving_fees: feesSaving };
    custodial += c;
    noncustodial += nc;
    fees += feesSaving;
  }
  const { mau } = inputs;
  return {
    lines,
    shares,
    totals: {
      custodial,
      noncustodial,
      saving: custodial - noncustodial,
      saving_cash: custodial - noncustodial - fees,
      saving_fees: fees,
      breach_custodial: breach.custodial,
      breach_noncustodial: breach.noncustodial,
      breach_saving: breach.custodial - breach.noncustodial,
      per_mau_custodial: custodial / mau,
      per_mau_noncustodial: noncustodial / mau
    }
  };
}
function networkShare(date2, v) {
  const T = monthsBetween(v.network_mature_start, v.network_mature_end);
  if (!(T > 0)) return 1;
  const t2 = monthsBetween(v.network_mature_start, date2);
  const u = Math.min(1, Math.max(0, t2 / T));
  return 1 - (1 - u) ** 2;
}
function usersAt(months, inputs, v) {
  const given = num(inputs.growth);
  let rate = given != null ? given : v.growth_default;
  const years = [inputs.mau];
  const last2 = Math.ceil(months / 12);
  for (let year = 1; year <= last2; year++) {
    if (year > 1) rate *= v.growth_decay;
    years.push(Math.max(1, Math.round(years[year - 1] * (1 + rate))));
  }
  const whole = Math.floor(months / 12);
  const frac = months / 12 - whole;
  if (frac === 0) return years[whole];
  return years[whole] * (years[whole + 1] / years[whole]) ** frac;
}
function perLine(r, share) {
  return Object.fromEntries(
    LINES.map((name) => {
      const l = r.lines[name];
      const parts = l.parts.map((q) => {
        const custodial = q.custodial - l.share * (q.custodial - q.noncustodial);
        return { id: q.id, kind: q.kind, custodial, noncustodial: q.noncustodial, gap: (custodial - q.noncustodial) * share };
      });
      return [name, { custodial: l.custodial, noncustodial: l.noncustodial, gap: (l.custodial - l.noncustodial) * share, parts }];
    })
  );
}
function pointAt(months, inputs, v, today2, base = null, date2 = addMonths(today2, months)) {
  const users = usersAt(months, inputs, v);
  const r = months === 0 && base ? base : evaluate(months === 0 ? inputs : { ...inputs, mau: users, p2p_volume: inputs.p2p_volume * users / inputs.mau }, v);
  const share = networkShare(date2, v);
  const T = r.totals;
  return {
    months,
    year: months / 12,
    date: date2,
    users,
    share,
    custodial: T.custodial,
    noncustodial: T.noncustodial,
    nostr: T.custodial - T.saving * share,
    saving: T.saving,
    saving_cash: T.saving_cash,
    saving_fees: T.saving_fees,
    realised: T.saving * share,
    breach: { custodial: T.breach_custodial, noncustodial: T.breach_noncustodial, reduction: T.breach_saving * share },
    lines: perLine(r, share)
  };
}
function project(inputs, v, today2, base = evaluate(inputs, v)) {
  const points = [];
  for (let year = 0; year <= YEARS; year++) points.push(pointAt(year * 12, inputs, v, today2, base));
  return points;
}
function calculate(rawInputs, data, rawOverrides = {}, { today: today2 } = {}) {
  if (!isDate(today2)) throw new Error("calculate: today must be an ISO date (YYYY-MM-DD)");
  const inputs = normalizeInputs(rawInputs);
  const clamped = [];
  const overrides = cleanOverrides(data, rawOverrides, clamped);
  const out = { version: data.version, today: today2, inputs, overrides, clamped };
  for (const s of SCENARIOS) {
    const resolved = resolveAssumptions(data, s, overrides);
    const { values: v, set } = applyKind(resolved, inputs.kind, overrides);
    const eff = deriveInputs(inputs, v);
    Object.assign(eff.derived, set);
    const r = evaluate(eff, v);
    r.effective = eff;
    r.derived = eff.derived;
    r.values = v;
    r.projection = project(eff, v, today2, r);
    const payback = Math.max(0, v.integration_payback_months);
    const estimatedAt = payback + Math.max(0, v.estimated_savings_months);
    const matureIn = monthsBetween(today2, v.network_mature_end);
    r.markers = {
      // The integration wedge ends here: nothing in it is summed or estimated.
      payback: { months: payback, point: pointAt(payback, eff, v, today2, r) },
      // The headline instant.
      estimated: { months: estimatedAt, point: pointAt(estimatedAt, eff, v, today2, r) },
      // The network's date, on the app's timeline: before today it is "since".
      mature: { date: v.network_mature_end, months: matureIn, since: !(matureIn > 0), point: matureIn > 0 ? pointAt(matureIn, eff, v, today2, r, v.network_mature_end) : null }
    };
    const E = r.markers.estimated.point;
    r.totals.estimated = E.realised;
    r.totals.estimated_cash = E.saving_cash * E.share;
    r.totals.estimated_fees = E.saving_fees * E.share;
    r.totals.estimated_custodial = E.custodial;
    r.totals.estimated_nostr = E.nostr;
    r.totals.estimated_users = E.users;
    r.totals.estimated_months = E.months;
    r.totals.estimated_after_payback = estimatedAt - payback;
    r.totals.estimated_date = E.date;
    r.totals.breach_reduction = E.breach.reduction;
    r.totals.today_nostr = r.projection[0].nostr;
    for (const name of LINES) {
      const line = r.lines[name];
      const at = E.lines[name];
      line.estimated = at.gap;
      line.estimated_custodial = at.custodial;
      line.estimated_noncustodial = at.custodial - at.gap;
      for (const p of line.parts) {
        const q = at.parts.find((x) => x.id === p.id);
        p.estimated_custodial = q ? q.custodial : 0;
        p.estimated_noncustodial = q ? q.custodial - q.gap : 0;
      }
    }
    out[s] = r;
  }
  return out;
}

// assets/js/calculator/src/format.js
var full = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
var cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
var plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
var DASH = "\u2014";
function clean(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return NaN;
  return Math.abs(x) < 0.5 ? 0 : x;
}
function money(n) {
  const x = clean(n);
  return Number.isNaN(x) ? DASH : full.format(Math.round(x));
}
function compact(n) {
  const x = clean(n);
  if (Number.isNaN(x)) return DASH;
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}k`;
  return full.format(Math.round(x));
}
function approx(n) {
  const x = clean(n);
  if (Number.isNaN(x)) return DASH;
  if (x === 0) return compact(0);
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1);
  return compact(Math.round(x / magnitude) * magnitude);
}
function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function compactNumber(n) {
  const x = clean(n);
  if (Number.isNaN(x)) return DASH;
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trim(abs / 1e3)}k`;
  return `${sign}${Math.round(abs)}`;
}
function perMau(n) {
  const x = clean(n);
  return Number.isNaN(x) ? DASH : cents.format(x);
}
function percent(r) {
  const x = typeof r === "number" ? r : Number(r);
  return Number.isFinite(x) ? `${plain.format(x * 100)}%` : DASH;
}
function number(n) {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? plain.format(x) : DASH;
}
function date(iso) {
  return iso ? String(iso) : DASH;
}

// assets/js/calculator/src/chart.js
var NS2 = "http://www.w3.org/2000/svg";
var PAD = { top: 44, right: 20, bottom: 30, left: 64 };
var HEIGHT = { wide: 300, narrow: 240 };
var VERSUS = "chart-custodial-cost-vs-nostr";
var charts = /* @__PURE__ */ new Map();
var last = null;
function yearLabel(year) {
  return year === 0 ? t("chart.today") : fmt(t("chart.year"), { n: year });
}
function node(name, attrs = {}, children = []) {
  const n = document.createElementNS(NS2, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of children) n.append(c);
  return n;
}
function valueAt(points, x) {
  if (x <= points[0].x) return points[0].y;
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      const a = points[i - 1];
      const b = points[i];
      return b.x === a.x ? b.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    }
  }
  return points[points.length - 1].y;
}
function slice(points, from, to) {
  const inner = points.filter((p) => p.x > from && p.x < to);
  return [{ x: from, y: valueAt(points, from) }, ...inner, { x: to, y: valueAt(points, to) }];
}
function drawCharts(input) {
  last = input;
  if (!input) return;
  const { projection, markers, headline } = input;
  const instants = [...projection.map((p) => p), markers.payback.point, markers.estimated.point].filter(Boolean).filter((p) => p.year <= YEARS).sort((a, b) => a.year - b.year);
  const dedup = instants.filter((p, i) => i === 0 || p.year !== instants[i - 1].year);
  const series = (key) => dedup.map((p) => ({ x: p.year, y: p[key] }));
  const estimatedX = Math.min(YEARS, markers.estimated.months / 12);
  const paybackX = Math.min(YEARS, markers.payback.months / 12);
  draw(VERSUS, {
    series: [
      { key: "custodial", cls: "chart__line chart__line--custodial", marker: "chart__marker chart__marker--custodial", points: series("custodial") },
      { key: "nostr", cls: "chart__line", marker: "chart__marker", points: series("nostr") }
    ],
    band: ["custodial", "nostr"],
    // The integration wedge: from today's custody dot to the Nostr line at
    // the end of the payback window. No figure on it, nothing summed into it.
    wedge: paybackX > 0 ? { to: paybackX, label: t("chart.wedge") } : null,
    // The estimated-savings instant: a gold rule from line to line, a gold
    // dot on each, and beside it, hero-sized and gold, its length.
    rule: { x: estimatedX, text: headline.text, sub: headline.sub },
    title: input.title,
    rows: [
      { at: "top", values: (year) => yearLabel(year) },
      { at: "bottom", ends: true, middle: t("chart.versus.users"), values: (year) => compactNumber(projection[year].users) }
    ],
    tip: (year) => {
      const p = projection[year];
      return [
        fmt(t("chart.tip.users"), { n: number(p.users) }),
        fmt(t("chart.versus.tip_custody"), { amount: compact(p.custodial) }),
        fmt(t(year === 0 ? "chart.versus.tip_nostr_today" : "chart.versus.tip_nostr"), { amount: compact(p.nostr) }),
        fmt(t("chart.versus.tip_saving"), { amount: compact(p.realised) })
      ];
    }
  });
}
function draw(id, spec) {
  const svg = document.getElementById(id);
  if (!svg) return;
  const width = Math.max(280, Math.round(svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 640));
  const height = width < 520 ? HEIGHT.narrow : HEIGHT.wide;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));
  while (svg.lastChild && svg.lastChild.tagName !== "title") svg.removeChild(svg.lastChild);
  const all = spec.series.flatMap((s) => s.points.map((p) => p.y));
  const top = Math.max(1, ...all);
  const bottom = Math.min(0, ...all);
  const right = PAD.right;
  const plotW = width - PAD.left - right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (year) => PAD.left + plotW * year / YEARS;
  const y = (value) => PAD.top + plotH - plotH * (value - bottom) / (top - bottom);
  const by = Object.fromEntries(spec.series.map((s) => [s.key, s.points]));
  const at = (key, year) => valueAt(by[key], year);
  const px = (p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
  const grid = node("g", { class: "chart__grid" });
  const axis = node("g", { class: "chart__axis" });
  for (let i = 0; i <= 3; i++) {
    const value = bottom + (top - bottom) * i / 3;
    grid.append(node("line", { x1: PAD.left, x2: width - right, y1: y(value), y2: y(value), class: i === 0 ? "chart__baseline" : null }));
    if (i > 0) axis.append(node("text", { x: PAD.left - 8, y: y(value) + 4, "text-anchor": "end" }, [compact(value)]));
  }
  const narrow = width < 520;
  for (const row of spec.rows) {
    const g = node("g", { class: `chart__axis chart__axis--${row.at}` });
    const baseline = row.at === "top" ? PAD.top - 18 : height - 8;
    const ticks = row.ends ? [0, YEARS] : narrow ? [0, Math.round(YEARS / 2), YEARS] : [0, 1, 2, 3, 4, 5];
    for (const year of ticks) {
      g.append(node("text", { x: x(year), y: baseline, "text-anchor": year === 0 ? "start" : year === YEARS ? "end" : "middle" }, [row.values(year)]));
    }
    if (row.middle) g.append(node("text", { x: x(YEARS / 2), y: baseline, "text-anchor": "middle", class: "chart__axis-name" }, [row.middle]));
    axis.append(g);
  }
  const [upperKey, lowerKey] = spec.band;
  const upper = by[upperKey];
  const lower = by[lowerKey];
  const fills = node("g", { class: "chart__fills" });
  const lines = node("g");
  const marks = node("g", { class: "chart__marks" });
  const polygon = (cls, pts) => node("path", { class: cls, d: `M${pts.map(px).join("L")}Z` });
  if (spec.wedge) {
    const to = spec.wedge.to;
    const start = { x: 0, y: upper[0].y };
    const end = { x: to, y: valueAt(lower, to) };
    const hatch = `wedge-hatch-${id}`;
    const defs = node("defs", {}, [
      node("pattern", { id: hatch, patternUnits: "userSpaceOnUse", width: 6, height: 6, patternTransform: "rotate(45)" }, [
        node("rect", { class: "chart__hatch-bg", width: 6, height: 6 }),
        node("line", { class: "chart__hatch-line", x1: 0, y1: 0, x2: 0, y2: 6 })
      ])
    ]);
    fills.append(defs);
    const wedge = polygon("chart__wedge", [start, end, ...slice(lower, 0, to).reverse().slice(1)]);
    wedge.setAttribute("fill", `url(#${hatch})`);
    fills.append(wedge);
    fills.append(polygon("chart__band", [...slice(upper, 0, to), end]));
    if (to < YEARS) fills.append(polygon("chart__band", [...slice(upper, to, YEARS), ...slice(lower, to, YEARS).reverse()]));
    lines.append(node("line", { class: "chart__ramp", x1: x(0), y1: y(start.y), x2: x(to), y2: y(end.y) }));
    const ex1 = x(0);
    const ey1 = y(start.y);
    const ex2 = x(to);
    const ey2 = y(end.y);
    const len = Math.hypot(ex2 - ex1, ey2 - ey1) || 1;
    const ux = (ex2 - ex1) / len;
    const uy = (ey2 - ey1) / len;
    const along = narrow ? 0.04 : 0.06;
    const inward = narrow ? 15 : 18;
    const lx = ex1 + ux * len * along - uy * inward;
    const ly = ey1 + uy * len * along + ux * inward;
    const angle = Math.atan2(ey2 - ey1, ex2 - ex1) * 180 / Math.PI;
    const label = node("text", { class: "chart__wedge-label", x: lx, y: ly, "text-anchor": "start", transform: `rotate(${angle.toFixed(2)} ${lx.toFixed(1)} ${ly.toFixed(1)})` });
    const words = spec.wedge.label.split(" ");
    const rows = narrow && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [spec.wedge.label];
    rows.forEach((row, i) => label.append(node("tspan", { x: lx, dy: i === 0 ? rows.length > 1 ? -5 : 0 : 12 }, [row])));
    marks.append(label);
  } else {
    fills.append(polygon("chart__band", [...upper, ...[...lower].reverse()]));
  }
  for (const s of spec.series) {
    lines.append(node("polyline", { class: s.cls, points: s.points.map(px).join(" ") }));
    for (let year = 0; year <= YEARS; year++) marks.append(node("circle", { class: s.marker, cx: x(year), cy: y(at(s.key, year)), r: 5 }));
  }
  let watermarkFit = null;
  if (spec.rule) {
    const rx = spec.rule.x;
    const ry1 = y(at(upperKey, rx));
    const ry2 = y(at(lowerKey, rx));
    const mid = (ry1 + ry2) / 2;
    lines.append(node("line", { class: "chart__scale-rule", x1: x(rx), x2: x(rx), y1: Math.min(ry1, ry2), y2: Math.max(ry1, ry2) }));
    marks.append(node("circle", { class: "chart__marker chart__marker--scale", cx: x(rx), cy: ry1, r: 7 }));
    marks.append(node("circle", { class: "chart__marker chart__marker--scale", cx: x(rx), cy: ry2, r: 7 }));
    const gap = narrow ? 12 : 16;
    const flip = x(rx) > width * 0.72;
    const left = flip ? x(rx) - gap : x(rx) + gap;
    const anchor = flip ? "end" : "start";
    const figure = node("text", { class: "chart__watermark", x: left, y: mid + (narrow ? 4 : 10), "text-anchor": anchor }, [spec.rule.text]);
    marks.append(figure);
    const words = spec.rule.sub.split(" ");
    const subLines = narrow && spec.rule.sub.length > 12 ? [words.slice(0, Math.ceil(words.length / 2)).join(" ") + " ", words.slice(Math.ceil(words.length / 2)).join(" ")] : [spec.rule.sub];
    const sub = node("text", { class: "chart__watermark-sub", x: left, y: mid + (narrow ? 20 : 32), "text-anchor": anchor });
    subLines.forEach((line, i) => sub.append(node("tspan", { x: left, dy: i === 0 ? 0 : 14 }, [line])));
    marks.append(sub);
    watermarkFit = () => {
      let wide = 0;
      try {
        wide = figure.getBBox().width;
      } catch {
        wide = 0;
      }
      const room = flip ? left - PAD.left - 4 : width - 4 - left;
      if (!wide || wide <= room) return;
      const size = parseFloat(getComputedStyle(figure).fontSize) || 36;
      figure.style.fontSize = `${Math.max(20, Math.floor(size * room / wide))}px`;
    };
  }
  const hover = node("g", { class: "chart__hover" });
  const cross = node("line", { class: "chart__cross", y1: PAD.top, y2: PAD.top + plotH, x1: 0, x2: 0, hidden: "" });
  hover.append(cross);
  for (const s of spec.series) hover.append(node("circle", { class: "chart__dot", "data-key": s.key, r: 6, hidden: "" }));
  const hits = node("g", { class: "chart__hits" });
  const step = plotW / YEARS;
  for (let year = 0; year <= YEARS; year++) {
    const rect = node("rect", { class: "chart__hit", x: x(year) - step / 2, y: PAD.top, width: step, height: plotH, "data-year": year });
    rect.addEventListener("pointerenter", () => focusYear(id, year));
    hits.append(rect);
  }
  svg.append(grid, fills, lines, axis, marks, hover, hits);
  watermarkFit?.();
  const title = svg.querySelector("title");
  if (title) title.textContent = spec.title;
  charts.set(id, { spec, layout: { x, y, width, height, at }, active: null });
  hideTip(id);
}
function focusYear(id, year) {
  const chart = charts.get(id);
  const svg = document.getElementById(id);
  const tip = document.getElementById(`tip-${id}`);
  if (!chart || !svg || !tip) return;
  chart.active = year;
  const { x, y, at, width, height } = chart.layout;
  const cross = svg.querySelector(".chart__cross");
  cross.setAttribute("x1", x(year));
  cross.setAttribute("x2", x(year));
  cross.removeAttribute("hidden");
  let anchor = 0;
  for (const dot of svg.querySelectorAll(".chart__dot")) {
    const v = at(dot.dataset.key, year);
    dot.setAttribute("cx", x(year));
    dot.setAttribute("cy", y(v));
    dot.removeAttribute("hidden");
    anchor = Math.max(anchor, v);
  }
  tip.replaceChildren();
  const head = document.createElement("b");
  head.textContent = yearLabel(year);
  tip.append(head);
  for (const text2 of chart.spec.tip(year)) {
    const row = document.createElement("span");
    row.textContent = text2;
    tip.append(row);
  }
  tip.hidden = false;
  const box = svg.getBoundingClientRect();
  tip.style.setProperty("--tip-x", `${x(year) / width * box.width}px`);
  tip.style.setProperty("--tip-y", `${y(anchor) / height * box.height}px`);
  tip.classList.toggle("is-flipped", x(year) > width * 0.6);
}
function hideTip(id) {
  const chart = charts.get(id);
  const svg = document.getElementById(id);
  const tip = document.getElementById(`tip-${id}`);
  if (chart) chart.active = null;
  if (tip) tip.hidden = true;
  svg?.querySelector(".chart__cross")?.setAttribute("hidden", "");
  for (const dot of svg?.querySelectorAll(".chart__dot") || []) dot.setAttribute("hidden", "");
}
function wireCharts() {
  let timer = null;
  const redraw = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const shown = document.getElementById(VERSUS);
      if (last && shown && shown.getBoundingClientRect().width > 0) drawCharts(last);
    }, 80);
  };
  const svg = document.getElementById(VERSUS);
  if (!svg) return;
  svg.addEventListener("pointerleave", () => hideTip(VERSUS));
  svg.addEventListener("blur", () => hideTip(VERSUS));
  svg.addEventListener("keydown", (e) => {
    const active = charts.get(VERSUS)?.active;
    if (e.key === "ArrowRight") focusYear(VERSUS, Math.min(YEARS, (active ?? -1) + 1));
    else if (e.key === "ArrowLeft") focusYear(VERSUS, Math.max(0, (active ?? YEARS + 1) - 1));
    else if (e.key === "Escape") hideTip(VERSUS);
    else return;
    e.preventDefault();
  });
  if ("ResizeObserver" in window) new ResizeObserver(redraw).observe(svg.parentElement);
  else window.addEventListener("resize", redraw);
}

// assets/js/calculator/src/codec.js
var VERSION_KEY = "v";
var OVERRIDE_PREFIX = "a.";
var TEST_KEY = "test";
var DATE_KEY = "t";
var RENAMED = { rev: "p2p_volume" };
function encode2(inputs, overrides = {}, version = 1, today2 = null) {
  const p = new URLSearchParams();
  for (const [key, spec] of Object.entries(INPUTS)) {
    const v = inputs[key];
    if (v == null || v === "") continue;
    if (spec.omit != null && String(v) === spec.omit) continue;
    if (spec.type === "multi") {
      if (v.length) p.set(key, v.join(","));
    } else {
      p.set(key, String(v));
    }
  }
  for (const [key, v] of Object.entries(overrides)) p.set(OVERRIDE_PREFIX + key, String(v));
  p.set(VERSION_KEY, String(version));
  if (isDate(today2)) p.set(DATE_KEY, today2);
  return p.toString();
}
function decode(search) {
  const p = new URLSearchParams(search);
  const inputs = {};
  const overrides = {};
  let present = false;
  for (const [key, v] of p.entries()) {
    const name = Object.hasOwn(RENAMED, key) ? RENAMED[key] : key;
    if (Object.hasOwn(INPUTS, name)) {
      if (!Object.hasOwn(inputs, name) || name === key) inputs[name] = v;
      present = true;
    } else if (key.startsWith(OVERRIDE_PREFIX)) {
      overrides[key.slice(OVERRIDE_PREFIX.length)] = v;
    }
  }
  const version = p.has(VERSION_KEY) ? Number(p.get(VERSION_KEY)) : null;
  const test2 = p.get(TEST_KEY);
  const today2 = isDate(p.get(DATE_KEY)) ? p.get(DATE_KEY) : null;
  return { inputs, overrides, version, present, test: test2, today: today2 };
}

// assets/js/calculator/src/form.js
var CONTACT_KEYS = ["app_name", "company", "contact_name", "email"];
function bands(slider) {
  return { values: slider.dataset.values.split(","), labels: slider.dataset.labels.split("|") };
}
function sliderValue(slider) {
  return bands(slider).values[Number(slider.value)] ?? "";
}
function setSlider(slider, value) {
  const { values } = bands(slider);
  let at = values.indexOf(String(value));
  if (at < 0) {
    const n = Number(value);
    at = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(Number(values[i]) - n) < Math.abs(Number(values[at]) - n)) at = i;
  }
  slider.value = String(at);
  announceSlider(slider);
}
function announceSlider(slider) {
  const label = bands(slider).labels[Number(slider.value)] ?? "";
  slider.setAttribute("aria-valuetext", slider.dataset.suggested ? fmt(t("suggested_valuetext"), { label }) : label);
  const out = slider.closest(".slider-row")?.querySelector("output");
  if (out) out.textContent = label;
}
function readInputs(form2) {
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    const slider = $(`input[type="range"][name="${key}"]`, form2);
    if (slider) {
      out[key] = slider.dataset.touched && !slider.dataset.suggested ? sliderValue(slider) : "";
    } else if (spec.type === "multi") {
      out[key] = $$(`input[name="${key}"]:checked`, form2).map((i) => i.value);
    } else if (spec.type === "option") {
      out[key] = $(`input[name="${key}"]:checked`, form2)?.value ?? "";
    } else {
      out[key] = form2.elements[key]?.value.trim() ?? "";
    }
  }
  return out;
}
function readContact(form2) {
  const out = {};
  for (const key of CONTACT_KEYS) {
    const v = form2.elements[key]?.value.trim();
    if (v) out[key] = v;
  }
  return out;
}
function writeInputs(form2, inputs) {
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (!(key in inputs) || inputs[key] == null) continue;
    const v = inputs[key];
    const slider = $(`input[type="range"][name="${key}"]`, form2);
    if (slider) {
      setSlider(slider, v);
      answered(slider);
    } else if (spec.type === "multi") {
      const list = Array.isArray(v) ? v : String(v).split(",");
      for (const box of $$(`input[name="${key}"]`, form2)) box.checked = list.includes(box.value);
    } else if (spec.type === "option") {
      for (const radio of $$(`input[name="${key}"]`, form2)) radio.checked = radio.value === String(v);
    } else if (form2.elements[key]) {
      form2.elements[key].value = String(v);
    }
  }
}
function writeDefaults(form2) {
  const starting2 = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.start != null) starting2[key] = spec.start;
    else if (spec.type === "multi" || spec.type === "option" && spec.required || (spec.type === "number" || spec.type === "integer") && spec.default != null) starting2[key] = spec.default;
  }
  writeInputs(form2, starting2);
  for (const slider of $$('input[type="range"]', form2)) announceSlider(slider);
}
function answered(slider) {
  slider.dataset.touched = "1";
  delete slider.dataset.suggested;
  slider.classList.remove("is-suggested");
  slider.closest(".slider-row")?.classList.remove("is-suggested");
}
function suggest(form2, effective, derived = {}) {
  for (const key of Object.keys(derived)) {
    const slider = $(`input[type="range"][name="${key}"]`, form2);
    if (!slider || slider.dataset.touched) continue;
    slider.dataset.suggested = "1";
    setSlider(slider, effective[key]);
    slider.classList.add("is-suggested");
    slider.closest(".slider-row")?.classList.add("is-suggested");
  }
}
function wireSliders(form2) {
  for (const slider of $$('input[type="range"]', form2)) {
    slider.addEventListener("input", () => {
      answered(slider);
      announceSlider(slider);
    });
  }
}
function resetForm(form2) {
  form2.reset();
  for (const slider of $$('input[type="range"]', form2)) {
    delete slider.dataset.touched;
    delete slider.dataset.suggested;
    slider.classList.remove("is-suggested");
    slider.closest(".slider-row")?.classList.remove("is-suggested");
    announceSlider(slider);
  }
  writeDefaults(form2);
  for (const button of $$(".group__toggle", form2)) setDetails(button, false);
  markInvalid(form2, null);
}
function wireDetails(form2) {
  for (const button of $$(".group__toggle", form2)) {
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") !== "true";
      setDetails(button, open);
    });
  }
}
function setDetails(button, open) {
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? button.dataset.hide : button.dataset.show;
  const more = document.getElementById(button.getAttribute("aria-controls"));
  if (more) more.hidden = !open;
}
function revealDetails(form2) {
  for (const button of $$(".group__toggle", form2)) {
    const more = document.getElementById(button.getAttribute("aria-controls"));
    if (!more) continue;
    const answered2 = $$("input, select, textarea", more).some((i) => {
      if (i.type === "range") return !i.dataset.suggested && i.dataset.touched;
      if (i.type === "checkbox" || i.type === "radio") return i.checked;
      return i.value.trim() !== "";
    });
    if (answered2) setDetails(button, true);
  }
}
function markInvalid(form2, key) {
  for (const node2 of $$(".is-invalid", form2)) node2.classList.remove("is-invalid");
  for (const node2 of $$("[aria-invalid]", form2)) {
    node2.removeAttribute("aria-invalid");
    node2.removeAttribute("aria-describedby");
  }
  if (!key) return;
  const wrap = $(`#field-${key}`, form2);
  if (wrap) wrap.classList.add("is-invalid");
  const input = $(`#f-${key}`, form2) || $(`input[name="${key}"]`, form2);
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "calc-error");
    input.focus({ preventScroll: false });
  }
}

// assets/js/shared/src/forms.js
var KIND_FORM = 30168;
var KIND_RESPONSE = 1069;
function checkMap(snapshot2, map2) {
  const byId = new Map(snapshot2.fields.map((f) => [f.id, f]));
  const missing2 = [];
  for (const [key, m] of Object.entries(map2.fields)) {
    const f = byId.get(m.id);
    if (!f) {
      missing2.push(`${key}: no question with id ${m.id}`);
      continue;
    }
    const rows = f.grid?.rows || f.rows || [];
    const columns = f.grid?.columns || f.columns || [];
    for (const [value, oid] of Object.entries(m.options || {})) {
      if (!(f.options || []).some((o) => o.id === oid)) missing2.push(`${key}.${value}: no option ${oid}`);
    }
    for (const [value, rid] of Object.entries(m.rows || {})) {
      if (!rows.some((r) => r.id === rid)) missing2.push(`${key}.${value}: no row ${rid}`);
    }
    for (const [value, cid] of Object.entries(m.columns || {})) {
      if (!columns.some((c) => c.id === cid)) missing2.push(`${key}.${value}: no column ${cid}`);
    }
  }
  return missing2;
}
function buildResponses(map2, values) {
  const out = [];
  for (const [key, v] of Object.entries(values)) {
    const f = map2.fields[key];
    if (!f) continue;
    if (v == null || v === "" || Array.isArray(v) && v.length === 0) continue;
    let value;
    if (f.rows) {
      const cells = {};
      for (const [rowKey, colKey] of Object.entries(v)) {
        const rid = f.rows[rowKey];
        const cid = f.columns?.[String(colKey)];
        if (rid && cid) cells[rid] = cid;
      }
      if (!Object.keys(cells).length) continue;
      value = JSON.stringify(cells);
    } else if (f.options) {
      const list = Array.isArray(v) ? v : [v];
      value = list.map((x) => f.options[String(x)]).filter(Boolean).join(";");
      if (!value) continue;
    } else {
      value = String(v);
    }
    out.push(["response", f.id, value, "{}"]);
  }
  return out;
}
function readResponses(map2, tags) {
  const byId = {};
  for (const [key, f] of Object.entries(map2.fields)) byId[f.id] = { key, ...f };
  const flip = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [v, k]));
  const values = {};
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "response") continue;
    const f = byId[tag[1]];
    if (!f) continue;
    const raw = tag[2] ?? "";
    if (f.rows) {
      let cells;
      try {
        cells = JSON.parse(raw);
      } catch {
        continue;
      }
      const rows = flip(f.rows);
      const cols = flip(f.columns);
      const out = {};
      for (const [rid, cid] of Object.entries(cells || {})) if (rows[rid] && cols[cid] != null) out[rows[rid]] = cols[cid];
      values[f.key] = out;
    } else if (f.options) {
      const opts = flip(f.options);
      const list = raw.split(";").map((id) => opts[id]).filter((v) => v != null);
      values[f.key] = list;
    } else {
      values[f.key] = raw;
    }
  }
  return values;
}
function formSecretFromList(list, snapshot2) {
  const want = `${snapshot2.pubkey}:${snapshot2.d}`;
  for (const tag of Array.isArray(list) ? list : []) {
    if (!Array.isArray(tag) || tag[0] !== "f" || tag[1] !== want) continue;
    const secret = String(tag[3] || "").split(":")[0];
    if (/^[0-9a-f]{64}$/.test(secret)) return secret;
  }
  return null;
}
var KIND_MY_FORMS = 14083;
var formAddress = (snapshot2) => `${KIND_FORM}:${snapshot2.pubkey}:${snapshot2.d}`;

// assets/js/calculator/src/restore.js
var HEX643 = /^[0-9a-f]{64}$/;
function decodePointer(value) {
  const v = (value || "").trim();
  if (!v) return null;
  if (HEX643.test(v)) return { id: v, relays: [], author: null };
  try {
    const { type, data } = decodeNip19(v);
    if (type === "nevent") return { id: data.id, relays: data.relays || [], author: data.author || null };
    if (type === "note") return { id: data, relays: [], author: null };
  } catch {
    return null;
  }
  return null;
}
function relaysFor() {
  if (dev.local && dev.relays.length) return [...new Set(dev.relays.map(normalizeRelay).filter(Boolean))];
  return siteRelays();
}
async function fetchResponse(pointer, snapshot2) {
  const pool = new SimplePool();
  try {
    const event = await pool.get(relaysFor(), { ids: [pointer.id], kinds: [KIND_RESPONSE] }, { maxWait: config.timeouts.discovery });
    return event || null;
  } finally {
    pool.destroy();
  }
}
async function secretAsHolder(signer, snapshot2) {
  const pool = new SimplePool();
  try {
    const relays = discoveryRelays();
    const list = await pool.get(relays, { kinds: [KIND_MY_FORMS], authors: [signer.pubkey] }, { maxWait: config.timeouts.discovery });
    if (!list) return null;
    const json = JSON.parse(await signer.nip44Decrypt(signer.pubkey, list.content));
    return formSecretFromList(json, snapshot2);
  } catch {
    return null;
  } finally {
    pool.destroy();
  }
}
function isOurs(event, snapshot2) {
  return Boolean(event && event.kind === KIND_RESPONSE && Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === "a" && tag[1] === formAddress(snapshot2)) && typeof event.content === "string" && event.content.length > 0);
}
function parseList(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list) || !list.every((tag) => Array.isArray(tag) && typeof tag[0] === "string")) throw new Error("malformed");
  return list;
}
async function openResponse(event, { signer, snapshot: snapshot2, map: map2 }) {
  if (!isOurs(event, snapshot2)) return { error: "restore_not_ours" };
  if (signer) {
    if (signer.pubkey === event.pubkey) {
      try {
        const tags = parseList(await signer.nip44Decrypt(snapshot2.pubkey, event.content));
        return { tags, values: readResponses(map2, tags), how: "responder" };
      } catch {
      }
    }
    const secret = await secretAsHolder(signer, snapshot2);
    if (secret) {
      try {
        const tags = parseList(nip44Decrypt(event.content, getConversationKey(hexToBytes(secret), event.pubkey)));
        return { tags, values: readResponses(map2, tags), how: "holder" };
      } catch {
      }
    }
  }
  return { error: "restore_locked" };
}

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex2(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean2(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, false);
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean2(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean2(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// assets/js/shared/src/pow-core.js
var enc = new TextEncoder();
function leadingZeroBits(hash) {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    count += Math.clz32(byte) - 24;
    break;
  }
  return count;
}
function mineSync(event, difficulty, { start = 1, step = 1, batch = 2e4, onBatch } = {}) {
  const marker = `nonce-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const tag = ["nonce", marker, String(difficulty)];
  event.tags = event.tags.filter((t2) => t2[0] !== "nonce");
  event.tags.push(tag);
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const at = serialized.indexOf(marker);
  const prefix = serialized.slice(0, at);
  const suffix = serialized.slice(at + marker.length);
  let n = start;
  let tries = 0;
  for (; ; ) {
    const hash = sha256(enc.encode(prefix + n + suffix));
    if (leadingZeroBits(hash) >= difficulty) {
      tag[1] = String(n);
      event.id = bytesToHex2(hash);
      return { event, tries: tries + 1 };
    }
    n += step;
    if (++tries % batch === 0 && onBatch && onBatch(tries) === false) return null;
  }
}

// assets/js/shared/src/pow.js
var WORKER_PATH = "/assets/js/shared/pow-worker.js";
function workerCount() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, cores - 1));
}
function minePow(event, difficulty, { onProgress, signal } = {}) {
  if (!difficulty) return Promise.resolve(event);
  if (typeof Worker === "undefined") {
    const started = Date.now();
    const { event: mined } = mineSync(event, difficulty, {
      onBatch: (tries) => (onProgress?.({ tries, elapsed: Date.now() - started }), true)
    });
    return Promise.resolve(mined);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const count = workerCount();
    const workers = [];
    const tries = new Array(count).fill(0);
    let done = false;
    const stop = () => {
      done = true;
      for (const w of workers) w.terminate();
    };
    signal?.addEventListener("abort", () => (stop(), reject(new DOMException("aborted", "AbortError"))));
    for (let i = 0; i < count; i++) {
      let worker;
      try {
        worker = new Worker(WORKER_PATH);
      } catch (err) {
        stop();
        return reject(err);
      }
      workers.push(worker);
      worker.onerror = (err) => (stop(), reject(err.error || new Error("pow worker failed")));
      worker.onmessage = ({ data }) => {
        if (done) return;
        tries[i] = data.tries;
        if (data.event) {
          stop();
          resolve(data.event);
        } else {
          onProgress?.({ tries: tries.reduce((a, b) => a + b, 0), elapsed: Date.now() - started });
        }
      };
      worker.postMessage({ event, difficulty, start: i + 1, step: count });
    }
  });
}

// assets/js/shared/src/nip17.js
var KIND_CHAT = 14;
var KIND_SEAL = 13;
var KIND_WRAP = 1059;
var TWO_DAYS = 2 * 24 * 60 * 60;
var now = () => Math.floor(Date.now() / 1e3);
function jitteredTimestamp() {
  return now() - Math.floor(Math.random() * TWO_DAYS);
}
function buildRumor({ senderPubkey, recipients, subject, content }) {
  const tags = recipients.map((r) => r.relay ? ["p", r.pubkey, r.relay] : ["p", r.pubkey]);
  if (subject) tags.push(["subject", subject]);
  const rumor = {
    pubkey: senderPubkey,
    created_at: now(),
    kind: KIND_CHAT,
    tags,
    content
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}
async function sealFor(signer, rumor, targetPubkey) {
  const content = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  return signer.signEvent({
    kind: KIND_SEAL,
    created_at: jitteredTimestamp(),
    tags: [],
    content
  });
}
async function wrapFor(seal, targetPubkey, relayHint, { pow = 0, onProgress } = {}) {
  const ephemeralKey = generateSecretKey();
  const conversationKey = getConversationKey(ephemeralKey, targetPubkey);
  let template = {
    pubkey: getPublicKey(ephemeralKey),
    kind: KIND_WRAP,
    created_at: jitteredTimestamp(),
    tags: [relayHint ? ["p", targetPubkey, relayHint] : ["p", targetPubkey]],
    content: nip44Encrypt(JSON.stringify(seal), conversationKey)
  };
  if (pow > 0) template = await minePow(template, pow, { onProgress });
  const wrap = finalizeEvent(template, ephemeralKey);
  return { wrap, ephemeralKey };
}
async function publishWrap(pool, relays, wrap, ephemeralKey, { maxWait }) {
  const onauth = async (template) => finalizeEvent(template, ephemeralKey);
  const settled = await Promise.allSettled(pool.publish(relays, wrap, { onauth, maxWait }));
  return relays.map((url, i) => {
    const result = settled[i];
    return result.status === "fulfilled" ? { url, ok: true, reason: result.value || "" } : { url, ok: false, reason: String(result.reason?.message || result.reason || "failed") };
  });
}

// assets/js/calculator/src/submit.js
var now2 = () => Math.floor(Date.now() / 1e3);
function prepareForm(snapshot2, map2) {
  if (!snapshot2 || !snapshot2.pubkey || !snapshot2.d || !map2?.fields) return null;
  const missing2 = checkMap(snapshot2, map2);
  if (missing2.length) {
    console.warn("calculator form: the id map does not fit the snapshot", missing2);
    return null;
  }
  return { snapshot: snapshot2, mapping: map2 };
}
function responseRelays() {
  if (dev.local && dev.relays.length) return dev.relays.map(normalizeRelay).filter(Boolean);
  return siteRelays();
}
async function submitResponse(form2, { signer, values, pow = 0, onProgress }) {
  const responses = buildResponses(form2.mapping, values);
  if (values.consent) responses.push(["consent", String(values.consent), (/* @__PURE__ */ new Date()).toISOString()]);
  const content = await signer.nip44Encrypt(form2.snapshot.pubkey, JSON.stringify(responses));
  let template = {
    pubkey: signer.pubkey,
    kind: KIND_RESPONSE,
    created_at: now2(),
    tags: [["a", formAddress(form2.snapshot)]],
    content
  };
  if (pow > 0) template = await minePow(template, pow, { onProgress });
  const event = await signer.signEvent(template);
  const relays = responseRelays();
  const pool = new SimplePool();
  try {
    const onauth = (challenge) => signer.signEvent(challenge);
    const settled = await Promise.allSettled(pool.publish(relays, event, { onauth, maxWait: config.timeouts.publish }));
    const results = relays.map(
      (url, i) => settled[i].status === "fulfilled" ? { url, ok: true, reason: settled[i].value || "" } : { url, ok: false, reason: String(settled[i].reason?.message || settled[i].reason || "failed") }
    );
    return { event, relays: results, ok: results.filter((r) => r.ok).length };
  } finally {
    pool.destroy();
  }
}
function composeLead({ inputs, result, link, contact, fieldLabels, open }) {
  const lines = [t("compose.header"), ""];
  for (const [key, v] of Object.entries(inputs)) {
    if (v == null || v === "" || Array.isArray(v) && !v.length) continue;
    lines.push(`${fieldLabels[key]?.label || key}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  lines.push("");
  if (result.date) lines.push(fmt(t("compose.date"), { date: result.date }));
  lines.push(fmt(t("compose.results"), { custodial: result.custodial, noncustodial: result.noncustodial }));
  if (result.estimated) lines.push(fmt(t("compose.estimated"), { amount: result.estimated, low: result.low, high: result.high }));
  if (result.fees) lines.push(fmt(t("compose.fees"), { amount: result.fees }));
  if (result.breach) lines.push(fmt(t("compose.breach"), { amount: result.breach }));
  lines.push(fmt(t("compose.link"), { link }));
  if (open) lines.push(fmt(t("compose.open"), { link: open }));
  lines.push("");
  for (const key of ["app_name", "company", "contact_name", "email"]) if (contact[key]) lines.push(`${fieldLabels[key]?.label || key}: ${contact[key]}`);
  return lines.join("\n").trim();
}
function leadSubject({ mode, test: test2 }) {
  return `${mode === "test" || test2 ? t("compose.subject_test") : ""}${t("compose.subject")}`;
}
async function sendLead({ signer, recipient, subject, content, pow = 0, onProgress }) {
  const pool = new SimplePool();
  try {
    const rumor = buildRumor({ senderPubkey: signer.pubkey, recipients: [{ pubkey: recipient.pubkey }], subject, content });
    const { relays, usedFallback } = await inboxRelaysFor(pool, recipient.pubkey);
    const seal = await sealFor(signer, rumor, recipient.pubkey);
    const { wrap, ephemeralKey } = await wrapFor(seal, recipient.pubkey, relays[0], { pow, onProgress });
    try {
      const results = await publishWrap(pool, relays, wrap, ephemeralKey, { maxWait: config.timeouts.publish });
      return { relays: results, usedFallback, ok: results.filter((r) => r.ok).length };
    } finally {
      ephemeralKey.fill(0);
    }
  } finally {
    pool.destroy();
  }
}

// assets/js/calculator/src/explain.js
function fill(template, vars) {
  return String(template).replace(/\{([a-z]\.[a-z_0-9]+)\}/g, (m, key) => vars[key] == null ? m : String(vars[key]));
}
function formatValue(v, unit = "") {
  if (unit === "date") return date(v);
  if (/^ratio/.test(unit)) return percent(v);
  if (unit === "multiplier") return `${number(v)}\xD7`;
  if (/^USD/.test(unit)) return v < 100 ? perMau(v) : money(v);
  if (unit === "months") return `${number(v)} ${v === 1 ? t("how.units.month") : t("how.units.months")}`;
  return number(v);
}
function variant(line, part2) {
  if (part2.id === "engineering") return `engineering_${line}`;
  if (part2.id === "labour") return part2.nobody ? "labour_nobody" : part2.implied ? "labour_implied" : `labour_${part2.who}`;
  if (part2.id === "privacy_programs") return part2.reported ? "privacy_programs_reported" : "privacy_programs";
  if (part2.id === "money_transmitter") return part2.holds ? "money_transmitter_holds" : "money_transmitter";
  return part2.id;
}
var MONEY = /* @__PURE__ */ new Set(["custodial", "noncustodial", "revenue", "loaded", "gdpr", "osa", "dsa", "usp", "content_law", "loss", "policy"]);
var PERCENT = /* @__PURE__ */ new Set(["rate", "share", "us_share", "sponsored", "factor", "conversion"]);
var CENTS = /* @__PURE__ */ new Set(["hourly", "fixed", "contact"]);
function partVars(part2) {
  const out = {};
  for (const [k, v] of Object.entries(part2)) {
    if (typeof v !== "number") continue;
    out[`p.${k}`] = MONEY.has(k) ? money(v) : PERCENT.has(k) ? percent(v) : CENTS.has(k) ? perMau(v) : number(v);
  }
  if (part2.benchmark) {
    out["p.benchmark_people"] = number(part2.benchmark.people);
    out["p.benchmark_loaded"] = money(part2.benchmark.loaded);
    out["p.benchmark_cost"] = money(part2.benchmark.cost);
  }
  return out;
}
function relevantKeys(line, part2, inputs) {
  const keys = [...PART_ASSUMPTIONS[`${line}.${part2.id}`] || []];
  const derived = inputs.derived || {};
  if (part2.id === "engineering" || part2.id === "legal_labour") {
    const area = part2.id === "legal_labour" ? "legal" : { accounts: "accounts", graph: "content", storage: "infra" }[line];
    if (derived[`eng_${area}`]) keys.push(...derivedAssumptions(`eng_${area}`, derived[`eng_${area}`], inputs));
  }
  if (part2.id === "database" && derived.posts_per_user) keys.push(...derivedAssumptions("posts_per_user", derived.posts_per_user, inputs));
  if (part2.id === "blob" && derived.mb) keys.push(...derivedAssumptions("mb", derived.mb, inputs));
  if (part2.id === "labour" && derived.mod_heads) keys.push(...derivedAssumptions("mod_heads", derived.mod_heads, inputs));
  if (part2.id === "egress" && derived.egress_gb_per_mau_month) keys.push(...derivedAssumptions("egress_gb_per_mau_month", "kind", inputs));
  if ((part2.id === "serving" || part2.id === "feed_compute") && derived.compute_per_mau_year) keys.push(...derivedAssumptions("compute_per_mau_year", "kind", inputs));
  const jur = inputs.jur || [];
  const team = TEAMS.includes(inputs.team) ? inputs.team : "more";
  return keys.filter((key) => {
    const m = key.match(/^verify_share_(\w+)$/);
    if (m) return jur.includes(m[1]);
    const w = key.match(/^jur_weight_(\w+)$/);
    if (w) return jur.length > 1 && jur.includes(w[1]);
    if (key === "ca_share_of_us_users" || key === "annual_users_per_mau") return jur.includes("us");
    if (key === "retained_data_share" && part2.id === "dsar") return part2.custodial > 0;
    if (key === "gdpr_program_year") return jur.includes("eu") || jur.includes("uk");
    if (key === "uk_osa_year") return jur.includes("uk");
    if (key === "dsa_year") return jur.includes("eu");
    const tier = key.match(/^compliance_tier_factor_(\w+)$/);
    if (tier) return !part2.reported && (tier[1] === team || tier[1] === "one" && team !== "more" && jur.includes("eu"));
    const loss = key.match(/^breach_loss_(\w+)$/);
    if (loss) return loss[1] === team;
    if (key === "us_privacy_year_small") return part2.us_tier === "small";
    if (key === "us_privacy_year_large") return part2.us_tier === "large";
    if (key === "ccpa_consumer_threshold") return jur.includes("us");
    if (/^default_hours_/.test(key)) return Boolean(part2.defaulted);
    if (/^team_factor_/.test(key)) return Boolean(part2.defaulted);
    if (/_rate_small$/.test(key)) return part2.tier === "small";
    if (/_rate_standard$/.test(key)) return part2.tier === "standard";
    if (key === "ts_base_salary") return part2.who === "team";
    if (key === "moderator_seat_outsourced") return part2.who === "vendor";
    if (part2.nobody) return key === "moderator_base_salary" || key === "mods_per_million_mau" || key === "loaded_multiplier" || key === "overhead_multiplier";
    if (key === "moderator_base_salary" || key === "mods_per_million_mau") return Boolean(part2.implied);
    if (part2.id === "labour" && (key === "loaded_multiplier" || key === "overhead_multiplier")) return part2.who !== "vendor";
    if (key === "mt_avoidance_year" || key === "mt_remains_share") return Boolean(part2.holds);
    if (key === "p2p_conversion_share") return part2.id !== "money_transmitter" && part2.id !== "p2p";
    return true;
  });
}
function describe(keys, { values, overrides = {}, data }) {
  return keys.map((key) => {
    const a = data.assumptions[key];
    return {
      key,
      label: a.label,
      unit: a.unit,
      value: formatValue(values[key], a.unit),
      low: formatValue(a.low, a.unit),
      high: formatValue(a.high, a.unit),
      confidence: a.confidence,
      changed: Object.hasOwn(overrides, key)
    };
  });
}
function explain(line, part2, { inputs, values, overrides = {}, data, estimated = {} }) {
  const v = values;
  const vars = {
    ...partVars(part2),
    "i.mau": number(inputs.mau),
    "i.mb": number(inputs.mb),
    "i.posts_per_user": number(inputs.posts_per_user),
    "i.p2p_volume": money(inputs.p2p_volume || 0),
    "i.legal_usd": money(inputs.legal_usd || 0),
    "d.weeks": number(WEEKS_PER_YEAR),
    "d.retention": number(RETENTION_MONTHS),
    "d.volume_year": money((inputs.p2p_volume || 0) * 12),
    "d.estimated_months": estimated.months != null ? number(estimated.months) : "",
    "d.estimated_users": estimated.users != null ? number(Math.round(estimated.users)) : "",
    "d.estimated_date": estimated.date ? date(estimated.date) : "",
    "d.breach_reduction": estimated.breach != null ? approx(estimated.breach) : "",
    "p.users": part2.users != null ? number(Math.round(part2.users)) : "",
    "d.tier": part2.tier ? t(`details.tier_${part2.tier}`) : "",
    "d.team": part2.team ? t(`whose.team.${part2.team}`) : "",
    "d.programs": programsList(part2)
  };
  for (const [key, a] of Object.entries(data.assumptions)) vars[`a.${key}`] = formatValue(v[key], a.unit);
  vars["d.ccpa"] = (inputs.jur || []).includes("us") && part2.ca_consumers != null ? fill(t("how.ccpa"), vars) : "";
  const which = variant(line, part2);
  const f = t(`how.formulas.${which}`) || t(`how.formulas.${part2.id}`) || {};
  return {
    label: t(`parts.${part2.id}`, part2.id),
    today: fill(f.today || "", vars),
    nostr: fill(f.nostr || "", vars),
    // What the savings list shows: the same part at the instant the headline is read, at that instant's users.
    estimated: part2.estimated_custodial != null ? fill(t(part2.kind === "risk" ? "how.estimated_risk" : "how.estimated"), { ...vars, "p.custodial": money(part2.estimated_custodial), "p.noncustodial": money(part2.estimated_noncustodial) }) : "",
    assumptions: describe(relevantKeys(line, part2, inputs), { values, overrides, data })
  };
}
function programsList(part2) {
  if (part2.id !== "privacy_programs") return "";
  const items = [];
  if (part2.gdpr) items.push(`${t("how.programs.gdpr")} ${money(part2.gdpr)}`);
  if (part2.osa) items.push(`${t("how.programs.osa")} ${money(part2.osa)}`);
  if (part2.dsa) items.push(`${t("how.programs.dsa")} ${money(part2.dsa)}`);
  if (part2.usp) items.push(`${t(`how.programs.us_${part2.us_tier}`)} ${money(part2.usp)}`);
  return items.join(" + ") || t("how.programs.none");
}

// assets/js/calculator/src/ui.js
var ordered = (a, b) => a <= b ? [a, b] : [b, a];
var range = (a, b, f = approx) => {
  const [low, high] = ordered(a, b);
  return fmt(t("range_short"), { low: f(low), high: f(high) });
};
var rangeFull = (a, b, f = compact) => {
  const [low, high] = ordered(a, b);
  return Math.abs(high - low) < 1e-9 ? "" : fmt(t("range"), { low: f(low), high: f(high) });
};
function renderResults(result, { own = false, data = null } = {}) {
  const { typical, low, high, inputs } = result;
  const T = typical.totals;
  renderWhose(result, own);
  renderCustom(result);
  const link = $("#r-whose-link");
  if (link) link.textContent = t("whose.link");
  text("#r-permau-c", perMau(T.estimated_custodial / T.estimated_users));
  text("#r-permau-c-range", rangeFull(low.totals.estimated_custodial / low.totals.estimated_users, high.totals.estimated_custodial / high.totals.estimated_users, perMau));
  text("#r-permau-nc", perMau(T.estimated_nostr / T.estimated_users));
  text("#r-permau-nc-range", rangeFull(low.totals.estimated_nostr / low.totals.estimated_users, high.totals.estimated_nostr / high.totals.estimated_users, perMau));
  text("#r-scale-nostr", approx(T.estimated_nostr));
  text("#r-scale-nostr-range", rangeFull(low.totals.estimated_nostr, high.totals.estimated_nostr, approx));
  text("#r-version", fmt(t("version"), { version: result.version, date: date(result.today) }));
  if (data) text("#r-sourcing", fmt(t("sourcing"), sourcingCounts(data)));
  renderChart(result);
  renderYears(typical.projection);
  const cut = (c, nc) => c > 0 ? Math.min(1, Math.max(0, 1 - nc / c)) : 0;
  for (const name of LINES) {
    const line = typical.lines[name];
    const row = $(`.lt-row[data-line="${name}"]`);
    if (!row) continue;
    row.classList.toggle("is-already", Boolean(line.already));
    row.classList.toggle("is-none", Boolean(line.none));
    show($(".lt-flag--already", row), Boolean(line.already));
    show($(".lt-flag--partly", row), Boolean(line.partly));
    show($(".lt-flag--none", row), Boolean(line.none));
    const nobody = Boolean(line.nobody);
    row.classList.toggle("is-nobody", nobody);
    const nobodyNote = $(".lt-flag--nobody", row);
    if (nobodyNote) {
      const benchmark = line.parts.find((p) => p.id === "labour")?.benchmark;
      nobodyNote.textContent = nobody && benchmark ? fmt(t("moderation_nobody"), { people: number(benchmark.people), cost: compact(benchmark.cost) }) : "";
      show(nobodyNote, nobody && Boolean(benchmark));
    }
    const saving = $(".lt-saving", row);
    const rangeNode = $(".lt-saving-range", row);
    saving.textContent = line.none ? "" : approx(line.estimated);
    rangeNode.textContent = line.none ? "" : range(low.lines[name].estimated, high.lines[name].estimated);
    show(saving, !line.none);
    const share = line.none ? 0 : cut(line.custodial, line.noncustodial);
    $(".share", row).style.setProperty("--w", `${100 * share}%`);
    text(`.lt-row[data-line="${name}"] .share__pct`, line.none ? "" : percent(share));
    renderParts(name, line, inputs);
  }
}
function renderCustom(result) {
  const banner = $("#r-custom");
  if (!banner) return;
  const keys = Object.keys(result.overrides || {});
  const clamped = result.clamped || [];
  show(banner, keys.length > 0 || clamped.length > 0);
  const detail = $("#r-custom-detail");
  if (detail) detail.textContent = clamped.length ? fmt(t("custom.clamped"), { list: clamped.map((c) => `${c.key} ${c.from} \u2192 ${c.to}`).join(", ") }) : "";
}
function span(months, kind) {
  const whole = months > 0 && months % 12 === 0 ? months / 12 : null;
  const words = t("chart.spans.words") || [];
  if (whole != null && words[whole]) {
    if (kind === "after") return fmt(t(whole === 1 ? "chart.spans.after_years" : "chart.spans.after_years_plural"), { n: words[whole] });
    return fmt(t(`chart.spans.${kind}_years`), { n: words[whole] });
  }
  return fmt(t(`chart.spans.${kind}_months`), { n: number(months) });
}
function renderNote(reduction) {
  const host = $("#r-note-text");
  const how = $("#r-breach-how");
  if (!host) return;
  clear(host);
  const amount = approx(reduction);
  if (!(reduction >= 0.5) || amount === "$0") {
    show(how, false);
    return;
  }
  for (const token of t("headline.note").split(/(\{breach\})/)) host.append(token === "{breach}" ? el("b", { text: amount }) : document.createTextNode(token));
  show(how, true);
}
function renderChart(result) {
  const { typical } = result;
  const T = typical.totals;
  const M = typical.markers;
  const spans = { window: span(M.payback.months, "window"), at: span(T.estimated_months, "at"), after: span(T.estimated_after_payback, "after") };
  const caption = $(`#caption-text-${"chart-custodial-cost-vs-nostr"}`);
  if (caption) caption.textContent = [caption.dataset.template, fmt(t("chart.caption_window"), spans), fmt(t("chart.caption_estimated"), spans)].filter(Boolean).join(" ");
  renderNote(T.breach_reduction);
  const first = typical.projection[0];
  const end = typical.projection[YEARS];
  const title = fmt(t("chart.versus.aria"), {
    custodial: approx(first.custodial),
    nostr: approx(first.nostr),
    end_custodial: approx(end.custodial),
    end_nostr: approx(end.nostr),
    saving: approx(T.estimated),
    ...spans
  });
  drawCharts({ projection: typical.projection, markers: M, headline: { text: approx(T.estimated), sub: t("chart.versus.band_sub") }, title });
}
function renderWhose(result, own) {
  const host = $("#r-whose-text");
  if (!host) return;
  const { inputs, typical } = result;
  const eff = typical.effective;
  const piece = (text2, answered2) => el("span", { class: answered2 ? "whose__fact" : "whose__fact whose__fact--assumed", text: text2 });
  const regions = (inputs.jur || []).map((j) => t(`whose.reach.${j}`, j));
  const pieces = {
    lead: document.createTextNode(t(own ? "whose.yours" : "whose.illustrative")),
    kind: piece(t(`whose.kind.${inputs.kind || "none"}`), inputs.kind != null),
    mau: piece(number(inputs.mau), true),
    // The growth bands are "0", "0.25", "0.5" and "1": looked up on the block, not by path.
    growth: piece(t("whose.growth")?.[eff.growth] ?? "", inputs.growth != null),
    team: piece(t(`whose.team.${eff.team}`), inputs.team != null),
    moderation: piece(t(`whose.moderation.${inputs.mod_who || "benchmark"}`), inputs.mod_who != null),
    payments: piece(inputs.p2p_volume > 0 ? fmt(t("whose.payments.some"), { volume: compact(inputs.p2p_volume) }) : t("whose.payments.none"), inputs.p2p_volume > 0),
    reach: piece(fmt(t("whose.reach.in"), { list: regions.join(t("whose.reach.join")) }), true),
    // The Nostr bands are "0", "0.5" and "1": a key with a dot in it is looked up on the block, not by path.
    nostr: piece(t("whose.nostr")?.[eff.nostr_now] ?? "", inputs.nostr_now != null)
  };
  clear(host);
  for (const token of t("whose.frame").split(/(\{\w+\})/)) {
    const m = token.match(/^\{(\w+)\}$/);
    host.append(m ? pieces[m[1]] || document.createTextNode(token) : document.createTextNode(token));
  }
}
function renderYears(projection) {
  const head = $("#r-years-head");
  if (!head) return;
  for (const extra of $$("th[data-year]", head)) extra.remove();
  for (let year = 0; year <= YEARS; year++) head.append(el("th", { scope: "col", class: "years-num", "data-year": year, text: yearLabel(year) }));
  const cell = { users: (p) => number(Math.round(p.users)), custodial: (p) => money(p.custodial), nostr: (p) => money(p.nostr), realised: (p) => money(p.realised) };
  for (const row of $$("#r-years tbody tr[data-row]")) {
    const value = cell[row.dataset.row];
    if (!value) continue;
    for (const old of $$("td", row)) old.remove();
    for (let year = 0; year <= YEARS; year++) row.append(el("td", { class: "years-num", text: value(projection[year]) }));
  }
}
function renderParts(name, line, inputs) {
  const host = $(`.lt-parts[data-line="${name}"] .parts`);
  if (!host) return;
  text(`.lt-parts[data-line="${name}"] .parts__total-c`, money(line.estimated_custodial));
  text(`.lt-parts[data-line="${name}"] .parts__total-nc`, money(line.estimated_noncustodial));
  clear(host);
  const item = (p) => {
    const meta = partMeta(p, inputs);
    return el("tr", {}, [
      el("th", { scope: "row" }, [
        el("button", { type: "button", class: "part", "data-line": name, "data-part": p.id, "aria-haspopup": "dialog" }, [
          el("span", { class: "part__label", text: t(`parts.${p.id}`, p.id) }),
          meta ? el("span", { class: "part__meta", text: meta }) : null
        ])
      ]),
      el("td", { class: "parts-num", text: money(p.estimated_custodial) }),
      el("td", { class: "parts-num" }, [el("b", { text: money(p.estimated_noncustodial) })])
    ]);
  };
  const subtotal = (label, parts) => el("tr", { class: "parts__subtotal" }, [
    el("th", { scope: "row", text: label }),
    el("td", { class: "parts-num", text: money(parts.reduce((a, p) => a + p.estimated_custodial, 0)) }),
    el("td", { class: "parts-num" }, [el("b", { text: money(parts.reduce((a, p) => a + p.estimated_noncustodial, 0)) })])
  ]);
  const groups = [
    ["cash", line.parts.filter((p) => !p.kind)],
    ["fees", line.parts.filter((p) => p.kind === "fees")]
  ].filter(([, parts]) => parts.length);
  const labelled = groups.some(([kind]) => kind !== "cash");
  for (const [kind, parts] of groups) {
    for (const p of parts) host.append(item(p));
    if (labelled) host.append(subtotal(t(`details.${kind}`), parts));
  }
}
var howKeys = [];
var howLabel = "";
function openHow(line, partId, result, data) {
  const part2 = result.typical.lines[line]?.parts.find((p) => p.id === partId);
  if (!part2) return;
  const T = result.typical.totals;
  const info = explain(line, part2, { inputs: result.typical.effective, values: result.typical.values, overrides: result.overrides, data, estimated: { months: T.estimated_months, users: T.estimated_users, date: T.estimated_date, breach: T.breach_reduction } });
  fillHow({
    label: info.label,
    line: $(`.lt-row[data-line="${line}"] .lt-title`)?.textContent.trim() || line,
    heads: [t("details.today"), t("details.on_nostr")],
    rows: [info.today, info.nostr],
    foot: info.estimated,
    assumptions: info.assumptions
  });
}
function fillHow({ label, line, heads, rows, foot, assumptions: assumptions2 }) {
  const dialog = $("#how-modal");
  if (!dialog) return;
  howKeys = assumptions2.map((a) => a.key);
  howLabel = label;
  text("#how-part", label);
  text("#how-line", line);
  text("#how-dt-today", heads[0]);
  text("#how-dt-nostr", heads[1]);
  text("#how-today", rows[0]);
  text("#how-nostr", rows[1]);
  text("#how-scale", foot);
  const list = $("#how-list");
  clear(list);
  for (const a of assumptions2) {
    list.append(
      el("li", { class: "how__item" }, [
        el("span", { class: "how__label" }, [a.label, a.changed ? el("span", { class: "how__changed", text: t("how.changed") }) : null]),
        el("span", { class: "how__value" }, [
          el("b", { text: a.value }),
          el("span", { class: "how__meta", text: fmt(t("how.meta"), { low: a.low, high: a.high, confidence: t(`how.confidence.${a.confidence}`, a.confidence) }) })
        ])
      ])
    );
  }
  show($("#how-adjust"), assumptions2.length > 0);
  if (!dialog.open) dialog.showModal();
}
function closeHow() {
  const dialog = $("#how-modal");
  if (dialog?.open) dialog.close();
}
function focusAssumptions() {
  const panel = $("#calc-assume");
  if (!panel) return;
  let first = null;
  for (const row of $$(".assume-table tr[data-key]")) {
    const on = howKeys.includes(row.dataset.key);
    row.classList.toggle("is-focus", on);
    if (on && !first) first = row;
  }
  panel.classList.toggle("is-filtered", howKeys.length > 0);
  text("#a-filter-text", fmt(t("how.showing"), { n: howKeys.length, part: howLabel }));
  show($("#a-filter"), howKeys.length > 0);
  first?.scrollIntoView({ behavior: "smooth", block: "center" });
}
function clearFocus() {
  const panel = $("#calc-assume");
  if (!panel) return;
  for (const row of $$(".assume-table tr.is-focus")) row.classList.remove("is-focus");
  panel.classList.remove("is-filtered");
  show($("#a-filter"), false);
}
function partMeta(p, inputs) {
  if (p.id.startsWith("store_")) return `${fmt(t("details.rate"), { rate: percent(p.rate) })} \xB7 ${t(`details.tier_${p.tier}`)}`;
  if (p.id === "processor") return fmt(t("details.rate"), { rate: percent(p.rate) });
  if (p.id === "verify" && p.rate != null) return fmt(t("details.checked"), { rate: percent(p.rate) });
  if (p.id === "privacy_programs") return p.reported ? t("details.reported") : p.us_tier ? t(`details.us_${p.us_tier}`) : "";
  if (p.id === "labour" && p.nobody) return "";
  if (p.id === "labour" && p.people != null) {
    if (p.implied) return fmt(t("details.people_implied"), { n: number(p.people) });
    const which = p.who === "vendor" ? "seats" : "people";
    return fmt(t(p.heads_from ? `details.${which}_default` : `details.${which}`), { n: number(p.people) });
  }
  if (p.id === "money_transmitter" && p.holds) return t("details.holds");
  if (p.id === "engineering" || p.id === "legal_labour") {
    if (p.defaulted) return fmt(t(p.from === "team" ? "details.defaulted_team" : "details.defaulted"), { team: t(`whose.team.${inputs.team}`) });
    return fmt(t("details.hours_given"), { hours: number(p.hours) });
  }
  if ((p.id === "reseller" || p.id === "p2p") && p.rate != null) return fmt(t("details.rate"), { rate: percent(p.rate) });
  if (p.id === "database" && p.gb != null) return fmt(t("details.gb"), { gb: number(p.gb) });
  if (p.id === "breach") return t("details.expected_loss");
  if (p.id === "relay" && p.minimum) return t("details.relay_minimum");
  if (p.id === "dsar" && p.users != null && p.custodial > 0 && p.users < inputs.mau - 0.5) return fmt(t("details.dsar_users"), { n: number(Math.round(p.users)) });
  return "";
}
function wireToggles() {
  for (const button of $$(".lt-toggle")) {
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? button.dataset.hide : button.dataset.show;
      const row = document.getElementById(button.getAttribute("aria-controls"));
      if (row) row.hidden = !open;
      button.closest("tr")?.classList.toggle("is-open", open);
    });
  }
}
var TABS = ["cost", "app", "assumptions"];
var TAB_ANCHORS = { results: "cost", app: "app", assumptions: "assumptions" };
function activateTab(name, { focus = false, scroll = true, behavior = "smooth" } = {}) {
  for (const tab of TABS) {
    const button = $(`#tab-${tab}`);
    const panel = $(`#panel-${tab}`);
    const on = tab === name;
    if (button) {
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    if (panel) panel.hidden = !on;
  }
  const current2 = $("#tabs-current .tabs__current-tab");
  const active = $(`#tab-${name}`);
  if (current2 && active) {
    clear(current2);
    for (const child of active.childNodes) current2.append(child.cloneNode(true));
    $("#tabs-current").dataset.tab = name;
  }
  openTabMenu(false);
  if (scroll) $("#calc")?.scrollIntoView({ behavior, block: "start" });
  if (focus) $(`#tab-${name}`)?.focus({ preventScroll: true });
}
function openTabMenu(open) {
  const bar = $("#tabbar");
  const button = $("#tabs-current");
  if (!bar || !button) return;
  const next = open ?? !bar.classList.contains("is-open");
  bar.classList.toggle("is-open", next);
  button.setAttribute("aria-expanded", String(next));
}
function wireTabs(onSelect) {
  $("#tabs-current")?.addEventListener("click", () => openTabMenu());
  const buttons = TABS.map((t2) => $(`#tab-${t2}`)).filter(Boolean);
  for (const button of buttons) {
    const name = button.id.replace("tab-", "");
    button.addEventListener("click", () => onSelect(name));
    button.addEventListener("keydown", (e) => {
      const at = TABS.indexOf(name);
      if (e.key === "ArrowRight") onSelect(TABS[(at + 1) % TABS.length], { focus: true });
      else if (e.key === "ArrowLeft") onSelect(TABS[(at + TABS.length - 1) % TABS.length], { focus: true });
    });
  }
}
function showResults(visible, { focus = false, scroll = true } = {}) {
  const panel = $("#calc-results");
  if (!panel) return;
  panel.hidden = !visible;
  const empty = $("#r-empty");
  if (empty) empty.hidden = visible;
  if (visible) {
    activateTab("cost", { scroll });
    if (focus) {
      $(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#results-title")?.focus({ preventScroll: true });
    }
  }
}
function setStatus2(message) {
  const node2 = $("#r-status");
  if (node2) node2.textContent = message || "";
}
function setError2(code, fieldLabel) {
  const node2 = $("#calc-error");
  if (!node2) return;
  const message = code ? fmt(t(`errors.${code}`) || t("errors.unknown"), { field: fieldLabel || "" }) : "";
  node2.textContent = message;
  show(node2, Boolean(message));
}
var isDateInput = (input) => input.dataset.unit === "date" || input.type === "date";
function readOverrides() {
  const out = {};
  for (const input of $$(".assume-input")) {
    const v = input.value.trim();
    if (v === "") continue;
    if (isDateInput(input)) {
      if (isDate(v) && v !== input.dataset.typical) out[input.dataset.key] = v;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n === Number(input.dataset.typical)) continue;
    out[input.dataset.key] = n;
  }
  return out;
}
function writeOverrides(overrides = {}) {
  for (const input of $$(".assume-input")) {
    const key = input.dataset.key;
    input.value = Object.hasOwn(overrides, key) ? String(overrides[key]) : input.dataset.typical;
  }
  markChanged();
}
function markChanged() {
  for (const input of $$(".assume-input")) {
    const v = input.value.trim();
    const changed = v !== "" && (isDateInput(input) ? v !== input.dataset.typical : Number(v) !== Number(input.dataset.typical));
    input.closest("tr")?.classList.toggle("is-changed", changed);
  }
}
function text(sel, value) {
  const node2 = $(sel);
  if (node2) node2.textContent = value;
}

// assets/js/calculator/src/app.js
var assumptions = readJson("page-assumptions");
var snapshot = readJson("page-form");
var map = readJson("page-map");
var form = prepareForm(snapshot, map);
var current = null;
var today = localDate();
function localDate() {
  const d = /* @__PURE__ */ new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
var dirty = false;
var test = null;
var nevent = null;
var openedAt = Date.now();
var sends = [];
var lastLead = "";
var signIn = null;
var session = null;
var pendingSave = false;
var pendingOpen = null;
var syncTimer = null;
function labelFor(key) {
  const node2 = document.querySelector(`#field-${key} .field__label, label[for="f-${key}"]`);
  return node2 ? node2.textContent.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim() : key;
}
function run(raw, overrides, { focus = true, show: show2 = true, scroll = true } = {}) {
  let result;
  try {
    result = calculate(raw, assumptions, overrides, { today });
  } catch (err) {
    if (err instanceof InputError) {
      if (!show2) return null;
      activateTab("app", { scroll });
      markInvalid($("#calc-form"), err.key);
      setError2(err.code, labelFor(err.key));
      return null;
    }
    setError2("unknown");
    throw err;
  }
  markInvalid($("#calc-form"), null);
  setError2(null);
  current = result;
  dirty = false;
  writeOverrides(result.overrides);
  const own = !sameAsDefaults(result.inputs);
  renderResults(result, { own, data: assumptions });
  $("#tabbar")?.classList.toggle("is-illustrative", !own);
  const share = $("#save-open");
  if (share) {
    share.classList.toggle("btn--primary", own);
    share.classList.toggle("btn--secondary", !own);
  }
  suggest($("#calc-form"), result.typical.effective, result.typical.derived);
  const query2 = encode2(result.inputs, result.overrides, result.version, today);
  result.link = `${location.origin}${location.pathname}?${query2}`;
  replaceQuery(query2);
  if (show2) showResults(true, { focus, scroll });
  return result;
}
var starting = "";
function sameAsDefaults(inputs) {
  return JSON.stringify(inputs) === starting;
}
function fresh() {
  return dirty || !current ? run(readInputs($("#calc-form")), readOverrides(), { focus: false }) : current;
}
function onCalculate(event) {
  event.preventDefault();
  run(readInputs(event.currentTarget), readOverrides());
}
function onRecalculate() {
  markChanged();
  run(readInputs($("#calc-form")), readOverrides(), { focus: true });
}
function onTab(name, opts) {
  if (name === "cost" && dirty) run(readInputs($("#calc-form")), readOverrides(), { focus: false });
  activateTab(name, opts);
}
function onDirty() {
  dirty = true;
  syncUrl();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    run(readInputs($("#calc-form")), readOverrides(), { focus: false, show: false });
  }, 150);
}
var previewTimer = null;
function currentQuery() {
  try {
    const inputs = normalizeInputs(readInputs($("#calc-form")));
    return encode2(inputs, cleanOverrides(assumptions, readOverrides()), assumptions.version, today);
  } catch {
    return null;
  }
}
function replaceQuery(query2) {
  const extra = `${test ? `&test=${encodeURIComponent(test)}` : ""}${nevent ? `&nevent=${encodeURIComponent(nevent)}` : ""}`;
  history.replaceState(null, "", `${query2 ? `?${query2}${extra}` : location.pathname}${location.hash}`);
}
function syncUrl() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const query2 = currentQuery();
    if (query2) replaceQuery(query2);
  }, 120);
}
function onResetOverrides() {
  writeOverrides({});
  markChanged();
  run(readInputs($("#calc-form")), {}, { focus: false });
}
var modal = () => $("#save-modal");
function requiredKeys() {
  return CONTACT_KEYS.filter((key) => snapshot?.fields?.some((f) => f.id === map.fields[key]?.id && f.required));
}
function missing(formEl) {
  const out = [];
  for (const key of requiredKeys()) if (!formEl.elements[key]?.value.trim()) out.push(key);
  if (formEl.elements.email?.value.trim() && !formEl.elements.consent?.checked) out.push("consent");
  return out;
}
function gate() {
  const formEl = $("#calc-form");
  if (!formEl || !modal()) return;
  const lacking = missing(formEl);
  const own = Boolean(signIn?.current());
  const save2 = $("#save-submit");
  if (save2) save2.disabled = lacking.length > 0;
  const needed = $("#save-needed");
  if (needed) {
    needed.textContent = lacking.length ? fmt(t("modal.needed"), { list: lacking.map((k) => k === "consent" ? t("modal.consent_name") : labelFor(k)).join(", ") }) : "";
  }
  const signedNote = $("#identity-note");
  if (signedNote && own) signedNote.textContent = t("modal.signed");
  const note = $("#save-note");
  if (note) note.textContent = t(own ? "modal.data_note_signed" : "modal.data_note_session");
}
var signDialog = () => $("#sign-modal");
function openSign() {
  const dialog = signDialog();
  if (dialog && !dialog.open) dialog.showModal();
}
function closeSign() {
  const dialog = signDialog();
  if (dialog?.open) dialog.close();
}
function openSave() {
  const dialog = modal();
  if (!dialog) return;
  setStatus2("");
  $("#save-status").textContent = "";
  gate();
  if (!dialog.open) dialog.showModal();
}
function closeSave() {
  const dialog = modal();
  if (dialog?.open) dialog.close();
}
function withhold(formEl) {
  if (formEl.elements.website.value) return "honeypot";
  if (Date.now() - openedAt < config.limits.min_seconds * 1e3) return "too_fast";
  const cutoff = Date.now() - config.limits.rate.window;
  sends = sends.filter((at) => at > cutoff);
  if (sends.length >= config.limits.rate.max) return "rate_limited";
  return null;
}
function valuesFor(result, contact) {
  const T = result.typical.totals;
  const i = result.inputs;
  const grid = (name, prefix) => {
    const cells = {};
    for (const key of GRIDS[name]) if (i[key] != null) cells[key.slice(prefix.length)] = i[key];
    return cells;
  };
  return {
    nostr_now: i.nostr_now ?? "",
    nostr: grid("nostr", "n_"),
    mau: i.mau,
    growth: i.growth ?? "",
    kind: i.kind ?? "",
    posts_per_user: i.posts_per_user ?? "",
    mb: i.mb ?? "",
    mod_who: i.mod_who ?? "",
    mod_heads: i.mod_heads ?? "",
    team: i.team ?? "",
    engineering: grid("engineering", "eng_"),
    legal_usd: i.legal_usd ?? "",
    p2p_volume: i.p2p_volume,
    rails: i.rails,
    balances: i.balances,
    jur: i.jur,
    distribution: i.distribution,
    result_custodial: Math.round(T.custodial),
    result_noncustodial: Math.round(T.noncustodial),
    // The fees saved a year at the estimated instant travel too (map.yml).
    fees_saved: Math.round(T.estimated_fees),
    link: result.link,
    overrides: Object.keys(result.overrides).length ? JSON.stringify(result.overrides) : "",
    version: String(result.version),
    ...contact,
    // The test checkbox beside Send: a send marked as a test is sent as the form's own option.
    test: $("#f-test")?.checked ? ["yes"] : [],
    // Consent to email, recorded in the response as the consent text's version (submit.js adds the time).
    consent: $("#f-consent")?.checked ? String(config.consent_version || "1") : ""
  };
}
function signerForSave() {
  const own = signIn?.current();
  if (own) return own;
  if (!session) session = createSessionSigner();
  return session;
}
function onSave() {
  const formEl = $("#calc-form");
  const error = $("#save-error");
  if (!form || !formEl) return;
  error.hidden = true;
  if (missing(formEl).length) return gate();
  const problem = withhold(formEl);
  if (problem === "honeypot") {
    $("#save-status").textContent = fmt(t("modal.saved"), { ok: 1, total: 1, id: "ok" });
    return;
  }
  if (problem) {
    error.textContent = t(`errors.${problem}`) || t("errors.unknown");
    error.hidden = false;
    return;
  }
  if (signIn?.current()) return save(signIn.current());
  pendingSave = true;
  openSign();
}
function onSession() {
  closeSign();
  if (pendingOpen) {
    const pointer = pendingOpen;
    pendingOpen = null;
    if (hasSessionKey()) return restore(pointer, signerForSave());
    setStatus2(t("errors.restore_locked"));
    return;
  }
  if (!pendingSave) return;
  pendingSave = false;
  save(signerForSave());
}
function onSigner(signer) {
  gate();
  if (!signer) return;
  closeSign();
  if (pendingOpen) {
    const pointer = pendingOpen;
    pendingOpen = null;
    return restore(pointer, signer);
  }
  if (!pendingSave) return;
  pendingSave = false;
  save(signer);
}
async function save(signer) {
  const formEl = $("#calc-form");
  const status = $("#save-status");
  const result = fresh();
  if (!result) return closeSave();
  const contact = readContact(formEl);
  const pow = dev.noPow ? 0 : signer.kind === "session" ? config.pow.response : config.pow.signed;
  $("#save-submit").disabled = true;
  status.textContent = t("status.saving");
  const mining = $("#save-mining");
  try {
    const { event, ok, relays } = await submitResponse(form, {
      signer,
      values: valuesFor(result, contact),
      pow,
      // The visible line stays quiet; the hash count goes to the live region for anyone who wants it.
      onProgress: ({ tries }) => {
        status.textContent = t("status.mining");
        if (mining) mining.textContent = fmt(t("status.mining_count"), { hashes: tries });
      }
    });
    if (mining) mining.textContent = "";
    sends.push(Date.now());
    status.textContent = ok ? fmt(t("modal.saved"), { ok, total: relays.length, id: event.id.slice(0, 12) }) : t("status.failed");
    setStatus2(status.textContent);
    if (ok && Object.keys(contact).length) {
      const hint = relays.find((r) => r.ok)?.url;
      const nevent2 = neventEncode({ id: event.id, relays: hint ? [hint] : [], author: event.pubkey });
      await tell(signer, result, contact, `${location.origin}${location.pathname}?nevent=${nevent2}`);
    }
  } catch (err) {
    console.warn("calculator: could not save", err);
    status.textContent = t("status.failed");
  } finally {
    gate();
  }
}
async function tell(signer, result, contact, open) {
  const fingerprint = JSON.stringify([contact, result.link]);
  if (fingerprint === lastLead) return;
  let recipient;
  try {
    recipient = pickRecipient(await loadRecipients(), config.lead_recipient);
  } catch {
    return;
  }
  if (!recipient) return;
  const T = result.typical.totals;
  const content = composeLead({
    inputs: result.inputs,
    result: {
      date: result.today,
      custodial: approx(T.custodial),
      noncustodial: approx(T.noncustodial),
      estimated: approx(T.estimated),
      low: approx(result.low.totals.estimated),
      high: approx(result.high.totals.estimated),
      breach: T.breach_reduction >= 1 ? approx(T.breach_reduction) : "",
      fees: T.estimated_fees >= 1 ? approx(T.estimated_fees) : ""
    },
    link: result.link,
    contact,
    fieldLabels: Object.fromEntries([...Object.keys(result.inputs), ...Object.keys(contact)].map((k) => [k, { label: labelFor(k) }])),
    open
  });
  try {
    const subject = leadSubject({ mode: config.calculator_mode, test: Boolean($("#f-test")?.checked) });
    await sendLead({ signer, recipient, subject, content, pow: dev.noPow ? 0 : signer.kind === "session" ? config.pow.anonymous : config.pow.signed });
    lastLead = fingerprint;
  } catch (err) {
    console.warn("calculator: could not notify", err);
  }
}
var copyTimer = null;
async function onCopyUrl() {
  const button = $("#save-copy");
  const query2 = currentQuery();
  const url = query2 ? `${location.origin}${location.pathname}?${query2}` : location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    $("#save-status").textContent = url;
    return;
  }
  button.classList.add("is-copied");
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => button.classList.remove("is-copied"), 1800);
}
async function restore(pointer, signer) {
  setStatus2(t("status.opening"));
  let event = null;
  try {
    event = await fetchResponse(pointer, snapshot);
  } catch {
    event = null;
  }
  if (!event) return setStatus2(t("errors.restore_missing"));
  let opened;
  try {
    opened = await openResponse(event, { signer, snapshot, map });
  } catch {
    opened = { error: "restore_malformed" };
  }
  if (opened.error) return setStatus2(t(`errors.${opened.error}`));
  const v = opened.values || {};
  const one = (x) => Array.isArray(x) ? x[0] : x;
  const inputs = {
    mau: v.mau,
    posts_per_user: v.posts_per_user,
    mb: v.mb,
    legal_usd: v.legal_usd,
    p2p_volume: v.p2p_volume ?? v.rev,
    rails: v.rails,
    balances: v.balances,
    distribution: v.distribution,
    jur: v.jur,
    growth: one(v.growth),
    nostr_now: one(v.nostr_now),
    kind: one(v.kind),
    mod_who: one(v.mod_who),
    mod_heads: one(v.mod_heads),
    team: one(v.team)
  };
  for (const [area, hours] of Object.entries(v.engineering || {})) inputs[`eng_${area}`] = hours;
  for (const [row, share] of Object.entries(v.nostr || {})) inputs[`n_${row}`] = share;
  let overrides = {};
  try {
    const parsed = v.overrides ? JSON.parse(v.overrides) : {};
    overrides = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    overrides = {};
  }
  const formEl = $("#calc-form");
  let result = null;
  try {
    writeInputs(formEl, inputs);
    revealDetails(formEl);
    writeOverrides(overrides);
    const box = $("#f-test");
    if (box) box.checked = Array.isArray(v.test) ? v.test.length > 0 : Boolean(v.test);
    result = run(inputs, overrides, { focus: false, show: false });
  } catch {
    result = null;
  }
  if (!result) return setStatus2(t("errors.restore_malformed"));
  showResults(true, { focus: false, scroll: false });
  setStatus2(fmt(t("status.opened"), { when: new Date(event.created_at * 1e3).toLocaleString(), how: t(`status.opened_${opened.how}`) }));
}
function openFromLink(pointer) {
  if (!form) return setStatus2(t("errors.restore_missing"));
  if (hasSessionKey()) return restore(pointer, signerForSave());
  pendingOpen = pointer;
  setStatus2(t("errors.restore_locked"));
  openSign();
}
function onEdit() {
  activateTab("app", { focus: true });
}
function onResetForm() {
  const formEl = $("#calc-form");
  resetForm(formEl);
  setError2(null);
  today = localDate();
  const result = run(readInputs(formEl), readOverrides(), { focus: false, show: false });
  if (result) replaceQuery("");
  formEl.scrollIntoView({ behavior: "smooth", block: "start" });
}
function wire() {
  $("#calc-form")?.addEventListener("submit", onCalculate);
  $("#r-edit")?.addEventListener("click", onEdit);
  $("#calc-reset")?.addEventListener("click", onResetForm);
  $("#r-whose-link")?.addEventListener("click", onEdit);
  wireCharts();
  $("#a-reset")?.addEventListener("click", onReset);
  $("#r-custom-reset")?.addEventListener("click", onResetOverrides);
  $("#a-recalc")?.addEventListener("click", onRecalculate);
  for (const input of $$(".assume-input")) {
    input.addEventListener("change", markChanged);
    input.addEventListener("change", onDirty);
  }
  $("#calc-form")?.addEventListener("input", onDirty);
  $("#calc-form")?.addEventListener("change", onDirty);
  $("#save-open")?.addEventListener("click", openSave);
  $("#save-close")?.addEventListener("click", closeSave);
  $("#save-submit")?.addEventListener("click", onSave);
  $("#save-copy")?.addEventListener("click", onCopyUrl);
  $("#save-modal")?.addEventListener("input", gate);
  $("#save-modal")?.addEventListener("change", gate);
  $("#sign-session")?.addEventListener("click", onSession);
  $("#sign-cancel")?.addEventListener("click", () => {
    pendingSave = false;
    pendingOpen = null;
    closeSign();
  });
  $("#sign-modal")?.addEventListener("close", () => {
    pendingSave = false;
    pendingOpen = null;
  });
  wireTabs(onTab);
  wireToggles();
  $("#r-table")?.addEventListener("click", (e) => {
    const button = e.target.closest("button.part");
    if (button && current) openHow(button.dataset.line, button.dataset.part, current, assumptions);
  });
  $("#r-breach-how")?.addEventListener("click", () => {
    if (current) openHow("compliance", "breach", current, assumptions);
  });
  $("#save-sign-open")?.addEventListener("click", openSign);
  $("#how-close")?.addEventListener("click", closeHow);
  $("#how-adjust")?.addEventListener("click", () => {
    closeHow();
    activateTab("assumptions", { focus: true });
    focusAssumptions();
  });
  $("#a-filter-clear")?.addEventListener("click", clearFocus);
}
function onReset() {
  writeOverrides({});
  markChanged();
  dirty = true;
}
async function boot() {
  const formEl = $("#calc-form");
  if (!formEl) return;
  wire();
  wireSliders(formEl);
  wireDetails(formEl);
  writeDefaults(formEl);
  try {
    starting = JSON.stringify(normalizeInputs(readInputs(formEl)));
  } catch {
    starting = "";
  }
  const anchor = TAB_ANCHORS[location.hash.slice(1)] || null;
  const opened = decode(location.search);
  test = opened.test;
  if (opened.present && opened.today) today = opened.today;
  if (test && $("#f-test")) $("#f-test").checked = true;
  const older = opened.present && opened.version != null && opened.version < assumptions.version ? opened.version : null;
  if (older && older < 2 && opened.inputs.team == null) opened.inputs.team = "ten";
  nevent = new URLSearchParams(location.search).get("nevent") || null;
  const pointer = decodePointer(nevent);
  if (pointer) {
    if (opened.present) {
      writeInputs(formEl, opened.inputs);
      revealDetails(formEl);
      writeOverrides(opened.overrides);
    }
    run(readInputs(formEl), readOverrides(), { focus: false, scroll: false });
  } else if (opened.present) {
    writeInputs(formEl, opened.inputs);
    revealDetails(formEl);
    writeOverrides(opened.overrides);
    const result = run(opened.inputs, opened.overrides, { focus: false, scroll: false });
    if (result) setStatus2(older ? fmt(t("status.older_version"), { from: older, to: assumptions.version }) : t("status.shared"));
    else activateTab("app", { scroll: false });
  } else {
    const result = run(readInputs(formEl), readOverrides(), { focus: false, scroll: false });
    if (result) replaceQuery("");
  }
  if (anchor) activateTab(anchor, { scroll: true, behavior: "auto" });
  window.addEventListener("hashchange", () => {
    const tab = TAB_ANCHORS[location.hash.slice(1)];
    if (tab) activateTab(tab);
  });
  if (form) {
    const open = $("#save-open");
    if (open) open.hidden = false;
    signIn = createSignIn({ onChange: onSigner });
    signIn.wire();
    signIn.markExtension(await detectNip07());
    if (pointer) openFromLink(pointer);
  }
  document.documentElement.dataset.calculator = "ready";
  document.documentElement.dataset.calculatorForm = form ? "ready" : "none";
  if (dev.local) console.info("calculator: localhost overrides active", dev);
}
boot();
