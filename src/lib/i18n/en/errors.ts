/**
 * One user-facing message per `AppError` kind. The developer-oriented `AppError.message` is never shown raw: it goes
 * into a "Details" disclosure.
 */
export const errors = {
  not_found: "That item couldn't be found.",
  invalid_argument: "That request isn't valid.",
  database: 'The local database reported a problem.',
  io: "A file couldn't be read or written.",
  network: "Couldn't reach the server. Check your connection and try again.",
  offline: "You're offline. This needs an internet connection.",
  integrity: 'The download was damaged and has been discarded. Try again.',
  cancelled: 'Cancelled.',
  conflict: 'This changed somewhere else at the same time. Try again.',
  audio: 'Audio playback ran into a problem.',
  unsupported: "This isn't available in this version.",
  internal: 'Something went wrong inside the app.',
} as const
