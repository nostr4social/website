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
function show(node, visible) {
  node.hidden = !visible;
}

// assets/js/shared/src/config.js
function readJson(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing config block: ${id}`);
  return JSON.parse(node.textContent);
}
var strings = readJson("page-strings");
var config = readJson("page-config");
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

// assets/js/calculator/src/inputs.js
var INPUTS = {
  mau: { type: "integer", required: true, default: 5e4, min: 1, max: 2e9 },
  posts: { type: "integer", required: false, default: null, min: 0, max: 1e12 },
  // blank → 20 × mau, see defaultsFor
  mb: { type: "number", required: false, default: 50, min: 0, max: 1e6 },
  eng: { type: "integer", required: true, default: 3, min: 0, max: 1e5 },
  hrs: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  hrs_accounts: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  hrs_graph: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  hrs_storage: { type: "number", required: false, default: null, min: 0, max: 1e6 },
  ts: { type: "option", required: true, default: "none", options: ["none", "inhouse", "outsourced"] },
  ts_n: { type: "integer", required: false, default: 0, min: 0, max: 1e5 },
  pay: { type: "option", required: true, default: "no", options: ["no", "yes"] },
  rev: { type: "number", required: false, default: 0, min: 0, max: 1e12 },
  stores: { type: "multi", required: false, default: ["apple", "google"], options: ["apple", "google", "web"] },
  jur: { type: "multi", required: true, default: ["us"], options: ["eu", "uk", "us", "other"] },
  nostr: { type: "multi", required: false, default: [], options: ["accounts", "graph", "storage", "moderation", "payments"] }
};
function defaultsFor(partial) {
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) out[key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  const mau = toNumber(partial?.mau);
  out.posts = mau > 0 ? mau * 20 : 1e6;
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
  if (out.ts !== "none" && !(out.ts_n > 0)) throw new InputError("ts_n", "required");
  if (out.pay === "yes" && !(out.rev > 0)) throw new InputError("rev", "required");
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
function engHoursYear(area, inputs, v) {
  const own = inputs[`hrs_${area}`];
  if (own != null) return own * WEEKS_PER_YEAR;
  const shares = { accounts: v.share_eng_accounts, graph: v.share_eng_graph, storage: v.share_eng_storage };
  if (inputs.hrs != null) {
    const total = shares.accounts + shares.graph + shares.storage;
    return inputs.hrs * WEEKS_PER_YEAR * (total > 0 ? shares[area] / total : 1 / 3);
  }
  return inputs.eng * HOURS_PER_YEAR * shares[area];
}
var part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra });
var sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0);
var has = (inputs, j) => inputs.jur.includes(j);
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
    part("engineering", eng, 0),
    part("key_support", 0, mau * v.key_support_per_mau_year)
  ];
  return { parts };
}
function graph(inputs, v) {
  const { mau, posts } = inputs;
  const dbGb = mau * v.db_mb_per_mau / 1024 + posts * RETENTION_MONTHS * v.db_kb_per_post / 1024 / 1024;
  const eng = engHoursYear("graph", inputs, v) * loadedHourly(v);
  const parts = [
    part("database", dbGb * v.db_gb_month * 12, 0, { gb: dbGb }),
    part("feed_compute", mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part("engineering", eng, eng * v.graph_eng_remains_share),
    part("ranking", 0, mau * v.ranking_fee_per_mau_year)
  ];
  return { parts };
}
function storage(inputs, v) {
  const { mau, mb } = inputs;
  const blob = mau * mb / 1024 * v.blob_gb_month * 12;
  const egress = mau * v.egress_gb_per_mau_month * v.egress_gb * 12;
  const eng = engHoursYear("storage", inputs, v) * loadedHourly(v);
  const parts = [
    part("blob", blob, blob * v.media_sponsor_share),
    part("egress", egress, egress * v.media_sponsor_share),
    part("serving", mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year),
    part("engineering", eng, 0),
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
  const usp = us ? mau >= v.ccpa_consumer_threshold ? v.us_privacy_year_large : v.us_privacy_year_small : 0;
  const dsar = eu || uk || us ? mau * v.dsar_rate_per_mau_year * v.dsar_cost : 0;
  const breach = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.breach_cost_per_user);
  const breachRemains = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.retained_data_share * v.breach_cost_per_user);
  const parts = [
    part("privacy_programs", gdpr + usp, (gdpr + usp) * v.privacy_remains_share, { us_tier: us ? mau >= v.ccpa_consumer_threshold ? "large" : "small" : null }),
    part("content_law", osa + dsa, osa + dsa),
    part("dsar", dsar, 0),
    part("insurance", v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part("breach", breach, breachRemains)
  ];
  return { parts };
}
function moderation(inputs, v) {
  const { mau, ts, ts_n } = inputs;
  let labour;
  let implied = false;
  if (ts === "inhouse") labour = ts_n * loadedYear(v.ts_base_salary, v);
  else if (ts === "outsourced") labour = ts_n * v.moderator_seat_outsourced;
  else {
    labour = mau / 1e6 * v.mods_per_million_mau * loadedYear(v.moderator_base_salary, v);
    implied = true;
  }
  const appeals = labour * v.appeals_share;
  const tooling = mau * v.ts_tooling_per_mau_year;
  const parts = [
    part("labour", labour, labour * v.moderation_remains_share, { implied, people: ts === "none" ? mau / 1e6 * v.mods_per_million_mau : ts_n }),
    part("appeals", appeals, appeals * v.moderation_remains_share),
    part("tooling", tooling, tooling)
  ];
  return { parts, implied };
}
function payments(inputs, v) {
  if (inputs.pay !== "yes") return { parts: [], none: true };
  const annual = inputs.rev * 12;
  const stores = inputs.stores.length ? inputs.stores : ["web"];
  const share = 1 / stores.length;
  const small = annual < v.store_small_threshold;
  const parts = [];
  for (const store of stores) {
    const rev = annual * share;
    if (store === "apple" || store === "google") {
      const rate = store === "apple" ? small ? v.apple_rate_small : v.apple_rate_standard : small ? v.google_rate_small : v.google_rate_standard;
      parts.push(part(`store_${store}`, rev * rate, rev * rate, { rate, tier: small ? "small" : "standard", revenue: rev }));
    } else {
      const processor = rev * v.processor_rate + rev / v.avg_ticket * v.processor_fixed;
      parts.push(part("processor", processor, rev * v.lightning_rate, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev }));
    }
  }
  parts.push(part("money_transmitter", v.mt_avoidance_year, v.mt_avoidance_year * v.mt_remains_share));
  return { parts, tier: small ? "small" : "standard" };
}
var LINE_FN = { accounts, graph, storage, compliance, moderation, payments };
function alreadyOn(line, inputs) {
  const on = inputs.nostr;
  if (line === "compliance") return on.includes("accounts") && on.includes("storage");
  return on.includes(line);
}
function evaluate(inputs, v) {
  const lines = {};
  let custodial = 0;
  let noncustodial = 0;
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v);
    const already = alreadyOn(name, inputs);
    const nc = sum(r.parts, "noncustodial");
    const c = already ? nc : sum(r.parts, "custodial");
    lines[name] = { ...r, custodial: c, noncustodial: nc, already };
    custodial += c;
    noncustodial += nc;
  }
  const { mau } = inputs;
  return {
    lines,
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
function encode(inputs, overrides = {}, version = 1) {
  const p = new URLSearchParams();
  for (const [key, spec] of Object.entries(INPUTS)) {
    const v = inputs[key];
    if (v == null || v === "") continue;
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
var CONTACT_KEYS = ["name", "company", "email", "npub"];
function readInputs(form) {
  const out = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === "multi") {
      out[key] = $$(`input[name="${key}"]:checked`, form).map((i) => i.value);
    } else if (spec.type === "option") {
      out[key] = $(`input[name="${key}"]:checked`, form)?.value ?? "";
    } else {
      out[key] = form.elements[key]?.value.trim() ?? "";
    }
  }
  return out;
}
function readContact(form) {
  const out = {};
  for (const key of CONTACT_KEYS) {
    const v = form.elements[key]?.value.trim();
    if (v) out[key] = v;
  }
  return out;
}
function writeInputs(form, inputs) {
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (!(key in inputs) || inputs[key] == null) continue;
    const v = inputs[key];
    if (spec.type === "multi") {
      const list = Array.isArray(v) ? v : String(v).split(",");
      for (const box of $$(`input[name="${key}"]`, form)) box.checked = list.includes(box.value);
    } else if (spec.type === "option") {
      for (const radio of $$(`input[name="${key}"]`, form)) radio.checked = radio.value === String(v);
    } else if (form.elements[key]) {
      form.elements[key].value = String(v);
    }
  }
  const more = $(".group__more", form);
  if (more && ["hrs_accounts", "hrs_graph", "hrs_storage"].some((k) => inputs[k] != null && inputs[k] !== "")) more.open = true;
}
function writeDefaults(form) {
  const starting = {};
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === "option" || spec.type === "multi") starting[key] = spec.default;
  }
  writeInputs(form, starting);
}
function markInvalid(form, key) {
  for (const node of $$(".is-invalid", form)) node.classList.remove("is-invalid");
  if (!key) return;
  const wrap = $(`#field-${key}`, form);
  if (wrap) wrap.classList.add("is-invalid");
  const input = $(`#f-${key}`, form) || $(`input[name="${key}"]`, form);
  input?.focus({ preventScroll: false });
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
  return s.replace(/\.?0+$/, "");
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
  if (p.id === "privacy_programs" && p.us_tier) return t(`details.us_${p.us_tier}`);
  if (p.id === "labour" && p.people != null) return fmt(t("details.people"), { n: number(p.people) });
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
function showResults(visible, { focus = false } = {}) {
  const panel = $("#calc-results");
  if (!panel) return;
  panel.hidden = !visible;
  if (visible && focus) {
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#results-title")?.focus({ preventScroll: true });
  }
}
function setLink(url) {
  const input = $("#r-link");
  if (input) input.value = url;
}
function setStatus(message) {
  const node = $("#r-status");
  if (node) node.textContent = message || "";
}
function setError(code, fieldLabel) {
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
var fields = readJson("page-fields");
var current = null;
var test = null;
function run(raw, overrides, { submit = false, focus = true } = {}) {
  let result;
  try {
    result = calculate(raw, assumptions, overrides);
  } catch (err) {
    if (err instanceof InputError) {
      markInvalid($("#calc-form"), err.key);
      setError(err.code, fields[err.key]?.label || err.key);
      return null;
    }
    setError("unknown");
    throw err;
  }
  markInvalid($("#calc-form"), null);
  setError(null);
  current = result;
  renderResults(result);
  const query2 = encode(result.inputs, result.overrides, result.version);
  const url = `${location.origin}${location.pathname}?${query2}`;
  setLink(url);
  history.replaceState(null, "", `?${query2}${test ? `&test=${encodeURIComponent(test)}` : ""}`);
  const contact = $("#r-contact");
  if (contact) {
    const p = new URLSearchParams({ subject: t("contact_subject"), calc: query2 });
    contact.href = `${config.contact_href}?${p.toString()}`;
  }
  showResults(true, { focus });
  if (submit) submitResponse(result);
  return result;
}
function submitResponse(result) {
  if (!config.form) return;
  setStatus(t("status.saving"));
  void result;
}
function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = readInputs(form);
  readContact(form);
  run(raw, readOverrides(), { submit: true });
}
function onAssumptionChange() {
  markChanged();
  if (!current) return;
  run(readInputs($("#calc-form")), readOverrides(), { submit: false, focus: false });
}
function onReset() {
  writeOverrides({});
  onAssumptionChange();
}
async function onShare() {
  const link = $("#r-link");
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link.value);
    setStatus(t("share_done"));
  } catch {
    link.select();
  }
}
function onEdit() {
  $("#calc-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#f-mau")?.focus({ preventScroll: true });
}
function wire() {
  $("#calc-form")?.addEventListener("submit", onSubmit);
  $("#r-share")?.addEventListener("click", onShare);
  $("#r-edit")?.addEventListener("click", onEdit);
  $("#a-reset")?.addEventListener("click", onReset);
  for (const input of document.querySelectorAll(".assume-input")) input.addEventListener("change", onAssumptionChange);
  wireToggles();
}
function boot() {
  const form = $("#calc-form");
  if (!form) return;
  wire();
  writeDefaults(form);
  const opened = decode(location.search);
  test = opened.test;
  if (opened.present) {
    writeInputs(form, opened.inputs);
    writeOverrides(opened.overrides);
    const result = run(opened.inputs, opened.overrides, { submit: false, focus: false });
    if (result) setStatus(t("status.shared"));
  }
  document.documentElement.dataset.calculator = "ready";
}
boot();
