const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

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

    // TODO: Send emails in next task
    res.status(200).json({ success: true, booking: result });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});
