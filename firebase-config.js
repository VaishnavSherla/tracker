// Firebase web config. These are public identifiers, not secrets: they ship to every visitor's browser by design.
// Access control comes from firestore.rules + Authentication's authorized domains, not from hiding these values.
// (The deploy workflow only overwrites this file if the FIREBASE_* repo Variables are set.)
export const firebaseConfig = {
  apiKey: "AIzaSyDrWJL7g0y6O1BTpGFrldPHRXU6L7gXbsU",
  authDomain: "tracker-e3808.firebaseapp.com",
  projectId: "tracker-e3808",
  appId: "1:941374044204:web:025e98222a40461b833989",
};
