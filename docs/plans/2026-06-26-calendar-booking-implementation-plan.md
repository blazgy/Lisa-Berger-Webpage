# Calendar Booking System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal**: Build a custom serverless calendar booking function for clients to book 50-minute and 90-minute appointments, and a secure admin dashboard to manage availability slots and bookings.

**Architecture**: An API-first architecture using Firebase Authentication for admin login, Cloud Firestore to store slots and bookings, Node.js Google Cloud Functions for secure transaction-based business logic, and the Resend API for sending HTML booking notifications.

**Tech Stack**: Firebase SDK (Auth, Firestore), Google Cloud Functions, Resend API, HTML5/CSS3/Vanilla JS.

---

### Task 1: Firebase Project Configuration Setup

**Files**:
- Create: `firebase.json`
- Create: `firestore.rules`
- Create: `.firebaserc`
- Create: `functions/package.json`
- Create: `functions/index.js`

**Step 1: Write configuration files**
Create `firebase.json`:
```json
{
  "firestore": {
    "rules": "firestore.rules"
  },
  "functions": {
    "source": "functions"
  }
}
```

Create `firestore.rules`:
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // All direct client writes are forbidden; data is handled by Cloud Functions
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Create `.firebaserc` (referencing the project ID):
```json
{
  "projects": {
    "default": "lisa-berger-webpage"
  }
}
```

Create `functions/package.json`:
```json
{
  "name": "functions",
  "description": "Cloud Functions for Lisa Berger Webpage",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "firebase-admin": "^11.8.0",
    "firebase-functions": "^4.3.1",
    "resend": "^3.0.0"
  },
  "engines": {
    "node": "18"
  }
}
```

Create base `functions/index.js`:
```javascript
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();

exports.ping = onRequest((req, res) => {
  res.status(200).send("pong");
});
```

**Step 2: Run verification**
Run: `cd functions && npm install`
Expected: Install completes successfully without conflicts.

**Step 3: Commit**
```bash
git add firebase.json firestore.rules .firebaserc functions/package.json functions/index.js
git commit -m "chore: initialize firebase project configurations"
```

---

### Task 2: Implement Public Booking API (Cloud Functions)

**Files**:
- Modify: `functions/index.js`

**Step 1: Implement getAvailableSlots and bookAppointment**
Update `functions/index.js`:
```javascript
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

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
```

**Step 2: Verify code compiling**
Run: `node -c functions/index.js`
Expected: Compile check succeeds without syntax errors.

**Step 3: Commit**
```bash
git add functions/index.js
git commit -m "feat: implement public getAvailableSlots and transaction-based bookAppointment"
```

---

### Task 3: Resend Email Integration

**Files**:
- Modify: `functions/index.js`

**Step 1: Configure Resend library and notification templates**
Import and initialize Resend, and trigger email sending after transaction completes:
```javascript
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

// Inside bookAppointment, right after the successful transaction completes:
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
```

**Step 2: Commit**
```bash
git add functions/index.js
git commit -m "feat: integrate Resend email notifications for bookings"
```

---

### Task 4: Client-Side Booking UI

**Files**:
- Modify: `index.html`
- Modify: `styles.css`

**Step 1: Add HTML Booking Modal**
Create the booking modal interface before closing `</body>` tag in `index.html`. Add inputs for selecting therapy type, calendar day, time slot, and personal data form.

**Step 2: Add styles.css layout**
Add calendar grid styles, slots badges, modal animations, and active state styles.

**Step 3: Add JS Calendar Fetch & Select Logic**
Implement JavaScript to fetch `/getAvailableSlots`, render them dynamically, filter by selected type, and handle form submission to `/bookAppointment`.

**Step 4: Commit**
```bash
git add index.html styles.css
git commit -m "feat: add client-side calendar booking modal and JavaScript fetch handlers"
```

---

### Task 5: Admin Cloud Functions

**Files**:
- Modify: `functions/index.js`

**Step 1: Implement Admin Auth Verification Helper**
Write authorization middleware that extracts the Firebase Bearer token and verifies it:
```javascript
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
```

**Step 2: Implement Admin CRUD Endpoints**
Implement endpoints `/admin/createSlot`, `/admin/deleteSlot`, `/admin/getBookings`, `/admin/cancelBooking` protected by `verifyAdmin`.

**Step 3: Commit**
```bash
git add functions/index.js
git commit -m "feat: implement admin auth middleware and slots CRUD endpoints"
```

---

### Task 6: Build Admin Dashboard Pages

**Files**:
- Create: `login.html`
- Create: `admin.html`

**Step 1: Implement login.html**
Simple form requesting Email and Password, calling Firebase Auth client script to authenticate and store token.

**Step 2: Implement admin.html dashboard**
- Displays current availability slots.
- Form to add new slots (submitting to `/admin/createSlot`).
- Lists all active bookings (fetched from `/admin/getBookings`) with option to cancel them.

**Step 3: Commit**
```bash
git add login.html admin.html
git commit -m "feat: build login and admin dashboard HTML panels with auth state"
```
