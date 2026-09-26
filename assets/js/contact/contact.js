// assets/js/contact/src/dom.js
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

// assets/js/contact/src/config.js
function readJson(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing config block: ${id}`);
  return JSON.parse(node.textContent);
}
var strings = readJson("contact-strings");
var config = readJson("contact-config");
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
  if (dev.local && dev.to && (dev.to.startsWith("npub1") || HEX64.test(dev.to))) {
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

// assets/js/contact/src/profiles.js
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
function bytesToHex(bytes) {
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

// assets/js/contact/src/pow-core.js
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
      event.id = bytesToHex(hash);
      return { event, tries: tries + 1 };
    }
    n += step;
    if (++tries % batch === 0 && onBatch && onBatch(tries) === false) return null;
  }
}

// assets/js/contact/src/pow.js
var WORKER_PATH = "/assets/js/contact/pow-worker.js";
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
  recipient: null,
  // the one this message goes to
  signer: null,
  // null until someone signs in; a guest key is made per send
  profileName: null,
  // a signed-in sender's kind 0 name, when one was found
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
    store2.set({ recipients, phase: "composing" });
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
function powFor(signerKind) {
  if (dev.noPow) return 0;
  return signerKind === "guest" ? config.pow?.anonymous || 0 : config.pow?.signed || 0;
}
async function send(store2, { signer, recipient, subject, content, onProgress }) {
  const pool = new SimplePool();
  const pow = powFor(signer.kind);
  const targets = [{ ...recipient, self: false }];
  if (signer.kind !== "guest" && recipient.pubkey !== signer.pubkey) {
    targets.push({ name: t("recipients.self_copy", "you"), pubkey: signer.pubkey, self: true });
  }
  const rumor = buildRumor({
    senderPubkey: signer.pubkey,
    recipients: [{ pubkey: recipient.pubkey }],
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
      const { wrap, ephemeralKey } = await wrapFor(seal, target.pubkey, relays[0], {
        pow,
        onProgress: (p) => onProgress?.({ step: "mining", index, total: targets.length, name: target.name, ...p })
      });
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
async function retry(store2, previous, { onProgress, pow = 0 } = {}) {
  const pool = new SimplePool();
  const results = previous.map((r) => ({ ...r }));
  try {
    for (const [index, result] of results.entries()) {
      if (result.relays.some((relay) => relay.ok)) continue;
      onProgress?.({ step: "publishing", index, total: results.length, name: result.name });
      const { relays, usedFallback } = await inboxRelaysFor(pool, result.pubkey);
      const { wrap, ephemeralKey } = await wrapFor(result.seal, result.pubkey, relays[0], {
        pow,
        onProgress: (p) => onProgress?.({ step: "mining", index, total: results.length, name: result.name, ...p })
      });
      onProgress?.({ step: "publishing", index, total: results.length, name: result.name });
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
  const secret = bytesToHex2(crypto.getRandomValues(new Uint8Array(16)));
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
function bytesToHex2(bytes) {
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
function labelFor(recipient) {
  return t(`recipients.labels.${recipient.name}`) || recipient.name;
}
function nip05For(recipient) {
  return `${recipient.name}@${config.client.name}`;
}
function timeNow() {
  return (/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function renderRecipients(recipients, selected) {
  const select = $("#field-to");
  if (!select) return;
  clear(select);
  for (const r of recipients) {
    select.append(
      el("option", {
        value: r.name,
        selected: r.name === selected?.name,
        text: `${labelFor(r)} \xB7 ${nip05For(r)}`
      })
    );
  }
}
function setSendMode(mode, { signed = mode === "signed" } = {}) {
  show($("#send-guest"), mode === "guest");
  show($("#send-signed"), mode === "signed");
  show($("#send-busy"), mode === "busy");
  show($("#field-reply"), !signed);
  const fields = $("#composer-fields");
  if (fields) fields.classList.toggle("is-locked", mode === "busy");
  for (const input of $$("#composer-fields input, #composer-fields select, #composer-fields textarea")) {
    input.disabled = mode === "busy";
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
function setTravel(states, { busy = false, done = false } = {}) {
  const travel = $("#travel");
  if (!travel) return;
  travel.classList.toggle("travel--busy", busy);
  travel.classList.toggle("travel--done", done);
  const nodes = $$(".travel__node", travel);
  nodes.forEach((node, i) => {
    const [state, noteKey] = (states[i] || "rest").split(":");
    node.dataset.state = state;
    const note = $(".travel__note", node);
    if (note) note.textContent = note.dataset[noteKey || state] || note.dataset[state] || note.dataset.rest || "";
  });
  const lastDone = states.lastIndexOf("done");
  const lit = lastDone < 0 ? 0 : Math.round((lastDone + 0.5) / nodes.length * 100);
  travel.style.setProperty("--lit", `${lit}%`);
}
var TRAVEL = {
  rest: () => setTravel(["rest", "rest", "rest"]),
  sealing: () => setTravel(["active", "rest", "rest"], { busy: true }),
  mining: () => setTravel(["active:mining", "rest", "rest"], { busy: true }),
  publishing: () => setTravel(["done", "active", "rest"], { busy: true }),
  delivered: () => setTravel(["done", "done", "done"], { done: true }),
  failed: () => setTravel(["done", "failed", "rest"], { busy: true })
};
function renderProgress({ step, tries, elapsed }, signerKind) {
  const label = $("#progress-label");
  const detail = $("#progress-detail");
  const note = $("#progress-note");
  if (label) label.textContent = t(`sending.${step}`, step);
  if (detail) {
    detail.textContent = step === "mining" && tries ? fmt(t("sending.mining_detail"), { hashes: compact(tries), seconds: Math.round((elapsed || 0) / 1e3) }) : "";
  }
  if (note) note.textContent = signerKind === "guest" ? t("sending.note_guest") : t("sending.note_signed");
  if (step === "publishing") TRAVEL.publishing();
  else if (step === "mining") TRAVEL.mining();
  else TRAVEL.sealing();
}
function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}
function showReceipt(visible) {
  const form = $("#contact-form");
  if (form) form.classList.toggle("composer--result", visible);
  show($("#panel-result"), visible);
  if (visible) $("#result-title")?.focus({ preventScroll: true });
}
function renderResult({ results, verdict, recipient, replyTo, signerKind }) {
  const panel = $("#panel-result");
  if (!panel) return;
  panel.classList.remove("receipt--success", "receipt--partial", "receipt--failure");
  panel.classList.add(`receipt--${verdict}`);
  const main = results.find((r) => !r.self) || results[0];
  const okCount = main ? main.relays.filter((r) => r.ok).length : 0;
  const total = main ? main.relays.length : 0;
  const name = recipient ? labelFor(recipient) : main?.name || "";
  const vars = { name, ok: okCount, total };
  const title = $("#result-title");
  const body = $("#result-body");
  if (title) title.textContent = t(`result.${verdict}.title`) || t(`result.${verdict === "partial" ? "success" : verdict}.title`);
  if (body) {
    const key = verdict === "failure" ? "failure" : "success";
    replace(body, ...boldName(fmt(t(`result.${key}.body`), vars), name));
  }
  const who = $("#result-who");
  if (who) {
    clear(who);
    for (const result of results) {
      const delivered = result.relays.some((relay) => relay.ok);
      const ok = result.relays.filter((relay) => relay.ok).length;
      who.append(
        el("li", { class: result.self ? "who who--self" : "who" }, [
          el("span", { class: "who__avatar" }, [faceIcon()]),
          el("span", { class: "who__name", text: result.self ? t("recipients.self_copy") : name }),
          result.self || !recipient ? null : el("span", { class: "who__nip05 code", text: nip05For(recipient) }),
          el("span", {
            class: delivered ? "badge badge--live" : "badge badge--soon",
            text: delivered ? t("result.delivered") : t("result.not_delivered")
          }),
          el("span", {
            class: "who__meta",
            text: fmt(t("result.relays_count"), { ok, total: result.relays.length })
          })
        ])
      );
    }
  }
  const warning = $("#result-warning");
  if (warning) {
    const fell = results.some((r) => !r.self && r.usedFallback);
    warning.textContent = fell ? t("result.fallback_warning") : "";
    show(warning, fell);
  }
  const relays = $("#result-relays");
  if (relays) {
    clear(relays);
    for (const result of results) {
      for (const relay of result.relays) {
        relays.append(
          el("li", { class: relay.ok ? "relay is-ok" : "relay is-failed" }, [
            el("span", { class: "relay__url", text: relay.url.replace(/^wss:\/\//, "") }),
            el("span", {
              class: "relay__state",
              text: relay.ok ? t("result.relay_ok") : fmt(t("result.relay_failed"), { reason: relay.reason })
            })
          ])
        );
      }
    }
  }
  const id = $("#result-id");
  if (id && main) {
    replace(
      id,
      el("span", { text: t("result.event_id") }),
      el("span", { class: "code", text: main.wrapId || "" }),
      el("span", {
        class: "receipt__meta",
        text: fmt(t("result.sent_at"), {
          time: timeNow(),
          key: signerKind === "guest" ? t("result.key_guest") : t("result.key_signed")
        })
      })
    );
  }
  const reply = $("#result-reply");
  if (reply) {
    if (signerKind !== "guest") reply.textContent = t("result.reply_self");
    else if (replyTo) reply.textContent = fmt(t("result.reply_to"), { reply: replyTo });
    else reply.textContent = verdict === "failure" ? "" : t("result.reply_none");
  }
  show($("#result-retry"), verdict !== "success");
}
function receiptText({ results, recipient }) {
  const main = results.find((r) => !r.self) || results[0];
  if (!main) return "";
  return fmt(t("result.receipt"), {
    name: recipient ? labelFor(recipient) : main.name,
    nip05: recipient ? nip05For(recipient) : "",
    time: (/* @__PURE__ */ new Date()).toISOString(),
    relays: main.relays.map((r) => `${r.url} ${r.ok ? "accepted" : "refused"}`).join(", "),
    id: main.wrapId
  });
}
function boldName(text, name) {
  if (!name) return [text];
  const at = text.indexOf(name);
  if (at < 0) return [text];
  return [text.slice(0, at), el("b", { text: name }), text.slice(at + name.length)];
}
function faceIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const tpl = $(".identity__glyph path");
  if (tpl) svg.append(tpl.cloneNode(true));
  return svg;
}
function openBunkerModal() {
  const dialog = $("#bunker-modal");
  if (dialog && !dialog.open) dialog.showModal();
}
function closeBunkerModal() {
  const dialog = $("#bunker-modal");
  if (dialog?.open) dialog.close();
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
function wireEmailFallback() {
  for (const node of document.querySelectorAll("[data-user][data-domain]")) {
    const address = `${node.dataset.user}@${node.dataset.domain}`;
    const subject = node.dataset.subject ? `?subject=${encodeURIComponent(node.dataset.subject)}` : "";
    node.setAttribute("href", `mailto:${address}${subject}`);
    node.textContent = address;
  }
}
function middle(s, head, tail) {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}\u2026${s.slice(-tail)}`;
}
function wireCopyButtons() {
  for (const node of document.querySelectorAll("[data-copy]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = node.className + " copyable";
    button.setAttribute("aria-label", node.dataset.copyLabel || "");
    button.title = node.dataset.copyLabel || "";
    while (node.firstChild) button.appendChild(node.firstChild);
    const text = button.querySelector(".ruled-item__code-text");
    if (text && node.dataset.copy.length > 40) text.textContent = middle(node.dataset.copy, 15, 9);
    const status = document.createElement("span");
    status.className = "copyable__status";
    status.setAttribute("role", "status");
    node.replaceWith(button, status);
    let timer = null;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(node.dataset.copy);
      } catch {
        return;
      }
      button.classList.add("is-copied");
      status.textContent = node.dataset.copyDone || "";
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove("is-copied");
        status.textContent = "";
      }, 1800);
    });
  }
}

