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
    $("outbox-card").classList.toggle("hidden", session.emailMode !== "log");
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
    await Promise.all([loadBookings(), loadSlots(), loadTemplate(), loadOutbox()]);
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
    $("services-list").replaceChildren(
      ...state.services.map((s) => {
        const name = h("input", { type: "text", value: s.name, maxlength: "60", class: "form-input-date", "aria-label": "Name" });
        const duration = h("input", { type: "number", value: String(s.durationMin), min: "10", max: "240", class: "form-input-date", "aria-label": "Dauer in Minuten" });
        const price = h("input", { type: "number", value: String(s.priceEur), min: "0", max: "2000", class: "form-input-date", "aria-label": "Preis in Euro" });
        const active = h("input", { type: "checkbox", class: "form-checkbox", checked: s.active });
        return h("div", { class: "service-row" },
          h("div", null, h("label", { class: "input-label" }, "Therapieform"), name),
          h("div", null, h("label", { class: "input-label" }, "Minuten"), duration),
          h("div", null, h("label", { class: "input-label" }, "Preis €"), price),
          h("label", { class: "check-row", style: "margin:0 0 10px;" }, active, "online"),
          h("button", {
            type: "button",
            class: "btn-secondary",
            onclick: () =>
              run(async () => {
                await api(`/api/admin/services/${encodeURIComponent(s.id)}`, "PUT", {
                  name: name.value,
                  durationMin: Number(duration.value),
                  priceEur: Number(price.value),
                  active: active.checked,
                });
                await loadServices();
              }, "Gespeichert"),
          }, "Speichern"));
      }),
    );
  }

  // ------------------------------------------------------------------ settings & feed

  async function loadSettings() {
    const s = await api("/api/admin/settings");
    $("set-cancel").value = s.cancelWindowHours;
    $("set-notice").value = s.minNoticeHours;
    $("set-horizon").value = s.bookingHorizonDays;
    $("set-retention").value = s.retentionDays;
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

  // ------------------------------------------------------------------ outbox

  async function loadOutbox() {
    if ($("outbox-card").classList.contains("hidden")) return;
    const mails = await api("/api/admin/outbox");
    $("outbox-list").replaceChildren(
      ...(mails.length
        ? mails.map((m) => {
            const frame = h("iframe", { sandbox: "", title: m.subject, loading: "lazy" });
            frame.srcdoc = m.html || "<p>(kein Inhalt gespeichert)</p>";
            return h("details", { class: "outbox-item" },
              h("summary", null, h("strong", null, m.subject), ` → ${m.to} · ${new Date(m.createdAt).toLocaleString("de-AT")}`),
              frame);
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
