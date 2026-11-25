// Shared online storage for Project RELIQUARY (Firebase: Firestore database + Authentication).
// While apiKey or adminEmail is empty, the site works as before: everything is saved in each visitor's browser only.
// To share articles, the starmap, locks and chat with every visitor, follow "Shared online storage" in README.md
// and paste your Firebase web-app settings below. These values are public by design; the database rules protect writes.
window.RELIQUARY_CLOUD_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyAH21ho1iqF7LoI70voh4q659nyxI0cVLY',
    authDomain: 'bretomeya-db.firebaseapp.com',
    projectId: 'bretomeya-db',
    appId: '1:999825007297:web:19b0138ccf065525b52a40'
  },
  // The e-mail address of the administrator account you create in Firebase Authentication (lower case).
  // Its password is what you type into the Admin login box.
  adminEmail: 'bretomeya@gmail.com'
};
