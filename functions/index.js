const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy");

exports.ping = onRequest((req, res) => {
  res.status(200).send("pong");
});

// Fetch future available slots
exports.getAvailableSlots = onRequest({ cors: true }, async (req, res) => {
  try {
    const now = admin.firestore.Timestamp.now();
    const snapshot = await db.collection("slots")
      .where("status", "==", "available")
      .get();
      
    const slots = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Filter future slots in-memory
      if (data.dateTime && data.dateTime.toMillis() >= now.toMillis()) {
        slots.push({
          id: doc.id,
          dateTime: data.dateTime.toDate().toISOString(),
          duration: data.duration,
          type: data.type
        });
      }
    });
    
    // Sort chronologically (ascending)
    slots.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    
    res.status(200).json(slots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Book a specific slot inside a Transaction
exports.bookAppointment = onRequest({ cors: true, secrets: ["RESEND_API_KEY"] }, async (req, res) => {
  const { slotId, name, email, phone, notes } = req.body;
  
  if (!slotId || !name || !email) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  
  const slotRef = db.collection("slots").doc(slotId);
  const bookingRef = db.collection("bookings").doc();
  
  try {
    const result = await db.runTransaction(async (transaction) => {
      const slotDoc = await transaction.get(slotRef);
      
      if (!slotDoc.exists) {
        throw new Error("Slot not found.");
      }
      
      const slotData = slotDoc.data();
      if (slotData.status !== "available") {
        throw new Error("Slot already booked.");
      }
      
      // Update slot status
      transaction.update(slotRef, {
        status: "booked",
        bookingId: bookingRef.id
      });
      
      // Write booking record
      transaction.set(bookingRef, {
        id: bookingRef.id,
        slotId: slotId,
        dateTime: slotData.dateTime,
        duration: slotData.duration,
        type: slotData.type,
        name,
        email,
        phone: phone || null,
        notes: notes || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return {
        dateTime: slotData.dateTime.toDate().toISOString(),
        duration: slotData.duration,
        type: slotData.type
      };
    });

    try {
      // Format DateTime for humans (Europe/Vienna timezone)
      const formattedDate = new Date(result.dateTime).toLocaleString("de-AT", {
        timeZone: "Europe/Vienna",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });

      // 1. Send confirmation to Client
      await resend.emails.send({
        from: "Lisa Berger Psychotherapie <info@psychotherapieberger.at>",
        to: email,
        subject: "Terminbestätigung Psychotherapie - Lisa Berger",
        html: `
          <h2>Terminbestätigung</h2>
          <p>Sehr geehrte(r) ${name},</p>
          <p>Ihr Termin wurde erfolgreich vereinbart:</p>
          <ul>
            <li><strong>Art des Termins:</strong> ${result.type === "psychotherapie" ? "Einzelpsychotherapie (50 Min)" : "Paartherapie (90 Min)"}</li>
            <li><strong>Datum & Uhrzeit:</strong> ${formattedDate} Uhr</li>
            <li><strong>Praxisadresse:</strong> Stadtplatz 36/25, 4840 Vöcklabruck (Galerie Burgstall, 3. Stock)</li>
          </ul>
          <p>Falls Sie den Termin absagen müssen, bitte ich Sie, dies mindestens 48 Stunden vorher zu tun.</p>
          <br>
          <p>Mit freundlichen Grüßen,<br>Lisa Berger, MA</p>
        `
      });

      // 2. Send notification to Therapist
      await resend.emails.send({
        from: "Praxis Website <info@psychotherapieberger.at>",
        to: "info@psychotherapieberger.at",
        subject: `Neue Buchung: ${name} (${result.type})`,
        html: `
          <h3>Neue Online-Terminbuchung</h3>
          <p>Ein neuer Termin wurde gebucht:</p>
          <ul>
            <li><strong>Klient:</strong> ${name}</li>
            <li><strong>E-Mail:</strong> ${email}</li>
            <li><strong>Telefon:</strong> ${phone || "Nicht angegeben"}</li>
            <li><strong>Termintyp:</strong> ${result.type}</li>
            <li><strong>Terminzeit:</strong> ${formattedDate} Uhr</li>
            <li><strong>Anmerkungen:</strong> ${notes || "Keine"}</li>
          </ul>
        `
      });
    } catch (emailError) {
      console.error("Email sending failed:", emailError);
    }

    res.status(200).json({ success: true, booking: result });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

// Admin Authentication Middleware
async function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    // Ensure email matches admin email
    if (decodedToken.email !== "info@psychotherapieberger.at") {
      return res.status(403).json({ error: "Forbidden." });
    }
    req.admin = decodedToken;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token." });
  }
}

// Helper to parse local Vienna date and time to a UTC Date object
function getViennaDate(localDateStr, timeStr) {
  // localDateStr is "YYYY-MM-DD", timeStr is "HH:MM"
  const utcDate = new Date(`${localDateStr}T${timeStr}:00.000Z`);
  
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Vienna',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(utcDate);
  
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  
  const viennaLocal = new Date(Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  ));
  
  const offsetMs = viennaLocal.getTime() - utcDate.getTime();
  const correctedDate = new Date(utcDate.getTime() - offsetMs);
  return correctedDate;
}

// Admin API Endpoints
exports.admin = {
  createSlot: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const { dateTime, duration, type } = req.body;
        if (!dateTime || !duration || !type) {
          return res.status(400).json({ error: "Missing required fields." });
        }
        const parsedDuration = Number(duration);
        if (parsedDuration !== 50 && parsedDuration !== 90) {
          return res.status(400).json({ error: "Duration must be 50 or 90." });
        }
        if (type !== "psychotherapie" && type !== "paartherapie") {
          return res.status(400).json({ error: "Type must be 'psychotherapie' or 'paartherapie'." });
        }
        const dateObj = new Date(dateTime);
        if (isNaN(dateObj.getTime())) {
          return res.status(400).json({ error: "Invalid date format." });
        }

        const slotRef = db.collection("slots").doc();
        await slotRef.set({
          dateTime: admin.firestore.Timestamp.fromDate(dateObj),
          duration: parsedDuration,
          type,
          status: "available",
          bookingId: null
        });

        res.status(200).json({ success: true, id: slotRef.id });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  deleteSlot: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const { slotId } = req.body;
        if (!slotId) {
          return res.status(400).json({ error: "Missing slotId." });
        }

        const slotRef = db.collection("slots").doc(slotId);
        const slotDoc = await slotRef.get();
        if (!slotDoc.exists) {
          return res.status(404).json({ error: "Slot not found." });
        }
        const slotData = slotDoc.data();
        if (slotData.status !== "available") {
          return res.status(400).json({ error: "Cannot delete a booked slot." });
        }

        await slotRef.delete();
        res.status(200).json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  getBookings: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const snapshot = await db.collection("bookings")
          .orderBy("dateTime", "asc")
          .get();

        const bookings = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          bookings.push({
            id: doc.id,
            slotId: data.slotId,
            dateTime: data.dateTime.toDate().toISOString(),
            duration: data.duration,
            type: data.type,
            name: data.name,
            email: data.email,
            phone: data.phone,
            notes: data.notes,
            createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
          });
        });

        res.status(200).json(bookings);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  cancelBooking: onRequest({ cors: true, secrets: ["RESEND_API_KEY"] }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const { bookingId } = req.body;
        if (!bookingId) {
          return res.status(400).json({ error: "Missing bookingId." });
        }

        const bookingRef = db.collection("bookings").doc(bookingId);
        
        const bookingData = await db.runTransaction(async (transaction) => {
          const bookingDoc = await transaction.get(bookingRef);
          if (!bookingDoc.exists) {
            throw new Error("Booking not found.");
          }
          const data = bookingDoc.data();
          const slotRef = db.collection("slots").doc(data.slotId);
          const slotDoc = await transaction.get(slotRef);
          
          if (slotDoc.exists) {
            transaction.update(slotRef, {
              status: "available",
              bookingId: null
            });
          }
          
          transaction.delete(bookingRef);
          return data;
        });

        // Format DateTime for client email (Europe/Vienna timezone)
        const formattedDate = new Date(bookingData.dateTime.toDate()).toLocaleString("de-AT", {
          timeZone: "Europe/Vienna",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });

        try {
          await resend.emails.send({
            from: "Lisa Berger Psychotherapie <info@psychotherapieberger.at>",
            to: bookingData.email,
            subject: "Absage Termin - Lisa Berger",
            html: `
              <h2>Terminabsage</h2>
              <p>Sehr geehrte(r) ${bookingData.name},</p>
              <p>Ihr vereinbarter Termin am <strong>${formattedDate} Uhr</strong> wurde storniert.</p>
              <p>Falls dies ein Versehen war oder Sie einen neuen Termin vereinbaren möchten, können Sie dies gerne wieder über die Website tun.</p>
              <br>
              <p>Mit freundlichen Grüßen,<br>Lisa Berger, MA</p>
            `
          });
        } catch (emailError) {
          console.error("Cancellation email sending failed:", emailError);
        }

        res.status(200).json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  saveTemplate: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const { template } = req.body;
        if (!Array.isArray(template)) {
          return res.status(400).json({ error: "Template must be an array." });
        }

        // Validate template items
        for (const item of template) {
          if (typeof item.dayOfWeek !== "number" || item.dayOfWeek < 1 || item.dayOfWeek > 7) {
            return res.status(400).json({ error: "dayOfWeek must be a number between 1 and 7." });
          }
          if (typeof item.time !== "string" || !/^\d{2}:\d{2}$/.test(item.time)) {
            return res.status(400).json({ error: "time must be in HH:MM format." });
          }
          if (item.type !== "psychotherapie" && item.type !== "paartherapie") {
            return res.status(400).json({ error: "Type must be 'psychotherapie' or 'paartherapie'." });
          }
          if (item.duration !== 50 && item.duration !== 90) {
            return res.status(400).json({ error: "Duration must be 50 or 90." });
          }
        }

        await db.collection("templates").doc("weekly_default").set({
          template,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  getTemplate: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const doc = await db.collection("templates").doc("weekly_default").get();
        if (!doc.exists) {
          return res.status(200).json({ template: [] });
        }
        res.status(200).json(doc.data());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }),

  applyTemplate: onRequest({ cors: true }, async (req, res) => {
    verifyAdmin(req, res, async () => {
      try {
        const { mondayDate } = req.body;
        if (!mondayDate || !/^\d{4}-\d{2}-\d{2}$/.test(mondayDate)) {
          return res.status(400).json({ error: "mondayDate must be in YYYY-MM-DD format." });
        }

        // Fetch template
        const templateDoc = await db.collection("templates").doc("weekly_default").get();
        if (!templateDoc.exists) {
          return res.status(400).json({ error: "No weekly template defined." });
        }

        const { template } = templateDoc.data();
        if (!Array.isArray(template) || template.length === 0) {
          return res.status(400).json({ error: "Weekly template is empty." });
        }

        const startMonday = new Date(mondayDate + 'T00:00:00');
        if (isNaN(startMonday.getTime())) {
          return res.status(400).json({ error: "Invalid Monday date." });
        }

        const slotsToCreate = [];
        
        // Loop through template items
        for (const item of template) {
          const targetDate = new Date(startMonday);
          targetDate.setDate(startMonday.getDate() + (item.dayOfWeek - 1));
          
          const yyyy = targetDate.getFullYear();
          const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
          const dd = String(targetDate.getDate()).padStart(2, '0');
          const dateStr = `${yyyy}-${mm}-${dd}`;
          
          const viennaDate = getViennaDate(dateStr, item.time);
          const timestamp = admin.firestore.Timestamp.fromDate(viennaDate);

          // Check if slot already exists in DB to prevent duplicates
          const query = await db.collection("slots")
            .where("dateTime", "==", timestamp)
            .limit(1)
            .get();

          if (query.empty) {
            slotsToCreate.push({
              dateTime: timestamp,
              duration: item.duration,
              type: item.type,
              status: "available",
              bookingId: null
            });
          }
        }

        if (slotsToCreate.length === 0) {
          return res.status(200).json({ success: true, createdCount: 0 });
        }

        // Batch write to Firestore
        const batch = db.batch();
        slotsToCreate.forEach(s => {
          const ref = db.collection("slots").doc();
          batch.set(ref, s);
        });
        await batch.commit();

        res.status(200).json({ success: true, createdCount: slotsToCreate.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  })
};

