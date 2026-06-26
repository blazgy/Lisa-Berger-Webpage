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