// assets/js/contact/src/app.js
var store = createStore(initialState);
var openedAt = Date.now();
var connectAbort = null;
var lastSend = null;
var errorCode = (err) => err instanceof SignerError ? err.code : err?.code || "unknown";
var sendMode = () => store.get().signer ? "signed" : "guest";
async function adopt(signer) {
  store.set({ signer, profileName: null, error: null });
  renderIdentity(signer, null);
  setSendMode("signed");
  setError($("#sign-error"), null);
  const pool = new SimplePool();
  try {
    const name = await fetchProfileName(pool, signer.pubkey);
    if (store.get().signer === signer && name) {
      store.set({ profileName: name });
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
    const signer = await connected;
    closeBunkerModal();
    await adopt(signer);
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
    const signer = await connectBunker(input.value, { onauth: renderAuthUrl });
    input.value = "";
    cancelConnect();
    closeBunkerModal();
    await adopt(signer);
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
  store.get().signer?.close();
  store.set({ signer: null, profileName: null });
  setSendMode("guest");
}
function validate(form) {
  if (form.elements.website.value) return "honeypot";
  if (Date.now() - openedAt < config.limits.min_seconds * 1e3) return "too_fast";
  if (!store.get().recipient) return "recipient_missing";
  const message = form.elements.message.value.trim();
  if (message.length < config.limits.message.min) return "message_short";
  if (message.length > config.limits.message.max) return "message_long";
  if (form.elements.subject.value.trim().length > config.limits.subject.max) return "subject_long";
  if (rateLimited(store)) return "rate_limited";
  return null;
}
function composeContent(form, signer) {
  const subject = form.elements.subject.value.trim();
  const replyTo = signer.kind === "guest" ? form.elements.replyto.value.trim() : "";
  const lines = [t("compose.header")];
  if (subject) lines.push(fmt(t("compose.subject_line"), { subject }));
  lines.push("", form.elements.message.value.trim(), "");
  if (replyTo) lines.push(fmt(t("compose.footer_reply"), { reply: replyTo }));
  const footer = signer.kind === "guest" ? t("compose.footer_guest") : t("compose.footer_signed");
  if (footer) lines.push(footer);
  return lines.join("\n").trim();
}
function finish(results, verdict, { signerKind, replyTo }) {
  const { recipient } = store.get();
  lastSend = { results, verdict, recipient, replyTo, signerKind };
  store.set({ results, verdict, phase: "result" });
  renderResult(lastSend);
  if (verdict === "failure") TRAVEL.failed();
  else TRAVEL.delivered();
  showReceipt(true);
}
function pretendSuccess() {
  const { recipient } = store.get();
  const fake = crypto.getRandomValues(new Uint8Array(32));
  const wrapId = Array.from(fake, (b) => b.toString(16).padStart(2, "0")).join("");
  const relays = config.relays.fallback_dm.map((url) => ({ url, ok: true, reason: "" }));
  finish([{ name: recipient?.name, pubkey: recipient?.pubkey, self: false, relays, usedFallback: false, wrapId }], "success", {
    signerKind: "guest",
    replyTo: ""
  });
}
async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const problem = validate(form);
  if (problem === "honeypot") return pretendSuccess();
  if (problem) return setError($("#compose-error"), problem);
  setError($("#compose-error"), null);
  const { recipient } = store.get();
  const signer = store.get().signer || createGuestSigner();
  const replyTo = signer.kind === "guest" ? form.elements.replyto.value.trim() : "";
  store.set({ phase: "sending" });
  setSendMode("busy", { signed: signer.kind !== "guest" });
  renderProgress({ step: "encrypting" }, signer.kind);
  try {
    const { results, verdict } = await send(store, {
      signer,
      recipient,
      subject: form.elements.subject.value.trim(),
      content: composeContent(form, signer),
      onProgress: (p) => renderProgress(p, signer.kind)
    });
    noteSend(store);
    finish(results, verdict, { signerKind: signer.kind, replyTo });
  } catch (err) {
    store.set({ phase: "composing" });
    setSendMode(sendMode());
    TRAVEL.rest();
    setError($("#compose-error"), errorCode(err));
  } finally {
    if (signer.kind === "guest") signer.close();
  }
}
async function onRetry() {
  if (!lastSend) return;
  showReceipt(false);
  setSendMode("busy", { signed: lastSend.signerKind !== "guest" });
  renderProgress({ step: "publishing" }, lastSend.signerKind);
  try {
    const { results, verdict } = await retry(store, lastSend.results, {
      pow: powFor(lastSend.signerKind),
      onProgress: (p) => renderProgress(p, lastSend.signerKind)
    });
    finish(results, verdict, lastSend);
  } catch (err) {
    setSendMode(sendMode());
    setError($("#contact-error"), errorCode(err));
    showReceipt(true);
  }
}
function sendAnother() {
  const form = $("#contact-form");
  const to = form.elements.to.value;
  form.reset();
  form.elements.to.value = to;
  showReceipt(false);
  TRAVEL.rest();
  setSendMode(sendMode());
  openedAt = Date.now();
  store.set({ phase: "composing", results: null, verdict: null });
  $("#field-message")?.focus();
}
async function copyReceipt() {
  if (!lastSend) return;
  try {
    await navigator.clipboard.writeText(receiptText(lastSend));
    const reply = $("#result-reply");
    if (reply) reply.textContent = t("result.copied");
  } catch {
  }
}
function prefillSubject() {
  const asked = query.get("subject");
  const field = $("#field-subject");
  if (asked && field) field.value = asked.slice(0, config.limits.subject.max);
}
function chooseRecipient(name) {
  const { recipients } = store.get();
  const recipient = recipients.find((r) => r.name === name) || null;
  store.set({ recipient });
}
function wire() {
  $("#contact-form")?.addEventListener("submit", onSubmit);
  $("#field-to")?.addEventListener("change", (e) => chooseRecipient(e.target.value));
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
  $("#result-retry")?.addEventListener("click", onRetry);
  $("#result-again")?.addEventListener("click", sendAnother);
  $("#result-copy")?.addEventListener("click", copyReceipt);
  window.addEventListener("pagehide", () => {
    cancelConnect();
    store.get().signer?.close();
  });
}
async function boot() {
  if (!$("#contact-form")) return;
  wireEmailFallback();
  wireCopyButtons();
  prefillSubject();
  wire();
  setSendMode("guest");
  TRAVEL.rest();
  const hasNip07 = await detectNip07();
  store.set({ hasNip07 });
  markExtension(hasNip07);
  await bootRecipients(store);
  if (store.get().phase === "unavailable") {
    setError($("#contact-error"), store.get().error);
    $("#contact-form").hidden = true;
    $("#panel-unavailable").hidden = false;
  } else {
    const { recipients } = store.get();
    const recipient = pickRecipient(recipients, query.get("to"));
    store.set({ recipient });
    renderRecipients(recipients, recipient);
  }
  document.documentElement.dataset.contact = "ready";
  if (dev.local) console.info("contact: localhost overrides active", dev);
}
boot();
