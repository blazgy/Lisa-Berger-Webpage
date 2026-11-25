/* Praxis-Dashboard – talks to /api/admin/* (session cookie, same origin). */
(function () {
  "use strict";

  const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const WEEKDAYS = ["", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const $ = (id) => document.getElementById(id);

  const state = {
    scope: "upcoming",
    bookings: [],
    services: [],
    slots: [],
    month: null,
    selectedDate: null,
    cancelTarget: null,
  };

  // ------------------------------------------------------------------ helpers

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

  const icon = (name, size = 16) => h("i", { "data-lucide": name, style: `width:${size}px;height:${size}px;` });
  const refreshIcons = () => window.lucide && window.lucide.createIcons();
  const pad = (n) => String(n).padStart(2, "0");

  function todayVienna() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(new Date());
  }

  function formatDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${WEEKDAYS[wd === 0 ? 7 : wd]}, ${d}. ${MONTHS[m - 1]} ${y}`;
  }

  let toastTimer;
  function toast(message, isError) {
    const el = $("toast");
    $("toast-message").textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.add("active");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("active"), 4000);
  }

  async function api(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith("/login")) {
      showLogin();
      throw new Error("Sitzung abgelaufen – bitte erneut anmelden.");
    }
    if (!res.ok) throw new Error(data.error || "Es ist ein Fehler aufgetreten.");
    return data;
  }

  async function run(fn, successMessage) {
    try {
      const result = await fn();
      if (successMessage) toast(successMessage);
      return result;
    } catch (err) {
      toast(err.message, true);
      return undefined;
    }
  }

  // ------------------------------------------------------------------ session

  function showLogin() {
    $("loading-screen").classList.add("hidden");
    $("admin-app").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    $("login-password").focus();
  }

  async function showApp(session) {
    $("loading-screen").classList.add("hidden");
    $("login-view").classList.add("hidden");
    $("admin-app").classList.remove("hidden");
    if (session.environment !== "production") {
      $("env-badge").textContent = session.environment === "staging" ? "Testumgebung" : "Lokal";
      $("env-badge").classList.remove("hidden");
    }
    refreshIcons();
    await loadAll();
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error");
    err.classList.add("hidden");
    try {
      await api("/api/admin/login", "POST", { password: $("login-password").value });
      $("login-password").value = "";
      await showApp(await api("/api/admin/session"));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/admin/logout", "POST", {}).catch(() => {});
    showLogin();
  });

  // ------------------------------------------------------------------ loading

  async function loadAll() {
    await Promise.all([loadServices(), loadSettings()]);
    await Promise.all([loadBookings(), loadSlots(), loadTemplate(), loadEmail(), loadOutbox()]);
  }

  $("refresh-all-btn").addEventListener("click", () => run(loadAll, "Aktualisiert"));

  // ------------------------------------------------------------------ bookings

  document.querySelectorAll("[data-scope]").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("active", b === btn));
      state.scope = btn.dataset.scope;
      run(loadBookings);
    }),
  );
  $("bookings-search").addEventListener("input", renderBookings);

  async function loadBookings() {
    state.bookings = await api(`/api/admin/bookings?scope=${state.scope}`);
    renderBookings();
  }

  function renderBookings() {
    const q = $("bookings-search").value.trim().toLowerCase();
    const list = state.bookings.filter(
      (b) => !q || [b.name, b.email, b.phone, b.notes, b.serviceName].some((v) => v && v.toLowerCase().includes(q)),
    );
    $("bookings-count").textContent = String(list.length);
    const container = $("bookings-list");
    if (!list.length) {
      container.replaceChildren(h("div", { class: "empty-state" }, q ? "Keine Treffer." : "Keine Buchungen in dieser Ansicht."));
      return;
    }
    container.replaceChildren(
      ...list.map((b) =>
        h("article", { class: "booking-item" },
          h("div", { class: "booking-top-bar" },
            h("div", null,
              h("strong", { class: "u-text-style-main" }, b.name), " ",
              h("span", { class: "badge badge-psychotherapie" }, b.serviceName), " ",
              h("span", { class: "badge badge-frei" }, b.sessionKindLabel),
              b.status === "cancelled"
                ? [" ", h("span", { class: "badge status-pill-cancelled" }, b.cancelledBy === "client" ? "von Klient:in abgesagt" : "von Praxis abgesagt")]
                : null),
            h("div", { class: "u-flex gap-sm" },
              h("a", { class: "btn-secondary", href: `/api/admin/bookings/${encodeURIComponent(b.id)}/ics`, download: "" }, ".ics"),
              b.status === "confirmed" && state.scope === "upcoming"
                ? h("button", { type: "button", class: "btn-cancel", onclick: () => openCancel(b) }, "Absagen")
                : null)),
          h("div", { class: "booking-details-grid" },
            h("div", { class: "detail-line" }, icon("calendar"), `${formatDate(b.date)}, ${b.time} Uhr`),
            h("div", { class: "detail-line" }, icon("mail"), h("a", { href: `mailto:${b.email}` }, b.email)),
            h("div", { class: "detail-line" }, icon("phone"), b.phone ? h("a", { href: `tel:${b.phone.replace(/[^+0-9]/g, "")}` }, b.phone) : "–"),
            h("div", { class: "detail-line" }, icon("clock"), `gebucht am ${new Date(b.createdAt).toLocaleDateString("de-AT")}`)),
          b.notes ? h("div", { class: "booking-notes" }, b.notes) : null),
      ),
    );
    refreshIcons();
  }

  function openCancel(b) {
    state.cancelTarget = b;
    $("cancel-summary").textContent = `${b.name} – ${b.serviceName}, ${formatDate(b.date)}, ${b.time} Uhr`;
    $("cancel-notify").checked = true;
    $("cancel-release").checked = true;
    $("cancel-dialog").showModal();
  }

  $("cancel-abort").addEventListener("click", () => $("cancel-dialog").close());
  $("cancel-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = state.cancelTarget;
    $("cancel-dialog").close();
    await run(async () => {
      await api(`/api/admin/bookings/${encodeURIComponent(b.id)}/cancel`, "POST", {
        notify: $("cancel-notify").checked,
        release: $("cancel-release").checked,
      });
      await Promise.all([loadBookings(), loadSlots(), loadOutbox()]);
    }, "Buchung abgesagt");
  });

  // ------------------------------------------------------------------ services

  async function loadServices() {
    state.services = await api("/api/admin/services");
    document.querySelectorAll(".service-select").forEach((sel) => {
      const current = sel.value;
      sel.replaceChildren(
        ...state.services.map((s) => h("option", { value: s.id }, `${s.name} (${s.durationMin} Min)${s.active ? "" : " – inaktiv"}`)),
      );
      if (current) sel.value = current;
    });
    $("services-list").replaceChildren(...state.services.map((svc) => serviceEditor(svc)));
    refreshIcons();
  }

  const SERVICE_ICONS = [
    ["user", "Person"], ["users", "Zwei Personen"], ["puzzle", "Puzzle"], ["baby", "Kind"], ["heart", "Herz"],
    ["heart-handshake", "Herz & Hand"], ["smile", "Lächeln"], ["leaf", "Blatt"], ["message-circle", "Sprechblase"], ["sparkles", "Funkeln"],
  ];

  /** Editor card for one therapy form; without `svc` it is the "add" form. */
  function serviceEditor(svc) {
    const isNew = !svc;
    const s = svc || { name: "", durationMin: 50, priceEur: 90, description: "", icon: "user", active: true };
    const uid = isNew ? "new" : s.id;
    const field = (label, input) => h("div", { class: "svc-field" }, h("label", { class: "input-label", for: input.id }, label), input);
    const name = h("input", { type: "text", id: `svc-${uid}-name`, value: s.name, maxlength: "60", required: true, class: "form-input-date", placeholder: "z. B. Kinder- und Jugendtherapie" });
    const duration = h("input", { type: "number", id: `svc-${uid}-min`, value: String(s.durationMin), min: "10", max: "240", class: "form-input-date" });
    const price = h("input", { type: "number", id: `svc-${uid}-price`, value: String(s.priceEur), min: "0", max: "2000", class: "form-input-date" });
    const description = h("input", { type: "text", id: `svc-${uid}-desc`, value: s.description || "", maxlength: "200", class: "form-input-date", placeholder: "Kurzer Satz auf der Buchungskarte (optional)" });
    const iconSelect = h("select", { id: `svc-${uid}-icon`, class: "form-select" },
      ...SERVICE_ICONS.map(([v, label]) => h("option", { value: v, selected: v === s.icon }, label)));
    const iconPreview = h("span", { class: "svc-icon-preview", "aria-hidden": "true" }, icon(s.icon || "user", 18));
    iconSelect.addEventListener("change", () => { iconPreview.replaceChildren(icon(iconSelect.value, 18)); refreshIcons(); });
    const active = h("input", { type: "checkbox", id: `svc-${uid}-active`, class: "form-checkbox", checked: s.active });
    const data = () => ({
      name: name.value,
      durationMin: Number(duration.value),
      priceEur: Number(price.value),
      description: description.value,
      icon: iconSelect.value,
      active: active.checked,
    });

    const actions = [];
    if (isNew) {
      actions.push(
        h("button", { type: "button", class: "btn-primary-admin", onclick: () => run(async () => {
          await api("/api/admin/services", "POST", data());
          $("svc-add-box").replaceChildren();
          $("svc-add-btn").hidden = false;
          await loadServices();
        }, "Therapieform hinzugefügt") }, "Hinzufügen"),
        h("button", { type: "button", class: "btn-secondary", onclick: () => { $("svc-add-box").replaceChildren(); $("svc-add-btn").hidden = false; } }, "Abbrechen"),
      );
    } else {
      actions.push(h("button", { type: "button", class: "btn-secondary", onclick: () => run(async () => {
        await api(`/api/admin/services/${encodeURIComponent(s.id)}`, "PUT", data());
        await loadServices();
      }, "Gespeichert") }, "Speichern"));
      const remove = h("button", { type: "button", class: "btn-text-danger" }, "Entfernen");
      let armed = false;
      remove.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          remove.textContent = "Wirklich entfernen?";
          setTimeout(() => { armed = false; remove.textContent = "Entfernen"; }, 4000);
          return;
        }
        run(async () => {
          await api(`/api/admin/services/${encodeURIComponent(s.id)}`, "DELETE");
          await loadServices();
        }, "Therapieform entfernt");
      });
      actions.push(remove);
    }

    return h("div", { class: `service-card${s.active ? "" : " is-inactive"}${isNew ? " is-new" : ""}` },
      h("div", { class: "svc-grid" },
        field("Therapieform", name),
        field("Minuten", duration),
        field("Preis €", price)),
      h("div", { class: "svc-grid svc-grid-2" },
        field("Beschreibung auf der Website", description),
        h("div", { class: "svc-field" }, h("label", { class: "input-label", for: iconSelect.id }, "Symbol"), h("div", { class: "svc-icon-row" }, iconPreview, iconSelect))),
      h("div", { class: "svc-foot" },
        h("label", { class: "check-row m-0", for: active.id }, active,
          h("span", null, h("strong", null, "Online buchbar"), h("small", { class: "svc-hint" }, " – erscheint im Buchungsfenster der Website"))),
        h("div", { class: "svc-actions" }, actions)));
  }

  $("svc-add-btn").addEventListener("click", () => {
    $("svc-add-btn").hidden = true;
    $("svc-add-box").replaceChildren(serviceEditor(null));
    refreshIcons();
    $("svc-new-name").focus();
  });

  // ------------------------------------------------------------------ settings & feed

  async function loadSettings() {
    const s = await api("/api/admin/settings");
    $("set-cancel").value = s.cancelWindowHours;
    $("set-notice").value = s.minNoticeHours;
    $("set-horizon").value = s.bookingHorizonDays;
    $("set-retention").value = s.retentionDays;
    $("set-daily-max").value = s.maxBookingsPerDay;
    $("feed-url").value = s.calendarFeedUrl || "";
  }

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      await api("/api/admin/settings", "PUT", {
        cancelWindowHours: Number($("set-cancel").value),
        minNoticeHours: Number($("set-notice").value),
        bookingHorizonDays: Number($("set-horizon").value),
        retentionDays: Number($("set-retention").value),
        maxBookingsPerDay: Number($("set-daily-max").value),
      });
      await loadSettings();
    }, "Regeln gespeichert");
  });

  $("feed-new").addEventListener("click", () => {
    if ($("feed-url").value && !confirm("Neue Adresse erzeugen? Die bisherige Abo-Adresse funktioniert danach nicht mehr.")) return;
    run(async () => {
      const { calendarFeedUrl } = await api("/api/admin/calendar-feed", "POST", {});
      $("feed-url").value = calendarFeedUrl;
    }, "Neue Kalender-Adresse erzeugt");
  });

  $("feed-copy").addEventListener("click", async () => {
    if (!$("feed-url").value) return toast("Bitte zuerst eine Adresse erzeugen.", true);
    try {
      await navigator.clipboard.writeText($("feed-url").value);
      toast("Adresse kopiert");
    } catch {
      $("feed-url").select();
    }
  });

  // ------------------------------------------------------------------ release slots

  document.querySelectorAll("[data-panel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-panel]").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.panel));
    }),
  );

  $("slot-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      await api("/api/admin/slots", "POST", { date: $("slot-date").value, time: $("slot-time").value, serviceId: $("slot-service").value });
      state.selectedDate = $("slot-date").value;
      const [y, m] = state.selectedDate.split("-").map(Number);
      state.month = { y, m: m - 1 };
      await loadSlots();
    }, "Termin freigegeben");
  });

  async function loadTemplate() {
    const items = await api("/api/admin/template");
    $("template-list").replaceChildren(
      ...(items.length
        ? items.map((t) =>
            h("div", { class: "template-slot-item" },
              h("span", null, `${WEEKDAYS[t.weekday]}, ${t.time} Uhr – ${t.serviceName}`),
              h("button", {
                type: "button",
                class: "btn-delete",
                "aria-label": "Aus Vorlage entfernen",
                onclick: () => run(async () => { await api(`/api/admin/template/${encodeURIComponent(t.id)}`, "DELETE"); await loadTemplate(); }),
              }, icon("trash-2", 14))))
        : [h("div", { class: "empty-state" }, "Noch keine Termine in der Vorlage.")]),
    );
    refreshIcons();
  }

  $("template-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      await api("/api/admin/template", "POST", {
        weekday: Number($("tpl-weekday").value),
        time: $("tpl-time").value,
        serviceId: $("tpl-service").value,
      });
      await loadTemplate();
    });
  });

  $("apply-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api("/api/admin/template/apply", "POST", { date: $("apply-date").value, weeks: Number($("apply-weeks").value) });
      await loadSlots();
      toast(`${r.created} Termine freigegeben${r.skipped ? `, ${r.skipped} übersprungen (vergangen oder belegt)` : ""}.`);
    });
  });

  // ------------------------------------------------------------------ slots calendar

  async function loadSlots() {
    const from = todayVienna();
    const [y, m] = from.split("-").map(Number);
    const to = new Date(Date.UTC(y, m - 1 + 13, 0)).toISOString().slice(0, 10); // ~1 year ahead
    state.slots = await api(`/api/admin/slots?from=${from}&to=${to}`);
    if (!state.month) state.month = { y, m: m - 1 };
    $("slots-count").textContent = String(state.slots.filter((s) => s.status === "available").length);
    renderCalendar();
  }

  function renderCalendar() {
    const { y, m } = state.month;
    $("cal-month").textContent = `${MONTHS[m]} ${y}`;
    const byDate = new Map();
    for (const s of state.slots) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    }
    const firstWeekday = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(h("div", { class: "calendar-day-btn empty-cell" }));
    for (let d = 1; d <= days; d++) {
      const date = `${y}-${pad(m + 1)}-${pad(d)}`;
      const daySlots = byDate.get(date) || [];
      const free = daySlots.filter((s) => s.status === "available").length;
      const cls = daySlots.length ? "available" : "";
      cells.push(
        h("button", {
          type: "button",
          class: `calendar-day-btn ${cls} ${state.selectedDate === date ? "selected" : ""}`,
          title: daySlots.length ? `${free} frei, ${daySlots.length - free} gebucht` : "",
          onclick: () => { state.selectedDate = date; $("slot-date").value = date; renderCalendar(); },
        }, String(d)),
      );
    }
    while (cells.length < 42) cells.push(h("div", { class: "calendar-day-btn empty-cell" }));
    $("cal-days").replaceChildren(...cells);
    renderDay(byDate);
  }

  function renderDay(byDate) {
    const date = state.selectedDate;
    $("day-title").textContent = date ? formatDate(date) : "Termine am ausgewählten Tag";
    const list = (date && byDate.get(date)) || [];
    $("day-slots").replaceChildren(
      ...(list.length
        ? list.map((s) =>
            h("div", { class: "slot-item" },
              h("div", { class: "slot-info" },
                h("strong", null, `${s.time}–${s.endTime}`), " ", s.serviceName, " ",
                h("span", { class: `badge ${s.status === "available" ? "badge-frei" : "badge-gebucht"}` }, s.status === "available" ? "frei" : `gebucht: ${s.clientName || "–"}`)),
              s.status === "available"
                ? h("button", {
                    type: "button",
                    class: "btn-delete",
                    "aria-label": "Termin löschen",
                    onclick: () => run(async () => { await api(`/api/admin/slots/${encodeURIComponent(s.id)}`, "DELETE"); await loadSlots(); }, "Termin gelöscht"),
                  }, icon("trash-2", 14))
                : null))
        : [h("div", { class: "empty-state" }, date ? "Keine Termine an diesem Tag." : "Bitte wählen Sie einen Tag im Kalender.")]),
    );
    refreshIcons();
  }

  $("cal-prev").addEventListener("click", () => {
    const k = state.month.y * 12 + state.month.m - 1;
    state.month = { y: Math.floor(k / 12), m: k % 12 };
    renderCalendar();
  });
  $("cal-next").addEventListener("click", () => {
    const k = state.month.y * 12 + state.month.m + 1;
    state.month = { y: Math.floor(k / 12), m: k % 12 };
    renderCalendar();
  });

  // ------------------------------------------------------------------ e-mail

  const EMAIL_KIND_LABEL = {
    client_confirmation: "Terminbestätigung",
    client_reminder: "Erinnerung",
    client_cancellation: "Absagebestätigung",
    practice_new: "Neue Buchung (Praxis)",
    practice_cancellation: "Online-Absage (Praxis)",
    test: "Test-E-Mail",
  };
  const EMAIL_STATUS = {
    sent: ["verschickt", "status-sent"],
    pending: ["wird erneut versucht", "status-pending"],
    sending: ["wird gesendet", "status-pending"],
    failed: ["fehlgeschlagen", "status-failed"],
    blocked: ["nicht verschickt (Test)", "status-muted"],
    logged: ["nur gespeichert", "status-muted"],
  };
  const fmtDateTime = (iso) => new Date(iso).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Vienna" });

  function renderEmailStatus(st) {
    let tone = "ok";
    let text;
    if (st.mode !== "smtp") {
      tone = "info";
      text = "Testbetrieb: Es werden keine E-Mails verschickt. Sie erscheinen nur im Versandprotokoll unten.";
    } else if (!st.smtpConfigured) {
      tone = "warn";
      text = `Der Versand ist eingeschaltet, aber die Zugangsdaten für ${st.from} fehlen. E-Mails können nicht zugestellt werden.`;
    } else if (st.environment !== "production") {
      tone = "info";
      text = `Testumgebung: E-Mails werden über ${st.from} verschickt – aber nur an die Test-Empfänger. Alle anderen erscheinen nur im Versandprotokoll.`;
    } else {
      text = `Automatischer Versand aktiv über ${st.from}. Fehlgeschlagene E-Mails werden bis zu 3-mal neu versucht.`;
    }
    $("email-status").className = `email-status email-status-${tone} mb-6`;
    $("email-status").replaceChildren(icon(tone === "warn" ? "triangle-alert" : tone === "info" ? "info" : "circle-check", 18), h("span", null, text));
    refreshIcons();
  }

  const emailState = { info: [], templates: {}, customized: new Set(), current: null, lastField: null };
  const templateInfo = (id) => emailState.info.find((t) => t.id === id);
  const sameTemplate = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function fillEmailForm(data) {
    const cfg = data.settings;
    const isProduction = data.status.environment === "production";
    $("em-sender").value = cfg.senderName;
    $("em-reply").value = cfg.replyTo;
    $("em-notify").value = cfg.notifyTo.join(", ");
    $("em-reminder-hours").value = cfg.reminderHours;
    $("em-footer").value = cfg.footer;
    document.querySelectorAll("#email-form [data-kind]").forEach((cb) => { cb.checked = !!cfg.enabled[cb.dataset.kind]; });
    $("em-test-recipients-box").classList.toggle("hidden", isProduction);
    if (!isProduction) $("em-test-recipients").value = (cfg.testRecipients || []).join(", ");

    emailState.info = data.templateInfo;
    emailState.templates = JSON.parse(JSON.stringify(cfg.templates));
    if (!emailState.current) emailState.current = data.templateInfo[0].id;
    $("tpl-type").replaceChildren(...data.templateInfo.map((t) => h("option", { value: t.id }, t.label)));
    $("tpl-type").value = emailState.current;
    showTemplate();
  }

  function showTemplate() {
    const id = emailState.current;
    const info = templateInfo(id);
    const tpl = emailState.templates[id];
    $("tpl-subject").value = tpl.subject;
    $("tpl-heading").value = tpl.heading;
    $("tpl-body").value = tpl.body;
    $("tpl-hints").classList.toggle("hidden", !info.hasHints);
    $("tpl-hint-open").value = tpl.hintOpen || "";
    $("tpl-hint-closed").value = tpl.hintClosed || "";
    $("tpl-chips").replaceChildren(
      ...info.placeholders.map((p) =>
        h("button", { type: "button", class: "tpl-chip", title: p.label, onclick: () => insertPlaceholder(p.key) },
          `{{${p.key}}}`, h("span", null, p.label))),
    );
    emailState.lastField = $("tpl-body");
    updateTemplateState();
  }

  function readTemplateFields() {
    const id = emailState.current;
    const tpl = { subject: $("tpl-subject").value, heading: $("tpl-heading").value, body: $("tpl-body").value };
    if (templateInfo(id).hasHints) {
      tpl.hintOpen = $("tpl-hint-open").value;
      tpl.hintClosed = $("tpl-hint-closed").value;
    }
    emailState.templates[id] = tpl;
    updateTemplateState();
  }

  function updateTemplateState() {
    const id = emailState.current;
    const isDefault = sameTemplate(emailState.templates[id], templateInfo(id).defaults);
    $("tpl-state").textContent = isDefault ? "Standardtext" : "Angepasst";
    $("tpl-state").className = `badge ${isDefault ? "status-muted" : "status-sent"}`;
    $("tpl-reset").disabled = isDefault;
  }

  function insertPlaceholder(key) {
    const field = emailState.lastField || $("tpl-body");
    const token = `{{${key}}}`;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = field.value.slice(0, start) + token + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + token.length, start + token.length);
    readTemplateFields();
    schedulePreview();
  }

  document.querySelectorAll(".tpl-field").forEach((el) => {
    el.addEventListener("focus", () => { emailState.lastField = el; });
    el.addEventListener("input", readTemplateFields);
  });
  $("tpl-type").addEventListener("change", () => {
    emailState.current = $("tpl-type").value;
    showTemplate();
    renderPreview();
  });
  $("tpl-reset").addEventListener("click", () => {
    const id = emailState.current;
    emailState.templates[id] = JSON.parse(JSON.stringify(templateInfo(id).defaults));
    showTemplate();
    renderPreview();
    toast("Standardtext wiederhergestellt – zum Übernehmen bitte speichern.");
  });

  function emailEnabledDraft() {
    const enabled = {};
    document.querySelectorAll("#email-form [data-kind]").forEach((cb) => { enabled[cb.dataset.kind] = cb.checked; });
    return enabled;
  }

  /** Templates for saving: unchanged defaults are sent as null (= use the built-in text). */
  function templatesDraft() {
    const out = {};
    for (const t of emailState.info) out[t.id] = sameTemplate(emailState.templates[t.id], t.defaults) ? null : emailState.templates[t.id];
    return out;
  }

  function emailDraft() {
    const draft = {
      senderName: $("em-sender").value,
      replyTo: $("em-reply").value,
      notifyTo: $("em-notify").value,
      reminderHours: Number($("em-reminder-hours").value),
      footer: $("em-footer").value,
      enabled: emailEnabledDraft(),
      templates: templatesDraft(),
    };
    if (!$("em-test-recipients-box").classList.contains("hidden")) draft.testRecipients = $("em-test-recipients").value;
    return draft;
  }

  async function loadEmail() {
    const data = await api("/api/admin/email");
    renderEmailStatus(data.status);
    fillEmailForm(data);
    await renderPreview();
  }

  $("email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("email-form-error");
    err.classList.add("hidden");
    try {
      fillEmailForm(await api("/api/admin/email", "PUT", emailDraft()));
      toast("E-Mail-Einstellungen gespeichert");
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    }
  });

  let previewTimer;
  let previewSeq = 0;
  async function renderPreview() {
    const seq = ++previewSeq;
    const id = emailState.current;
    if (!id) return;
    // Only what changes the content; incomplete addresses while typing must not block it.
    const settings = {
      footer: $("em-footer").value,
      enabled: emailEnabledDraft(),
      templates: { [id]: emailState.templates[id] },
    };
    const hours = Number($("em-reminder-hours").value);
    if (Number.isInteger(hours) && hours >= 2 && hours <= 72) settings.reminderHours = hours;
    try {
      const p = await api("/api/admin/email/preview", "POST", { type: id, settings });
      if (seq !== previewSeq) return;
      $("em-preview-subject").classList.remove("text-red-500");
      $("em-preview-subject").textContent = `Betreff: ${p.subject}${p.enabled ? "" : " – diese E-Mail ist derzeit ausgeschaltet"}`;
      $("em-preview-frame").srcdoc = p.html;
    } catch (ex) {
      if (seq !== previewSeq) return;
      $("em-preview-subject").classList.add("text-red-500");
      $("em-preview-subject").textContent = ex.message;
    }
  }
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 400); };
  $("email-form").addEventListener("input", schedulePreview);
  $("email-form").addEventListener("change", (e) => { if (e.target.id !== "tpl-type") schedulePreview(); });

  $("email-test-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("em-test-btn");
    const out = $("em-test-result");
    btn.disabled = true;
    out.textContent = "Wird gesendet …";
    try {
      const r = await api("/api/admin/email/test", "POST", { to: $("em-test-to").value.trim() });
      const messages = {
        sent: `Verschickt an ${r.to}. Bitte den Posteingang (und den Spam-Ordner) prüfen.`,
        logged: `Testbetrieb: nicht verschickt, nur im Versandprotokoll gespeichert.`,
        pending: `Zustellung an ${r.to} fehlgeschlagen: ${r.error || "unbekannter Fehler"}. Es wird automatisch erneut versucht.`,
        failed: `Zustellung an ${r.to} fehlgeschlagen: ${r.error || "unbekannter Fehler"}.`,
      };
      out.textContent = messages[r.status] || r.status;
      out.classList.toggle("text-red-500", r.status === "pending" || r.status === "failed");
    } catch (ex) {
      out.textContent = ex.message;
      out.classList.add("text-red-500");
    } finally {
      btn.disabled = false;
      loadOutbox().catch(() => {});
    }
  });

  async function loadOutbox() {
    const data = await api("/api/admin/outbox");
    $("outbox-list").replaceChildren(
      ...(data.items.length
        ? data.items.map((m) => {
            const [label, cls] = EMAIL_STATUS[m.status] || [m.status, "status-muted"];
            const details = [];
            if (m.status === "pending" && m.nextAttemptAt) {
              details.push(h("p", { class: "form-hint-admin" }, `Versuch ${m.attempts} von ${data.maxAttempts} fehlgeschlagen. Nächster Versuch ca. ${fmtDateTime(m.nextAttemptAt)}.`));
            }
            if (m.sentAt) details.push(h("p", { class: "form-hint-admin" }, `Zugestellt an den Mailserver: ${fmtDateTime(m.sentAt)}`));
            if (m.error) details.push(h("p", { class: "outbox-error" }, m.error));
            if (m.canResend) {
              details.push(h("button", {
                type: "button",
                class: "btn-secondary",
                onclick: (ev) => run(async () => {
                  ev.target.disabled = true;
                  const r = await api(`/api/admin/outbox/${encodeURIComponent(m.id)}/resend`, "POST", {});
                  await loadOutbox();
                  if (r.status !== "sent") throw new Error(`Erneut fehlgeschlagen: ${r.error || r.status}`);
                }, "E-Mail wurde verschickt"),
              }, "Erneut senden"));
            }
            if (m.html) {
              const frame = h("iframe", { sandbox: "", title: m.subject, loading: "lazy" });
              frame.srcdoc = m.html;
              details.push(frame);
            } else if (m.status === "sent") {
              details.push(h("p", { class: "form-hint-admin" }, "Aus Datenschutzgründen wird der Inhalt verschickter E-Mails nicht gespeichert."));
            }
            return h("details", { class: "outbox-item" },
              h("summary", null,
                h("span", { class: `badge ${cls}` }, label), " ",
                h("strong", null, EMAIL_KIND_LABEL[m.kind] || m.subject), ` → ${m.to} · ${fmtDateTime(m.createdAt)}`),
              h("div", { class: "outbox-body" }, details));
          })
        : [h("div", { class: "empty-state" }, "Noch keine E-Mails.")]),
    );
  }

  // ------------------------------------------------------------------ init

  $("slot-date").min = todayVienna();
  $("apply-date").value = todayVienna();
  api("/api/admin/session")
    .then((s) => (s.authenticated ? showApp(s) : showLogin()))
    .catch(() => showLogin());
})();
