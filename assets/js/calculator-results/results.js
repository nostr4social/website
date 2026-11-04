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
function show(node, visible2) {
  node.hidden = !visible2;
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
  verifyEvent,
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
  const relays2 = url.searchParams.getAll("relay").filter(isRelayUrl);
  if (!relays2.length) throw new SignerError("bunker_no_relay");
  return { pubkey, relays: relays2, secret: url.searchParams.get("secret") };
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
  const relays2 = config.relays.nip46;
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: relays2,
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
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// assets/js/shared/src/relays.js
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
function qrSvg(text, { label, margin = 2 } = {}) {
  const { data, size } = encode(text, { ecc: "M", border: margin });
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
  function show3(mode) {
    const guest = $("#sign-guest");
    const signed = $("#sign-signed");
    if (guest && !guest.closest("dialog")) guest.hidden = mode !== "guest";
    if (signed) signed.hidden = mode !== "signed";
  }
  async function adopt(next) {
    signer = next;
    profileName = null;
    renderIdentity(signer, null);
    show3("signed");
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
    show3("guest");
    onChange?.(null);
  }
  function wire() {
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
    show3("guest");
  }
  return {
    wire,
    markExtension,
    signOut,
    current: () => signer,
    profileName: () => profileName
  };
}

// assets/js/shared/src/forms.js
var KIND_FORM = 30168;
var KIND_RESPONSE = 1069;
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
      const rows2 = flip(f.rows);
      const cols = flip(f.columns);
      const out = {};
      for (const [rid, cid] of Object.entries(cells || {})) if (rows2[rid] && cols[cid] != null) out[rows2[rid]] = cols[cid];
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

// assets/js/shared/src/policy.js
function powOf(id) {
  let count = 0;
  for (let i = 0; i < id.length; i++) {
    const nibble = parseInt(id[i], 16);
    if (Number.isNaN(nibble)) return count;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}
function fingerprintOf(answers) {
  if (!Array.isArray(answers)) return null;
  const pairs = answers.filter((t2) => Array.isArray(t2) && t2[0] === "response").map((t2) => [String(t2[1]), String(t2[2] ?? "")]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify(pairs);
}
function screenResponses(rows2, { address: address2, minPow = 0, known: known2 = /* @__PURE__ */ new Set(), verify = () => true, testId = null, testOption = null } = {}) {
  const kept = [];
  const dropped2 = [];
  const byPrint = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const e = row.event;
    if (!e || !Array.isArray(e.tags) || !e.tags.some((t2) => t2[0] === "a" && t2[1] === address2)) {
      dropped2.push({ event: e, reason: "not addressed to this form" });
      continue;
    }
    let valid = false;
    try {
      valid = Boolean(verify(e));
    } catch {
      valid = false;
    }
    if (!valid) {
      dropped2.push({ event: e, reason: "signature does not check" });
      continue;
    }
    const label = known2.has(e.pubkey) ? "signed-in" : "unverified";
    const pow = powOf(e.id);
    if (label === "unverified" && pow < minPow) {
      dropped2.push({ event: e, reason: `proof of work ${pow} below ${minPow}` });
      continue;
    }
    const test = Boolean(testId && Array.isArray(row.answers) && row.answers.some((t2) => t2[0] === "response" && t2[1] === testId && (testOption ? String(t2[2]).split(";").includes(testOption) : Boolean(t2[2]))));
    const out = { event: e, answers: row.answers ?? null, label, pow, test, fingerprint: fingerprintOf(row.answers) };
    if (out.fingerprint != null) {
      const seen = byPrint.get(out.fingerprint);
      if (seen) {
        const [older, newer] = seen.event.created_at >= e.created_at ? [out, seen] : [seen, out];
        dropped2.push({ event: older.event, reason: `duplicate of ${newer.event.id.slice(0, 12)}` });
        if (newer === out) {
          kept[kept.indexOf(seen)] = out;
          byPrint.set(out.fingerprint, out);
        }
        continue;
      }
      byPrint.set(out.fingerprint, out);
    }
    kept.push(out);
  }
  kept.sort((a, b) => b.event.created_at - a.event.created_at);
  return { kept, dropped: dropped2 };
}

// assets/js/calculator/src/restore.js
async function secretAsHolder(signer, snapshot2) {
  const pool = new SimplePool();
  try {
    const relays2 = discoveryRelays();
    const list = await pool.get(relays2, { kinds: [KIND_MY_FORMS], authors: [signer.pubkey] }, { maxWait: config.timeouts.discovery });
    if (!list) return null;
    const json = JSON.parse(await signer.nip44Decrypt(signer.pubkey, list.content));
    return formSecretFromList(json, snapshot2);
  } catch {
    return null;
  } finally {
    pool.destroy();
  }
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
  const last = Math.ceil(months / 12);
  for (let year = 1; year <= last; year++) {
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
function pointAt(months, inputs, v, today, base = null, date2 = addMonths(today, months)) {
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
function project(inputs, v, today, base = evaluate(inputs, v)) {
  const points = [];
  for (let year = 0; year <= YEARS; year++) points.push(pointAt(year * 12, inputs, v, today, base));
  return points;
}
function calculate(rawInputs, data, rawOverrides = {}, { today } = {}) {
  if (!isDate(today)) throw new Error("calculate: today must be an ISO date (YYYY-MM-DD)");
  const inputs = normalizeInputs(rawInputs);
  const clamped = [];
  const overrides = cleanOverrides(data, rawOverrides, clamped);
  const out = { version: data.version, today, inputs, overrides, clamped };
  for (const s of SCENARIOS) {
    const resolved = resolveAssumptions(data, s, overrides);
    const { values: v, set } = applyKind(resolved, inputs.kind, overrides);
    const eff = deriveInputs(inputs, v);
    Object.assign(eff.derived, set);
    const r = evaluate(eff, v);
    r.effective = eff;
    r.derived = eff.derived;
    r.values = v;
    r.projection = project(eff, v, today, r);
    const payback = Math.max(0, v.integration_payback_months);
    const estimatedAt = payback + Math.max(0, v.estimated_savings_months);
    const matureIn = monthsBetween(today, v.network_mature_end);
    r.markers = {
      // The integration wedge ends here: nothing in it is summed or estimated.
      payback: { months: payback, point: pointAt(payback, eff, v, today, r) },
      // The headline instant.
      estimated: { months: estimatedAt, point: pointAt(estimatedAt, eff, v, today, r) },
      // The network's date, on the app's timeline: before today it is "since".
      mature: { date: v.network_mature_end, months: matureIn, since: !(matureIn > 0), point: matureIn > 0 ? pointAt(matureIn, eff, v, today, r, v.network_mature_end) : null }
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

// assets/js/calculator-results/src/app.js
var snapshot = readJson("page-form");
var map = readJson("page-map");
var versions = readJson("page-assumptions-all");
var address = formAddress(snapshot);
var signIn = null;
var decrypted = [];
var known = /* @__PURE__ */ new Set();
var rows = [];
var dropped = [];
function relays() {
  if (dev.local && dev.relays.length) return [...new Set(dev.relays.map(normalizeRelay).filter(Boolean))];
  return siteRelays();
}
function status(message) {
  const node = $("#inbox-status");
  if (node) node.textContent = message || "";
}
async function opener(signer) {
  if (signer.pubkey === snapshot.pubkey) return (event) => signer.nip44Decrypt(event.pubkey, event.content);
  const secret = await secretAsHolder(signer, snapshot);
  if (!secret) return null;
  const key = hexToBytes(secret);
  return async (event) => nip44Decrypt(event.content, getConversationKey(key, event.pubkey));
}
function inputsOf(v) {
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
  return inputs;
}
function dateOf(v, event) {
  try {
    const t2 = new URL(v.link).searchParams.get("t");
    if (t2 && /^\d{4}-\d{2}-\d{2}$/.test(t2)) return t2;
  } catch {
  }
  return new Date(event.created_at * 1e3).toISOString().slice(0, 10);
}
function headlineOf(v, event) {
  const version = Number(v.version);
  const data = versions[String(version)];
  if (data) {
    try {
      let overrides = {};
      try {
        const parsed = v.overrides ? JSON.parse(v.overrides) : {};
        overrides = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        overrides = {};
      }
      const r = calculate(inputsOf(v), data, overrides, { today: dateOf(v, event) });
      return { value: r.typical.totals.estimated, text: approx(r.typical.totals.estimated), inputs: r.inputs };
    } catch {
    }
  }
  const custodial = Number(v.result_custodial);
  const nostr = Number(v.result_noncustodial);
  const value = Number.isFinite(custodial) && Number.isFinite(nostr) ? custodial - nostr : NaN;
  return { value, text: Number.isFinite(custodial) ? fmt(t("row.saved"), { custodial: approx(custodial), nostr: approx(nostr), version: Number.isFinite(version) ? version : "?" }) : t("row.none"), inputs: null };
}
async function load(signer) {
  status(t("status.connecting"));
  const open = await opener(signer);
  if (!open) {
    status(t("status.wrong_key"));
    return show2([], []);
  }
  const pool = new SimplePool();
  let events = [];
  let profiles = [];
  try {
    events = await pool.querySync(relays(), { kinds: [KIND_RESPONSE], "#a": [address] }, { maxWait: config.timeouts.discovery * 2 });
    const seen = /* @__PURE__ */ new Map();
    for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
    events = [...seen.values()];
    const authors = [...new Set(events.map((e) => e.pubkey))];
    if (authors.length) {
      const where = dev.local && dev.relays.length ? relays() : discoveryRelays();
      profiles = await pool.querySync(where, { kinds: [0], authors }, { maxWait: config.timeouts.profile }).catch(() => []);
    }
  } finally {
    pool.destroy();
  }
  known = new Set(profiles.map((p) => p.pubkey));
  decrypted = [];
  for (const event of events) {
    let answers = null;
    try {
      const list = JSON.parse(await open(event));
      answers = Array.isArray(list) ? list : null;
    } catch {
      answers = null;
    }
    decrypted.push({ event, answers });
  }
  screen();
}
function screen() {
  const required = $("#inbox-pow") ? $("#inbox-pow").checked : true;
  const screened = screenResponses(decrypted, { address, minPow: required ? Number(config.pow?.response ?? 0) : 0, known, verify: verifyEvent, testId: map.fields.test?.id, testOption: map.fields.test?.options?.yes });
  const kept = screened.kept.map((k) => {
    const v = k.answers ? readResponses(map, k.answers) : {};
    const headline = headlineOf(v, k.event);
    const one = (x) => Array.isArray(x) ? x[0] : x;
    return {
      id: k.event.id,
      version: Number(v.version) || 0,
      date: new Date(k.event.created_at * 1e3),
      test: k.test,
      tier: k.label,
      name: v.contact_name || "",
      email: v.email || "",
      kind: one(v.kind) || "",
      mau: Number(v.mau) || 0,
      team: one(v.team) || "",
      regions: Array.isArray(v.jur) ? v.jur : [],
      volume: Number(v.p2p_volume ?? v.rev) || 0,
      savings: headline.value,
      savingsText: headline.text,
      link: v.link || "",
      undecryptable: !k.answers
    };
  });
  const refused = screened.dropped.map((d) => ({ id: d.event?.id?.slice(0, 12) || "?", reason: d.reason }));
  for (const k of kept) if (k.undecryptable) refused.push({ id: k.id.slice(0, 12), reason: "undecryptable" });
  show2(kept.filter((k) => !k.undecryptable), refused);
}
var RECENT = Math.min(...Object.keys(versions).map(Number).filter(Number.isFinite), 4);
function versionOptions() {
  const select = $("#inbox-version");
  if (!select) return;
  const chosen = select.value || "recent";
  clear(select);
  select.append(el("option", { value: "recent", text: fmt(select.dataset.recent, { n: RECENT }) }));
  select.append(el("option", { value: "all", text: select.dataset.all }));
  for (const n of [...new Set(rows.map((r) => r.version))].filter((n2) => n2 > 0).sort((a, b) => b - a)) select.append(el("option", { value: String(n), text: fmt(select.dataset.one, { n }) }));
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : "recent";
}
function show2(kept, refused) {
  rows = kept;
  dropped = refused;
  $("#inbox-tools").hidden = false;
  versionOptions();
  render();
}
function visible() {
  const mode = $("#inbox-mode")?.value || "live";
  const tier = $("#inbox-tier")?.value || "all";
  const contact = $("#inbox-contact")?.checked;
  const sort = $("#inbox-sort")?.value || "date";
  const version = $("#inbox-version")?.value || "recent";
  const byVersion = (r) => version === "all" ? true : version === "recent" ? r.version >= RECENT : r.version === Number(version);
  const out = rows.filter((r) => byVersion(r) && (mode === "all" || mode === "test" === r.test) && (tier === "all" || r.tier === tier) && (!contact || r.email || r.name));
  out.sort((a, b) => sort === "savings" ? (Number.isFinite(b.savings) ? b.savings : -1) - (Number.isFinite(a.savings) ? a.savings : -1) : b.date - a.date);
  return out;
}
function render() {
  const list = visible();
  const body = $("#inbox-rows");
  const table = $("#inbox-table");
  const count = $("#inbox-count");
  if (!body || !table || !count) return;
  clear(body);
  for (const r of list) {
    const cells = [
      el("td", { text: r.date.toISOString().slice(0, 16).replace("T", " ") }),
      el("td", { text: r.version ? `v${r.version}` : "" }),
      el("td", { text: r.test ? t("row.yes") : t("row.no") }),
      el("td", { text: t(`row.${r.tier === "signed-in" ? "signed" : "unverified"}`) }),
      el("td", { text: r.name }),
      el("td", { text: r.email }),
      el("td", { text: r.kind ? t(`kind.${r.kind}`, r.kind) : "" }),
      el("td", { class: "is-num", text: r.mau ? r.mau.toLocaleString("en-US") : "" }),
      el("td", { text: r.team ? t(`team.${r.team}`, r.team) : "" }),
      el("td", { text: r.regions.map((j) => j.toUpperCase()).join(", ") }),
      el("td", { class: "is-num", text: r.volume ? approx(r.volume) : "" }),
      el("td", { class: "is-num", text: r.savingsText }),
      el("td", {}, r.link ? [el("a", { href: r.link, text: t("row.open"), rel: "noopener" })] : [])
    ];
    body.append(el("tr", { class: r.test ? "is-test" : null, "data-id": r.id }, cells));
  }
  table.hidden = list.length === 0;
  count.hidden = false;
  count.textContent = rows.length === 0 && dropped.length === 0 ? t("status.none") : fmt(t("status.count"), { shown: list.length, kept: rows.length, dropped: dropped.length });
  const details = $("#inbox-dropped");
  if (details) {
    details.hidden = dropped.length === 0;
    $("#inbox-dropped-summary").textContent = `${t("status.dropped")} (${dropped.length})`;
    const ul = $("#inbox-dropped-list");
    clear(ul);
    for (const d of dropped) ul.append(el("li", { text: fmt(t("status.reason"), d) }));
  }
  status("");
}
function csv() {
  const head = $$("#inbox-table thead th").map((th) => th.textContent);
  const quote = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(quote).join(",")];
  for (const r of visible()) {
    lines.push([r.date.toISOString(), r.version || "", r.test ? "yes" : "no", r.tier, r.name, r.email, r.kind, r.mau || "", r.team, r.regions.join(" "), r.volume || "", Number.isFinite(r.savings) ? Math.round(r.savings) : "", r.link].map(quote).join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: t("csv_name") });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
  return lines;
}
function onSigner(signer) {
  const dialog = $("#sign-modal");
  if (dialog?.open) dialog.close();
  if (!signer) {
    decrypted = [];
    rows = [];
    dropped = [];
    $("#inbox-tools").hidden = true;
    $("#inbox-table").hidden = true;
    $("#inbox-count").hidden = true;
    $("#inbox-dropped").hidden = true;
    status(t("status.signed_out"));
    return;
  }
  load(signer).catch((err) => {
    console.warn("results: could not load", err);
    status(t("status.wrong_key"));
  });
}
async function boot() {
  if (!$("#inbox")) return;
  status(t("status.signed_out"));
  signIn = createSignIn({ onChange: onSigner });
  signIn.wire();
  signIn.markExtension(await detectNip07());
  $("#inbox-sign-open")?.addEventListener("click", () => {
    const dialog = $("#sign-modal");
    if (dialog && !dialog.open) dialog.showModal();
  });
  $("#sign-cancel")?.addEventListener("click", () => $("#sign-modal")?.close());
  for (const id of ["inbox-version", "inbox-mode", "inbox-tier", "inbox-contact", "inbox-sort"]) $(`#${id}`)?.addEventListener("change", render);
  $("#inbox-pow")?.addEventListener("change", () => decrypted.length && screen());
  $("#inbox-csv")?.addEventListener("click", csv);
  window.__inboxCsv = () => {
    const head = $$("#inbox-table thead th").map((th) => th.textContent);
    return [head.join(","), ...visible().map((r) => [r.date.toISOString(), r.version, r.test ? "yes" : "no", r.tier, r.email, r.mau, Math.round(r.savings) || ""].join(","))].join("\n");
  };
  document.documentElement.dataset.results = "ready";
}
boot();
