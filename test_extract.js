const fs = require('fs');

// We will test exactly what app.js would do
function extractUPIIdentifier(desc) {
  if (!desc) return "";
  const str = desc.trim();
  if (str.includes('/')) {
    const parts = str.split('/');
    for (let part of parts) {
      if (part.includes('@')) {
        return part.trim();
      }
    }
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        if (/^[A-Za-z\s]+$/.test(parts[i].trim()) && parts[i].trim().length > 3) {
          return parts[i].trim();
        }
      }
      return parts[1].trim();
    }
  }
  return str.substring(0, 25);
}

console.log("TEST:", extractUPIIdentifier("FT IMPS/IFI/612118239985/JAMES KARINGANATTU CYRIAC"));
console.log("TEST:", extractUPIIdentifier("FT IMPS/IFI/615302712229/JAMESKARINGANATTUCYRIAC/I"));
