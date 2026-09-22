// assets/js/contact/src/dom.js
var $ = (sel, root = document) => root.querySelector(sel);
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

// assets/js/contact/src/config.js
function readJson(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing config block: ${id}`);
  return JSON.parse(node.textContent);
}
var strings = readJson("contact-strings");
var config = readJson("contact-config");
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
    no10050: params.has("no10050")
  };
})();

// assets/js/contact/src/vendor.js
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  SimplePool,
  decodeNip19,
  npubEncode,
  getConversationKey,
  nip44Encrypt,
  BunkerSigner,
  createNostrConnectURI
} from "/assets/js/vendor/nostr-tools/nostr-tools-2.25.2.esm.min.js";
import { encode } from "/assets/js/vendor/uqr/uqr-0.1.3.esm.min.js";

// assets/js/contact/src/recipients.js
var HEX64 = /^[0-9a-f]{64}$/;
var RecipientError = class extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
};
function toPubkey(value) {
  if (HEX64.test(value)) return value;
  if (typeof value === "string" && value.startsWith("npub1")) {
    try {
      const { type, data } = decodeNip19(value);
      if (type === "npub" && HEX64.test(data)) return data;
    } catch {
      return null;
    }
  }
  return null;
}
async function loadRecipients() {
  if (dev.local && dev.to) {
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

// assets/js/contact/src/relays.js
var KIND_DM_RELAYS = 10050;
var MAX_RELAYS = 5;
function normalizeRelay(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== "wss:") return null;
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

// assets/js/contact/src/nip17.js
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
function wrapFor(seal, targetPubkey, relayHint) {
  const ephemeralKey = generateSecretKey();
  const conversationKey = getConversationKey(ephemeralKey, targetPubkey);
  const wrap = finalizeEvent(
    {
      kind: KIND_WRAP,
      created_at: jitteredTimestamp(),
      tags: [relayHint ? ["p", targetPubkey, relayHint] : ["p", targetPubkey]],
      content: nip44Encrypt(JSON.stringify(seal), conversationKey)
    },
    ephemeralKey
  );
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

// assets/js/contact/src/state.js
function createStore(initial) {
  let state = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
var initialState = {
  phase: "boot",
  hasNip07: false,
  recipients: [],
  signer: null,
  error: null,
  connect: null,
  // { uri, authUrl }
  progress: null,
  // { done, total, label }
  results: null,
  // [{ name, pubkey, relays: [{url, ok, reason}], usedFallback, wrapId }]
  verdict: null,
  // success | partial | failure
  sends: []
  // timestamps, for the per-tab rate limit
};
async function bootRecipients(store2) {
  store2.set({ phase: "loading_recipients", error: null });
  try {
    const recipients = await loadRecipients();
    store2.set({ recipients, phase: "choose_method" });
  } catch (err) {
    store2.set({ phase: "unavailable", error: err.code || "recipients_unavailable" });
  }
}
function rateLimited(store2) {
  const { window: windowMs, max } = config.limits.rate;
  const cutoff = Date.now() - windowMs;
  const recent = store2.get().sends.filter((t2) => t2 > cutoff);
  store2.set({ sends: recent });
  return recent.length >= max;
}
function noteSend(store2) {
  store2.set({ sends: [...store2.get().sends, Date.now()] });
}
async function send(store2, { subject, content, onProgress }) {
  const { signer, recipients } = store2.get();
  const pool = new SimplePool();
  const targets = recipients.map((r) => ({ ...r, self: false }));
  if (signer.kind !== "guest" && !recipients.some((r) => r.pubkey === signer.pubkey)) {
    targets.push({ name: t("result.self_copy", "you"), pubkey: signer.pubkey, self: true });
  }
  const rumor = buildRumor({
    senderPubkey: signer.pubkey,
    recipients: recipients.map((r) => ({ pubkey: r.pubkey })),
    subject,
    content
  });
  const results = [];
  try {
    for (const [index, target] of targets.entries()) {
      onProgress?.({ step: "resolving", index, total: targets.length, name: target.name });
      const { relays, usedFallback } = await inboxRelaysFor(pool, target.pubkey);
      onProgress?.({ step: "encrypting", index, total: targets.length, name: target.name });
      const seal = await sealFor(signer, rumor, target.pubkey);
      const { wrap, ephemeralKey } = wrapFor(seal, target.pubkey, relays[0]);
      onProgress?.({ step: "publishing", index, total: targets.length, name: target.name });
      let relayResults;
      try {
        relayResults = await publishWrap(pool, relays, wrap, ephemeralKey, {
          maxWait: config.timeouts.publish
        });
      } finally {
        ephemeralKey.fill(0);
      }
      results.push({
        name: target.name,
        pubkey: target.pubkey,
        self: target.self,
        relays: relayResults,
        usedFallback,
        wrapId: wrap.id,
        // Kept so a retry can re-wrap and re-publish without asking the signer
        // to approve anything a second time. The seal is already signed; only
        // the throwaway wrapping key is made again.
        seal
      });
    }
  } finally {
    pool.destroy();
  }
  return { results, verdict: verdictFor(results) };
}
function verdictFor(results) {
  const real = results.filter((r) => !r.self);
  const delivered = real.filter((r) => r.relays.some((relay) => relay.ok));
  if (!real.length || delivered.length === real.length) return "success";
  return delivered.length ? "partial" : "failure";
}
async function retry(store2, previous, { onProgress } = {}) {
  const pool = new SimplePool();
  const results = previous.map((r) => ({ ...r }));
  try {
    for (const [index, result] of results.entries()) {
      if (result.relays.some((relay) => relay.ok)) continue;
      onProgress?.({ step: "publishing", index, total: results.length, name: result.name });
      const { relays, usedFallback } = await inboxRelaysFor(pool, result.pubkey);
      const { wrap, ephemeralKey } = wrapFor(result.seal, result.pubkey, relays[0]);
      try {
        result.relays = await publishWrap(pool, relays, wrap, ephemeralKey, {
          maxWait: config.timeouts.publish
        });
      } finally {
        ephemeralKey.fill(0);
      }
      result.usedFallback = usedFallback;
      result.wrapId = wrap.id;
    }
  } finally {
    pool.destroy();
  }
  return { results, verdict: verdictFor(results) };
}

// assets/js/contact/src/signers.js
var SignerError = class extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
};
var HEX642 = /^[0-9a-f]{64}$/;
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
  if (!HEX642.test(pubkey)) throw new SignerError("nip07_bad_pubkey");
  return {
    kind: "nip07",
    pubkey,
    signEvent: (template) => window.nostr.signEvent(template),
    nip44Encrypt: (target, plaintext) => nip44.encrypt(target, plaintext),
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
  if (!HEX642.test(pubkey)) throw new SignerError("bunker_bad_pubkey");
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
  if (!HEX642.test(pubkey)) {
    wipe(clientSecretKey);
    throw new SignerError("nip46_bad_pubkey");
  }
  return {
    kind: "nip46",
    pubkey,
    signEvent: (template) => signer.signEvent(template),
    nip44Encrypt: (target, plaintext) => signer.nip44Encrypt(target, plaintext),
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
function createGuestSigner() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  let open = true;
  const assertOpen = () => {
    if (!open) throw new SignerError("guest_closed");
  };
  return {
    kind: "guest",
    pubkey,
    async signEvent(template) {
      assertOpen();
      return finalizeEvent(template, secretKey);
    },
    async nip44Encrypt(target, plaintext) {
      assertOpen();
      return nip44Encrypt(plaintext, getConversationKey(secretKey, target));
    },
    close() {
      open = false;
      wipe(secretKey);
    }
  };
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// assets/js/contact/src/qr.js
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

// assets/js/contact/src/ui.js
var PANELS = ["methods", "nip46", "compose", "sending", "result", "unavailable"];
function panels() {
  const found = {};
  for (const name of PANELS) found[name] = $(`#panel-${name}`);
  return found;
}
function showPanel(name) {
  for (const panel of PANELS) {
    const node = $(`#panel-${panel}`);
    if (node) show(node, panel === name);
  }
  const heading = $(`#panel-${name} h2`);
  if (heading) heading.setAttribute("tabindex", "-1"), heading.focus({ preventScroll: true });
}
function setStatus(message, { tone = "info" } = {}) {
  const node = $("#contact-status");
  if (!node) return;
  node.textContent = message || "";
  node.dataset.tone = tone;
  show(node, Boolean(message));
}
function setError(node, code) {
  if (!node) return;
  const message = code ? t(`errors.${code}`) || t("errors.unknown") : "";
  node.textContent = message;
  show(node, Boolean(message));
}
function renderIdentity(signer) {
  const node = $("#contact-identity");
  if (!node) return;
  if (!signer) return show(node, false);
  const label = t(`methods.${signer.kind}.identity`, signer.kind);
  replace(
    node,
    el("span", { class: "identity__label", text: label }),
    el("code", { class: "identity__key code", text: shortKey(signer.pubkey) })
  );
  show(node, true);
}
function shortKey(hex) {
  return `${hex.slice(0, 8)}\u2026${hex.slice(-8)}`;
}
function renderConnect({ uri }) {
  const qrHost = $("#nip46-qr");
  if (qrHost) replace(qrHost, qrSvg(uri, { label: t("nip46.qr_alt") }));
  const uriField = $("#nip46-uri");
  if (uriField) uriField.value = uri;
  const links = $("#nip46-signers");
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
  const host = $("#nip46-auth");
  if (!host) return;
  if (!url) return show(host, false);
  replace(
    host,
    el("p", { class: "note", text: t("nip46.auth_note") }),
    el("a", { class: "btn btn--primary btn--compact", href: url, target: "_blank", rel: "noopener", text: t("nip46.auth_open") })
  );
  show(host, true);
}
function renderProgress({ step, index, total, name }) {
  const node = $("#sending-progress");
  if (!node) return;
  const label = t(`sending.${step}`, step);
  node.textContent = `${label} \u2014 ${name} (${index + 1}/${total})`;
}
function renderResult({ results, verdict }) {
  const head = $("#result-head");
  if (head) {
    replace(
      head,
      el("h2", { text: t(`result.${verdict}.title`) }),
      el("p", { class: "lede", text: t(`result.${verdict}.body`) })
    );
  }
  const list = $("#result-list");
  if (!list) return;
  clear(list);
  for (const result of results) {
    const relays = el("ul", { class: "result__relays" });
    for (const relay of result.relays) {
      relays.append(
        el("li", { class: relay.ok ? "result__relay is-ok" : "result__relay is-failed" }, [
          el("span", { class: "result__relay-url code", text: relay.url }),
          el("span", {
            class: "result__relay-state",
            text: relay.ok ? t("result.relay_ok") : `${t("result.relay_failed")}: ${relay.reason}`
          })
        ])
      );
    }
    const delivered = result.relays.some((relay) => relay.ok);
    list.append(
      el("li", { class: "result__item" }, [
        el("div", { class: "result__who" }, [
          el("span", { class: "result__name", text: result.self ? t("result.self_copy") : result.name }),
          el("span", {
            class: delivered ? "badge badge--live" : "badge badge--soon",
            text: delivered ? t("result.delivered") : t("result.not_delivered")
          })
        ]),
        result.usedFallback ? el("p", { class: "result__warning", text: t("result.fallback_warning") }) : null,
        relays,
        el("p", { class: "result__id" }, [
          el("span", { text: t("result.event_id") }),
          el("code", { class: "code", text: result.wrapId })
        ])
      ])
    );
  }
}
function wireEmailFallback() {
  for (const node of document.querySelectorAll("[data-user][data-domain]")) {
    const address = `${node.dataset.user}@${node.dataset.domain}`;
    const subject = node.dataset.subject ? `?subject=${encodeURIComponent(node.dataset.subject)}` : "";
    node.setAttribute("href", `mailto:${address}${subject}`);
    if (node.dataset.fill === "address") node.textContent = address;
  }
}

