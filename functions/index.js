const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();

exports.ping = onRequest((req, res) => {
  res.status(200).send("pong");
});
