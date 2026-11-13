// A short, non-clinical reference for an emergency, used in notification texts ("ref 1a2b3c4d") so staff can find the case
// on the emergency board without the notification repeating symptoms or other clinical details.
module.exports = { emergencyRef: (id) => String(id).slice(0, 8) };
