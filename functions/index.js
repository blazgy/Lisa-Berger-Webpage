const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

exports.ping = onRequest((req, res) => {
  res.status(200).send("pong");
});

// Fetch future available slots
exports.getAvailableSlots = onRequest({ cors: true }, async (req, res) => {
  try {
    const now = admin.firestore.Timestamp.now();
    const snapshot = await db.collection("slots")
      .where("status", "==", "available")
      .where("dateTime", ">=", now)
      .orderBy("dateTime", "asc")
      .get();
      
    const slots = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      slots.push({
        id: doc.id,
        dateTime: data.dateTime.toDate().toISOString(),
        duration: data.duration,
        type: data.type
      });
    });
    
    res.status(200).json(slots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Book a specific slot inside a Transaction
exports.bookAppointment = onRequest({ cors: true }, async (req, res) => {
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

  cancelBooking: onRequest({ cors: true }, async (req, res) => {
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
  })
};

