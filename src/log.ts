/**
 * One line per event, with the time. Only Discord ids, role and channel names, counts and
 * error messages go in here: never the token, the secret or anything about a person.
 */

const stamp = () => new Date().toISOString();

export const log = {
  info: (message: string) => console.log(`${stamp()} ${message}`),
  warn: (message: string) => console.warn(`${stamp()} WARN ${message}`),
  error: (message: string) => console.error(`${stamp()} ERROR ${message}`),
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
