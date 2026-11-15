/*
 * Online-Terminbuchung – Praxis Lisa Berger
 * Opens from any element with [data-open-booking] (optionally data-service="<id>").
 * Talks to the booking Worker API (same origin by default, or data-api on the script tag).
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const API = (script && script.dataset.api ? script.dataset.api : "").replace(/\/$/, "");
  const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

  const state = {
    config: null,
    services: [],
    service: null,
    slots: [],
    byDate: new Map(),
    date: null,
    slot: null,
    month: null, // { y, m } (m: 0-11)
    highlightSlotId: null, // slot marked by "Nächster freier Termin"
    turnstileWidget: null,
    turnstileToken: null,
    submitting: false,
  };

  // ------------------------------------------------------------------ helpers

  /** Create an element. Children may be strings (inserted as text, never HTML) or nodes. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function icon(name, cls) {
    return h("i", { "data-lucide": name, class: cls || "" });
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  async function api(path, options) {
    const res = await fetch(API + path, {
      ...options,
      headers: options && options.body ? { "content-type": "application/json" } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Es ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function formatDateLong(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${WEEKDAYS[wd]}, ${d}. ${MONTHS[m - 1]} ${y}`;
  }

  function formatInstant(iso) {
    return new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso)) + " Uhr";
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  // ------------------------------------------------------------------ markup

  let dialog, steps, els;

  function build() {
    els = {};
    els.services = h("div", { class: "u-grid gap-md mb-6", "data-large-columns": "3", "data-medium-columns": "1", "data-small-columns": "1" });
    els.step1Status = h("p", { class: "text-gray-500 u-text-style-small italic text-center" }, "Lade Therapieformen …");

    els.monthLabel = h("h4", { class: "u-text-style-main font-bold text-dark-text uppercase m-0 tracking-wider" });
    els.prev = h("button", { type: "button", class: "nav-month-btn", "aria-label": "Vorheriger Monat", onclick: () => shiftMonth(-1) }, icon("chevron-left"));
    els.next = h("button", { type: "button", class: "nav-month-btn", "aria-label": "Nächster Monat", onclick: () => shiftMonth(1) }, icon("chevron-right"));
    els.days = h("div", { class: "calendar-days-grid", role: "grid" });
    els.times = h("div", { class: "calendar-slots-grid", "aria-live": "polite" });
    els.calendar = h(
      "div",
      { class: "calendar-container u-grid gap-lg-grid", "data-large-columns": "12", "data-medium-columns": "1" },
      h(
        "div",
        { class: "calendar-days-sidebar col-span-7" },
        h("div", { class: "calendar-header-bar" }, els.prev, els.monthLabel, els.next),
        h("div", { class: "calendar-weekdays-header u-grid mb-2", style: "grid-template-columns: repeat(7, 1fr);" },
          ["MO", "DI", "MI", "DO", "FR", "SA", "SO"].map((d) => h("div", null, d))),
        els.days,
      ),
      h(
        "div",
        { class: "calendar-slots-sidebar col-span-5" },
        h("h4", { class: "u-text-style-small font-bold text-gray-500 uppercase tracking-wider mb-3" }, "Freie Uhrzeiten"),
        els.times,
      ),
    );
    // Step 2 header: switch therapy form without going back, and jump to the next free slot.
    els.serviceTabs = h("div", { class: "booking-service-tabs", role: "group", "aria-label": "Therapieform wechseln" });
    els.step2Title = h("p", { class: "booking-service-meta" });
    els.nextFree = h("button", { type: "button", class: "booking-next-free", onclick: showNextFree },
      icon("calendar-check", "icon-sm"), h("span", null, "Nächster freier Termin"));
    els.nextFreeInfo = h("p", { class: "booking-next-info hidden", "aria-live": "polite" });
    els.toolbar = h("div", { class: "booking-toolbar" },
      h("p", { class: "booking-toolbar-label" }, "Wählen Sie einen freien Termin"), els.nextFree);
    els.noSlots = h(
      "div",
      { class: "no-slots-message hidden text-center p-8 glass-panel rounded-2xl" },
      h("h4", { class: "u-text-style-h4 u-weight-medium text-dark-text mb-2" }, "Derzeit keine Online-Termine frei"),
      h("p", { class: "u-text-style-small text-gray-600 mb-4" }, "Für diese Therapieform sind aktuell keine freien Termine online eingetragen."),
      h("p", { class: "u-text-style-small text-gray-600" }, "Bitte kontaktieren Sie mich per E-Mail an ",
        h("a", { href: "mailto:info@psychotherapieberger.at", class: "text-dark-text u-weight-medium underline" }, "info@psychotherapieberger.at"),
        " oder telefonisch unter ",
        h("a", { href: "tel:+4367763142687", class: "text-dark-text u-weight-medium underline" }, "+43 677 631 426 87"),
        "."),
    );
    els.step2Error = h("div", { class: "booking-error hidden mb-4", role: "alert" });

    // Step 3 – form
    els.summary = h("div", { class: "booking-details-box mb-6" });
    els.name = h("input", { type: "text", id: "bk-name", name: "name", required: true, maxlength: "100", autocomplete: "name", class: "form-input" });
    els.nameHint = h("span", { class: "form-hint hidden", id: "bk-name-hint" }, "Bei Spieltherapie bitte den Namen der erziehungsberechtigten Person angeben.");
    els.email = h("input", { type: "email", id: "bk-email", name: "email", required: true, maxlength: "254", autocomplete: "email", class: "form-input" });
    els.phone = h("input", { type: "tel", id: "bk-phone", name: "phone", maxlength: "40", autocomplete: "tel", class: "form-input", placeholder: "+43 …" });
    els.notes = h("textarea", { id: "bk-notes", name: "notes", rows: "3", maxlength: "1000", class: "form-input no-resize" });
    els.consent = h("input", { type: "checkbox", id: "bk-consent", required: true, class: "form-checkbox", style: "margin-top: 0.3rem; flex-shrink: 0;" });
    els.turnstile = h("div", { class: "booking-turnstile" });
    els.formError = h("div", { class: "booking-error hidden", role: "alert" });
    els.submit = h("button", { type: "submit", class: "button-primary booking-submit u-weight-medium mt-2 w-full", style: "padding: 0.8rem; border-radius: 9999px;" }, "Termin verbindlich buchen");
    const kind = (value, title, hint, checked) =>
      h("label", null, h("input", { type: "radio", name: "sessionKind", value, required: true, checked }), h("span", null, title), h("small", null, hint));

    els.form = h(
      "form",
      { class: "booking-form u-flex", "data-direction": "vertical", style: "gap: 1.1rem;", novalidate: true, onsubmit: submit },
      h("fieldset", { style: "border: 0; padding: 0; margin: 0;" },
        h("legend", { class: "u-text-style-small u-weight-medium text-dark-text mb-2" }, "Art des Termins ", h("span", { class: "text-red-500" }, "*")),
        h("div", { class: "booking-kind-toggle" },
          kind("erstgespraech", "Erstgespräch", "Ich komme zum ersten Mal", true),
          kind("folgetermin", "Folgetermin", "Ich bin bereits in Therapie"))),
      field("bk-name", "Name", true, els.name, els.nameHint),
      field("bk-email", "E-Mail-Adresse", true, els.email),
      field("bk-phone", "Telefonnummer", false, els.phone),
      field("bk-notes", "Anmerkungen (optional)", false, els.notes,
        h("span", { class: "form-hint" }, "Bitte hier keine ausführlichen Gesundheitsinformationen angeben – alles Weitere besprechen wir persönlich.")),
      h("div", { class: "u-flex gap-sm", "data-align": "flex-start" },
        els.consent,
        h("label", { for: "bk-consent", class: "u-text-style-small text-gray-600 leading-relaxed" },
          "Ich willige ein, dass meine Angaben zur Terminvereinbarung verarbeitet und gespeichert werden. Details in der ",
          h("a", { href: "#datenschutz-content", class: "text-dark-text u-weight-medium underline", onclick: openPrivacy }, "Datenschutzerklärung"),
          ". ", h("span", { class: "text-red-500" }, "*"))),
      els.turnstile,
      els.formError,
      els.submit,
    );

    // Step 4 – success
    els.success = h("div", { class: "booking-details-box mb-6 text-left" });

    steps = {
      1: h("div", { class: "booking-step active", "data-step": "1" },
        h("p", { class: "u-text-style-main text-gray-700 mb-6 text-center" }, "Bitte wählen Sie die gewünschte Therapieform:"),
        els.step1Status, els.services),
      2: h("div", { class: "booking-step", "data-step": "2" },
        backButton(1), els.serviceTabs, els.step2Title, els.step2Error, els.toolbar, els.nextFreeInfo, els.calendar, els.noSlots),
      3: h("div", { class: "booking-step", "data-step": "3" },
        backButton(2),
        h("h3", { class: "u-text-style-h4 u-weight-medium text-dark-text mb-4 text-center" }, "Ihre Kontaktdaten"),
        els.summary, els.form),
      4: h("div", { class: "booking-step text-center", "data-step": "4" },
        h("div", { class: "icon-circle bg-white shadow-sm icon-circle-lg", style: "color: #15803d; margin: 0 auto 1.5rem;" }, icon("check")),
        h("h3", { class: "u-text-style-h3 u-weight-medium text-dark-text mb-4" }, "Ihr Termin ist gebucht"),
        h("p", { class: "u-text-style-main text-gray-700 mb-6" },
          "Vielen Dank! Sie erhalten in Kürze eine Bestätigung per E-Mail – mit einem Link, über den Sie den Termin bei Bedarf absagen können."),
        els.success,
        h("button", { type: "button", class: "button-primary u-weight-medium", style: "padding: 0.6em 2em; border-radius: 9999px;", onclick: close }, "Schließen")),
    };

    dialog = h(
      "dialog",
      { id: "booking-dialog", class: "booking-dialog rounded-3xl bg-white shadow-2xl", "aria-labelledby": "booking-dialog-title" },
      h("button", { type: "button", class: "booking-dialog-close cursor-pointer icon-circle glass-panel z-50 text-dark-text", "aria-label": "Schließen", onclick: close }, icon("x", "icon-sm")),
      h("div", { class: "booking-dialog-content u-padding-inline-4 u-padding-block-5" },
        h("h2", { id: "booking-dialog-title", class: "u-text-style-h2 u-weight-medium text-dark-text mb-4 tracking-tight text-center" }, "Termin online buchen"),
        Object.values(steps)),
    );
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) close(); // click on the backdrop
    });
    dialog.addEventListener("close", reset);
    document.body.append(dialog);
  }

  function field(id, label, required, input, hint) {
    return h("div", { class: "form-group" },
      h("label", { for: id, class: "u-text-style-small u-weight-medium text-dark-text" }, label, required ? h("span", { class: "text-red-500" }, " *") : null),
      input, hint || null);
  }

  function backButton(target) {
    return h("button", { type: "button", class: "back-btn mb-4 u-flex gap-sm", "data-align": "center", onclick: () => showStep(target) },
      icon("arrow-left", "icon-sm"), " Zurück");
  }

  function showStep(n) {
    for (const [k, el] of Object.entries(steps)) el.classList.toggle("active", Number(k) === n);
    if (n === 3) ensureTurnstile();
    refreshIcons();
    dialog.querySelector(".booking-dialog-content").scrollTop = 0;
  }

  function showError(el, message) {
    el.textContent = message;
    el.classList.toggle("hidden", !message);
  }

  // ------------------------------------------------------------------ flow

  async function open(preselectServiceId) {
    if (!dialog) build();
    dialog.showModal();
    refreshIcons();
    try {
      if (!state.config) state.config = await api("/api/config");
      state.services = await api("/api/services");
      renderServices();
      const pre = preselectServiceId && state.services.find((s) => s.id === preselectServiceId);
      if (pre) selectService(pre);
    } catch (err) {
      els.step1Status.textContent = "Die Online-Buchung ist gerade nicht erreichbar. Bitte kontaktieren Sie mich per E-Mail oder Telefon.";
    }
  }

  function close() {
    if (dialog && dialog.open) dialog.close();
  }

  function reset() {
    state.service = state.slot = state.date = state.highlightSlotId = null;
    state.slots = [];
    els.nextFreeInfo.classList.add("hidden");
    state.submitting = false;
    els.form.reset();
    showError(els.formError, "");
    showError(els.step2Error, "");
    els.submit.disabled = false;
    if (window.turnstile && state.turnstileWidget !== null) window.turnstile.reset(state.turnstileWidget);
    state.turnstileToken = null;
    showStep(1);
  }

  function openPrivacy(e) {
    e.preventDefault();
    close();
    const btn = document.getElementById("datenschutz-btn");
    const content = document.getElementById("datenschutz-content");
    if (content && !content.classList.contains("active") && btn) btn.click();
    else if (content) content.scrollIntoView({ behavior: "smooth" });
  }

  function renderServices() {
    els.services.replaceChildren(
      ...state.services.map((s) =>
        h("button", { type: "button", class: "type-card rounded-2xl glass-panel shadow-sm text-center group cursor-pointer", onclick: () => selectService(s) },
          h("div", { class: "icon-circle bg-white shadow-sm text-gray-400 icon-circle-lg mx-auto mb-4" }, icon(s.icon || "user")),
          h("h3", { class: "u-text-style-h4 u-weight-medium text-dark-text m-0 mb-2" }, s.name),
          h("p", { class: "type-card-meta mb-0" }, `${s.durationMin} Minuten · ${s.priceEur} €`),
          s.description ? h("p", { class: "type-card-desc mb-0" }, s.description) : null),
      ),
    );
    els.step1Status.classList.toggle("hidden", state.services.length > 0);
    if (!state.services.length) els.step1Status.textContent = "Derzeit sind keine Therapieformen online buchbar.";
    refreshIcons();
  }

  async function selectService(service) {
    state.service = service;
    state.date = state.slot = null;
    state.highlightSlotId = null;
    els.nextFreeInfo.classList.add("hidden");
    els.step2Title.textContent = `${service.durationMin} Minuten · ${service.priceEur} €${service.description ? ` · ${service.description}` : ""}`;
    renderServiceTabs();
    els.nameHint.classList.toggle("hidden", service.id !== "spieltherapie");
    if (!steps[2].classList.contains("active")) showStep(2);
    await loadSlots();
  }

  function renderServiceTabs() {
    els.serviceTabs.classList.toggle("hidden", state.services.length < 2);
    els.serviceTabs.replaceChildren(
      ...state.services.map((s) =>
        h("button", {
          type: "button",
          class: "booking-service-tab",
          "aria-pressed": state.service && state.service.id === s.id ? "true" : "false",
          onclick: () => { if (!state.service || state.service.id !== s.id) selectService(s); },
        }, s.name)),
    );
  }

  /** Jump to the earliest free slot: show its month, select its day and highlight the time. */
  function showNextFree() {
    const slot = state.slots[0];
    if (!slot) return;
    const [y, m] = slot.date.split("-").map(Number);
    state.month = { y, m: m - 1 };
    state.date = slot.date;
    state.slot = null;
    state.highlightSlotId = slot.id;
    els.nextFreeInfo.textContent = `Nächster freier Termin: ${formatDateLong(slot.date)}, ${slot.time} Uhr – zum Buchen die Uhrzeit anklicken.`;
    els.nextFreeInfo.classList.remove("hidden");
    renderMonth();
    const btn = els.times.querySelector(".is-next");
    if (btn) {
      btn.focus({ preventScroll: true });
      btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function loadSlots() {
    showError(els.step2Error, "");
    els.days.replaceChildren(h("p", { class: "text-gray-500 u-text-style-small italic", style: "grid-column: 1 / -1; text-align: center;" }, "Lade freie Termine …"));
    els.times.replaceChildren();
    try {
      state.slots = await api(`/api/slots?service=${encodeURIComponent(state.service.id)}`);
    } catch (err) {
      state.slots = [];
      showError(els.step2Error, err.message);
    }
    state.byDate = new Map();
    for (const s of state.slots) {
      if (!state.byDate.has(s.date)) state.byDate.set(s.date, []);
      state.byDate.get(s.date).push(s);
    }
    state.slots.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const empty = state.slots.length === 0;
    els.calendar.classList.toggle("hidden", empty);
    els.toolbar.classList.toggle("hidden", empty);
    els.noSlots.classList.toggle("hidden", !empty);
    if (empty) return;
    const first = state.slots[0].date.split("-").map(Number);
    state.month = { y: first[0], m: first[1] - 1 };
    renderMonth();
  }

  function monthKey(y, m) {
    return y * 12 + m;
  }

  function shiftMonth(delta) {
    const k = monthKey(state.month.y, state.month.m) + delta;
    state.month = { y: Math.floor(k / 12), m: k % 12 };
    renderMonth();
  }

  function renderMonth() {
    const { y, m } = state.month;
    els.monthLabel.textContent = `${MONTHS[m]} ${y}`;
    const dates = [...state.byDate.keys()].sort();
    const firstParts = dates[0].split("-").map(Number);
    const lastParts = dates[dates.length - 1].split("-").map(Number);
    const firstKey = monthKey(firstParts[0], firstParts[1] - 1);
    const lastKey = monthKey(lastParts[0], lastParts[1] - 1);
    els.prev.disabled = monthKey(y, m) <= firstKey;
    els.next.disabled = monthKey(y, m) >= lastKey;

    const firstWeekday = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(h("div", { class: "calendar-day-btn empty-cell", "aria-hidden": "true" }));
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${y}-${pad(m + 1)}-${pad(d)}`;
      const available = state.byDate.has(date);
      cells.push(
        h("button", {
          type: "button",
          class: `calendar-day-btn ${available ? "available" : "unavailable"} ${state.date === date ? "selected" : ""}`,
          disabled: !available,
          "aria-label": `${formatDateLong(date)}${available ? ", freie Termine" : ", keine freien Termine"}`,
          "aria-pressed": state.date === date ? "true" : "false",
          onclick: () => selectDate(date),
        }, String(d)),
      );
    }
    while (cells.length < 42) cells.push(h("div", { class: "calendar-day-btn empty-cell", "aria-hidden": "true" }));
    els.days.replaceChildren(...cells);
    renderTimes();
  }

  function selectDate(date) {
    state.date = date;
    state.slot = null;
    if (!state.slots.some((s) => s.id === state.highlightSlotId && s.date === date)) els.nextFreeInfo.classList.add("hidden");
    renderMonth();
  }

  function renderTimes() {
    if (!state.date) {
      els.times.replaceChildren(h("p", { class: "text-gray-500 u-text-style-small italic" }, "Bitte wählen Sie zuerst einen Tag aus."));
      return;
    }
    els.times.replaceChildren(
      ...(state.byDate.get(state.date) || []).map((slot) => {
        const isNext = slot.id === state.highlightSlotId;
        return h("button", {
          type: "button",
          class: `calendar-slot-btn${isNext ? " is-next" : ""}`,
          "aria-label": isNext ? `${slot.time} Uhr, nächster freier Termin` : `${slot.time} Uhr`,
          onclick: () => selectSlot(slot),
        }, `${slot.time} Uhr`, isNext ? h("span", { class: "slot-next-tag" }, "nächster frei") : null);
      }),
    );
  }

  function selectSlot(slot) {
    state.slot = slot;
    els.summary.replaceChildren(
      h("strong", null, state.service.name), h("br"),
      `${formatDateLong(slot.date)}, ${slot.time} Uhr`, h("br"),
      `${state.service.durationMin} Minuten · ${state.service.priceEur} €`, h("br"),
      "Praxis: Stadtplatz 36/25, 4840 Vöcklabruck",
    );
    showError(els.formError, "");
    showStep(3);
    els.name.focus();
  }

  // ------------------------------------------------------------------ Turnstile

  function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve();
    if (loadTurnstileScript.promise) return loadTurnstileScript.promise;
    loadTurnstileScript.promise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Turnstile konnte nicht geladen werden."));
      document.head.append(s);
    });
    return loadTurnstileScript.promise;
  }

  async function ensureTurnstile() {
    if (state.turnstileWidget !== null) return;
    try {
      await loadTurnstileScript();
      state.turnstileWidget = window.turnstile.render(els.turnstile, {
        sitekey: state.config.turnstileSiteKey,
        language: "de",
        appearance: "interaction-only",
        callback: (token) => (state.turnstileToken = token),
        "expired-callback": () => (state.turnstileToken = null),
        "error-callback": () => (state.turnstileToken = null),
      });
    } catch (err) {
      showError(els.formError, "Die Sicherheitsprüfung konnte nicht geladen werden. Bitte deaktivieren Sie ggf. Werbeblocker oder kontaktieren Sie mich direkt.");
    }
  }

  // ------------------------------------------------------------------ submit

  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;
    showError(els.formError, "");
    const form = els.form;
    if (!form.checkValidity()) {
      const invalid = form.querySelector(":invalid");
      showError(els.formError, invalid === els.consent
        ? "Bitte bestätigen Sie die Einwilligung zur Datenverarbeitung."
        : "Bitte füllen Sie alle Pflichtfelder korrekt aus.");
      if (invalid) invalid.focus();
      return;
    }
    if (!state.turnstileToken) {
      showError(els.formError, "Bitte warten Sie einen Moment, bis die Sicherheitsprüfung abgeschlossen ist, und versuchen Sie es erneut.");
      return;
    }
    state.submitting = true;
    els.submit.disabled = true;
    els.submit.textContent = "Wird gebucht …";
    try {
      const { booking } = await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          slotId: state.slot.id,
          serviceId: state.service.id,
          sessionKind: form.elements.sessionKind.value,
          name: els.name.value,
          email: els.email.value,
          phone: els.phone.value,
          notes: els.notes.value,
          consent: els.consent.checked,
          turnstileToken: state.turnstileToken,
        }),
      });
      els.success.replaceChildren(
        h("strong", null, `${booking.service.name} · ${booking.sessionKind}`), h("br"),
        `${formatDateLong(booking.date)}, ${booking.time} Uhr`, h("br"),
        "Stadtplatz 36/25, 4840 Vöcklabruck (Galerie Burgstall, 3. Stock)", h("br"), h("br"),
        new Date(booking.cancelDeadline) > new Date()
          ? `Kostenfreie Online-Absage bis ${formatInstant(booking.cancelDeadline)}.`
          : "Da der Termin kurzfristig ist, ist eine kostenfreie Online-Absage nicht mehr möglich. Falls Sie verhindert sind, melden Sie sich bitte telefonisch oder per E-Mail.",
      );
      showStep(4);
    } catch (err) {
      showError(els.formError, err.message);
      if (err.code === "slot_taken") {
        await loadSlots();
        showStep(2);
        showError(els.step2Error, err.message);
      }
      if (window.turnstile && state.turnstileWidget !== null) window.turnstile.reset(state.turnstileWidget);
      state.turnstileToken = null;
    } finally {
      state.submitting = false;
      els.submit.disabled = false;
      els.submit.textContent = "Termin verbindlich buchen";
    }
  }

  // ------------------------------------------------------------------ wiring

  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-open-booking]");
    if (!trigger) return;
    e.preventDefault();
    open(trigger.getAttribute("data-service"));
  });
})();
