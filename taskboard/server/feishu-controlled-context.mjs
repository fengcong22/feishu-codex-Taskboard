export const CONTROLLED_CONTEXT_FIELDS = Object.freeze([
  "documentLinks",
  "namingDisplayValue",
  "namingValueUnique",
  "courseName",
]);

const INVALID_COURSE_NAME_CHARACTER = /[<>:"/\\|?*\p{Cc}]/u;

export function isSafeCourseName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 180
    && value !== "."
    && value !== ".."
    && !value.endsWith(".")
    && !value.endsWith(" ")
    && !INVALID_COURSE_NAME_CHARACTER.test(value);
}

/**
 * Older Bridge payloads represent an unavailable optional value as an empty
 * string. Normalize that sentinel away before persisting or using it.
 */
export function normalizeOptionalCourseName(value) {
  if (value === undefined || value === "") return undefined;
  return isSafeCourseName(value) ? value : null;
}
