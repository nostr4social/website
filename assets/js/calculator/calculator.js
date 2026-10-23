// assets/js/shared/src/dom.js
var $ = (sel, root = document) => root.querySelector(sel);
var $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function replace(node, ...children) {
  clear(node);
  for (const child of children) if (child != null) node.append(child);
}
function show(node, visible) {
  node.hidden = !visible;
}

// assets/js/shared/src/config.js
function readJson(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing config block: ${id}`);
  return JSON.parse(node.textContent);
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
  return path.split(".").reduce((node, key) => node == null ? void 0 : node[key], strings) ?? fallback;
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

// assets/js/shared/src/profiles.js
var KIND_PROFILE = 0;
var MAX_NAME = 40;
async function fetchProfileName(pool, pubkey) {
  let event = null;
  try {
    event = await pool.get(
      config.relays.discovery,
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
function setError(node, code) {
  if (!node) return;
  const message = code ? t(`errors.${code}`) || t("errors.unknown") : "";
  node.textContent = message;
  show(node, Boolean(message));
}
function setStatus(node, message) {
  if (!node) return;
  node.textContent = message || "";
  show(node, Boolean(message));
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
var HEADS = ["0", "5", "50", "500", "2000"];
var NOSTR = ["0", "0.5", "1"];
var band = (options, omit) => ({ type: "option", required: false, default: null, options, omit });
var INPUTS = {
  // Non Custody: "Our app already uses Nostr"
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
  // Accounts & Storage
  mau: { type: "integer", required: true, default: 5e4, min: 1, max: 2e9 },
  posts_per_user: { type: "number", required: false, default: 20, min: 0, max: 1e6 },
  mb: { type: "number", required: false, default: 50, min: 0, max: 1e6 },
  // Staffing Costs
  eng_accounts: band(HOURS),
  // engineering hours a week: managing user accounts
  eng_content: band(HOURS),
  // managing user content
  eng_infra: band(HOURS),
  // managing infrastructure
  eng_legal: band(HOURS),
  // legal and compliance
  mod_inhouse: band(HEADS, "0"),
  // content review and moderation: in-house employees
  mod_vendor: band(HEADS, "0"),
  // outside vendor seats
  legal_usd: { type: "number", required: false, default: null, min: 0, max: 1e12, omit: "0" },
  // 0 means not given
  // Payment Gateway
  rails: { type: "multi", required: false, default: [], options: ["p2p", "apple", "google", "processor", "reseller"] },
  rev: { type: "number", required: false, default: 0, min: 0, max: 1e12 },
  balances: { type: "multi", required: false, default: [], options: ["yes"] },
  // App Availability
  distribution: { type: "multi", required: false, default: [], options: ["apple", "google", "web"] },
  jur: { type: "multi", required: true, default: ["us"], options: ["eu", "uk", "us", "other"] }
};
var GRIDS = {
  nostr: ["n_keys", "n_raw_keys", "n_signed_events", "n_event_storage", "n_media_storage", "n_labels", "n_feeds", "n_algos", "n_p2p", "n_nips"],
  engineering: ["eng_accounts", "eng_content", "eng_infra", "eng_legal"],
  moderation: ["mod_inhouse", "mod_vendor"]
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
  if (out.rails.length && !(out.rev > 0)) throw new InputError("rev", "required");
  return out;
}

// assets/js/calculator/src/model.js
var LINES = ["accounts", "graph", "storage", "compliance", "moderation", "payments"];
var SCENARIOS = ["low", "typical", "high"];
var HOURS_PER_YEAR = 2e3;
var WEEKS_PER_YEAR = 50;
var RETENTION_MONTHS = 12;
function resolveAssumptions(data, scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const out = {};
  for (const [key, a] of Object.entries(data.assumptions)) {
    const o = overrides[key];
    out[key] = o != null && Number.isFinite(Number(o)) ? Number(o) : a[scenario];
  }
  return out;
}
function cleanOverrides(data, overrides = {}) {
  const out = {};
  for (const [key, v] of Object.entries(overrides)) {
    if (!(key in data.assumptions)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n === data.assumptions[key].typical) continue;
    out[key] = n;
  }
  return out;
}
var loadedHourly = (v) => v.eng_base_salary * v.loaded_multiplier * v.overhead_multiplier / HOURS_PER_YEAR;
var loadedYear = (base, v) => base * v.loaded_multiplier * v.overhead_multiplier;
var num = (x) => x == null || x === "" ? null : Number(x);
function engHoursYear(area, inputs, v) {
  const given = num(inputs[`eng_${area}`]);
  const defaults = {
    accounts: v.default_hours_accounts,
    content: v.default_hours_content,
    infra: v.default_hours_infra,
    legal: v.default_hours_legal
  };
  const weekly = given != null ? given : defaults[area];
  return weekly * WEEKS_PER_YEAR;
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
var part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra });
var sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0);
var has = (inputs, j) => inputs.jur.includes(j);
var posts = (inputs) => inputs.mau * inputs.posts_per_user;
function accounts(inputs, v) {
  const { mau } = inputs;
  const verifyShare = Math.max(
    has(inputs, "uk") ? v.verify_share_uk : 0,
    has(inputs, "us") ? v.verify_share_us : 0,
    has(inputs, "eu") ? v.verify_share_eu : 0,
    has(inputs, "other") ? v.verify_share_other : 0
  );
  const verify = mau * verifyShare * v.verify_price;
  const eng = engHoursYear("accounts", inputs, v) * loadedHourly(v);
  const parts = [
    part("auth", mau * v.auth_per_mau_month * 12, 0),
    part("resets", mau * v.reset_rate_per_mau_year * v.reset_cost, 0),
    part("verify", verify, verify, { rate: verifyShare }),
    part("engineering", eng, 0, { defaulted: num(inputs.eng_accounts) == null }),
    part("key_support", 0, mau * v.key_support_per_mau_year)
  ];
  return { parts };
}
function graph(inputs, v) {
  const { mau } = inputs;
  const dbGb = mau * v.db_mb_per_mau / 1024 + posts(inputs) * RETENTION_MONTHS * v.db_kb_per_post / 1024 / 1024;
  const eng = engHoursYear("content", inputs, v) * loadedHourly(v);
  const parts = [
    part("database", dbGb * v.db_gb_month * 12, 0, { gb: dbGb }),
    part("feed_compute", mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part("engineering", eng, eng * v.graph_eng_remains_share, { defaulted: num(inputs.eng_content) == null }),
    part("ranking", 0, mau * v.ranking_fee_per_mau_year)
  ];
  return { parts };
}
function storage(inputs, v) {
  const { mau, mb } = inputs;
  const blob = mau * mb / 1024 * v.blob_gb_month * 12;
  const egress = mau * v.egress_gb_per_mau_month * v.egress_gb * 12;
  const eng = engHoursYear("infra", inputs, v) * loadedHourly(v);
  const parts = [
    part("blob", blob, blob * v.media_sponsor_share),
    part("egress", egress, egress * v.media_sponsor_share),
    part("serving", mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year),
    part("engineering", eng, 0, { defaulted: num(inputs.eng_infra) == null }),
    part("relay", 0, v.relay_cost_year)
  ];
  return { parts };
}
function compliance(inputs, v) {
  const { mau } = inputs;
  const eu = has(inputs, "eu");
  const uk = has(inputs, "uk");
  const us = has(inputs, "us");
  const gdpr = eu || uk ? v.gdpr_program_year : 0;
  const osa = uk ? v.uk_osa_year : 0;
  const dsa = eu ? v.dsa_year : 0;
  const usTier = us ? mau >= v.ccpa_consumer_threshold ? "large" : "small" : null;
  const usp = us ? usTier === "large" ? v.us_privacy_year_large : v.us_privacy_year_small : 0;
  const contentLaw = osa + dsa;
  const reported = num(inputs.legal_usd) || null;
  let programs;
  let programsRemain;
  if (reported != null && reported > 0) {
    programs = reported;
    programsRemain = Math.min(reported, contentLaw) + Math.max(0, reported - contentLaw) * v.privacy_remains_share;
  } else {
    programs = gdpr + usp + contentLaw;
    programsRemain = contentLaw + (gdpr + usp) * v.privacy_remains_share;
  }
  const legal = engHoursYear("legal", inputs, v) * loadedHourly(v);
  const dsar = eu || uk || us ? mau * v.dsar_rate_per_mau_year * v.dsar_cost : 0;
  const breach = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.breach_cost_per_user);
  const breachRemains = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.retained_data_share * v.breach_cost_per_user);
  const parts = [
    part("privacy_programs", programs, programsRemain, { us_tier: usTier, reported: reported != null && reported > 0 }),
    part("legal_labour", legal, legal * v.privacy_remains_share, { defaulted: num(inputs.eng_legal) == null }),
    part("dsar", dsar, 0),
    part("insurance", v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part("breach", breach, breachRemains)
  ];
  return { parts };
}
function moderation(inputs, v) {
  const { mau } = inputs;
  const inhouse = num(inputs.mod_inhouse) ?? 0;
  const vendor = num(inputs.mod_vendor) ?? 0;
  let labour;
  let people;
  let implied = false;
  if (inhouse > 0 || vendor > 0) {
    labour = inhouse * loadedYear(v.ts_base_salary, v) + vendor * v.moderator_seat_outsourced;
    people = inhouse + vendor;
  } else {
    people = mau / 1e6 * v.mods_per_million_mau;
    labour = people * loadedYear(v.moderator_base_salary, v);
    implied = true;
  }
  const appeals = labour * v.appeals_share;
  const tooling = mau * v.ts_tooling_per_mau_year;
  const parts = [
    part("labour", labour, labour * v.moderation_remains_share, { implied, people }),
    part("appeals", appeals, appeals * v.moderation_remains_share),
    part("tooling", tooling, tooling)
  ];
  return { parts, implied };
}
function payments(inputs, v) {
  const rails = inputs.rails;
  if (!rails.length || !(inputs.rev > 0)) return { parts: [], none: true };
  const annual = inputs.rev * 12;
  const share = 1 / rails.length;
  const small = annual < v.store_small_threshold;
  const parts = [];
  for (const rail of rails) {
    const rev = annual * share;
    if (rail === "apple" || rail === "google") {
      const rate = rail === "apple" ? small ? v.apple_rate_small : v.apple_rate_standard : small ? v.google_rate_small : v.google_rate_standard;
      parts.push(part(`store_${rail}`, rev * rate, rev * rate, { rate, tier: small ? "small" : "standard", revenue: rev }));
    } else if (rail === "processor") {
      const fee = rev * v.processor_rate + rev / v.avg_ticket * v.processor_fixed;
      parts.push(part("processor", fee, rev * v.lightning_rate, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev }));
    } else if (rail === "reseller") {
      const fee = rev * v.reseller_rate + rev / v.avg_ticket * v.reseller_fixed;
      parts.push(part("reseller", fee, rev * v.lightning_rate, { rate: v.reseller_rate, fixed: v.reseller_fixed, revenue: rev }));
    } else {
      const fee = rev * v.lightning_rate;
      parts.push(part("p2p", fee, fee, { rate: v.lightning_rate, revenue: rev }));
    }
  }
  const holds = inputs.balances.includes("yes");
  parts.push(part("money_transmitter", holds ? v.mt_avoidance_year : 0, holds ? v.mt_avoidance_year * v.mt_remains_share : 0, { holds }));
  return { parts, tier: small ? "small" : "standard" };
}
var LINE_FN = { accounts, graph, storage, compliance, moderation, payments };
function evaluate(inputs, v) {
  const shares = nostrShares(inputs);
  const lines = {};
  let custodial = 0;
  let noncustodial = 0;
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v);
    const nc = sum(r.parts, "noncustodial");
    const full2 = sum(r.parts, "custodial");
    const share = Math.min(1, Math.max(0, shares[name]));
    const c = full2 - share * (full2 - nc);
    lines[name] = { ...r, custodial: c, noncustodial: nc, full: full2, share, already: share >= 0.999, partly: share > 0 && share < 0.999 };
    custodial += c;
    noncustodial += nc;
  }
  const { mau } = inputs;
  return {
    lines,
    shares,
    totals: {
      custodial,
      noncustodial,
      saving: custodial - noncustodial,
      per_mau_custodial: custodial / mau,
      per_mau_noncustodial: noncustodial / mau
    }
  };
}
function calculate(rawInputs, data, rawOverrides = {}) {
  const inputs = normalizeInputs(rawInputs);
  const overrides = cleanOverrides(data, rawOverrides);
  const out = { version: data.version, inputs, overrides };
  for (const s of SCENARIOS) out[s] = evaluate(inputs, resolveAssumptions(data, s, overrides));
  return out;
}

// assets/js/calculator/src/codec.js
var VERSION_KEY = "v";
var OVERRIDE_PREFIX = "a.";
var TEST_KEY = "test";
function encode2(inputs, overrides = {}, version = 1) {
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
  return p.toString();
}
function decode(search) {
  const p = new URLSearchParams(search);
  const inputs = {};
  const overrides = {};
  let present = false;
  for (const [key, v] of p.entries()) {
    if (key in INPUTS) {
      inputs[key] = v;
      present = true;
    } else if (key.startsWith(OVERRIDE_PREFIX)) {
      overrides[key.slice(OVERRIDE_PREFIX.length)] = v;
    }
  }
  const version = p.has(VERSION_KEY) ? Number(p.get(VERSION_KEY)) : null;
  const test2 = p.get(TEST_KEY);
  return { inputs, overrides, version, present, test: test2 };
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
  slider.setAttribute("aria-valuetext", label);
  const out = slider.closest(".slider-row")?.querySelector("output");
  if (out) out.textContent = label;
}
function readInputs(form2) {
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    const slider = $(`input[type="range"][name="${key}"]`, form2);
    if (slider) {
      out[key] = sliderValue(slider);
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
function writeContact(form2, contact = {}) {
  for (const key of CONTACT_KEYS) if (form2.elements[key] && contact[key] != null) form2.elements[key].value = String(contact[key]);
}
function writeInputs(form2, inputs) {
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (!(key in inputs) || inputs[key] == null) continue;
    const v = inputs[key];
    const slider = $(`input[type="range"][name="${key}"]`, form2);
    if (slider) {
      setSlider(slider, v);
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
function writeDefaults(form2, defaultHours = {}) {
  const starting = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === "multi" || (spec.type === "number" || spec.type === "integer") && spec.default != null) starting[key] = spec.default;
  }
  for (const [area, hours] of Object.entries(defaultHours)) starting[`eng_${area}`] = hours;
  writeInputs(form2, starting);
  for (const slider of $$('input[type="range"]', form2)) announceSlider(slider);
}
function wireSliders(form2) {
  for (const slider of $$('input[type="range"]', form2)) slider.addEventListener("input", () => announceSlider(slider));
}
function markInvalid(form2, key) {
  for (const node of $$(".is-invalid", form2)) node.classList.remove("is-invalid");
  if (!key) return;
  const wrap = $(`#field-${key}`, form2);
  if (wrap) wrap.classList.add("is-invalid");
  const input = $(`#f-${key}`, form2) || $(`input[name="${key}"]`, form2);
  input?.focus({ preventScroll: false });
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
async function inboxRelaysFor(pool, pubkey) {
  if (dev.local && dev.relays.length) {
    const relays2 = dedupe(dev.relays.map(normalizeRelay)).slice(0, MAX_RELAYS);
    if (relays2.length) return { relays: relays2, usedFallback: false };
  }
  const fallback = () => ({
    relays: dedupe(config.relays.fallback_dm.map(normalizeRelay)).slice(0, MAX_RELAYS),
    usedFallback: true
  });
  if (dev.no10050) return fallback();
  let event = null;
  try {
    event = await pool.get(
      config.relays.discovery,
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
function relaysFor(pointer, snapshot2) {
  const list = dev.local && dev.relays.length ? dev.relays : [...pointer.relays || [], ...snapshot2?.relays || [], ...config.relays.fallback_dm];
  return [...new Set(list.map(normalizeRelay).filter(Boolean))].slice(0, 8);
}
async function fetchResponse(pointer, snapshot2) {
  const pool = new SimplePool();
  try {
    const event = await pool.get(relaysFor(pointer, snapshot2), { ids: [pointer.id], kinds: [KIND_RESPONSE] }, { maxWait: config.timeouts.discovery });
    return event || null;
  } finally {
    pool.destroy();
  }
}
async function secretAsHolder(signer, snapshot2) {
  const pool = new SimplePool();
  try {
    const relays = [...new Set([...config.relays.discovery, ...snapshot2.relays || []].map(normalizeRelay).filter(Boolean))];
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
async function openResponse(event, { signer, snapshot: snapshot2, map: map2 }) {
  if (!event.content) return { tags: event.tags, values: readResponses(map2, event.tags), how: "plain" };
  if (signer) {
    if (signer.pubkey === event.pubkey) {
      try {
        const tags = JSON.parse(await signer.nip44Decrypt(snapshot2.pubkey, event.content));
        return { tags, values: readResponses(map2, tags), how: "responder" };
      } catch {
      }
    }
    const secret = await secretAsHolder(signer, snapshot2);
    if (secret) {
      try {
        const tags = JSON.parse(nip44Decrypt(event.content, getConversationKey(hexToBytes(secret), event.pubkey)));
        return { tags, values: readResponses(map2, tags), how: "holder" };
      } catch {
      }
    }
  }
  return { error: "restore_locked" };
}

// assets/js/calculator/src/format.js
var full = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
var cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
var plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
function money(n) {
  return full.format(Math.round(n));
}
function compact(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}k`;
  return full.format(Math.round(n));
}
function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function perMau(n) {
  return cents.format(n);
}
function percent(r) {
  return `${plain.format(r * 100)}%`;
}
function number(n) {
  return plain.format(n);
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
function clean(...arrays) {
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
    clean(this.buffer.subarray(pos));
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
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
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
function responseRelays(snapshot2) {
  if (dev.local && dev.relays.length) return dev.relays.map(normalizeRelay).filter(Boolean);
  const relays = snapshot2.relays.map(normalizeRelay).filter(Boolean);
  return relays.length ? relays : config.relays.fallback_dm.map(normalizeRelay).filter(Boolean);
}
async function submitResponse(form2, { signer, values, pow = 0, onProgress }) {
  const responses = buildResponses(form2.mapping, values);
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
  const relays = responseRelays(form2.snapshot);
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
  lines.push(fmt(t("compose.results"), { custodial: result.custodial, noncustodial: result.noncustodial }));
  lines.push(fmt(t("compose.link"), { link }));
  if (open) lines.push(fmt(t("compose.open"), { link: open }));
  lines.push("");
  for (const key of ["app_name", "company", "contact_name", "email"]) if (contact[key]) lines.push(`${fieldLabels[key]?.label || key}: ${contact[key]}`);
  return lines.join("\n").trim();
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

// assets/js/calculator/src/ui.js
var range = (low, high) => fmt(t("range_short"), { low: compact(low), high: compact(high) });
function renderResults(result) {
  const { typical, low, high, inputs } = result;
  const T = typical.totals;
  text("#r-hero", compact(T.custodial));
  text("#r-hero-range", fmt(t("range"), { low: compact(low.totals.custodial), high: compact(high.totals.custodial) }));
  text("#r-nc", compact(T.noncustodial));
  text("#r-nc-range", range(low.totals.noncustodial, high.totals.noncustodial));
  text("#r-permau", perMau(T.per_mau_custodial));
  text("#r-permau-pair", fmt(t("per_mau_pair"), { custodial: perMau(T.per_mau_custodial), noncustodial: perMau(T.per_mau_noncustodial) }));
  text("#r-saving", compact(T.saving));
  text("#r-saving-range", range(low.totals.saving, high.totals.saving));
  text("#r-version", fmt(t("version"), { version: result.version }));
  const scale = Math.max(...LINES.map((l) => typical.lines[l].custodial), 1);
  for (const name of LINES) {
    const line = typical.lines[name];
    const row = $(`.lt-row[data-line="${name}"]`);
    if (!row) continue;
    row.classList.toggle("is-already", Boolean(line.already));
    row.classList.toggle("is-none", Boolean(line.none));
    show($(".lt-flag--already", row), Boolean(line.already));
    show($(".lt-flag--partly", row), Boolean(line.partly));
    show($(".lt-flag--implied", row), Boolean(line.implied));
    show($(".lt-flag--none", row), Boolean(line.none));
    const c = $(".lt-value--c", row);
    const nc = $(".lt-value--nc", row);
    c.textContent = money(line.custodial);
    nc.textContent = money(line.noncustodial);
    c.nextElementSibling.textContent = line.none ? "" : range(low.lines[name].custodial, high.lines[name].custodial);
    nc.nextElementSibling.textContent = line.none ? "" : range(low.lines[name].noncustodial, high.lines[name].noncustodial);
    $(".bar--c", row).style.setProperty("--w", `${100 * line.custodial / scale}%`);
    $(".bar--nc", row).style.setProperty("--w", `${100 * line.noncustodial / scale}%`);
    renderParts(name, line, inputs);
  }
}
function renderParts(name, line, inputs) {
  const host = $(`.lt-parts[data-line="${name}"] .parts`);
  if (!host) return;
  clear(host);
  for (const p of line.parts) {
    const meta = partMeta(p, inputs);
    host.append(
      el("li", { class: "part" }, [
        el("span", { class: "part__label" }, [
          t(`parts.${p.id}`, p.id),
          meta ? el("span", { class: "part__meta", text: meta }) : null
        ]),
        el("span", { class: "part__nums" }, [
          money(p.custodial),
          " \u2192 ",
          el("b", { text: money(p.noncustodial) })
        ])
      ])
    );
  }
}
function partMeta(p, inputs) {
  if (p.id.startsWith("store_")) return `${fmt(t("details.rate"), { rate: percent(p.rate) })} \xB7 ${t(`details.tier_${p.tier}`)}`;
  if (p.id === "processor") return fmt(t("details.rate"), { rate: percent(p.rate) });
  if (p.id === "verify" && p.rate != null) return fmt(t("details.rate"), { rate: percent(p.rate) });
  if (p.id === "privacy_programs") return p.reported ? t("details.reported") : p.us_tier ? t(`details.us_${p.us_tier}`) : "";
  if (p.id === "labour" && p.people != null) return fmt(t("details.people"), { n: number(p.people) });
  if (p.id === "money_transmitter" && p.holds) return t("details.holds");
  if ((p.id === "engineering" || p.id === "legal_labour") && p.defaulted) return t("details.defaulted");
  if ((p.id === "reseller" || p.id === "p2p") && p.rate != null) return fmt(t("details.rate"), { rate: percent(p.rate) });
  if (p.id === "database" && p.gb != null) return fmt(t("details.gb"), { gb: number(p.gb) });
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
    });
  }
}
var TABS = ["cost", "app", "assumptions"];
function activateTab(name, { focus = false } = {}) {
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
  if (focus) {
    $(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    $(`#tab-${name}`)?.focus({ preventScroll: true });
  }
}
function wireTabs(onSelect) {
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
function showResults(visible, { focus = false } = {}) {
  const panel = $("#calc-results");
  if (!panel) return;
  panel.hidden = !visible;
  const empty = $("#r-empty");
  if (empty) empty.hidden = visible;
  if (visible) {
    activateTab("cost");
    if (focus) {
      $(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#results-title")?.focus({ preventScroll: true });
    }
  }
}
function setStatus2(message) {
  const node = $("#r-status");
  if (node) node.textContent = message || "";
}
function setError2(code, fieldLabel) {
  const node = $("#calc-error");
  if (!node) return;
  const message = code ? fmt(t(`errors.${code}`) || t("errors.unknown"), { field: fieldLabel || "" }) : "";
  node.textContent = message;
  show(node, Boolean(message));
}
function readOverrides() {
  const out = {};
  for (const input of $$(".assume-input")) {
    const typical = Number(input.dataset.typical);
    const v = input.value.trim();
    if (v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n === typical) continue;
    out[input.dataset.key] = n;
  }
  return out;
}
function writeOverrides(overrides = {}) {
  for (const input of $$(".assume-input")) {
    const key = input.dataset.key;
    input.value = key in overrides ? String(overrides[key]) : input.dataset.typical;
  }
  markChanged();
}
function markChanged() {
  for (const input of $$(".assume-input")) {
    const changed = input.value.trim() !== "" && Number(input.value) !== Number(input.dataset.typical);
    input.closest("tr")?.classList.toggle("is-changed", changed);
  }
}
function text(sel, value) {
  const node = $(sel);
  if (node) node.textContent = value;
}

// assets/js/calculator/src/app.js
var assumptions = readJson("page-assumptions");
var snapshot = readJson("page-form");
var map = readJson("page-map");
var form = prepareForm(snapshot, map);
var current = null;
var dirty = false;
var test = null;
var openedAt = Date.now();
var sends = [];
var lastLead = "";
var signIn = null;
var session = null;
var pendingSave = false;
var pendingOpen = null;
var syncTimer = null;
function labelFor(key) {
  const node = document.querySelector(`#field-${key} .field__label, label[for="f-${key}"]`);
  return node ? node.textContent.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim() : key;
}
function run(raw, overrides, { focus = true } = {}) {
  let result;
  try {
    result = calculate(raw, assumptions, overrides);
  } catch (err) {
    if (err instanceof InputError) {
      activateTab("app");
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
  renderResults(result);
  const query2 = encode2(result.inputs, result.overrides, result.version);
  result.link = `${location.origin}${location.pathname}?${query2}`;
  history.replaceState(null, "", `?${query2}${test ? `&test=${encodeURIComponent(test)}` : ""}`);
  const contact = $("#r-contact");
  if (contact) contact.href = `${config.contact_href}?${new URLSearchParams({ subject: t("contact_subject"), calc: query2 })}`;
  showResults(true, { focus });
  return result;
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
}
function currentQuery() {
  try {
    const inputs = normalizeInputs(readInputs($("#calc-form")));
    return encode2(inputs, cleanOverrides(assumptions, readOverrides()), assumptions.version) + (test ? `&test=${encodeURIComponent(test)}` : "");
  } catch {
    return null;
  }
}
function syncUrl() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const query2 = currentQuery();
    if (query2) history.replaceState(null, "", `?${query2}`);
  }, 120);
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
    mau: i.mau,
    posts_per_user: i.posts_per_user,
    mb: i.mb,
    engineering: grid("engineering", "eng_"),
    moderation: grid("moderation", "mod_"),
    legal_usd: i.legal_usd ?? "",
    rails: i.rails,
    rev: i.rev,
    balances: i.balances,
    distribution: i.distribution,
    jur: i.jur,
    nostr: grid("nostr", "n_"),
    result_custodial: Math.round(T.custodial),
    result_noncustodial: Math.round(T.noncustodial),
    link: result.link,
    overrides: Object.keys(result.overrides).length ? JSON.stringify(result.overrides) : "",
    version: String(result.version),
    ...contact,
    test: test || ""
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
  try {
    const { event, ok, relays } = await submitResponse(form, {
      signer,
      values: valuesFor(result, contact),
      pow,
      onProgress: ({ tries }) => status.textContent = fmt(t("status.mining"), { hashes: tries })
    });
    sends.push(Date.now());
    status.textContent = ok ? fmt(t("modal.saved"), { ok, total: relays.length, id: event.id.slice(0, 12) }) : t("status.failed");
    setStatus2(status.textContent);
    if (ok) {
      const hint = relays.find((r) => r.ok)?.url;
      const nevent = neventEncode({ id: event.id, relays: hint ? [hint] : [], author: event.pubkey });
      await tell(signer, result, contact, `${location.origin}${location.pathname}?nevent=${nevent}`);
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
  const content = composeLead({
    inputs: result.inputs,
    result: { custodial: compact(result.typical.totals.custodial), noncustodial: compact(result.typical.totals.noncustodial) },
    link: result.link,
    contact,
    fieldLabels: Object.fromEntries([...Object.keys(result.inputs), ...Object.keys(contact)].map((k) => [k, { label: labelFor(k) }])),
    open
  });
  try {
    await sendLead({ signer, recipient, subject: t("compose.subject"), content, pow: dev.noPow ? 0 : signer.kind === "session" ? config.pow.anonymous : config.pow.signed });
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
  const event = await fetchResponse(pointer, snapshot);
  if (!event) return setStatus2(t("errors.restore_missing"));
  const opened = await openResponse(event, { signer, snapshot, map });
  if (opened.error) return setStatus2(t(`errors.${opened.error}`));
  const v = opened.values;
  const inputs = { mau: v.mau, posts_per_user: v.posts_per_user, mb: v.mb, legal_usd: v.legal_usd, rev: v.rev, rails: v.rails, balances: v.balances, distribution: v.distribution, jur: v.jur };
  for (const [area, hours] of Object.entries(v.engineering || {})) inputs[`eng_${area}`] = hours;
  for (const [row, n] of Object.entries(v.moderation || {})) inputs[`mod_${row}`] = n;
  for (const [row, share] of Object.entries(v.nostr || {})) inputs[`n_${row}`] = share;
  let overrides = {};
  try {
    overrides = v.overrides ? JSON.parse(v.overrides) : {};
  } catch {
    overrides = {};
  }
  const formEl = $("#calc-form");
  writeInputs(formEl, inputs);
  writeOverrides(overrides);
  writeContact(formEl, Object.fromEntries(CONTACT_KEYS.map((k) => [k, v[k]])));
  if (v.test) test = v.test;
  const result = run(inputs, overrides, { focus: false });
  if (result) setStatus2(fmt(t("status.opened"), { when: new Date(event.created_at * 1e3).toLocaleString(), how: t(`status.opened_${opened.how}`) }));
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
function wire() {
  $("#calc-form")?.addEventListener("submit", onCalculate);
  $("#r-edit")?.addEventListener("click", onEdit);
  $("#a-reset")?.addEventListener("click", onReset);
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
  const A = assumptions.assumptions;
  writeDefaults(formEl, {
    accounts: A.default_hours_accounts.typical,
    content: A.default_hours_content.typical,
    infra: A.default_hours_infra.typical,
    legal: A.default_hours_legal.typical
  });
  const opened = decode(location.search);
  test = opened.test;
  const pointer = decodePointer(new URLSearchParams(location.search).get("nevent"));
  if (pointer) {
    if (opened.present) {
      writeInputs(formEl, opened.inputs);
      writeOverrides(opened.overrides);
    }
    run(readInputs(formEl), readOverrides(), { focus: false });
  } else if (opened.present) {
    writeInputs(formEl, opened.inputs);
    writeOverrides(opened.overrides);
    const result = run(opened.inputs, opened.overrides, { focus: false });
    if (result) setStatus2(t("status.shared"));
    else activateTab("app");
  } else {
    const result = run(readInputs(formEl), readOverrides(), { focus: false });
    if (result) history.replaceState(null, "", location.pathname);
  }
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
