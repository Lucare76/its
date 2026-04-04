export function generateOtpCode(length = 6): string {
  const chars = "0123456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function getOtpExpiration(minutesFromNow = 10): Date {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutesFromNow);
  return date;
}
