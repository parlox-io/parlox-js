// Every string a face renders passes through here, so a secret key that reaches a message, a log line from a child
// process, or an error text is shown as [hidden] instead.
export const SECRET_PATTERN = /sk_(parlox_)?[0-9a-f]{64}/g;
export const scrub = (text: string): string => text.replace(SECRET_PATTERN, "[hidden]");
