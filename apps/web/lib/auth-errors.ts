/**
 * Maps Supabase Auth error messages to user-friendly product messages.
 * Avoids leaking internal error details while giving clear guidance.
 */

const ERROR_MAP: Record<string, string> = {
  "Invalid login credentials": "Incorrect email or password.",
  "Email not confirmed": "Please verify your email address first.",
  "User already registered": "An account with this email already exists. Try signing in instead.",
  "Signup requires a valid password": "Password is required.",
  "Password should be at least 8 characters": "Password must be at least 8 characters.",
  "Token has expired or is invalid": "This code has expired. Please request a new one.",
  "Email rate limit exceeded": "Too many attempts. Please wait a moment before trying again.",
  "For security purposes, you can only request this after": "Please wait before requesting another code.",
  "Unable to validate email address: invalid format": "Please enter a valid email address.",
  "Phone number format is not valid": "Please enter a valid phone number.",
  "Signups not allowed for otp": "No account found with that email or phone. Please sign up first.",
  "duplicate key value violates unique constraint": "This phone number is already in use by another account.",
};

export function mapAuthError(raw: string): string {
  for (const [pattern, message] of Object.entries(ERROR_MAP)) {
    if (raw.includes(pattern)) return message;
  }
  if (raw.includes("rate limit") || raw.includes("too many")) {
    return "Too many attempts. Please wait a moment before trying again.";
  }
  if (raw.includes("already registered") || raw.includes("already exists")) {
    return "An account with this email already exists. Try signing in instead.";
  }
  return "Something went wrong. Please try again.";
}