// assets/js/contact/src/app.js
var store = createStore(initialState);
var openedAt = Date.now();
var connectAbort = null;
var errorCode = (err) => err instanceof SignerError ? err.code : err?.code || "unknown";
function fail(err, { panel } = {}) {
  const code = errorCode(err);
  setError($("#contact-error"), code);
  if (panel) showPanel(panel);
  return code;
}
function adopt(signer) {
  store.set({ signer, phase: "composing", error: null });
  renderIdentity(signer);
  showPanel("compose");
  openedAt = Date.now();
  $("#field-message")?.focus();
}
async function signInNip07() {
  setStatus(t("status.connecting_nip07"));
  try {
    adopt(await connectNip07());
  } catch (err) {
    fail(err, { panel: "methods" });
  } finally {
    setStatus("");
  }
}
function signInGuest() {
  adopt(createGuestSigner());
}
async function signInNostrConnect() {
  cancelConnect();
  showPanel("nip46");
  setError($("#contact-error"), null);
  renderAuthUrl(null);
  const controller = new AbortController();
  connectAbort = controller;
  const { uri, connected } = startNostrConnect({
    onauth: renderAuthUrl,
    signal: controller.signal
  });
  renderConnect({ uri });
  const timer = setTimeout(() => controller.abort(), config.timeouts.nip46_connect);
  try {
    adopt(await connected);
  } catch (err) {
    if (!controller.signal.aborted) fail(err, { panel: "nip46" });
  } finally {
    clearTimeout(timer);
    if (connectAbort === controller) connectAbort = null;
  }
}
async function signInBunker(event) {
  event.preventDefault();
  const input = $("#field-bunker");
  setStatus(t("status.connecting_nip46"));
  try {
    const signer = await connectBunker(input.value, { onauth: renderAuthUrl });
    input.value = "";
    adopt(signer);
  } catch (err) {
    fail(err, { panel: "nip46" });
  } finally {
    setStatus("");
  }
}
function cancelConnect() {
  connectAbort?.abort();
  connectAbort = null;
  renderAuthUrl(null);
  setError($("#contact-error"), null);
}
function signOut() {
  cancelConnect();
  store.get().signer?.close();
  store.set({ signer: null, phase: "choose_method", results: null, verdict: null });
  renderIdentity(null);
  showPanel("methods");
}
function validate(form) {
  if (form.elements.website.value) return "honeypot";
  if (Date.now() - openedAt < config.limits.min_seconds * 1e3) return "too_fast";
  const message = form.elements.message.value.trim();
  if (message.length < config.limits.message.min) return "message_short";
  if (message.length > config.limits.message.max) return "message_long";
  if (form.elements.subject.value.trim().length > config.limits.subject.max) return "subject_long";
  if (rateLimited(store)) return "rate_limited";
  return null;
}
function composeContent(form) {
  const signer = store.get().signer;
  const lines = [form.elements.message.value.trim()];
  const replyTo = form.elements.replyto.value.trim();
  lines.push("");
  if (replyTo) lines.push(`${t("compose.footer_reply")} ${replyTo}`);
  lines.push(signer.kind === "guest" ? t("compose.footer_guest") : t("compose.footer_signed"));
  return lines.join("\n");
}
async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const problem = validate(form);
  if (problem === "honeypot") {
    store.set({ results: [], verdict: "success" });
    renderResult({ results: [], verdict: "success" });
    return showPanel("result");
  }
  if (problem) return setError($("#compose-error"), problem);
  setError($("#compose-error"), null);
  showPanel("sending");
  store.set({ phase: "sending" });
  try {
    const { results, verdict } = await send(store, {
      subject: form.elements.subject.value.trim(),
      content: composeContent(form),
      onProgress: renderProgress
    });
    noteSend(store);
    store.set({ results, verdict, phase: "result" });
    renderResult({ results, verdict });
    showPanel("result");
    form.reset();
  } catch (err) {
    store.set({ phase: "composing" });
    fail(err, { panel: "compose" });
    setError($("#compose-error"), errorCode(err));
  }
}
async function onRetry() {
  const previous = store.get().results;
  if (!previous) return;
  showPanel("sending");
  try {
    const { results, verdict } = await retry(store, previous, { onProgress: renderProgress });
    store.set({ results, verdict });
    renderResult({ results, verdict });
  } catch (err) {
    setError($("#contact-error"), errorCode(err));
  } finally {
    showPanel("result");
  }
}
function prefillSubject() {
  const asked = new URLSearchParams(location.search).get("subject");
  const field = $("#field-subject");
  if (asked && field) field.value = asked.slice(0, config.limits.subject.max);
}
function wire() {
  $("#method-nip07")?.addEventListener("click", signInNip07);
  $("#method-nip46")?.addEventListener("click", signInNostrConnect);
  $("#method-guest")?.addEventListener("click", signInGuest);
  $("#form-bunker")?.addEventListener("submit", signInBunker);
  $("#nip46-cancel")?.addEventListener("click", () => (cancelConnect(), showPanel("methods")));
  $("#nip46-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#nip46-uri").value);
      setStatus(t("nip46.copied"));
    } catch {
      $("#nip46-uri").select();
    }
  });
  $("#contact-form")?.addEventListener("submit", onSubmit);
  $("#result-retry")?.addEventListener("click", onRetry);
  $("#result-again")?.addEventListener("click", () => showPanel("compose"));
  $("#sign-out")?.addEventListener("click", signOut);
  window.addEventListener("pagehide", () => {
    cancelConnect();
    store.get().signer?.close();
  });
}
async function boot() {
  const found = panels();
  if (!found.methods) return;
  wireEmailFallback();
  prefillSubject();
  wire();
  document.documentElement.dataset.contact = "ready";
  showPanel("methods");
  const hasNip07 = await detectNip07();
  store.set({ hasNip07 });
  const button = $("#method-nip07");
  if (button) {
    button.disabled = !hasNip07;
    button.setAttribute("aria-disabled", String(!hasNip07));
  }
  const missing = $("#nip07-missing");
  if (missing) missing.hidden = hasNip07;
  await bootRecipients(store);
  if (store.get().phase === "unavailable") {
    setError($("#contact-error"), store.get().error);
    showPanel("unavailable");
  }
  if (dev.local) console.info("contact: localhost overrides active", dev);
}
boot();
